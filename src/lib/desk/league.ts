// The Desk — the leagues. Pure: the settings, the draft, tiers, names, the
// death line, the reward ladder for big days, the trading hours. Copied into the desk-league edge function, so
// nothing here may import from outside src/lib/desk.

export type Tier = "diamond" | "gold" | "bronze";
export const TIERS: Tier[] = ["diamond", "gold", "bronze"];

/** ET, HH:MM; the start is inside the window, the end is outside. A window may cross midnight. */
export type Hours = { stocks: [string, string]; crypto: [string, string] };

export type LeagueSettings = {
  frontier_pool: string[];   // the league itself: one team per frontier, the strong models that decide
  worker_pool: string[];     // the crew: cheap, fast models that research every candidate once, for every team
  teams_per_tier: number;    // 3 → nine teams
  death_pct: number;         // a team dies when its book is this far below its start (less any cushion it earned)
  risk_max_pct: number;      // the most a frontier may risk on one trade
  budget_usd_day: number;    // OpenRouter credit for every team's model calls, per day
  research: "off" | "light"; // light = a worker may look something up before it votes
  worker_lookups: number;    // how many look-ups a worker gets per ballot: quality over quantity
  hours: Hours;              // when the teams take new decisions and hold sessions; positions are managed round the clock
  session_times: string[];   // ET, HH:MM; the crew proposes and every frontier reviews its positions
  season_days: number;       // the champion is crowned at the daily ranking on the last day
  min_takes_day: number;     // playing to survive: fewer takes than this in a day, and ...
  min_heat_pct: number;      // ... less than this share of the book at risk in open positions
  passive_penalty_pct: number; // each passive day docks this from the team's ranked return
};

export const DEFAULT_LEAGUE: LeagueSettings = {
  frontier_pool: ["anthropic/claude-opus-5", "openai/gpt-6-astra", "anthropic/claude-fable-5.1", "google/gemini-3.1-pro-preview", "moonshotai/kimi-k3", "x-ai/grok-4.6", "anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "x-ai/grok-4.3"],
  worker_pool: ["google/gemini-3.5-flash-lite", "openai/gpt-5.6-luna", "minimax/minimax-m3", "google/gemini-3.8-flash"],
  teams_per_tier: 3, death_pct: 25, risk_max_pct: 3, budget_usd_day: 3, research: "light", worker_lookups: 1,
  hours: { stocks: ["09:00", "17:00"], crypto: ["09:00", "22:00"] },
  session_times: ["09:35", "15:15", "21:30"], season_days: 14,
  min_takes_day: 2, min_heat_pct: 4, passive_penalty_pct: 1,
};

const MODEL_ID = /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clampN = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const models = (v: unknown, d: string[]) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter((x) => MODEL_ID.test(x)))] : d);
const pair = (v: unknown, d: [string, string]): [string, string] => (Array.isArray(v) && v.length === 2 && v.every((t) => HHMM.test(String(t))) ? [String(v[0]), String(v[1])] : d);

/** The stored settings merged over the defaults, every field inside its range. */
export function leagueSettings(p?: Partial<LeagueSettings> | null): LeagueSettings {
  const x = (p ?? {}) as Record<string, unknown>;
  const fp = models(x.frontier_pool, DEFAULT_LEAGUE.frontier_pool);
  const wp = models(x.worker_pool, DEFAULT_LEAGUE.worker_pool);
  const h = (x.hours ?? {}) as Record<string, unknown>;
  return {
    frontier_pool: fp.length ? fp : DEFAULT_LEAGUE.frontier_pool,
    worker_pool: wp.length ? wp.slice(0, 6) : DEFAULT_LEAGUE.worker_pool,
    teams_per_tier: Math.floor(clampN(x.teams_per_tier, 1, 5, 3)),
    death_pct: clampN(x.death_pct, 1, 50, 25),
    risk_max_pct: clampN(x.risk_max_pct, 0.5, 10, 3),
    budget_usd_day: clampN(x.budget_usd_day, 0, 500, 3),
    research: x.research === "off" ? "off" : "light",
    worker_lookups: Math.floor(clampN(x.worker_lookups, 0, 2, 1)),
    hours: { stocks: pair(h.stocks, DEFAULT_LEAGUE.hours.stocks), crypto: pair(h.crypto, DEFAULT_LEAGUE.hours.crypto) },
    session_times: Array.isArray(x.session_times) && x.session_times.every((t) => HHMM.test(String(t))) && x.session_times.length ? (x.session_times as string[]).slice(0, 6) : DEFAULT_LEAGUE.session_times,
    season_days: Math.floor(clampN(x.season_days, 3, 90, 14)),
    min_takes_day: Math.floor(clampN(x.min_takes_day, 0, 20, 2)),
    min_heat_pct: clampN(x.min_heat_pct, 0, 50, 4),
    passive_penalty_pct: clampN(x.passive_penalty_pct, 0, 10, 1),
  };
}

