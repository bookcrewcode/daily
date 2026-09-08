"use client";

// 📓 An open notebook. Leads with the chapter spine and one "Study this now"
// button; the studio tools (guide, cards, map, chat, podcast, exam) sit under
// "More" because they are things to reach for, not the daily path.
//
// A notebook with no chapters is in paste-first mode: Sources sits at the top,
// and the first saved source triggers chapters + the first run on its own —
// the cold start is one paste, not paste → tab → build → tab → run.

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { LADDER, LADDER_NOTEBOOK } from "@/lib/curriculum";
import { buildSession, studyDay, pickChapter, orderChapters, type SessionPlan, type LearnHome, type ChapterLite, type NotebookLite, type RunCard } from "@/lib/session";
import { ensureRun, buildChapters } from "@/lib/learnApi";
import { advisorCall } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card, ProgressCircle, Segmented } from "./ui";
import NotebookSources from "./NotebookSources";
import NotebookChat from "./NotebookChat";
import Session from "./Session";
import Podcast from "./Podcast";
import MajorTest from "./MajorTest";
import StudyGuide from "./StudyGuide";
import Cards from "./Cards";
import MindMap from "./MindMap";

type Tool = "sources" | "guide" | "cards" | "map" | "chat";
const TOOLS: { key: Tool; label: string; icon: string }[] = [
  { key: "sources", label: "Sources", icon: "📚" },
  { key: "guide", label: "Guide", icon: "📖" },
  { key: "cards", label: "Cards", icon: "🃏" },
  { key: "map", label: "Map", icon: "🕸️" },
  { key: "chat", label: "Chat", icon: "🎓" },
];

const weekday = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short" }) : "");

