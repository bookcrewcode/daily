// Small helpers shared by tools.ts and caltools.ts (kept apart so neither
// file imports the other).
import type { ToolCtx, ToolOutcome } from "./dayops";
import type { ToolSpec } from "./llm";
import { addDays } from "./time";
import type { ActionRow, Pending } from "./types";

export type Handler = {
  spec: ToolSpec;
  run: (args: Record<string, unknown>, ctx: ToolCtx, ids: () => string) => Promise<ToolOutcome>;
  confirm?: (p: Pending, ctx: ToolCtx) => Promise<ToolOutcome>;
  undo?: (a: ActionRow, ctx: ToolCtx) => Promise<boolean>;
};

export const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const S = { type: "string" } as const;
export const dayArg = { type: "string", description: "today, tomorrow, or YYYY-MM-DD" };

export function dayOf(v: unknown, ctx: ToolCtx): string {
  const x = str(v);
  if (!x || x === "today") return ctx.plan.day;
  if (x === "tomorrow") return addDays(ctx.plan.day, 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : ctx.plan.day;
}
