"use client";

// The leagues — the small shared pieces. Tier colours and what each tier
// means in plain words, the colour money takes, day maths that reads the day
// it was handed rather than the clock, and the little labelled boxes the
// cards are built from. Nothing here loads anything.

import { fmtMoney, labTone, modelLabel } from "@/lib/desk/api";
import { etDate } from "@/lib/desk/clock";
import type { Tier } from "@/lib/desk/league";

export const TIER_COLOR: Record<Tier, string> = { diamond: "#7dd3fc", gold: "#fbbf24", bronze: "#d97706" };
export const TIER_LABEL: Record<Tier, string> = { diamond: "Diamond", gold: "Gold", bronze: "Bronze" };

/** The one line under each tier heading, sized to the settings so it never lies. */
export function tierMeaning(tier: Tier, perTier: number): string {
  const n = perTier === 1 ? "book" : `${perTier} books`;
  if (tier === "diamond") return `Diamond: the best ${n} by ranked return since each team was formed, re-sorted every day at 16:06 New York time.`;
  if (tier === "gold") return `Gold: the next ${n} down the same list.`;
  return "Bronze: everyone below them. A frontier whose team dies comes back here with a new life and a fresh book.";
}

export const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
export const signed = (v: number, d = 0) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), d);
/** A plain, unsigned percentage: 0.032 reads "3.2%". */
export const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

/** True when that timestamp fell on this New York day. Pure: it never asks for the time. */
export function onDay(iso: string | null | undefined, day: string): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && etDate(ms) === day;
}

/** "Sep 9", from either a date ("2026-09-09") or a full timestamp. */
export function dayLabel(v: string | null | undefined): string {
  if (!v) return "";
  const ms = Date.parse(v.length === 10 ? `${v}T12:00:00Z` : v);
  if (!Number.isFinite(ms)) return v;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Sep 9, 3:15pm", for a single moment. */
export function timeLabel(v: string | null | undefined): string {
  if (!v) return "";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return v;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whole days from that date to `today`. Both are read as dates, never as the clock. */
export function daysSince(v: string | null | undefined, today: string): number {
  if (!v) return 0;
  const from = Date.parse(`${v.slice(0, 10)}T12:00:00Z`);
  const to = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** The mono label every card uses over a small number. */
export function MonoLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`mono text-[9px] uppercase tracking-widest text-[var(--text-4)] ${className}`}>{children}</p>;
}

/** The plain-words line that explains the thing above it. */
export function Note({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-[10.5px] text-[var(--text-4)] leading-relaxed ${className}`}>{children}</p>;
}

/** A number with its name and, always, what it means. */
export function Mini({ label, value, note, color }: { label: string; value: string; note: string; color?: string }) {
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2">
      <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{label}</p>
      <p className="mono text-[15px] font-bold leading-tight mt-0.5" style={color ? { color } : undefined}>{value}</p>
      <p className="text-[9px] text-[var(--text-4)] mt-0.5 leading-snug">{note}</p>
    </div>
  );
}

/** One model, with its lab's colour and an optional role in mono. */
export function Member({ model, note }: { model: string; note?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--raised)] border border-[var(--border-1)] px-2 py-1">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: labTone(model) }} />
      <span className="text-[11px] font-semibold leading-none">{modelLabel(model)}</span>
      {note ? <span className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)] leading-none">{note}</span> : null}
    </span>
  );
}
