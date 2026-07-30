// Spaced repetition, powered by FSRS (Free Spaced Repetition Scheduler) via the
// open-source ts-fsrs library — the same algorithm Anki adopted. We don't invent
// scheduling; we adopt the proven one and persist its card state per row.

import { fsrs, generatorParameters, createEmptyCard, Rating, State, type Grade, type Card as FsrsCard } from "ts-fsrs";

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

// The FSRS state we persist on each notebook_cards row.
export type CardState = {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number; // 0 New, 1 Learning, 2 Review, 3 Relearning
  last_review: string | null;
};

export type NBCard = {
  id: string;
  notebook_id: string;
  chapter_id: string | null;
  front: string;
  back: string;
  hint: string;
  suspended: boolean;
} & CardState;

function fromRow(row: CardState): FsrsCard {
  return {
    due: new Date(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  } as FsrsCard;
}

function toState(c: FsrsCard, now: Date): CardState {
  return {
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: (c.last_review ?? now).toISOString(),
  };
}

// Fresh card state for a brand-new card. A new card was never reviewed, so
// last_review is null (not "now") — the first rating computes stability fresh.
export function emptyCardState(now = new Date()): CardState {
  return { ...toState(createEmptyCard(now), now), last_review: null };
}

// The four rating buttons, in order.
export const RATINGS: { key: string; label: string; rating: Grade; hue: string }[] = [
  // Anki-style semantic colors for a fast, repeated glance-action — kept OFF the
  // app's brand violet so "the accent" still means "the primary action".
  { key: "again", label: "Again", rating: Rating.Again, hue: "#f87171" },
  { key: "hard", label: "Hard", rating: Rating.Hard, hue: "#fbbf24" },
  { key: "good", label: "Good", rating: Rating.Good, hue: "#38bdf8" },
  { key: "easy", label: "Easy", rating: Rating.Easy, hue: "#34d399" },
];

// Apply a rating → the next persistable card state.
export function reviewCard(row: CardState, rating: Grade, now = new Date()): CardState {
  const rec = scheduler.next(fromRow(row), now, rating);
  return toState(rec.card, now);
}

// Short human label for the interval each button would produce ("10m", "1d", "3d").
export function intervalPreview(row: CardState, now = new Date()): Record<string, string> {
  const all = scheduler.repeat(fromRow(row), now);
  const out: Record<string, string> = {};
  for (const { key, rating } of RATINGS) {
    const next = all[rating]?.card?.due;
    out[key] = next ? humanize(next.getTime() - now.getTime()) : "";
  }
  return out;
}

function humanize(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

// Is this card due now?
export function isDue(row: { due: string; suspended?: boolean }, now = new Date()): boolean {
  return !row.suspended && new Date(row.due).getTime() <= now.getTime();
}
