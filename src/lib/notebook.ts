import { supabase, SUPABASE_URL, SUPABASE_ANON, ADVISOR_FN, LEARN_FN, STUDIO_FN } from "./supabase";
import type { RunCard } from "./session";

// ─── The notebook data model (mirrors the notebook_* tables) ───────────────
export type Notebook = {
  id: string;
  title: string;
  subject: string;
  why: string;
  emoji: string;
  trunk: string;
  archived: boolean;
  created_at: string;
  course: string;
  kind: "personal" | "class";
  course_key: string | null;
  last_studied_at: string | null;
};

export type NBKind = "note" | "youtube" | "link" | "pdf";
export type NBSource = {
  id: string; notebook_id: string; kind: string; title: string; url: string; content: string; created_at: string;
  week: number | null; page_count: number; meta: Record<string, unknown>;
};

// The interactive lesson cards (shapes in lib/session.ts — the renderer relies on them).
export type { RunCard };
export type RecallQ = { q: string; expected: string };

export type NBChapter = {
  id: string;
  notebook_id: string;
  idx: number;
  title: string;
  objective: string;
  summary: string;
  // Curated YouTube, shown BEFORE the questions. Replaces the clip generator,
  // which never produced a finished video. Ids verified at authoring time.
  videos: import("./curriculum").ChapterVideo[];
  run: RunCard[] | null;      // cached lesson cards; null until the learn function writes them
  run_at: string | null;
  week: number | null;
  due: string | null;
  misses: string[];           // ≤ 12 missed question stems, newest last
  retention_check_at: string | null;
  attempts: number;
  fade: number;               // worked problems: 0 asks the last step, 1 the last two, 2 every step
  quant: boolean;
  status: string;             // active | passed (check pending) | done (check held) | stuck (resting 3 days)
  best_score: number;
  created_at: string;
};

export type GradeResult = { score: number; correct: boolean; feedback: string; missed: string };
export type PodSegment = { speaker: "A" | "B"; text: string };

export type StudyGuide = {
  tldr: string;
  trunk: string;
  big_ideas: { title: string; point: string }[];
  key_terms: { term: string; definition: string }[];
  misconceptions: string[];
  so_what: string;
};
export type MindMap = { root: string; branches: { label: string; children: string[] }[] };

export const PDF_FN = `${SUPABASE_URL}/functions/v1/pdf`;
export const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

// Which edge function answers which mode. `learn` keeps the lesson loop small
// enough to redeploy safely; `studio` takes the heavier one-off generators;
// anything else is a legacy advisor persona.
export const MODE_FN: Record<string, string> = {
  syllabus: LEARN_FN, lesson: LEARN_FN, coach: LEARN_FN, tutor: LEARN_FN, grade: LEARN_FN,
  exam: STUDIO_FN, flashcards: STUDIO_FN, mindmap: STUDIO_FN, "study-guide": STUDIO_FN, podcast: STUDIO_FN, videos: STUDIO_FN,
};

// One call into an edge function. Returns the parsed JSON, which is either
// the payload or `{ error }` — callers check `.error`. Network failures (fetch
// rejects when offline) surface as a synthetic `{ error }` so a caller never
// has to wrap this in its own try/catch to stay safe.
export async function advisorCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const url = MODE_FN[String(body.advisor ?? "")] ?? ADVISOR_FN;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T & { error?: string };
  } catch {
    return { error: "Couldn't reach the server — check your connection and try again." } as T & { error?: string };
  }
}

// Progress = chapters done ÷ total. A notebook with no chapters yet is 0.
export function notebookProgress(chapters: { status: string }[]): { done: number; total: number; pct: number } {
  const total = chapters.length;
  const done = chapters.filter((c) => c.status === "done").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// The chapter that's next to work on: first not-done, else the last.
export function currentChapter<T extends { status: string }>(chapters: T[]): T | null {
  if (!chapters.length) return null;
  return chapters.find((c) => c.status !== "done") ?? chapters[chapters.length - 1];
}
