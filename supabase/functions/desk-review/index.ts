// desk-review — the learning loop. Called by desk-sync for every closed
// trade (settle), by the app for a rewrite (postmortem), by the daily cron
// and the Learn tab (coach), by the League (roster) and by Ben's questions
// (ask).
//
//   settle     ratings for the model that owned the trade (Brier, calibration
//              bins, Elo matches against jurors who took the other side or
//              abstained); a strategy's shadow trade scores its sit's ballots
//              and re-rates the strategy; then for desk trades the micro
//              review (what happened, why, was the reasoning sound) and its
//              lesson. Idempotent: a trade is settled once.
//   postmortem rewrite the micro review for one trade
//   coach      the daily macro review: the measured record by strategy,
//              timeframe, source and juror, the last trades one per line, the
//              standard applied to every seat, and about 350 words on what is
//              working, what is not, what it teaches and how to proceed
//   roster     apply the standard now: cut what is below it, seat the bench
//   ask        a question about a night, answered with the packet and the
//              transcript in hand
//
// verify_jwt=false at the gateway; callers checked here.

import { binOf, calibration, eloK, eloUpdate, shrink, tstat, standingOf, DEFAULT_CUT_RULES, type CalibBin, type CutRules } from "./lib/stats.ts";
import { templateName } from "./lib/playbook.ts";
import { leagueSettings, poolStanding, type LeagueSettings, type TeamLike } from "./lib/league.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OR = "https://openrouter.ai/api/v1/chat/completions";
const D_SMART = "google/gemini-3.8-flash";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown, max = 2000): string => String(v ?? "").slice(0, max);
const okModel = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String).filter((m) => okModel(m)) : []);
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk-review] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function smartModel(): Promise<string> {
  const r = await rest("user_settings?select=ai_models&limit=1");
  const m = ((r.ok ? (r.json as J[]) : [])[0]?.ai_models as J | undefined)?.smart;
  return okModel(m) ? String(m) : D_SMART;
}

/* ── OpenRouter (same ladder as desk) ─────────────────────────────────── */
type Result = { json: J | null; text: string; cost: number; error: string };
function parseJson(raw: string): J | null {
  const s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(s) as J; } catch { /* salvage */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) as J; } catch { /* give up */ } }
  return null;
}
async function callModel(key: string, model: string, system: string, user: string, maxTokens: number, schema?: J): Promise<Result> {
  let cost = 0;
  const once = async (o: { schema: boolean; reasoning: boolean; maxTokens: number }) => {
    const sys = o.schema || !schema ? system : `${system}\n\nReturn ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`;
    const body: J = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: o.maxTokens };
    if (o.reasoning) body.reasoning = { effort: "low", exclude: true };
    if (o.schema && schema) { body.response_format = { type: "json_schema", json_schema: { name: "review", strict: true, schema } }; body.provider = { require_parameters: true }; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90_000);
    try {
      const r = await fetch(OR, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      let d: J | null = null;
      try { d = JSON.parse(text) as J; } catch { /* keep */ }
      cost += num((d?.usage as J)?.cost);
      return { status: r.status, text, content: String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "") };
    } catch (e) { return { status: 0, text: e instanceof Error ? e.message : String(e), content: "" }; }
    finally { clearTimeout(t); }
  };
  let o = { schema: !!schema, reasoning: true, maxTokens };
  let last = { status: 0, text: "", content: "" };
  for (let i = 0; i < 4; i++) {
    last = await once(o);
    if (last.status === 200 && last.content.trim()) return { json: schema ? parseJson(last.content) : null, text: last.content, cost, error: "" };
    if (last.status === 402) return { json: null, text: "", cost, error: "OpenRouter credits are out" };
    const msg = last.text.slice(0, 300);
    if (o.schema && (last.status === 503 || (last.status === 400 && /response_format|json_schema|structured|schema/i.test(msg)))) { o = { ...o, schema: false }; continue; }
    if (o.reasoning && last.status >= 400 && last.status < 500 && /reasoning/i.test(msg)) { o = { ...o, reasoning: false }; continue; }
    if (last.status === 200 && !last.content.trim() && o.maxTokens < maxTokens * 4) { o = { ...o, maxTokens: o.maxTokens * 2 }; continue; }
    if ((last.status === 0 || last.status >= 500) && i === 0) continue;
    break;
  }
  return { json: null, text: "", cost, error: last.status ? `HTTP ${last.status}: ${last.text.slice(0, 160)}` : `network: ${last.text.slice(0, 120)}` };
}

/* ── ratings ───────────────────────────────────────────────────────────── */
type Rating = { model: string; elo: number; n_matches: number; n_trades: number; n_wins: number; sum_r: number; brier_sum: number; brier_n: number; calib: CalibBin[]; n_abstain: number; n_sits: number; n_sit_right: number; preds: { p: number; won: boolean }[] };
async function loadRating(uid: string, model: string): Promise<Rating> {
  const r = await rest(`desk_ratings?user_id=eq.${uid}&model=eq.${encodeURIComponent(model)}&select=*`);
  const x = (r.ok ? (r.json as J[]) : [])[0];
  const calib = Array.isArray(x?.calib) ? (x!.calib as CalibBin[]) : [];
  return { model, elo: num(x?.elo, 1500), n_matches: num(x?.n_matches), n_trades: num(x?.n_trades), n_wins: num(x?.n_wins), sum_r: num(x?.sum_r), brier_sum: num(x?.brier_sum), brier_n: num(x?.brier_n), calib, n_abstain: num(x?.n_abstain), n_sits: num(x?.n_sits), n_sit_right: num(x?.n_sit_right), preds: [] };
}
async function saveRating(uid: string, r: Rating): Promise<boolean> {
  const row = { user_id: uid, model: r.model, elo: r.elo, n_matches: r.n_matches, n_trades: r.n_trades, n_wins: r.n_wins, sum_r: r.sum_r, brier_sum: r.brier_sum, brier_n: r.brier_n, calib: r.calib, n_abstain: r.n_abstain, n_sits: r.n_sits, n_sit_right: r.n_sit_right, updated_at: new Date().toISOString() };
  return (await rest("desk_ratings?on_conflict=user_id,model", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) })).ok;
}
// Calibration bins are kept as counts so they can be updated one trade at a time.
function addToCalib(calib: CalibBin[], p: number, won: boolean): CalibBin[] {
  const base = calib.length ? calib.map((b) => ({ ...b })) : calibration([]);
  const bin = binOf(p);
  const b = base.find((x) => x.bin === bin);
  if (!b) return base;
  const hits = (b.hit ?? 0) * b.n + (won ? 1 : 0);
  b.n += 1;
  b.hit = hits / b.n;
  return base;
}

