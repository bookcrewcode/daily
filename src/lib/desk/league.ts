// The Desk — the leagues. Pure: the settings, the draft, replacements, tiers,
// names, the death line. Copied into the desk-league edge function, so nothing
// here may import from outside src/lib/desk.

export type Tier = "diamond" | "gold" | "bronze";
export const TIERS: Tier[] = ["diamond", "gold", "bronze"];

export type LeagueSettings = {
  frontier_pool: string[];   // strong models; one leads each team
  worker_pool: string[];     // fast, cheap models; four sit behind each frontier
  teams_per_tier: number;    // 3 → nine teams
  workers_per_team: number;  // 4
  death_pct: number;         // a team dies when its book is this far below its start
  risk_max_pct: number;      // the most a frontier may risk on one trade
  budget_usd_day: number;    // OpenRouter credit for every team's model calls, per day
  research: "off" | "light"; // light = a worker may look twice before it votes
  session_times: string[];   // ET, HH:MM; the frontier reviews positions and the workers propose
  season_days: number;       // the champion is crowned at the daily cut on the last day
  min_takes_day: number;     // playing to survive: fewer takes than this in a day, and ...
  min_heat_pct: number;      // ... less than this share of the book at risk in open positions
  passive_penalty_pct: number; // each passive day docks this from the team's ranked return
};

export const DEFAULT_LEAGUE: LeagueSettings = {
  frontier_pool: ["anthropic/claude-opus-5", "openai/gpt-6-astra", "anthropic/claude-fable-5.1", "google/gemini-3.1-pro-preview", "moonshotai/kimi-k3", "x-ai/grok-4.6", "anthropic/claude-sonnet-5", "openai/gpt-5.6-terra"],
  worker_pool: ["google/gemini-3.8-flash", "openai/gpt-5.6-luna", "deepseek/deepseek-v4-flash-0731", "x-ai/grok-4.3", "qwen/qwen3.8-flash", "anthropic/claude-haiku-4.5", "google/gemini-3.5-flash-lite", "minimax/minimax-m3", "moonshotai/kimi-k2.6", "mistralai/mistral-medium-3-5", "z-ai/glm-5.3", "qwen/qwen3.8-max-0902"],
  teams_per_tier: 3, workers_per_team: 4, death_pct: 5, risk_max_pct: 3, budget_usd_day: 25, research: "light",
  session_times: ["08:45", "15:15", "21:30"], season_days: 14,
  min_takes_day: 2, min_heat_pct: 4, passive_penalty_pct: 1,
};

const MODEL_ID = /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i;
const clampN = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const models = (v: unknown, d: string[]) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter((x) => MODEL_ID.test(x)))] : d);

/** The stored settings merged over the defaults, every field inside its range. */
export function leagueSettings(p?: Partial<LeagueSettings> | null): LeagueSettings {
  const x = (p ?? {}) as Record<string, unknown>;
  const fp = models(x.frontier_pool, DEFAULT_LEAGUE.frontier_pool);
  const wp = models(x.worker_pool, DEFAULT_LEAGUE.worker_pool);
  return {
    frontier_pool: fp.length ? fp : DEFAULT_LEAGUE.frontier_pool,
    worker_pool: wp.length ? wp : DEFAULT_LEAGUE.worker_pool,
    teams_per_tier: Math.floor(clampN(x.teams_per_tier, 1, 5, 3)),
    workers_per_team: Math.floor(clampN(x.workers_per_team, 2, 6, 4)),
    death_pct: clampN(x.death_pct, 1, 50, 5),
    risk_max_pct: clampN(x.risk_max_pct, 0.5, 10, 3),
    budget_usd_day: clampN(x.budget_usd_day, 0, 500, 25),
    research: x.research === "off" ? "off" : "light",
    session_times: Array.isArray(x.session_times) && x.session_times.every((t) => /^\d{2}:\d{2}$/.test(String(t))) && x.session_times.length ? (x.session_times as string[]).slice(0, 6) : DEFAULT_LEAGUE.session_times,
    season_days: Math.floor(clampN(x.season_days, 3, 90, 14)),
    min_takes_day: Math.floor(clampN(x.min_takes_day, 0, 20, 2)),
    min_heat_pct: clampN(x.min_heat_pct, 0, 50, 4),
    passive_penalty_pct: clampN(x.passive_penalty_pct, 0, 10, 1),
  };
}