export default function NotebookView({ uid, notebook, home, runs, aiOff, onBack, onChanged }: {
  uid: string; notebook: NotebookLite; home: LearnHome; runs: Record<string, RunCard[]>; aiOff: boolean;
  onBack: () => void; onChanged: () => Promise<LearnHome | null>;
}) {
  const chapters = orderChapters(notebook, home.chapters);
  const sourceCount = home.source_counts[notebook.id] ?? 0;
  const pasteFirst = chapters.length === 0;

  const [more, setMore] = useState(false);
  const [tool, setTool] = useState<Tool>("sources");
  const [podcast, setPodcast] = useState(false);
  const [exam, setExam] = useState(false);
  const [session, setSession] = useState<SessionPlan | null>(null);
  const [progress, setProgress] = useState("");   // the ONE line for anything the AI is writing
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");           // a quiet result line ("3 videos found"), never orange
  const [confirm, setConfirm] = useState<"rebuild" | "ladder" | null>(null);
  // "is the check ready" compares against the moment the screen opened — a
  // stable clock keeps render pure and a few minutes of drift changes nothing
  const [nowMs] = useState(() => Date.now());
  const busy = useRef(false);

  const done = chapters.filter((c) => c.status === "done").length;
  const passed = chapters.filter((c) => c.status === "passed").length;
  const fill = chapters.length ? (done + passed * 0.5) / chapters.length : 0;
  const today = studyDay(new Date());
  const next = pickChapter(notebook, chapters, home.deadlines, today);

  // Wandering off to a tool instead of answering the confirm dismisses it.
  const pickTool = (t: Tool) => { setTool(t); setConfirm(null); };
  const toggleMore = () => { setMore((m) => !m); setConfirm(null); };

  // ── one chapter → a session ─────────────────────────────────────────
  async function study(ch: ChapterLite) {
    if (busy.current) return;
    if (aiOff && !runs[ch.id] && !ch.has_run) { setErr("AI is off — this chapter's cards haven't been written yet. Turn the key on from the Card tab."); return; }
    busy.current = true; setErr("");
    setProgress(ch.has_run || runs[ch.id] ? "opening…" : `Writing the cards for “${ch.title}”… about 30 seconds`);
    try {
      if (!runs[ch.id]) {
        const cards = await ensureRun(notebook, ch, { onNote: setNote });
        if (!cards?.length) { setErr(`Couldn't write the cards for “${ch.title}”. Tap it again to retry.`); return; }
        runs[ch.id] = cards;
      }
      const opts = { now: new Date(), scope: "chapter" as const, chapterId: ch.id, aiOff };
      let plan = buildSession(home, runs, opts);
      if (plan.state === "ai-off") { setErr("AI is off — this chapter's cards need rewriting, and that needs the key. Turn it on from the Card tab."); return; }
      if (plan.state === "preparing") {
        // the cached run failed the checks a round relies on — a fresh one is
        // the only way forward (re-reading the same run would fail the same way)
        setProgress(`Rewriting the cards for “${ch.title}”… about 30 seconds`);
        const cards = await ensureRun(notebook, ch, { force: true, onNote: setNote });
        if (!cards?.length) { setErr(`Couldn't rewrite the cards for “${ch.title}”. Tap it again to retry.`); return; }
        runs[ch.id] = cards;
        plan = buildSession(home, runs, opts);
      }
      if (!plan.items.length) { setErr(`Couldn't build a round for “${ch.title}” — try again.`); return; }
      setSession(plan);
    } finally { busy.current = false; setProgress(""); }
  }

  // ── chapters from sources ───────────────────────────────────────────
  // replace=false appends after the last chapter and skips titles that already
  // exist, so progress is untouched; replace=true resets chapters and scores
  // (review cards survive — chapter_id is set null, the card stays).
  async function build(replace: boolean) {
    if (busy.current) return;
    busy.current = true; setErr(""); setConfirm(null);
    setProgress(replace ? "Rebuilding chapters from your sources… about 20 seconds" : "Reading your new sources for chapters… about 20 seconds");
    try {
      const r = await buildChapters(uid, notebook, replace ? [] : chapters.map((c) => c.title), replace);
      if (r.error) { setErr(r.error); return; }
      if (r.added === 0) { setErr("Nothing new to add — every chapter in your sources is already here."); return; }
      sfx.coin();
      const h = await onChanged();
      if (!h) setErr(`${r.added} chapters saved, but the screen couldn't refresh — go back and reopen.`);
    } finally { busy.current = false; setProgress(""); }
  }

  // The cold start: first source saved → chapters → first run, one line the whole way.
  async function coldStart() {
    if (busy.current) return;
    busy.current = true; setErr("");
    setProgress("Reading your source… writing chapters… about 45 seconds");
    try {
      const r = await buildChapters(uid, notebook, [], false);
      if (r.error || r.added === 0) { setErr(r.error || "Couldn't build chapters from that — add a little more material and tap Build."); return; }
      const h = await onChanged();
      if (!h) { setErr("Chapters saved, but the screen couldn't refresh — go back and reopen."); return; }
      const first = orderChapters(notebook, h.chapters)[0];
      if (!first) return;
      setProgress(`${r.added} chapters ready · writing chapter 1: ${first.title}… about 30 seconds`);
      const cards = await ensureRun(notebook, first, { onNote: setNote });
      if (cards?.length) { runs[first.id] = cards; sfx.coin(); }
      else setErr("Chapters are in. The first round didn't finish writing — tap a chapter to try again.");
      await onChanged();
    } finally { busy.current = false; setProgress(""); }
  }

  // Ben's own precalculus-to-quantum syllabus with verified videos. Same atomic
  // RPC as before — never a half-written notebook; the outgoing chapters are
  // stashed as a source note first so the swap stays reversible.
  async function loadLadder() {
    if (busy.current) return;
    busy.current = true; setErr(""); setConfirm(null);
    setProgress(`Installing the ${LADDER.length}-chapter ladder…`);
    try {
      if (chapters.length > 0) {
        const dump = chapters.map((c) => ({ idx: c.idx, title: c.title, objective: c.objective, summary: c.summary }));
        const { error: bErr } = await supabase.from("notebook_sources").insert({
          user_id: uid, notebook_id: notebook.id, kind: "note",
          title: `Chapters before the ladder (${new Date().toISOString().slice(0, 10)})`,
          url: "", content: JSON.stringify(dump, null, 1).slice(0, 200000),
        });
        if (bErr) { setErr("Couldn't back up the current chapters, so nothing was replaced. Try again."); return; }
      }
      const { error } = await supabase.rpc("rebuild_notebook_chapters", {
        p_notebook_id: notebook.id,
        p_chapters: LADDER.map((c) => ({ title: c.title, objective: c.objective, summary: c.summary, videos: c.videos })),
      });
      if (error) { setErr("Couldn't install the ladder — try again (your chapters are untouched)."); return; }
      sfx.coin();
      await onChanged();
    } catch { setErr("Couldn't reach the server — try again."); }
    finally { busy.current = false; setProgress(""); }
  }

  // A fresh video search for the chapter that is up next, ignoring the ones on
  // the row (`existing: []`) — for when the clips on it made no sense. The
  // studio verifies each candidate against YouTube and caches transcripts;
  // clips reach the cards only when they are next written, and the copy says so.
  async function findVideos() {
    if (busy.current || !next) return;
    busy.current = true; setErr(""); setNote("");
    setProgress(`Finding videos for “${next.title}”… about a minute`);
    try {
      const json = await advisorCall<{ videos?: unknown[]; withTranscripts?: number }>({
        advisor: "videos", topicId: notebook.id, chapterId: next.id, chapterTitle: next.title, chapterObjective: next.objective, chapterSummary: next.summary, existing: [],
      });
      if (json.error) { setErr(json.error); return; }
      const n = Array.isArray(json.videos) ? json.videos.length : 0;
      if (!n) { setErr(`No video for “${next.title}” checked out on YouTube — its cards stay text-first for now.`); return; }
      sfx.coin();
      setNote(`${n} video${n === 1 ? "" : "s"} found for “${next.title}” · ${json.withTranscripts ?? 0} with transcripts. New clips land the next time its cards are written.`);
      await onChanged();
    } finally { busy.current = false; setProgress(""); }
  }

  if (session) {
    // onFinished fires before the done screen — the Session stays up until Done
    // is tapped (onClose), which is when the spine refreshes.
    return <Session uid={uid} plan={session} resume={null} home={home}
      onClose={() => { setSession(null); onChanged(); }}
      onFinished={() => { /* the Session shows its own done screen first */ }} />;
  }

  const isLadderNb = notebook.title === LADDER_NOTEBOOK;

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mb-2 active:scale-95">← Learn</button>

      <div className="flex items-start gap-3">
        <ProgressCircle pct={fill} size={52} stroke={4}><span className="text-2xl">{notebook.emoji || "📓"}</span></ProgressCircle>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold leading-tight">{notebook.title}</h1>
          <p className="text-[11px] opacity-55 mt-0.5">
            {notebook.course && <span className="uppercase tracking-wider font-semibold mr-2">{notebook.course}</span>}
            {notebook.kind === "class" ? "Class — chapters by week, jump anywhere" : "Personal — one chapter at a time"}
            {chapters.length > 0 && ` · ${done} of ${chapters.length} done${passed ? `, ${passed} passed` : ""}`}
          </p>
        </div>
      </div>

      {progress && <p className="text-[12px] text-[var(--neon)] mt-3">{progress}</p>}
      {err && !progress && <p className="text-xs text-orange-300 mt-3">{err}</p>}
      {note && !progress && !err && <p className="text-[12px] text-[var(--text-2)] mt-3">{note}</p>}

      {/* ── paste-first: nothing to study yet ─────────────────────── */}
      {pasteFirst ? (
        <div className="mt-4">
          <Card tone="paper">
            <p className="study-prose text-[1rem]">
              {sourceCount === 0
                ? <>Paste anything you&apos;re learning — notes, a PDF, a YouTube link. The first one you save gets turned into chapters and the first round, on its own.</>
                : <>Your {sourceCount === 1 ? "source is" : `${sourceCount} sources are`} in. One tap builds the chapters.</>}
            </p>
            {sourceCount > 0 && !progress && (
              <button onClick={() => build(false)} className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Build chapters (about 20s)</button>
            )}
            {isLadderNb && !progress && (
              <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
                <p className="text-[12px] text-[var(--text-3)] leading-relaxed mb-2">
                  Or install the written syllabus: {LADDER.length} chapters from precalculus to quantum mechanics, each with hand-picked videos.
                </p>
                <button onClick={loadLadder} className="rounded-xl bg-white/10 font-semibold px-4 py-2 text-sm active:scale-95">Load the ladder</button>
              </div>
            )}
          </Card>
          {/* the Today card said "paste something in" — so the paste box is already open */}
          <NotebookSources uid={uid} notebookId={notebook.id} onFirstSource={coldStart} startOpen={sourceCount === 0} />
        </div>
      ) : (
        <>
          {/* ── study now ──────────────────────────────────────────── */}
          {next && !progress && (
            <button onClick={() => study(next)} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black py-3 font-bold active:scale-95">
              <span className="block">Study this now</span>
              <span className="block text-[11px] font-semibold opacity-70 truncate px-4">
                {next.retention_check_at && new Date(next.retention_check_at).getTime() <= nowMs ? "check · " : ""}{next.title}
              </span>
            </button>
          )}
          {!next && <p className="mt-4 text-sm opacity-60">No chapter is up right now — each one is done ✓, waiting on its check, or resting after two tries. Add sources for more, or reach for a tool below.</p>}

          {/* ── the spine ──────────────────────────────────────────── */}
          <p className="text-[10px] uppercase tracking-widest opacity-40 mt-5 mb-2">Chapters · tap any to study it</p>
          <div className="relative pl-8 overflow-hidden">
            <div className="absolute left-3 top-3 bottom-3 w-[3px] spine-track rounded-full" />
            <div className="absolute left-3 top-3 w-[3px] spine-fill rounded-full transition-all duration-500" style={{ height: `calc(${Math.round(fill * 100)} * (100% - 1.5rem) / 100)` }} />
            <div className="space-y-2">
              {chapters.map((c, i) => {
                const weekLabel = notebook.kind === "class" && c.week != null && (i === 0 || chapters[i - 1].week !== c.week) ? `Week ${c.week}` : null;
                return (
                  <div key={c.id}>
                    {weekLabel && <p className="text-[10px] uppercase tracking-widest opacity-40 -ml-8 mb-1 mt-2">{weekLabel}</p>}
                    <ChapterRow c={c} n={i + 1} nowMs={nowMs} isNext={next?.id === c.id} onStudy={() => study(c)} onGuide={() => { setMore(true); pickTool("chat"); }} />
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── More: the studio tools ─────────────────────────────────── */}
      {!pasteFirst && (
        <div className="mt-5">
          <button onClick={toggleMore} className="w-full flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-3.5 py-2.5 active:scale-[0.99]">
            <span className="text-xs font-semibold">More — sources, guide, cards, map, chat, podcast, exam</span>
            <span className="text-xs opacity-50">{more ? "▲" : "▼"}</span>
          </button>
          {more && (
            <div className="mt-2 space-y-2">
              <Segmented value={tool} onChange={pickTool} options={TOOLS} />
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setPodcast(true)} className="rounded-xl bg-white/5 border border-white/10 py-2.5 active:scale-95 text-xs font-semibold">🎙️ Podcast</button>
                <button onClick={() => setExam(true)} className="rounded-xl bg-white/5 border border-white/10 py-2.5 active:scale-95 text-xs font-semibold">📝 Exam</button>
              </div>

              {tool === "sources" && <NotebookSources uid={uid} notebookId={notebook.id} />}
              {tool === "guide" && <StudyGuide uid={uid} notebookId={notebook.id} title={notebook.title} />}
              {tool === "cards" && <Cards uid={uid} notebookId={notebook.id} />}
              {tool === "map" && <MindMap uid={uid} notebookId={notebook.id} title={notebook.title} />}
              {tool === "chat" && <NotebookChat uid={uid} notebookId={notebook.id} chapterTitle={next?.title} interests={home.settings.interests} />}

              {/* chapter maintenance lives here, not next to the spine — it is rare */}
              <div className="pt-2 border-t border-[var(--border-1)] flex flex-wrap items-center gap-x-4 gap-y-1">
                <button onClick={() => build(false)} disabled={!!progress} className="text-[11px] text-[var(--neon)] underline disabled:opacity-40">Add chapters from new sources</button>
                {next && <button onClick={findVideos} disabled={!!progress} className="text-[11px] opacity-60 underline disabled:opacity-40">Find videos again for “{next.title}”</button>}
                {isLadderNb && <button onClick={() => setConfirm("ladder")} disabled={!!progress} className="text-[11px] opacity-60 underline disabled:opacity-40">Load the ladder</button>}
                <button onClick={() => setConfirm("rebuild")} disabled={!!progress} className="text-[11px] opacity-60 underline disabled:opacity-40">Rebuild from scratch</button>
              </div>
              {confirm && (
                <Card tone="warn" className="p-3">
                  <p className="text-sm font-semibold">Chapters and scores reset. Your review cards stay.</p>
                  {confirm === "ladder" && <p className="text-[11px] opacity-60 mt-0.5">The current chapters are saved into Sources first, so this is reversible.</p>}
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => setConfirm(null)} className="flex-1 rounded-lg bg-white/10 py-2 text-xs font-semibold active:scale-95">Keep them</button>
                    <button onClick={confirm === "ladder" ? loadLadder : () => build(true)} className="flex-1 rounded-lg bg-orange-500/30 py-2 text-xs font-bold active:scale-95">
                      {confirm === "ladder" ? `Install the ${LADDER.length}-chapter ladder` : "Rebuild"}
                    </button>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {podcast && <Podcast uid={uid} notebookId={notebook.id} onClose={() => setPodcast(false)} />}
      {exam && <MajorTest uid={uid} notebookId={notebook.id} onClose={() => setExam(false)} />}
    </div>
  );
}

// One chapter on the spine. Status copy is the same four lines everywhere
// (§5); "sticking" is a tap into the guide, not a dead label.
function ChapterRow({ c, n, nowMs, isNext, onStudy, onGuide }: { c: ChapterLite; n: number; nowMs: number; isNext: boolean; onStudy: () => void; onGuide: () => void }) {
  const isDone = c.status === "done";
  const checkDue = !!c.retention_check_at && new Date(c.retention_check_at).getTime() <= nowMs;
  const status =
    isDone ? "done ✓"
    : c.status === "passed" ? (checkDue ? "passed · check is ready" : `passed · check ${weekday(c.retention_check_at)}`)
    : c.status === "stuck" ? "sticking — ask the guide?"
    : c.attempts > 0 ? "in progress" : "first look";   // a cold chapter is a first look, not a task not started
  return (
    <div className="relative">
      <span className={`absolute -left-[1.55rem] top-3.5 w-6 h-6 rounded-full grid place-items-center text-xs font-bold z-10 border-2 border-[var(--background)] ${isDone ? "bg-[var(--neon)] text-black" : isNext ? "bg-white/25" : "bg-white/10"}`}>
        {isDone ? "✓" : n}
      </span>
      <Card tone="paper" padded={false} className={`p-3.5 ${isDone ? "opacity-75" : ""} ${isNext ? "ring-1 ring-[var(--neon)]/40" : ""}`}>
        <button onClick={onStudy} className="w-full text-left flex items-center gap-2 active:scale-[0.99]">
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm truncate">{c.title}</p>
            {c.objective && <p className="text-[11px] opacity-55 truncate">{c.objective}</p>}
          </div>
          {c.best_score > 0 && (
            <ProgressCircle pct={c.best_score / 100} size={34} stroke={3} color={c.best_score >= 80 ? "var(--neon)" : "rgba(255,255,255,0.45)"}>
              <span className="text-[9px] font-bold">{c.best_score}</span>
            </ProgressCircle>
          )}
        </button>
        <div className="flex items-center gap-2 mt-1.5">
          {c.status === "stuck"
            ? <button onClick={onGuide} className="text-[10px] text-[var(--neon)] underline">{status}</button>
            : <span className={`text-[10px] ${isDone || c.status === "passed" ? "text-[var(--neon)]" : "opacity-50"}`}>{status}</span>}
          {isNext && !isDone && <span className="text-[9px] uppercase tracking-wider opacity-40">· next</span>}
          {c.best_score > 0 && <span className="text-[10px] opacity-40 ml-auto">best {c.best_score}% · first-try answers</span>}
        </div>
      </Card>
    </div>
  );
}