async function settle(uid: string, tradeId: string, key: string): Promise<J> {
  const tR = await rest(`desk_trades?id=eq.${tradeId}&user_id=eq.${uid}&select=*`);
  const t = (tR.ok ? (tR.json as J[]) : [])[0];
  if (!t) return { error: "No such trade." };
  if (t.status !== "closed") return { error: "That trade is still open." };
  const review = ((t.review as J) ?? {}) as J;
  const won = num(t.pnl) > 0;
  const r = num(t.r_multiple);
  let ratingsDone = review.settled === true;
  const out: J = { trade_id: tradeId, owner: t.owner, won, r };

  // A strategy's shadow trade is the pure execution of a setup. When it closes, the sit that judged
  // that setup is scored against it, and the strategy's own record decides the size it earns.
  const owner = String(t.owner);
  if (!ratingsDone && owner.startsWith("strat:")) {
    out.sit = await scoreSit(uid, t, won);
    out.decisions = await scoreDecisions(uid, t, won, r);
    out.strategy = await rateStrategy(uid, owner.slice(6));
    ratingsDone = true;
  }
  if (!ratingsDone && owner.startsWith("team:")) {
    out.decision = await settleTeamTrade(uid, t, won, r);
    ratingsDone = true;
  }

  if (!ratingsDone && t.owner !== "desk") {
    const model = String(t.owner);
    const me = await loadRating(uid, model);
    me.n_trades++; if (won) me.n_wins++; me.sum_r += r;
    const p = num(t.confidence, 0.5);
    me.brier_sum += (p - (won ? 1 : 0)) ** 2; me.brier_n++;
    me.calib = addToCalib(me.calib, p, won);
    // Matches: another juror's closed shadow trade on the same symbol, other side, same session;
    // and jurors who explicitly sat the night out.
    const matches: { other: string; iWin: boolean | null }[] = [];
    if (t.session_id) {
      const oR = await rest(`desk_trades?user_id=eq.${uid}&session_id=eq.${t.session_id}&symbol=eq.${encodeURIComponent(String(t.symbol))}&status=eq.closed&owner=neq.desk&select=owner,side,r_multiple`);
      for (const o of (oR.ok ? (oR.json as J[]) : [])) {
        if (o.owner === model || o.side === t.side) continue;
        const or = num(o.r_multiple);
        matches.push({ other: String(o.owner), iWin: r === or ? null : r > or });
      }
      const abR = await rest(`desk_opinions?session_id=eq.${t.session_id}&round=eq.1&select=model,content`);
      for (const o of (abR.ok ? (abR.json as J[]) : [])) {
        if (o.model === model) continue;
        const c = (o.content as J) ?? {};
        const props = Array.isArray(c.proposals) ? (c.proposals as J[]).filter((x) => !x.dropped) : [];
        if (c.no_trade === true && props.length === 0) matches.push({ other: String(o.model), iWin: r === 0 ? null : r > 0 });
      }
    }
    for (const m of matches) {
      const other = await loadRating(uid, m.other);
      const k = eloK(Math.min(me.n_matches, other.n_matches));
      const res = eloUpdate(me.elo, other.elo, m.iWin === null ? 0.5 : m.iWin ? 1 : 0, k);
      me.elo = res.ra; other.elo = res.rb; me.n_matches++; other.n_matches++;
      await saveRating(uid, other);
    }
    await saveRating(uid, me);
    out.matches = matches.length;
    ratingsDone = true;
  }

  let prose = review;
  if ((t.owner === "desk" || owner.startsWith("team:")) && (!review.text || review.text === "")) {
    prose = await postmortem(uid, t, key);
  }
  const merged = { ...review, ...prose, settled: true, settled_at: new Date().toISOString() };
  await rest(`desk_trades?id=eq.${tradeId}`, { method: "PATCH", body: JSON.stringify({ review: merged, updated_at: new Date().toISOString() }) });
  return { ...out, review: merged };
}

// Every juror's confidence on the sit is a Brier and calibration entry; every taker plays every
// passer for Elo, the taker winning if the setup won. A model that passes on winners loses rating too.
async function scoreSit(uid: string, t: J, won: boolean): Promise<J> {
  const sR = await rest(`desk_setups?shadow_trade_id=eq.${t.id}&select=id,sit_id`);
  const setup = (sR.ok ? (sR.json as J[]) : [])[0];
  if (!setup?.sit_id) return { scored: 0, why: "no sit judged this setup" };
  const oR = await rest(`desk_opinions?sit_id=eq.${setup.sit_id}&round=eq.sit&select=model,content,error`);
  const ballots = (oR.ok ? (oR.json as J[]) : [])
    .filter((o) => !o.error)
    .map((o) => ({ model: String(o.model), stance: String((o.content as J)?.stance ?? ""), p: Math.min(0.99, Math.max(0.01, num((o.content as J)?.confidence, 0.5))) }))
    .filter((b) => b.stance === "take" || b.stance === "pass");
  if (!ballots.length) return { scored: 0, why: "no ballots" };
  const ratings = new Map<string, Rating>();
  for (const b of ballots) if (!ratings.has(b.model)) ratings.set(b.model, await loadRating(uid, b.model));
  for (const b of ballots) {
    const me = ratings.get(b.model)!;
    me.n_sits++; if ((b.stance === "take") === won) me.n_sit_right++;
    me.brier_sum += (b.p - (won ? 1 : 0)) ** 2; me.brier_n++;
    me.calib = addToCalib(me.calib, b.p, won);
  }
  let matches = 0;
  for (const a of ballots.filter((b) => b.stance === "take")) {
    for (const c of ballots.filter((b) => b.stance === "pass")) {
      if (a.model === c.model) continue;
      const me = ratings.get(a.model)!, other = ratings.get(c.model)!;
      const k = eloK(Math.min(me.n_matches, other.n_matches));
      const res = eloUpdate(me.elo, other.elo, won ? 1 : 0, k);
      me.elo = res.ra; other.elo = res.rb; me.n_matches++; other.n_matches++; matches++;
    }
  }
  for (const r of ratings.values()) await saveRating(uid, r);
  return { scored: ballots.length, matches, won };
}

