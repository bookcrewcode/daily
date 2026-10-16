// The reading plan — five books, one at a time, each with ONE drill that turns
// the reading into something used on real life. Pure logic only (no I/O) so the
// rules that matter (scoring, the buzzword test, what "today's drill is done"
// means) can't drift between screens.

export type Drill = "apply" | "feynman" | "predict" | "layers" | "swipe";
export type BookStatus = "queued" | "active" | "done" | "parallel";

export type Book = {
  id: string; ord: number; title: string; author: string;
  drill: Drill; status: BookStatus; started_on: string | null; finished_on: string | null;
};
export type Session = { id: string; book_id: string | null; day: string; minutes: number };
export type Entry = { id: string; book_id: string | null; kind: Drill; day: string; data: Record<string, unknown>; created_at: string };

export const SLOT_MINUTES = 40;
export const INFLUENCE_TARGET = 30;

export const DRILLS: Record<Drill, { name: string; rule: string; cadence: "daily" | "weekly" | "whenever" }> = {
  apply: {
    name: "The 24-hour application rule",
    rule: "One principle a day. Use it within 24 hours on something that was already happening (a professor, a group project, a negotiation, a text you were already sending). Never invent a situation to practice on. Log one line: what you tried, did it work.",
    cadence: "daily",
  },
  feynman: {
    name: "The Feynman explanation test",
    rule: "After every chapter: explain the mechanism in under 5 bullets, no jargon, simple enough for a 12-year-old. If you reach for a buzzword, you don't have it yet. Reread before moving on.",
    cadence: "daily",
  },
  predict: {
    name: "The prediction journal",
    rule: "Every prediction gets three lines: the exact outcome, your confidence as a percent, a deadline. Scored on the 1st of every month. The book is the manual; the journal is the training. It never stops.",
    cadence: "daily",
  },
  layers: {
    name: "The layer drill",
    rule: "Once a week: one real behavior you actually saw (someone snapping at you, a bad call you made, a stranger's reaction). Run it down every layer you've read so far, written out.",
    cadence: "weekly",
  },
  swipe: {
    name: "The swipe file",
    rule: "Every sentence that explains something huge in a clear, punchy way goes in the file, with what it was explaining. Reread the file before you write or say anything that matters.",
    cadence: "whenever",
  },
};

// Cialdini's seven, each with the plain meaning on screen (no lingo without it).
export const PRINCIPLES: { key: string; name: string; meaning: string }[] = [
  { key: "reciprocity", name: "Reciprocity", meaning: "people feel they owe you back when you give first" },
  { key: "commitment", name: "Commitment & consistency", meaning: "people stick with what they already said or did, especially in writing or in public" },
  { key: "social_proof", name: "Social proof", meaning: "people copy what others like them are doing" },
  { key: "liking", name: "Liking", meaning: "people say yes to people they like: similarity, compliments, working together" },
  { key: "authority", name: "Authority", meaning: "people defer to real expertise and its signals" },
  { key: "scarcity", name: "Scarcity", meaning: "things feel more valuable when they're rare or running out" },
  { key: "unity", name: "Unity", meaning: "people say yes to someone who is one of 'us'" },
];

// Sapolsky's widening time scales, in the order Behave walks them.
export const LAYERS: { key: string; name: string; meaning: string }[] = [
  { key: "second", name: "One second before", meaning: "what the brain was doing right then (fear, impulse, the brake)" },
  { key: "minutes", name: "Seconds to minutes before", meaning: "what they saw, heard, smelled that set it off" },
  { key: "hours", name: "Hours to days before", meaning: "hormones: stress, sleep, testosterone, hunger" },
  { key: "months", name: "Days to months before", meaning: "how recent experience rewired them" },
  { key: "adolescence", name: "Adolescence", meaning: "the still-unfinished brain of a teen or young adult" },
  { key: "childhood", name: "Childhood", meaning: "how they were raised and what they went through" },
  { key: "womb", name: "The womb", meaning: "conditions before birth" },
  { key: "genes", name: "Genes", meaning: "what they inherited, and how the environment switches it on" },
  { key: "culture", name: "Centuries back", meaning: "the culture and ecology they come from" },
  { key: "evolution", name: "Evolution", meaning: "why humans in general are built to do this" },
];

