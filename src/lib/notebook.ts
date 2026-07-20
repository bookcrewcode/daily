import { supabase, SUPABASE_URL, SUPABASE_ANON, ADVISOR_FN } from "./supabase";

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
};

export type NBKind = "note" | "youtube" | "link" | "pdf";
export type NBSource = { id: string; notebook_id: string; kind: string; title: string; url: string; content: string; created_at: string };

export type ChapterCheck = { q: string; choices: string[]; answer: number; explain: string };
export type ChapterChunk = { teach: string; check: ChapterCheck | null };
export type RecallQ = { q: string; expected: string };
export type ChapterPack = { chunks: ChapterChunk[]; recall: RecallQ[] };

export type NBChapter = {
  id: string;
  notebook_id: string;
  idx: number;
  title: string;
  objective: string;
  summary: string;
  pack: ChapterPack | null;
  status: string;      // active | done
  best_score: number;
  created_at: string;
};

export type GradeResult = { score: number; correct: boolean; feedback: string; missed: string };
export type PodSegment = { speaker: "A" | "B"; text: string };

export const PDF_FN = `${SUPABASE_URL}/functions/v1/pdf`;
export const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

// One call into the advisor edge function. Returns the parsed JSON, which is
// either the payload or `{ error }` — callers check `.error`. Network failures
// (fetch rejects when offline) surface as a synthetic `{ error }` so a caller
// never has to wrap this in its own try/catch to stay safe.
export async function advisorCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const res = await fetch(ADVISOR_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T & { error?: string };
  } catch {
    return { error: "Couldn't reach the server — check your connection and try again." } as T & { error?: string };
  }
}

// Progress = chapters cleared ÷ total. A notebook with no chapters yet is 0.
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