// Every team that saw this setup: each worker's vote and the frontier's verdict is a Brier and calibration entry against what the
// strategy's own book did; takers play passers for Elo inside the same team; the ballot is marked right or wrong for the council.
async function scoreDecisions(uid: string, t: J, won: boolean, r: number): Promise<J> {
  const setup = (rows(await rest(`desk_setups?shadow_trade_id=eq.${t.id}&select=id`)))[0];
  if (!setup) return { scored: 0, why: "no setup" };
  const ds = rows(await rest(`desk_decisions?setup_id=eq.${setup.id}&status=eq.done&select=id,ballots,outcome`));
  const ratings = new Map<string, Rating>();
  const ratingOf = async (m: string) => { if (!ratings.has(m)) ratings.set(m, await loadRating(uid, m)); return ratings.get(m)!; };
  let scored = 0, matches = 0;
  for (const d of ds) {
    const ballots = (Array.isArray(d.ballots) ? (d.ballots as J[]) : []);
    const valid = ballots.filter((b) => !b.error && (b.stance === "take" || b.stance === "pass"));
    for (const b of valid) {
      const me = await ratingOf(String(b.model));
      const right = (b.stance === "take") === won;
      me.n_sits++; if (right) me.n_sit_right++;
      const p = Math.min(0.99, Math.max(0.01, num(b.confidence, 0.5)));
      me.brier_sum += (p - (won ? 1 : 0)) ** 2; me.brier_n++;
      me.calib = addToCalib(me.calib, p, won);
      b.right = right; scored++;
    }
    for (const a of valid.filter((b) => b.stance === "take")) for (const c of valid.filter((b) => b.stance === "pass")) {
      if (a.model === c.model) continue;
      const me = await ratingOf(String(a.model)), other = await ratingOf(String(c.model));
      const k = eloK(Math.min(me.n_matches, other.n_matches));
      const res = eloUpdate(me.elo, other.elo, won ? 1 : 0, k);
      me.elo = res.ra; other.elo = res.rb; me.n_matches++; other.n_matches++; matches++;
    }
    const outcome = { ...((d.outcome as J) ?? {}), result: { won, r, from: "the strategy's own book" } };
    await rest(`desk_decisions?id=eq.${d.id}`, { method: "PATCH", body: JSON.stringify({ ballots, outcome, updated_at: new Date().toISOString() }) });
  }
  for (const x of ratings.values()) await saveRating(uid, x);
  return { scored, matches, decisions: ds.length, won };
}
// A team's own trade closed: its decision carries the result, the ballots are marked, and a session idea (no strategy book to score it) scores its voters here.
async function settleTeamTrade(uid: string, t: J, won: boolean, r: number): Promise<J> {
  const d = rows(await rest(`desk_decisions?id=eq.${t.proposal_id}&select=id,setup_id,ballots,outcome`))[0];
  if (!d) return { why: "no decision" };
  const ballots = (Array.isArray(d.ballots) ? (d.ballots as J[]) : []);
  const scoreHere = !d.setup_id;
  const ratings = new Map<string, Rating>();
  for (const b of ballots) {
    if (b.error || !(b.stance === "take" || b.stance === "pass")) continue;
    b.right = (b.stance === "take") === won;
    if (scoreHere) {
      const m = String(b.model);
      if (!ratings.has(m)) ratings.set(m, await loadRating(uid, m));
      const me = ratings.get(m)!;
      me.n_sits++; if (b.right) me.n_sit_right++;
      const p = Math.min(0.99, Math.max(0.01, num(b.confidence, 0.5)));
      me.brier_sum += (p - (won ? 1 : 0)) ** 2; me.brier_n++; me.calib = addToCalib(me.calib, p, won);
    }
  }
  for (const x of ratings.values()) await saveRating(uid, x);
  const outcome = { ...((d.outcome as J) ?? {}), result: { won, r, pnl: num(t.pnl), from: "the team's trade" } };
  await rest(`desk_decisions?id=eq.${d.id}`, { method: "PATCH", body: JSON.stringify({ ballots, outcome, updated_at: new Date().toISOString() }) });
  return { decision: d.id, won, r };
}

