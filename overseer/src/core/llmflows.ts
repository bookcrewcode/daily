// The three places the Overseer asks a model for words: the morning plan
// (smart model), the evening wrap note (smart) and a two-minute first step
// (cheap). Each checks the day's cap first and records what it spent. A
// null answer means "use the template", never "say nothing".
import { overCap } from "./budget";
import type { Db } from "./db";
import { parseJson, type LlmPort } from "./llm";

export type Spend = { db: Db; llm: LlmPort; day: string; cap: number };

// A failed call is recorded too (purpose "<purpose>:error:<reason>"), so the
// Overseer page can say the AI couldn't be reached today.
export async function recordSpend(db: Db, day: string, model: string, purpose: string, r: { cost: number; tin: number; tout: number; error?: string | null }) {
  if (r.error) await db.addSpend({ day, model, purpose: `${purpose}:error:${r.error}`, cost_usd: r.cost, tokens_in: r.tin, tokens_out: r.tout });
  else if (r.cost > 0 || r.tin > 0) await db.addSpend({ day, model, purpose, cost_usd: r.cost, tokens_in: r.tin, tokens_out: r.tout });
}

const STYLE = "Plain words. No emojis. No hype. Never shame. Write in English.";

async function once(sp: Spend, model: string, purpose: string, system: string, user: string, maxTokens: number): Promise<string | null> {
  if (!model || overCap(await sp.db.spent(sp.day), sp.cap)) return null;
  const r = await sp.llm.chat(model, [{ role: "system", content: system }, { role: "user", content: user }], undefined, maxTokens);
  await recordSpend(sp.db, sp.day, model, purpose, r);
  return r.error ? null : r.text.trim() || null;
}

export async function morningPlan(
  sp: Spend, model: string, tasks: { n: number; what: string; time: string }[], top3: string[], calendar: string[],
): Promise<{ steps: { n: number; step: string }[]; stakes: number[]; note: string } | null> {
  if (!tasks.length) return null;
  const text = await once(sp, model, "morning", `You plan Ben's day. ${STYLE} Reply with JSON only.`, [
    "Tasks:", ...tasks.map((t) => `${t.n}. ${t.time ? `${t.time} ` : ""}${t.what}`),
    `Top 3 for today: ${top3.join("; ") || "none"}`,
    `Calendar: ${calendar.join("; ") || "none"}`,
    "For each task give the smallest concrete first step, at most 12 words. Pick up to 2 task numbers that matter most to put stakes on (prefer top-3 matches and deadlines). Add one short sentence about the day.",
    'JSON shape: {"steps":[{"n":1,"step":"..."}],"stakes":[1],"note":"..."}',
  ].join("\n"), 700);
  const j = text ? parseJson(text) : null;
  if (!j || !Array.isArray(j.steps)) return null;
  const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= tasks.length;
  return {
    steps: j.steps
      .filter((x: any) => valid(x?.n) && typeof x?.step === "string" && x.step.trim())
      .map((x: any) => ({ n: x.n as number, step: String(x.step).trim().slice(0, 120) })),
    stakes: (Array.isArray(j.stakes) ? j.stakes : []).filter(valid).slice(0, 2),
    note: typeof j.note === "string" ? j.note.trim().slice(0, 200) : "",
  };
}

export function wrapNote(sp: Spend, model: string, done: string[], open: string[], moved: string[]): Promise<string | null> {
  return once(sp, model, "wrap", `You close Ben's day. ${STYLE}`, [
    `Done: ${done.join("; ") || "nothing"}`,
    `Still open: ${open.join("; ") || "nothing"}`,
    `Moved: ${moved.join("; ") || "nothing"}`,
    "Write two or three short sentences: wins first, then what is still open. No day counts, no 'you failed'.",
  ].join("\n"), 250);
}

export async function shrinkStep(sp: Spend, model: string, what: string): Promise<string | null> {
  const t = await once(sp, model, "stuck", `You help Ben start. ${STYLE}`, `Give the smallest two-minute first step to start this task, at most 12 words, no preamble. Task: ${what}`, 80);
  if (!t) return null;
  return t.split("\n")[0].replace(/^["'\s-]+|["'\s]+$/g, "").slice(0, 120) || null;
}