export type TeamLike = { id?: string; frontier: string; workers: string[]; status: "live" | "dead"; return_pct: number; formed_at?: string; score?: number };

/** The set of members, order-free: the key that keeps every combination unique for all time. */
export function comboKey(frontier: string, workers: string[]): string {
  return `${frontier}|${[...workers].sort().join(",")}`;
}

const SHORT: Record<string, string> = {
  "anthropic/claude-opus-5": "Opus 5", "openai/gpt-6-astra": "Astra", "anthropic/claude-fable-5.1": "Fable", "google/gemini-3.1-pro-preview": "Gemini Pro",
  "moonshotai/kimi-k3": "Kimi K3", "x-ai/grok-4.6": "Grok", "anthropic/claude-sonnet-5": "Sonnet 5", "openai/gpt-5.6-terra": "Terra",
  "deepseek/deepseek-v4-pro-0813": "DeepSeek Pro", "qwen/qwen3.8-max-0902": "Qwen Max", "z-ai/glm-5.3": "GLM", "mistralai/mistral-medium-3-5": "Mistral",
};
export function shortModel(id: string): string {
  if (SHORT[id]) return SHORT[id];
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/^claude-/, "").replace(/-preview$/, "").replace(/-(0\d|1[0-2])[0-3]\d$/, "").split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
export function roman(n: number): string {
  const t: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "", v = Math.max(1, Math.floor(n));
  for (const [k, s] of t) while (v >= k) { out += s; v -= k; }
  return out;
}
/** "Astra II": the frontier's short name and how many teams it has led, this one included. */
export function teamName(frontier: string, ordinal: number): string {
  return `${shortModel(frontier)} ${roman(ordinal)}`;
}

/** Day one: frontiers dealt in pool order, workers spread so every team gets a similar mix and every worker sits about equally often; tiers interleaved so no tier gets all the strongest frontiers. */
export function draftTeams(s: LeagueSettings): { frontier: string; workers: string[]; combo: string; tier: Tier }[] {
  const n = s.teams_per_tier * 3, m = s.workers_per_team;
  const F = s.frontier_pool, W = s.worker_pool;
  const out: { frontier: string; workers: string[]; combo: string; tier: Tier }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const frontier = F[i % F.length];
    const workers: string[] = [];
    let bump = 0;
    for (let k = 0; k < m; k++) {
      let idx = (k * n + i + bump) % W.length;
      while (workers.includes(W[idx])) { bump++; idx = (k * n + i + bump) % W.length; }
      workers.push(W[idx]);
    }
    let combo = comboKey(frontier, workers);
    // a repeated set (small pools): rotate the last worker until the set is new
    for (let tries = 0; seen.has(combo) && tries < W.length; tries++) {
      const next = W[(W.indexOf(workers[m - 1]) + 1 + tries) % W.length];
      if (workers.includes(next)) continue;
      workers[m - 1] = next; combo = comboKey(frontier, workers);
    }
    seen.add(combo);
    out.push({ frontier, workers, combo, tier: TIERS[i % 3] });
  }
  return out;
}

/** A team's ranked return: the score (percent return less passive days) when it has one, the plain return until then. */
const scoreOf = (t: TeamLike): number => (typeof t.score === "number" && Number.isFinite(t.score) ? t.score : t.return_pct);

/** A model's standing in the pool: the mean ranked return of the teams it has been on, living or dead, a frontier's teams counting in full and a worker's at half. Null until it has been on a team. */
export function poolStanding(model: string, teams: TeamLike[]): number | null {
  let w = 0, sum = 0;
  for (const t of teams) {
    if (t.frontier === model) { w += 1; sum += scoreOf(t); }
    else if (t.workers.includes(model)) { w += 0.5; sum += 0.5 * scoreOf(t); }
  }
  return w > 0 ? sum / w : null;
}