// A strategy earns size from its own shadow book, never from a story: twenty closed trades and a
// positive shrunk R is worth 1.5x, forty and +0.2R worth 2x; twenty and a negative R is a week on the bench.
async function rateStrategy(uid: string, id: string): Promise<J> {
  const today = etToday();
  const r = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.${encodeURIComponent(`strat:${id}`)}&status=eq.closed&select=pnl,r_multiple&order=exit_at.desc&limit=300`);
  const rows = r.ok ? (r.json as J[]) : [];
  const rs = rows.map((x) => num(x.r_multiple));
  const n = rs.length, wins = rows.filter((x) => num(x.pnl) > 0).length;
  const mean = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const sh = shrink(mean, n);
  const last20 = rs.slice(0, 20);
  const recent = last20.length ? last20.reduce((a, b) => a + b, 0) / last20.length : 0;
  let size_mult = 1, benched_until: string | null = null, label = n < 20 ? "learning" : "flat";
  if (n >= 40 && sh > 0.2) { size_mult = 2; label = "promoted"; }
  else if (n >= 20 && sh > 0.1) { size_mult = 1.5; label = "earning size"; }
  else if (n >= 20 && sh < -0.1) { size_mult = 0.5; benched_until = new Date(Date.parse(today + "T12:00:00Z") + 7 * 86_400_000).toISOString().slice(0, 10); label = "benched a week"; }
  const stats = { n, wins, hit: n ? wins / n : null, mean_r: mean, shrunk_r: sh, recent_r: recent, label, as_of: today };
  const up = await rest("desk_strategies?on_conflict=user_id,id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ user_id: uid, id, size_mult, benched_until, stats, updated_at: new Date().toISOString() }) });
  return { id, ...stats, size_mult, benched_until, ok: up.ok };
}

/* ── the micro review ──────────────────────────────────────────────────── */
const PM_SCHEMA: J = {
  type: "object", additionalProperties: false,
  required: ["what_happened", "why", "thesis_right", "timing_right", "sizing_right", "rules_followed", "verdict", "grade", "quadrant", "tags", "lesson", "lesson_key", "text"],
  properties: {
    what_happened: { type: "string" }, why: { type: "string" },
    thesis_right: { type: "boolean" }, timing_right: { type: "boolean" }, sizing_right: { type: "boolean" }, rules_followed: { type: "boolean" },
    verdict: { type: "string", enum: ["held", "broke", "unclear"] }, grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
    quadrant: { type: "string", enum: ["earned", "bad_luck", "dumb_luck", "deserved"] },
    tags: { type: "array", items: { type: "string", enum: ["chased", "no_catalyst", "ignored_calendar", "stop_too_tight", "size_too_big", "leverage_too_high", "thesis_vague", "wrong_instrument", "moved_stop", "held_past_time", "funding_ignored", "luck", "none"] } },
    lesson: { type: "string" }, lesson_key: { type: "string" }, text: { type: "string" },
  },
};
// What the jury said at the time, the headlines while the trade was held, and what the strategy's
// own book did with the same setup: the review reads these, so "why" is grounded, not guessed.
async function tradeContext(uid: string, t: J): Promise<{ jury: string; headlines: string; shadow: string }> {
  let jury = "";
  if (t.source === "league" && t.proposal_id) {
    const d = rows(await rest(`desk_decisions?id=eq.${t.proposal_id}&select=ballots,verdict`))[0];
    const ballots = (Array.isArray(d?.ballots) ? (d!.ballots as J[]) : []).filter((b) => !b.error && b.stance);
    const v = (d?.verdict as J) ?? null;
    jury = [...ballots.map((b) => `${b.model} (${b.role ?? "worker"}): ${b.stance} at ${(num(b.confidence) * 100).toFixed(0)}%${b.thesis ? ` — ${str(b.thesis, 300)}` : ""}${b.wrong_if ? ` (wrong if: ${str(b.wrong_if, 160)})` : ""}${Array.isArray(b.checked) && (b.checked as string[]).length ? ` [looked at ${(b.checked as string[]).join(", ")}]` : ""}`),
      ...(v ? [`the frontier ${v.model}${v.acting ? " (a senior worker acting for a silent frontier)" : ""}: ${v.action}${v.risk_pct ? ` at ${v.risk_pct}% risk` : ""}${v.leverage && num(v.leverage) > 1 ? `, ${v.leverage}x` : ""} — ${str(v.reason, 400)}`] : [])].join("\n");
  } else if (t.sit_id) {
    const sR = await rest(`desk_sits?id=eq.${t.sit_id}&select=votes`);
    const votes = ((sR.ok ? (sR.json as J[]) : [])[0]?.votes as J[] | undefined) ?? [];
    jury = votes.filter((v) => !v.error && v.stance).map((v) => `${v.model}: ${v.stance} at ${(num(v.confidence) * 100).toFixed(0)}%${v.thesis ? ` — ${str(v.thesis, 300)}` : ""}${v.what_would_prove_me_wrong ? ` (wrong if: ${str(v.what_would_prove_me_wrong, 160)})` : ""}`).join("\n");
  } else if (t.session_id) {
    const oR = await rest(`desk_opinions?session_id=eq.${t.session_id}&round=eq.2&select=model,content`);
    const lines: string[] = [];
    for (const o of (oR.ok ? (oR.json as J[]) : [])) {
      for (const b of (Array.isArray((o.content as J)?.ballots) ? ((o.content as J).ballots as J[]) : [])) {
        if (String(b.proposal_id) === String(t.proposal_id)) lines.push(`${o.model}: ${b.stance} at ${(num(b.confidence) * 100).toFixed(0)}% — ${str(b.counter, 200)}`);
      }
    }
    jury = lines.join("\n");
  }
  const base = String(t.symbol).split("-")[0];
  const from = new Date((Date.parse(String(t.entry_at ?? t.decided_at)) || Date.now()) - 24 * 3_600_000).toISOString();
  const to = String(t.exit_at ?? new Date().toISOString());
  const [symR, macR] = await Promise.all([
    rest(`desk_news?tagged=eq.true&published=gte.${from}&published=lte.${to}&tickers=cs.${encodeURIComponent(JSON.stringify([base]))}&select=title,impact,direction,why,published&order=published.asc&limit=8`),
    rest(`desk_news?tagged=eq.true&published=gte.${from}&published=lte.${to}&venue=eq.macro&impact=gte.4&select=title,impact,direction,why,published&order=published.asc&limit=5`),
  ]);
  const heads = [...(symR.ok ? (symR.json as J[]) : []), ...(macR.ok ? (macR.json as J[]) : [])].sort((a, b) => String(a.published).localeCompare(String(b.published)));
  const headlines = heads.map((n) => `${String(n.published).slice(5, 16).replace("T", " ")}Z · ${str(n.title, 110)} (impact ${n.impact}, ${n.direction}${n.why ? `: ${str(n.why, 120)}` : ""})`).join("\n");
  let shadow = "";
  if (t.strategy) {
    const stR = await rest(`desk_setups?trade_id=eq.${t.id}&select=shadow_trade_id`);
    const sid = (stR.ok ? (stR.json as J[]) : [])[0]?.shadow_trade_id;
    if (sid) {
      const shR = await rest(`desk_trades?id=eq.${sid}&select=status,exit_reason,r_multiple,stop,target`);
      const sh = (shR.ok ? (shR.json as J[]) : [])[0];
      if (sh) shadow = sh.status === "closed"
        ? `The strategy's own book took the same setup with no jury (stop ${sh.stop}, target ${sh.target}) and ended ${sh.exit_reason} at ${num(sh.r_multiple).toFixed(2)}R.`
        : `The strategy's own book is still holding the same setup (stop ${sh.stop}, target ${sh.target}).`;
    }
  }
  return { jury, headlines, shadow };
}
async function postmortem(uid: string, t: J, key: string): Promise<J> {
  const model = await smartModel();
  const pct = (v: unknown) => `${(num(v) * 100).toFixed(1)}%`;
  const spy = num(t.spy_entry) > 0 && num(t.spy_exit) > 0 ? `SPY moved ${pct(num(t.spy_exit) / num(t.spy_entry) - 1)} over the same days.` : "";
  const held = t.entry_at && t.exit_at ? (Date.parse(String(t.exit_at)) - Date.parse(String(t.entry_at))) / 3_600_000 : null;
  const ctx = await tradeContext(uid, t);
  const system = `You are writing the micro review of one closed PAPER trade for Ben, 19, who is learning markets by watching this desk. Three parts, in plain words.
"what_happened": two or three sentences on the path from entry to exit: where it went first, how far it ran against and for the trade (the excursions), how it ended, and what the headlines say was driving it.
"why": one paragraph on the mechanism that made it work or fail: was the setup's reason still true, did the news overtake it, was the level wrong, was the clock wrong, did the jury's tightening help or hurt against the strategy's own book.
Then separate WAS THE REASONING SOUND from DID IT MAKE MONEY: a winner on a broken thesis is luck; a loser on a sound thesis is variance. Grade the PROCESS (A–F) on its own: was the thesis specific and falsifiable, did the stop and target follow the rules, was the size right, did the exit follow the plan. "quadrant": earned = good process, good outcome; bad_luck = good process, bad outcome; dumb_luck = bad process, good outcome; deserved = bad process, bad outcome. "lesson": one transferable rule in the form "when X, do Y", no tickers, no dates. "lesson_key": a short kebab-case slug for that rule so repeats can be counted. "text": the verdict in under 120 words, blunt and concrete, no hedging, no disclaimers. Return ONLY JSON matching the schema.`;
  let from = t.source === "sit" ? "an intraday sit" : "the nightly jury";
  if (String(t.owner).startsWith("team:")) { const tm = rows(await rest(`desk_teams?id=eq.${String(t.owner).slice(5)}&select=name,tier`))[0]; from = tm ? `team ${tm.name} (${tm.tier} league)` : "a team"; }
  else if (t.source === "league") from = "the champion team, mirrored to the desk";
  const closedBy = (t.review as J)?.closed_by ? ` Closed on request: ${str((t.review as J).closed_by, 200)}.` : "";
  const user = `${t.symbol} ${t.side}${t.instrument === "crypto_perp" ? ` ${t.leverage}x perp` : ""} · template ${t.template ? `${t.template} ${templateName(num(t.template))}` : "none"} · regime ${t.regime} · from ${from}${t.strategy ? ` on a ${t.strategy} setup` : ""} · a ${t.timeframe ?? "swing"} trade${t.horizon_hours ? ` on a ${t.horizon_hours}-hour clock` : ""}${closedBy}
Entry ${t.entry_price} → exit ${t.exit_price} (${t.exit_reason}${t.ambiguous_bar ? ", both stop and target touched in one bar — stop assumed" : ""}). Stop ${t.stop}, target ${t.target}, horizon ${t.horizon_days}d, confidence stated ${pct(t.confidence)}.${held !== null ? ` Held ${held < 48 ? `${held.toFixed(1)} hours` : `${(held / 24).toFixed(1)} days`}.` : ""}
P/L ${num(t.pnl).toFixed(2)} (${pct(t.pnl_pct)}), ${num(t.r_multiple).toFixed(2)}R. Worst excursion ${num(t.mae_r).toFixed(2)}R, best ${num(t.mfe_r).toFixed(2)}R. Fees ${num(t.fees).toFixed(2)}${t.instrument === "crypto_perp" ? `, funding ${num(t.funding).toFixed(2)}` : ""}. ${spy}
Catalyst: ${t.catalyst}
Thesis: ${t.thesis}
It would have been wrong if: ${t.falsifier}

WHAT THE JURY SAID AT THE TIME
${ctx.jury || "(no ballots on record)"}

HEADLINES WHILE IT WAS HELD (the day before entry to the exit)
${ctx.headlines || "(nothing tagged on this symbol; no high-impact macro)"}${ctx.shadow ? `\n\n${ctx.shadow}` : ""}`;
  const res = await callModel(key, model, system, user, 3000, PM_SCHEMA);
  const j = res.json ?? {};
  const tags = (Array.isArray(j.tags) ? (j.tags as string[]) : []).filter((x) => x !== "none").slice(0, 5);
  const review: J = {
    what_happened: str(j.what_happened, 700), why: str(j.why, 900),
    thesis_right: j.thesis_right === true, timing_right: j.timing_right === true, sizing_right: j.sizing_right === true, rules_followed: j.rules_followed !== false,
    verdict: ["held", "broke", "unclear"].includes(String(j.verdict)) ? String(j.verdict) : "unclear",
    grade: ["A", "B", "C", "D", "F"].includes(String(j.grade)) ? String(j.grade) : "",
    quadrant: ["earned", "bad_luck", "dumb_luck", "deserved"].includes(String(j.quadrant)) ? String(j.quadrant) : "",
    tags, lesson: str(j.lesson, 300), lesson_key: str(j.lesson_key, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""),
    text: str(j.text, 1200) || (res.error ? `The review could not be written (${res.error}).` : ""), model, cost: res.cost,
  };
  if (review.lesson && review.lesson_key) await recordLesson(uid, String(review.lesson_key), String(review.lesson), { template: num(t.template), instrument: String(t.instrument), strategy: str(t.strategy, 40), timeframe: str(t.timeframe, 12), source: str(t.source, 12) }, String(t.id));
  return review;
}

