// desk-review — the learning loop. Called by desk-sync for every closed
// trade (settle), by the app for a rewrite (postmortem), by the Sunday cron
// (coach) and by Ben's questions (ask).
//
//   settle     ratings for the model that owned the trade (Brier, calibration
//              bins, Elo matches against jurors who took the other side or
//              abstained), then for desk trades the structured post-mortem and
//              its lesson. Idempotent: a trade is settled once.
//   postmortem rewrite the prose for one trade
//   coach      the weekly track-record card (numbers, shrunk toward zero for
//              small samples) + a 200-word review
//   ask        a question about a night, answered with the packet and the
//              transcript in hand
//
// verify_jwt=false at the gateway; callers checked here.

import { binOf, calibration, eloK, eloUpdate, shrink, tstat, type CalibBin } from "./lib/stats.ts";
import { templateName } from "./lib/playbook.ts";

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
type Rating = { model: string; elo: number; n_matches: number; n_trades: number; n_wins: number; sum_r: number; brier_sum: number; brier_n: number; calib: CalibBin[]; n_abstain: number; preds: { p: number; won: boolean }[] };
async function loadRating(uid: string, model: string): Promise<Rating> {
  const r = await rest(`desk_ratings?user_id=eq.${uid}&model=eq.${encodeURIComponent(model)}&select=*`);
  const x = (r.ok ? (r.json as J[]) : [])[0];
  const calib = Array.isArray(x?.calib) ? (x!.calib as CalibBin[]) : [];
  return { model, elo: num(x?.elo, 1500), n_matches: num(x?.n_matches), n_trades: num(x?.n_trades), n_wins: num(x?.n_wins), sum_r: num(x?.sum_r), brier_sum: num(x?.brier_sum), brier_n: num(x?.brier_n), calib, n_abstain: num(x?.n_abstain), preds: [] };
}
async function saveRating(uid: string, r: Rating): Promise<boolean> {
  const row = { user_id: uid, model: r.model, elo: r.elo, n_matches: r.n_matches, n_trades: r.n_trades, n_wins: r.n_wins, sum_r: r.sum_r, brier_sum: r.brier_sum, brier_n: r.brier_n, calib: r.calib, n_abstain: r.n_abstain, updated_at: new Date().toISOString() };
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
  if (t.owner === "desk" && (!review.text || review.text === "")) {
    prose = await postmortem(uid, t, key);
  }
  const merged = { ...review, ...prose, settled: true, settled_at: new Date().toISOString() };
  await rest(`desk_trades?id=eq.${tradeId}`, { method: "PATCH", body: JSON.stringify({ review: merged, updated_at: new Date().toISOString() }) });
  return { ...out, review: merged };
}