/**
 * The replacement for a dead team. The frontier: in the pool, leading fewer than two live teams, best standing first (untested counts as zero),
 * then fewer live teams, then pool order. The workers: best standing, then fewest live seats, then pool order. The set must be new: no team,
 * living or dead, may ever have had the same members. Null only when the pools cannot make a new set.
 */
export function replacementTeam(s: LeagueSettings, teams: TeamLike[]): { frontier: string; workers: string[]; combo: string } | null {
  const live = teams.filter((t) => t.status === "live");
  const used = new Set(teams.map((t) => comboKey(t.frontier, t.workers)));
  const led = (m: string) => live.filter((t) => t.frontier === m).length;
  const seats = (m: string) => live.filter((t) => t.workers.includes(m)).length;
  const st = (m: string) => poolStanding(m, teams) ?? 0;
  const frontiers = s.frontier_pool.map((m, i) => ({ m, i, led: led(m), st: st(m) })).filter((f) => f.led < 2)
    .sort((a, b) => b.st - a.st || a.led - b.led || a.i - b.i);
  const workers = s.worker_pool.map((m, i) => ({ m, i, seats: seats(m), st: st(m) })).sort((a, b) => b.st - a.st || a.seats - b.seats || a.i - b.i).map((w) => w.m);
  const m = s.workers_per_team;
  if (workers.length < m) return null;
  for (const f of frontiers) {
    const base = workers.slice(0, m - 1);
    for (let j = m - 1; j < workers.length; j++) {
      const set = [...base, workers[j]];
      const combo = comboKey(f.m, set);
      if (!used.has(combo)) return { frontier: f.m, workers: set, combo };
    }
    // every last-seat swap is taken: rotate the whole tail
    for (let a = 0; a < workers.length; a++) for (let b = a + 1; b < workers.length; b++) {
      const set = [...new Set([workers[a], workers[b], ...workers.filter((_, i) => i !== a && i !== b)])].slice(0, m);
      const combo = comboKey(f.m, set);
      if (set.length === m && !used.has(combo)) return { frontier: f.m, workers: set, combo };
    }
  }
  return null;
}

/** Playing to survive: too few takes in the day AND too little of the book at risk. Survival alone ranks nothing. */
export function isPassive(takesDay: number, heatPct: number, s: LeagueSettings): boolean {
  return takesDay < s.min_takes_day && heatPct < s.min_heat_pct;
}
/** The ranked return: percent return less the penalty for every passive day. */
export function rankScore(returnPct: number, passiveDays: number, s: LeagueSettings): number {
  return returnPct - Math.max(0, passiveDays) * s.passive_penalty_pct;
}
/** Live teams ranked by their score (the ranked return; percent return when no score is set), older team first on a tie; the top third Diamond, the next Gold, the rest Bronze. */
export function rankTiers(teams: TeamLike[], perTier: number): { id: string; rank: number; tier: Tier }[] {
  const live = teams.filter((t) => t.status === "live" && t.id).sort((a, b) => scoreOf(b) - scoreOf(a) || String(a.formed_at ?? "").localeCompare(String(b.formed_at ?? "")));
  return live.map((t, i) => ({ id: String(t.id), rank: i + 1, tier: i < perTier ? "diamond" : i < 2 * perTier ? "gold" : "bronze" }));
}

export function deathLine(start: number, deathPct: number): number {
  return start * (1 - deathPct / 100);
}

/** The session whose window (its minute to four minutes after) holds this ET time, or null. The tick fires one minute past each five-minute mark. */
export function sessionDue(hour: number, minute: number, times: string[]): string | null {
  const now = hour * 60 + minute;
  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    const at = h * 60 + m;
    if (now >= at && now < at + 5) return t;
  }
  return null;
}