// Lessons are counted, not believed: hidden → emerging at 3 → active at 5.
async function recordLesson(uid: string, keyText: string, text: string, scope: J, tradeId: string): Promise<void> {
  const r = await rest(`desk_lessons?user_id=eq.${uid}&scope->>key=eq.${encodeURIComponent(keyText)}&select=id,for_count,against_count,source_trade_ids`);
  const row = (r.ok ? (r.json as J[]) : [])[0];
  if (row) {
    const forCount = num(row.for_count) + 1, against = num(row.against_count);
    const status = forCount >= 5 && forCount >= 3 * against ? "active" : forCount >= 3 ? "emerging" : "hidden";
    const ids = Array.isArray(row.source_trade_ids) ? [...(row.source_trade_ids as string[]), tradeId].slice(-50) : [tradeId];
    await rest(`desk_lessons?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ for_count: forCount, status, source_trade_ids: ids, updated_at: new Date().toISOString() }) });
  } else {
    await rest("desk_lessons", { method: "POST", body: JSON.stringify({ user_id: uid, text, scope: { ...scope, key: keyText }, for_count: 1, status: "hidden", source_trade_ids: [tradeId] }) });
  }
}

/* ── the standard: perform or be replaced ─────────────────────────────── */
// Every seat on both juries is judged against the same bars (standingOf). A juror below the
// standard is cut and the first bench model that is not seated and not itself below the standard
// takes the seat; the cut model goes to the back of the bench. A jury never drops below three.
async function rosterReview(uid: string, acct: J, today: string): Promise<J> {
  const rules: CutRules = { ...DEFAULT_CUT_RULES, ...(((acct.cut_rules as Partial<CutRules>) ?? {})) };
  const ratR = await rest(`desk_ratings?user_id=eq.${uid}&select=*`);
  const ratings = new Map<string, J>((ratR.ok ? (ratR.json as J[]) : []).map((r) => [String(r.model), r]));
  const eqR = await rest(`desk_equity?user_id=eq.${uid}&select=owner,day,equity&order=day.desc&limit=600`);
  const equity: Record<string, number> = {};
  for (const e of (eqR.ok ? (eqR.json as J[]) : [])) { const o = String(e.owner); if (!(o in equity)) equity[o] = num(e.equity); }
  const rosters: Record<"nightly" | "sit", string[]> = { nightly: arr(acct.roster), sit: arr(acct.sit_roster) };
  const benches: Record<"nightly" | "sit", string[]> = { nightly: arr(acct.bench), sit: arr(acct.sit_bench) };
  const changes: J[] = [];
  const standings: Record<string, J> = {};
  const patches = new Map<string, J>();
  const now = new Date().toISOString();
  const standingFor = (seat: "nightly" | "sit", m: string) => {
    const r = ratings.get(m) ?? {};
    return standingOf({ seat, elo: num(r.elo, 1500), n_trades: num(r.n_trades), sum_r: num(r.sum_r), brier_sum: num(r.brier_sum), brier_n: num(r.brier_n), n_sits: num(r.n_sits), n_sit_right: num(r.n_sit_right), equity: seat === "nightly" ? (equity[m] ?? null) : null }, rules);
  };
  const log = async (row: J) => { changes.push(row); await rest("desk_roster_log", { method: "POST", body: JSON.stringify({ user_id: uid, at: now, ...row }) }); };
  for (const seat of ["nightly", "sit"] as const) {
    const seated = (m: string) => rosters.nightly.includes(m) || rosters.sit.includes(m);
    const next: string[] = [];
    let removed = 0;
    const list = rosters[seat];
    for (const m of list) {
      const st = standingFor(seat, m);
      const prev = (((ratings.get(m)?.standing as J) ?? {})[seat] as J | undefined)?.label;
      standings[`${seat}:${m}`] = { ...st, model: m, seat };
      if (st.label !== "cut") {
        next.push(m);
        if (st.label === "on notice" && prev !== "on notice") await log({ seat, action: "notice", model: m, replaced_by: "", reason: st.reasons.join("; ") });
        continue;
      }
      const reason = st.reasons.join("; ");
      const sub = benches[seat].find((b) => !seated(b) && !next.includes(b) && standingFor(seat, b).label !== "cut");
      if (sub) {
        next.push(sub);
        benches[seat] = [...benches[seat].filter((b) => b !== sub), m];
        standings[`${seat}:${sub}`] = { ...standingFor(seat, sub), model: sub, seat };
        patches.set(m, { status: "cut", cut_at: now, cut_reason: reason });
        await log({ seat, action: "cut", model: m, replaced_by: sub, reason });
      } else if (list.length - removed - 1 >= 3) {
        removed++;
        benches[seat] = [...benches[seat], m];
        patches.set(m, { status: "cut", cut_at: now, cut_reason: reason });
        await log({ seat, action: "cut", model: m, replaced_by: "", reason: `${reason}; nobody on the bench, the seat stays empty` });
      } else {
        next.push(m);
        if (prev !== "cut") await log({ seat, action: "kept", model: m, replaced_by: "", reason: `${reason}; below the standard but the jury needs three and the bench is empty` });
      }
    }
    rosters[seat] = next;
  }
  // A ratings row for every seated model, so the League can show its standing from day one.
  for (const st of Object.values(standings)) {
    const model = String(st.model), seat = String(st.seat);
    const r = ratings.get(model) ?? {};
    const standing = { ...((r.standing as J) ?? {}), [seat]: { label: st.label, reasons: st.reasons, sample: st.sample, needed: st.needed, as_of: today } };
    const patch = patches.get(model) ?? (r.status === "cut" && (rosters.nightly.includes(model) || rosters.sit.includes(model)) ? { status: "active", cut_reason: "" } : {});
    await rest("desk_ratings?on_conflict=user_id,model", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ user_id: uid, model, standing, ...patch, updated_at: now }) });
    ratings.set(model, { ...r, standing, ...patch });
  }
  await rest(`desk_accounts?user_id=eq.${uid}`, { method: "PATCH", body: JSON.stringify({ roster: rosters.nightly, sit_roster: rosters.sit, bench: benches.nightly, sit_bench: benches.sit, updated_at: now }) });
  return { changes, standings: Object.values(standings), roster: rosters.nightly, sit_roster: rosters.sit, bench: benches.nightly, sit_bench: benches.sit, rules };
}

/* ── the macro review ──────────────────────────────────────────────────── */
type Cell = { n: number; wins: number; rs: number[]; gross_win: number; gross_loss: number };
function cellStats(c: Cell) {
  const mean = c.rs.length ? c.rs.reduce((a, b) => a + b, 0) / c.rs.length : 0;
  const t = tstat(c.rs);
  const sh = shrink(mean, c.rs.length);
  const label = c.n < 8 ? "too few to trust" : c.n >= 50 && t !== null && Math.abs(t) >= 2 ? "strong" : c.n >= 20 ? "a rule" : "emerging";
  return { n: c.n, hit: c.n ? c.wins / c.n : null, mean_r: mean, shrunk_r: sh, profit_factor: c.gross_loss > 0 ? c.gross_win / c.gross_loss : null, t, label };
}
async function coach(uid: string, key: string, today: string, acct: J): Promise<J> {
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const dayStart = `${today}T04:00:00Z`;
  const [teamsR, tradesR, decR, councilR, seasonR, ratR, stratR] = await Promise.all([
    rest(`desk_teams?user_id=eq.${uid}&select=*&order=formed_at.asc`),
    rest(`desk_trades?user_id=eq.${uid}&owner=like.team:*&select=id,owner,symbol,side,strategy,timeframe,status,pnl,r_multiple,exit_reason,exit_at,review&order=created_at.desc&limit=3000`),
    rest(`desk_decisions?user_id=eq.${uid}&created_at=gte.${dayStart}&select=team_id,kind,outcome,cost_usd&limit=3000`),
    rest(`desk_councils?user_id=eq.${uid}&day=eq.${today}&select=team_id,kicked,replaced_by,reason,cost_usd`),
    rest(`desk_seasons?user_id=eq.${uid}&select=*&order=n.desc&limit=3`),
    rest(`desk_ratings?user_id=eq.${uid}&select=model,elo,n_sits,n_sit_right,brier_sum,brier_n`),
    rest(`desk_trades?user_id=eq.${uid}&owner=like.strat:*&status=eq.closed&select=owner,pnl,r_multiple&limit=3000`),
  ]);
  const teams = rows(teamsR), trades = rows(tradesR), decs = rows(decR), councils = rows(councilR), seasons = rows(seasonR), ratings = rows(ratR), stratTrades = rows(stratR);
  const nameOf = (id: string) => String(teams.find((t) => String(t.id) === id)?.name ?? id.slice(0, 8));
  const teamLikes: TeamLike[] = teams.map((t) => ({ id: String(t.id), frontier: String(t.frontier), workers: Array.isArray(t.workers) ? (t.workers as string[]) : [], status: t.status === "dead" ? "dead" : "live", return_pct: num(t.return_pct), formed_at: String(t.formed_at ?? "") }));
  const daysBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(from.slice(0, 10) + "T12:00:00Z")) / 86_400_000));
  const tierOrder: Record<string, number> = { diamond: 0, gold: 1, bronze: 2 };
  const liveOrDiedToday = teams.filter((t) => t.status === "live" || String(t.died_at ?? "") >= dayStart);
  const teamCards = liveOrDiedToday.map((t) => {
    const id = String(t.id);
    const mine = decs.filter((d) => String(d.team_id) === id);
    const reads = mine.filter((d) => d.kind === "candidate" || d.kind === "session");
    const takes = reads.filter((d) => ((d.outcome as J) ?? {}).taken === true).length;
    const stats = (t.stats as J) ?? {};
    return {
      id, name: String(t.name), tier: String(t.tier), rank: 0, status: String(t.status), frontier: String(t.frontier), workers: Array.isArray(t.workers) ? t.workers : [], seniors: Array.isArray(t.seniors) ? t.seniors : [],
      return_pct: num(t.return_pct), rank_score: num(stats.rank_score, num(t.return_pct)), passive_days: num(stats.passive_days), equity: num(t.equity), days_alive: daysBetween(String(t.formed_at), today),
      open: trades.filter((x) => x.owner === `team:${id}` && (x.status === "open" || x.status === "pending")).length,
      decisions: reads.length, takes, passes: reads.length - takes, closes: mine.filter((d) => d.kind === "close").length, kicks: councils.filter((c) => String(c.team_id) === id && c.kicked).length,
      death_reason: str(t.death_reason, 200),
    };
  }).sort((a, b) => (a.status === "dead" ? 1 : 0) - (b.status === "dead" ? 1 : 0) || tierOrder[a.tier] - tierOrder[b.tier] || b.rank_score - a.rank_score);
  let rank = 0; for (const c of teamCards) if (c.status === "live") c.rank = ++rank;
  const groups: Record<string, Record<string, Cell>> = { strategy: {}, tier: {}, book: {} };
  const add = (g: string, k: string, x: J) => {
    const c = (groups[g][k] ??= { n: 0, wins: 0, rs: [], gross_win: 0, gross_loss: 0 });
    const pnl = num(x.pnl), rr = num(x.r_multiple);
    c.n++; if (pnl > 0) { c.wins++; c.gross_win += pnl; } else c.gross_loss += -pnl; c.rs.push(rr);
  };
  const closedTeam = trades.filter((x) => x.status === "closed");
  for (const x of closedTeam) {
    add("strategy", String(x.strategy || "session idea"), x);
    const tm = teams.find((t) => `team:${t.id}` === x.owner);
    add("tier", String(tm?.tier ?? "unknown"), x);
  }
  for (const x of stratTrades) add("book", String(x.owner).slice(6), x);
  const cells = (g: string) => Object.fromEntries(Object.entries(groups[g]).map(([k, c]) => [k, cellStats(c)]));
  const recent = closedTeam.slice(0, 25).map((x) => {
    const rv = (x.review as J) ?? {};
    return { team: nameOf(String(x.owner).slice(5)), symbol: x.symbol, side: x.side, strategy: x.strategy || "session idea", timeframe: x.timeframe || "swing", r: num(x.r_multiple), pnl: num(x.pnl), exit: x.exit_reason, closed: String(x.exit_at ?? "").slice(0, 16), quadrant: rv.quadrant ?? "", grade: rv.grade ?? "", lesson: str(rv.lesson, 160), why: str(rv.why, 240) };
  });
  const liveSeats = (m: string) => teams.filter((t) => t.status === "live" && (t.frontier === m || (Array.isArray(t.workers) && (t.workers as string[]).includes(m)))).length;
  const pool = [...s.frontier_pool.map((m) => ({ m, role: "frontier" })), ...s.worker_pool.map((m) => ({ m, role: "worker" }))].map(({ m, role }) => {
    const r = ratings.find((x) => x.model === m);
    return { model: m, role, standing: poolStanding(m, teamLikes), live_teams: liveSeats(m), elo: r ? num(r.elo, 1500) : 1500, brier: r && num(r.brier_n) ? num(r.brier_sum) / num(r.brier_n) : null, sits: r ? num(r.n_sits) : 0, sit_right: r && num(r.n_sits) ? num(r.n_sit_right) / num(r.n_sits) : null };
  });
  const running = seasons.find((x) => x.status === "running") ?? null;
  const lastDone = seasons.find((x) => x.status === "done" && x.champion_team) ?? null;
  const season = running ? { n: num(running.n), day_of: daysBetween(String(running.start_day), today) + 1, days: s.season_days, start_day: String(running.start_day), end_day: String(running.end_day), champion: lastDone ? nameOf(String(lastDone.champion_team)) : null } : null;
  const spend = decs.reduce((a, d) => a + num(d.cost_usd), 0) + councils.reduce((a, c) => a + num(c.cost_usd), 0);
  const card: J = {
    as_of: today, day: today, season, teams: teamCards,
    dead_today: teams.filter((t) => String(t.died_at ?? "") >= dayStart).map((t) => ({ name: t.name, reason: str(t.death_reason, 200), return_pct: num(t.return_pct) })),
    formed_today: teams.filter((t) => String(t.formed_at ?? "") >= dayStart).map((t) => ({ name: t.name, frontier: t.frontier, workers: t.workers })),
    councils_today: councils.map((c) => ({ team: nameOf(String(c.team_id)), kicked: c.kicked ?? null, replaced_by: c.replaced_by ?? null, reason: str(c.reason, 300) })),
    by_strategy: cells("strategy"), by_tier: cells("tier"), strategy_books: cells("book"), pool, trades: recent, spend_today: Number(spend.toFixed(3)),
    rules: { death_pct: s.death_pct, min_takes_day: s.min_takes_day, min_heat_pct: s.min_heat_pct, passive_penalty_pct: s.passive_penalty_pct, season_days: s.season_days },
  };
  let review = "";
  let cost = 0;
  if (teams.length) {
    const model = await smartModel();
    const system = `You are the daily macro review of a paper-trading tournament run by Ben, 19, who is learning markets. Nine teams, each one frontier model that decides and four worker models that research and vote, run a $100k paper book each. The tiers rank by ranked return (percent return less ${s.passive_penalty_pct}% for every passive day): the top three are Diamond, the next three Gold, the rest Bronze. Every day the worst team in Bronze is replaced by a set of models never used before; a team ${s.death_pct}% below its start dies at once; a team that takes fewer than ${s.min_takes_day} trades in a day and keeps less than ${s.min_heat_pct}% of its book at risk is playing to survive and is cut first. Each team's council (frontier plus two senior workers) can kick a member daily. The objective is to make as much as possible; survival alone ranks nothing.
You are handed the measured record: the standings ("teams", with days alive, takes and passes today, kicks, passive days), who died and who formed today, today's councils, the teams' closed trades grouped by strategy (with each strategy's rule-only book beside it in "strategy_books", so the gap is what the teams add or cost) and by tier, the pool's standings (mean return of the teams a model has been on; Elo and Brier from its scored votes), the last closed trades with their micro reviews, and today's spend. Mean R is shrunk toward zero for small samples; "too few to trust" means exactly that.
Write about 350 words in four short parts with these headings on their own lines: WHAT IS WORKING, WHAT IS NOT, WHAT THESE TRADES TEACH, HOW TO PROCEED. Reason across teams and days: which frontiers and which worker combinations are winning and why, which strategies pay in which tier, what the dead did wrong, who is playing to survive, where the councils were right or wrong. In HOW TO PROCEED be concrete: which teams look like champions, which councils should kick whom and who from the pool deserves a seat, one rule to add or change, and what is still too thin to judge. Numbers, not adjectives. Plain words, no advice framing, no hedging boilerplate. Never tell him what to do with real money.`;
    const res = await callModel(key, model, system, JSON.stringify(card).slice(0, 18000), 1700);
    review = res.text || (res.error ? `The review could not be written today (${res.error}).` : "");
    cost = res.cost;
  } else review = "No teams yet. Form them under League and the review writes itself from the first day's record.";
  const up = await rest("desk_cards?on_conflict=user_id,day", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ user_id: uid, day: today, week_start: weekStart(today), card, review }) });
  return { day: today, teams: teamCards.length, closed: closedTeam.length, ok: up.ok, cost, review };
}
function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return new Date(Date.UTC(y, m - 1, d - ((dow + 6) % 7))).toISOString().slice(0, 10);
}

/* ── ask the desk ──────────────────────────────────────────────────────── */
async function ask(uid: string, key: string, body: J): Promise<J> {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day ?? "")) ? String(body.day) : "";
  const message = str(body.message, 2000).trim();
  if (!message) return { error: "Ask something." };
  const sR = day ? await rest(`desk_sessions?user_id=eq.${uid}&day=eq.${day}&status=neq.dry&select=id,packet,votes,verdict,regime&order=seq.desc&limit=1`) : { ok: false, json: null };
  const s = (sR.ok ? (sR.json as J[]) : [])[0];
  let context = "No session for that day.";
  if (s) {
    const p = (s.packet as J) ?? {};
    const oR = await rest(`desk_opinions?session_id=eq.${s.id}&select=model,juror,round,content&order=created_at.asc`);
    const ops = (oR.ok ? (oR.json as J[]) : []).map((o) => `[${o.round === "judge" ? "JUDGE" : `Juror ${o.juror}`} · ${o.model}] ${JSON.stringify(o.content).slice(0, 1800)}`).join("\n");
    context = `REGIME ${s.regime}\nNEWS\n${JSON.stringify(p.briefing ?? []).slice(0, 5000)}\nTAPE\n${Object.values((p.cards as J) ?? {}).join("\n").slice(0, 3000)}\nBOOK\n${JSON.stringify(p.book ?? {})}\nTRANSCRIPT\n${ops.slice(0, 16000)}\nTALLY ${JSON.stringify(s.votes)}\nVERDICT ${JSON.stringify(s.verdict).slice(0, 4000)}`;
  }
  const history = Array.isArray(body.history) ? (body.history as J[]).slice(-10).map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: str(h.content, 1500) })) : [];
  const model = await smartModel();
  const system = `You are the desk's explainer for Ben, 19, learning markets by watching a jury of models paper-trade the news. Answer his question from the night's packet and transcript below. Be concrete: name the juror, the number, the level. Teach the general idea when it helps, in plain words, under 200 words unless he asks for more. Never tell him what to do with real money.\n\n${context}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90_000);
  try {
    const r = await fetch(OR, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }], max_tokens: 1500, reasoning: { effort: "low", exclude: true } }), signal: ctl.signal });
    const d = (await r.json()) as J;
    const text = String((((d.choices as J[]) ?? [])[0]?.message as J)?.content ?? "").trim();
    if (!r.ok || !text) return { error: r.status === 402 ? "OpenRouter credits are out." : `The desk did not answer (HTTP ${r.status}).` };
    return { text, cost: num((d.usage as J)?.cost), model };
  } catch (e) { return { error: `Couldn't reach the model (${e instanceof Error ? e.message : e}).` }; }
  finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    const mode = String(body.mode ?? "");
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const key = (await secret("anthropic_api_key")) || ENV_KEY;
    if (!key) return ok({ error: "No AI key set." });
    const today = etToday();
    if (mode === "settle") return ok(await settle(uid, str(body.trade_id, 64), key));
    if (mode === "postmortem") {
      const tR = await rest(`desk_trades?id=eq.${str(body.trade_id, 64)}&user_id=eq.${uid}&select=*`);
      const t = (tR.ok ? (tR.json as J[]) : [])[0];
      if (!t) return ok({ error: "No such trade." });
      if (t.status !== "closed") return ok({ error: "That one is still open — nothing to review yet." });
      const prev = ((t.review as J) ?? {}) as J;
      if (prev.text && body.force !== true) return ok({ review: prev, cached: true });
      const review = { ...prev, ...(await postmortem(uid, t, key)) };
      await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ review, updated_at: new Date().toISOString() }) });
      return ok({ review });
    }
    if (mode === "coach" || mode === "roster") {
      const aR = await rest(`desk_accounts?user_id=eq.${uid}&select=*`);
      const acct = (aR.ok ? (aR.json as J[]) : [])[0];
      if (!acct) return ok({ error: "No desk account." });
      return ok(mode === "coach" ? await coach(uid, key, today, acct) : await rosterReview(uid, acct, today));
    }
    if (mode === "ask") return ok(await ask(uid, key, body));
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-review] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