/* ── post-mortem ───────────────────────────────────────────────────────── */
const PM_SCHEMA: J = {
  type: "object", additionalProperties: false,
  required: ["thesis_right", "timing_right", "sizing_right", "rules_followed", "verdict", "grade", "quadrant", "tags", "lesson", "lesson_key", "text"],
  properties: {
    thesis_right: { type: "boolean" }, timing_right: { type: "boolean" }, sizing_right: { type: "boolean" }, rules_followed: { type: "boolean" },
    verdict: { type: "string", enum: ["held", "broke", "unclear"] }, grade: { type: "string", enum: ["A", "B", "C", "D", "F"] },
    quadrant: { type: "string", enum: ["earned", "bad_luck", "dumb_luck", "deserved"] },
    tags: { type: "array", items: { type: "string", enum: ["chased", "no_catalyst", "ignored_calendar", "stop_too_tight", "size_too_big", "leverage_too_high", "thesis_vague", "wrong_instrument", "moved_stop", "held_past_time", "funding_ignored", "luck", "none"] } },
    lesson: { type: "string" }, lesson_key: { type: "string" }, text: { type: "string" },
  },
};
async function postmortem(uid: string, t: J, key: string): Promise<J> {
  const model = await smartModel();
  const pct = (v: unknown) => `${(num(v) * 100).toFixed(1)}%`;
  const spy = num(t.spy_entry) > 0 && num(t.spy_exit) > 0 ? `SPY moved ${pct(num(t.spy_exit) / num(t.spy_entry) - 1)} over the same days.` : "";
  const system = `You are writing the post-mortem on a closed PAPER trade for Ben, 19, who is learning markets by watching this desk. Separate WAS THE REASONING SOUND from DID IT MAKE MONEY: a winner on a broken thesis is luck; a loser on a sound thesis is variance. Grade the PROCESS (A–F) on its own: was the thesis specific and falsifiable, did the stop and target follow the rules, was the size right, did the exit follow the plan. "quadrant": earned = good process, good outcome; bad_luck = good process, bad outcome; dumb_luck = bad process, good outcome; deserved = bad process, bad outcome. "lesson": one transferable rule in the form "when X, do Y" — no tickers, no dates. "lesson_key": a short kebab-case slug for that rule so repeats can be counted. "text": under 130 words, blunt and concrete, no hedging, no disclaimers. Return ONLY JSON matching the schema.`;
  const user = `${t.symbol} ${t.side}${t.instrument === "crypto_perp" ? ` ${t.leverage}x perp` : ""} · template ${t.template ? `${t.template} ${templateName(num(t.template))}` : "none"} · regime ${t.regime}
Entry ${t.entry_price} → exit ${t.exit_price} (${t.exit_reason}${t.ambiguous_bar ? ", both stop and target touched in one bar — stop assumed" : ""}). Stop ${t.stop}, target ${t.target}, horizon ${t.horizon_days}d, confidence stated ${pct(t.confidence)}.
P/L ${num(t.pnl).toFixed(2)} (${pct(t.pnl_pct)}), ${num(t.r_multiple).toFixed(2)}R. Worst excursion ${num(t.mae_r).toFixed(2)}R, best ${num(t.mfe_r).toFixed(2)}R. Fees ${num(t.fees).toFixed(2)}${t.instrument === "crypto_perp" ? `, funding ${num(t.funding).toFixed(2)}` : ""}. ${spy}
Catalyst: ${t.catalyst}
Thesis: ${t.thesis}
It would have been wrong if: ${t.falsifier}`;
  const res = await callModel(key, model, system, user, 2500, PM_SCHEMA);
  const j = res.json ?? {};
  const tags = (Array.isArray(j.tags) ? (j.tags as string[]) : []).filter((x) => x !== "none").slice(0, 5);
  const review: J = {
    thesis_right: j.thesis_right === true, timing_right: j.timing_right === true, sizing_right: j.sizing_right === true, rules_followed: j.rules_followed !== false,
    verdict: ["held", "broke", "unclear"].includes(String(j.verdict)) ? String(j.verdict) : "unclear",
    grade: ["A", "B", "C", "D", "F"].includes(String(j.grade)) ? String(j.grade) : "",
    quadrant: ["earned", "bad_luck", "dumb_luck", "deserved"].includes(String(j.quadrant)) ? String(j.quadrant) : "",
    tags, lesson: str(j.lesson, 300), lesson_key: str(j.lesson_key, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""),
    text: str(j.text, 1200) || (res.error ? `The post-mortem could not be written (${res.error}).` : ""), model, cost: res.cost,
  };
  if (review.lesson && review.lesson_key) await recordLesson(uid, String(review.lesson_key), String(review.lesson), { template: num(t.template), instrument: String(t.instrument) }, String(t.id));
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

/* ── coach ─────────────────────────────────────────────────────────────── */
type Cell = { n: number; wins: number; rs: number[]; gross_win: number; gross_loss: number };
function cellStats(c: Cell) {
  const mean = c.rs.length ? c.rs.reduce((a, b) => a + b, 0) / c.rs.length : 0;
  const t = tstat(c.rs);
  const sh = shrink(mean, c.rs.length);
  const label = c.n < 8 ? "too few to trust" : c.n >= 50 && t !== null && Math.abs(t) >= 2 ? "strong" : c.n >= 20 ? "a rule" : "emerging";
  return { n: c.n, hit: c.n ? c.wins / c.n : null, mean_r: mean, shrunk_r: sh, profit_factor: c.gross_loss > 0 ? c.gross_win / c.gross_loss : null, t, label };
}
async function coach(uid: string, key: string, today: string): Promise<J> {
  const r = await rest(`desk_trades?user_id=eq.${uid}&status=eq.closed&select=owner,template,instrument,regime,pnl,r_multiple,confidence,exit_reason,review&order=exit_at.asc&limit=5000`);
  const rows = (r.ok ? (r.json as J[]) : []);
  const groups: Record<string, Record<string, Cell>> = { template: {}, instrument: {}, regime: {}, model: {}, exit: {} };
  const add = (g: string, k: string, x: J) => {
    const c = (groups[g][k] ??= { n: 0, wins: 0, rs: [], gross_win: 0, gross_loss: 0 });
    const pnl = num(x.pnl), rr = num(x.r_multiple);
    c.n++; if (pnl > 0) { c.wins++; c.gross_win += pnl; } else c.gross_loss += -pnl; c.rs.push(rr);
  };
  for (const x of rows) {
    const owner = String(x.owner);
    if (owner === "desk") {
      add("template", x.template ? `${x.template} ${templateName(num(x.template))}` : "no template", x);
      add("instrument", String(x.instrument), x);
      add("regime", String(x.regime || "unknown"), x);
      add("exit", String(x.exit_reason || "?"), x);
    } else add("model", owner, x);
  }
  const card: J = { as_of: today, desk: {} as J, models: {} as J };
  for (const g of ["template", "instrument", "regime", "exit"]) {
    (card.desk as J)[g] = Object.fromEntries(Object.entries(groups[g]).map(([k, c]) => [k, cellStats(c)]));
  }
  const ratR = await rest(`desk_ratings?user_id=eq.${uid}&select=model,elo,n_trades,n_wins,sum_r,brier_sum,brier_n,n_matches`);
  for (const m of (ratR.ok ? (ratR.json as J[]) : [])) {
    const c = groups.model[String(m.model)];
    (card.models as J)[String(m.model)] = { ...(c ? cellStats(c) : { n: 0 }), elo: num(m.elo, 1500), brier: num(m.brier_n) ? num(m.brier_sum) / num(m.brier_n) : null, matches: num(m.n_matches) };
  }
  const deskAll: Cell = { n: 0, wins: 0, rs: [], gross_win: 0, gross_loss: 0 };
  for (const x of rows.filter((y) => y.owner === "desk")) { const pnl = num(x.pnl); deskAll.n++; if (pnl > 0) { deskAll.wins++; deskAll.gross_win += pnl; } else deskAll.gross_loss += -pnl; deskAll.rs.push(num(x.r_multiple)); }
  (card.desk as J).overall = cellStats(deskAll);

  let review = "";
  let cost = 0;
  if (deskAll.n > 0 || Object.keys(card.models as J).length) {
    const model = await smartModel();
    const system = `You are the weekly coach for a paper-trading desk run by Ben, 19, who is learning markets. You are handed the measured track record (hit rates, mean R shrunk toward zero for small samples, profit factors, t-stats, per model Brier scores). Write about 200 words: what is working, what is not, what is still too thin to judge, and the one thing to watch next week. Numbers, not adjectives. Say "too few to trust" where the label says so. No advice framing, no hedging boilerplate.`;
    const res = await callModel(key, model, system, JSON.stringify(card).slice(0, 12000), 1200);
    review = res.text || (res.error ? `The coach could not write this week (${res.error}).` : "");
    cost = res.cost;
  } else review = "No closed trades yet. The first review writes itself once the book has closed a few positions.";
  const wk = weekStart(today);
  const up = await rest("desk_cards?on_conflict=user_id,week_start", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ user_id: uid, week_start: wk, card, review }) });
  return { week_start: wk, closed: rows.length, ok: up.ok, cost, review };
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
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (mode === "settle") return ok(await settle(uid, str(body.trade_id, 64), key));
    if (mode === "postmortem") {
      const tR = await rest(`desk_trades?id=eq.${str(body.trade_id, 64)}&user_id=eq.${uid}&select=*`);
      const t = (tR.ok ? (tR.json as J[]) : [])[0];
      if (!t) return ok({ error: "No such trade." });
      if (t.status !== "closed") return ok({ error: "That one is still open — nothing to post-mortem yet." });
      const prev = ((t.review as J) ?? {}) as J;
      if (prev.text && body.force !== true) return ok({ review: prev, cached: true });
      const review = { ...prev, ...(await postmortem(uid, t, key)) };
      await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ review, updated_at: new Date().toISOString() }) });
      return ok({ review });
    }
    if (mode === "coach") return ok(await coach(uid, key, today));
    if (mode === "ask") return ok(await ask(uid, key, body));
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-review] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