export type TeamLike = { id?: string; frontier: string; workers: string[]; status: "live" | "dead"; return_pct: number; formed_at?: string; score?: number; floor?: Tier };

/** The key stored as the team's combo: the frontier and which of its lives this is, unique for all time. */
export function teamKey(frontier: string, ordinal: number): string {
  return `${frontier}#${Math.max(1, Math.floor(ordinal))}`;
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
/** "Astra II": the frontier's short name and which of its lives this is. */
export function teamName(frontier: string, ordinal: number): string {
  return `${shortModel(frontier)} ${roman(ordinal)}`;
}

/** Day one: one team per frontier in pool order (a frontier gets a second team only when the pool is smaller than the league), every team on the same crew, tiers interleaved so no tier gets all the strongest frontiers. */
export function draftTeams(s: LeagueSettings): { frontier: string; ordinal: number; workers: string[]; key: string; tier: Tier }[] {
  const n = s.teams_per_tier * 3;
  const F = s.frontier_pool;
  const led: Record<string, number> = {};
  const out: { frontier: string; ordinal: number; workers: string[]; key: string; tier: Tier }[] = [];
  for (let i = 0; i < n; i++) {
    const frontier = F[i % F.length];
    const ordinal = (led[frontier] ?? 0) + 1;
    led[frontier] = ordinal;
    out.push({ frontier, ordinal, workers: [...s.worker_pool], key: teamKey(frontier, ordinal), tier: TIERS[i % 3] });
  }
  return out;
}

/** A team's ranked return: the score (percent return less passive days) when it has one, the plain return until then. */
const scoreOf = (t: TeamLike): number => (typeof t.score === "number" && Number.isFinite(t.score) ? t.score : t.return_pct);

/** A frontier's standing: the mean ranked return of every team it has led, living or dead. Null until it has led one. The crew is shared, so workers have no standing of their own. */
export function poolStanding(model: string, teams: TeamLike[]): number | null {
  const mine = teams.filter((t) => t.frontier === model);
  return mine.length ? mine.reduce((a, t) => a + scoreOf(t), 0) / mine.length : null;
}

/** Playing to survive: too few takes in the day AND too little of the book at risk. Survival alone ranks nothing. */
export function isPassive(takesDay: number, heatPct: number, s: LeagueSettings): boolean {
  return takesDay < s.min_takes_day && heatPct < s.min_heat_pct;
}
/** The ranked return: percent return less the penalty for every passive day. */
export function rankScore(returnPct: number, passiveDays: number, s: LeagueSettings): number {
  return returnPct - Math.max(0, passiveDays) * s.passive_penalty_pct;
}
/** Live teams ranked by their score (the ranked return; percent return when no score is set), older team first on a tie; the top third Diamond, the next Gold, the rest Bronze. A team with a floor (a shield) is never put below it: it keeps that tier and the tier holds one more team that day. */
export function rankTiers(teams: TeamLike[], perTier: number): { id: string; rank: number; tier: Tier; shielded: boolean }[] {
  const live = teams.filter((t) => t.status === "live" && t.id).sort((a, b) => scoreOf(b) - scoreOf(a) || String(a.formed_at ?? "").localeCompare(String(b.formed_at ?? "")));
  const order: Record<Tier, number> = { diamond: 0, gold: 1, bronze: 2 };
  return live.map((t, i) => {
    const byScore: Tier = i < perTier ? "diamond" : i < 2 * perTier ? "gold" : "bronze";
    const shielded = !!t.floor && order[t.floor] < order[byScore];
    return { id: String(t.id), rank: i + 1, tier: shielded ? t.floor! : byScore, shielded };
  });
}

/** Where a team dies: the death percentage below its start, pushed further down by any cushion it earned. */
export function deathLine(start: number, deathPct: number, cushion = 0): number {
  return start * (1 - deathPct / 100) - Math.max(0, cushion);
}

/* ── the reward ladder: big days pay ─────────────────────────────────────── */
/** A reward for a big day, measured at the daily ranking as the change in the book since the last ranking. Cumulative: a day that clears a step earns every step below it too. */
export type RewardStep = { at: number; key: "vest" | "cushion" | "guns" | "shield"; name: string; what: string };
export const REWARD_LADDER: RewardStep[] = [
  { at: 5000, key: "vest", name: "a life vest", what: "when the book hits the death line the vest is spent instead of the team: the book is refilled to its start, the team keeps its name, its tier and its record, and no death is recorded; a team can hold three" },
  { at: 10000, key: "cushion", name: "a cushion", what: "the death line drops $10,000 for the rest of the team's life, to $50,000 below the start at most" },
  { at: 20000, key: "guns", name: "bigger guns", what: "the most the frontier may risk on one trade rises by one point of the book, three points at most" },
  { at: 30000, key: "shield", name: "a shield and a second vest", what: "the team cannot be relegated at the next ranking, and it holds one more life vest" },
];
export const MAX_VESTS = 3, MAX_CUSHION = 50000, MAX_RISK_BONUS = 3;
/** The steps a day's change in the book clears, lowest first. */
export function rewardsFor(dayPnl: number): RewardStep[] {
  return REWARD_LADDER.filter((r) => dayPnl >= r.at);
}
/** What a team holds from the ladder, kept in its stats: vests and revivals, the cushion in dollars, the risk bonus in points, the shield, and the refill (the dollars its vests put back into the book). */
export type Rewards = { vests: number; cushion: number; risk_bonus: number; shield: number; refill: number; revivals: number };
export function rewardsOf(stats: Record<string, unknown> | null | undefined): Rewards {
  const x = stats ?? {};
  const n = (v: unknown) => { const k = Number(v); return Number.isFinite(k) ? Math.max(0, k) : 0; };
  return { vests: Math.floor(n(x.vests)), cushion: n(x.cushion), risk_bonus: Math.floor(n(x.risk_bonus)), shield: n(x.shield) > 0 ? 1 : 0, refill: n(x.refill), revivals: Math.floor(n(x.revivals)) };
}
/** The most this team's frontier may risk on one trade: the setting plus its bigger-guns points, never above 10% of the book. */
export function riskCap(s: LeagueSettings, r: Rewards): number {
  return Math.min(10, s.risk_max_pct + r.risk_bonus);
}
/** Pay a day's rewards into what the team holds. */
export function grantRewards(r: Rewards, dayPnl: number): { next: Rewards; earned: RewardStep[] } {
  const earned = rewardsFor(dayPnl);
  const next = { ...r };
  for (const e of earned) {
    if (e.key === "vest") next.vests = Math.min(MAX_VESTS, next.vests + 1);
    if (e.key === "cushion") next.cushion = Math.min(MAX_CUSHION, next.cushion + 10000);
    if (e.key === "guns") next.risk_bonus = Math.min(MAX_RISK_BONUS, next.risk_bonus + 1);
    if (e.key === "shield") { next.shield = 1; next.vests = Math.min(MAX_VESTS, next.vests + 1); }
  }
  return { next, earned };
}
/** The team's holdings in words, for the frontier's brief and the app; empty when it holds nothing. */
export function rewardsText(r: Rewards): string {
  return [
    r.vests ? `${r.vests} life vest${r.vests === 1 ? "" : "s"}` : "",
    r.cushion ? `a $${r.cushion.toLocaleString("en-US")} cushion under the death line` : "",
    r.risk_bonus ? `bigger guns (+${r.risk_bonus} point${r.risk_bonus === 1 ? "" : "s"} of risk per trade)` : "",
    r.shield ? "a shield against relegation at the next ranking" : "",
  ].filter(Boolean).join(", ");
}

const minutesOf = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** Whether a venue is inside its trading window at this ET time: stocks by the stock hours, perps (BloFin) by the crypto hours. */
export function inHours(venue: string, hour: number, minute: number, s: LeagueSettings): boolean {
  const [a, b] = venue === "blofin" ? s.hours.crypto : s.hours.stocks;
  const now = hour * 60 + minute, from = minutesOf(a), to = minutesOf(b);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** The session whose window (its minute to four minutes after) holds this ET time, or null. The tick fires one minute past each five-minute mark. */
export function sessionDue(hour: number, minute: number, times: string[]): string | null {
  const now = hour * 60 + minute;
  for (const t of times) {
    const at = minutesOf(t);
    if (now >= at && now < at + 5) return t;
  }
  return null;
}