// Words that usually mean "I'm repeating the book, not explaining it."
// The test isn't the word itself, it's whether you could say it without it.
const BUZZWORDS = [
  "liquidity", "leverage", "leveraged", "derivative", "derivatives", "securitization", "securitize", "collateral",
  "arbitrage", "yield", "yields", "hedge", "hedging", "underwriting", "underwrite", "fiat", "monetary", "fiscal",
  "solvency", "insolvent", "default", "bond", "bonds", "equity", "equities", "credit", "debt instrument", "premium",
  "annuity", "inflation", "deflation", "central bank", "reserve", "fractional", "mortgage-backed", "subprime",
  "speculation", "speculative", "bubble", "volatility", "portfolio", "diversification", "risk premium", "interest rate",
];

export function findBuzzwords(text: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z\s-]/g, " ")} `;
  return BUZZWORDS.filter((w) => t.includes(` ${w} `));
}

// ── predictions ───────────────────────────────────────────────────────────
export type Prediction = { outcome: string; confidence: number; deadline: string; result?: boolean | null; scored_on?: string | null };

export function asPrediction(e: Entry): Prediction {
  const d = e.data as Partial<Prediction>;
  return {
    outcome: String(d.outcome ?? ""),
    confidence: Math.min(99, Math.max(1, Number(d.confidence ?? 50))),
    deadline: String(d.deadline ?? ""),
    result: typeof d.result === "boolean" ? d.result : null,
    scored_on: d.scored_on ? String(d.scored_on) : null,
  };
}

// Brier score: the average of (confidence − what happened)². 0 is perfect,
// 0.25 is what you'd get saying 50% on everything; lower is better.
export function brier(ps: Prediction[]): number | null {
  const done = ps.filter((p) => typeof p.result === "boolean");
  if (!done.length) return null;
  return done.reduce((s, p) => s + ((p.confidence / 100) - (p.result ? 1 : 0)) ** 2, 0) / done.length;
}

// Calibration: of the things you called at ~70%, did ~70% happen?
export function calibration(ps: Prediction[]): { band: string; said: number; hit: number; n: number }[] {
  const bands = [[50, 59], [60, 69], [70, 79], [80, 89], [90, 99]];
  return bands.map(([lo, hi]) => {
    // a 30% call on X is a 70% call on not-X — fold everything to ≥50
    const inBand = ps.filter((p) => typeof p.result === "boolean").map((p) => p.confidence >= 50
      ? { c: p.confidence, r: p.result as boolean }
      : { c: 100 - p.confidence, r: !(p.result as boolean) })
      .filter((x) => x.c >= lo && x.c <= hi);
    return {
      band: `${lo}–${hi}%`,
      said: inBand.length ? Math.round(inBand.reduce((s, x) => s + x.c, 0) / inBand.length) : 0,
      hit: inBand.length ? Math.round((inBand.filter((x) => x.r).length / inBand.length) * 100) : 0,
      n: inBand.length,
    };
  }).filter((b) => b.n > 0);
}

// past their deadline and not yet scored
export const toScore = (ps: { e: Entry; p: Prediction }[], today: string) =>
  ps.filter(({ p }) => p.result == null && p.deadline && p.deadline < today);

// ── influence tally ───────────────────────────────────────────────────────
export function influenceTally(entries: Entry[]) {
  const rows = PRINCIPLES.map((pr) => {
    const mine = entries.filter((e) => e.kind === "apply" && e.data.principle === pr.key);
    const worked = mine.filter((e) => e.data.worked === "yes").length;
    const partly = mine.filter((e) => e.data.worked === "partly").length;
    return { ...pr, n: mine.length, worked, partly };
  });
  return rows;
}

// ── today ─────────────────────────────────────────────────────────────────
// What "today's drill is done" means, per drill. Weekly drills count the
// Mon–Sun week; the swipe file never blocks a day.
export function drillDone(drill: Drill, entries: Entry[], today: string, weekStartDay: string): boolean {
  if (drill === "swipe") return entries.some((e) => e.kind === "swipe" && e.day === today);
  if (drill === "layers") return entries.some((e) => e.kind === "layers" && e.day >= weekStartDay && e.day <= today);
  if (drill === "predict") return entries.some((e) => e.kind === "predict" && (e.day === today || asPrediction(e).scored_on === today));
  return entries.some((e) => e.kind === drill && e.day === today);
}

// The plan says not at night and not in bed. The app doesn't lock you out
// (a logged session that really happened is still true); it just says so.
export const isLate = (h: number) => h >= 21 || h < 5;
