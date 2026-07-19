"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, ADVISOR_FN, SUPABASE_ANON, type LearningTopic, type LearningRetrieval, type LearningWeakSpot } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { SectionTitle, Card, Pill } from "./ui";
import Sources from "./Sources";
import NotebookBridge from "./NotebookBridge";

type ChatMsg = { role: string; content: string };

// 🎓 The Tutor, embedded — learn with the AI right here, inside the topic.
// Same thread as the full-screen Board tutor (chat_messages, advisor='tutor',
// per-topic), so Recap & save and the fullscreen view all see one conversation.
function TutorChat({ uid, topicId, onFullScreen }: { uid: string; topicId: string; onFullScreen?: () => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 60);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("chat_messages").select("role,content")
      .eq("user_id", uid).eq("advisor", "tutor").eq("topic_id", topicId)
      .order("created_at", { ascending: false }).limit(30);
    if (error) { setLoaded(true); return; } // keep any messages already shown; don't wipe on a transient read
    setMsgs(((data ?? []) as ChatMsg[]).reverse());
    setLoaded(true);
    scrollDown();
  }, [uid, topicId]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setNote("");
    // save FIRST — "sent" must mean saved; input stays put on failure
    const { error } = await supabase.from("chat_messages")
      .insert({ user_id: uid, advisor: "tutor", topic_id: topicId, role: "user", content: text });
    if (error) { setNote("Couldn't save that — check your connection and try again."); setBusy(false); return; }
    const history = msgs.slice(-14);
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }]);
    scrollDown();
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ advisor: "tutor", message: text, history, topicId, clientDay: todayStr() }),
      });
      const json = await res.json();
      const reply = json.text || json.error || "No response.";
      if (json.text) {
        await supabase.from("chat_messages")
          .insert({ user_id: uid, advisor: "tutor", topic_id: topicId, role: "assistant", content: json.text });
      }
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "Couldn't reach the Tutor — your message is saved. Try again." }]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  return (
    <Card tone="neon" className="mt-3" padded={false}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]">🎓 Tutor — learn it right here</p>
        {onFullScreen && (
          <button onClick={onFullScreen} title="Full screen + Recap & save"
            className="text-xs opacity-60 active:scale-90">⛶ full</button>
        )}
      </div>
      <div ref={scrollRef} className="max-h-[45vh] overflow-y-auto px-4 space-y-2">
        {loaded && msgs.length === 0 && (
          <p className="text-xs opacity-50 pb-1">Ask anything about this topic — the Tutor runs your 3C protocol: trunk first, retrieval always. It already knows your tree, weak spots, and accuracy.</p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm whitespace-pre-wrap rounded-xl px-3 py-2 ${m.role === "user" ? "bg-[var(--neon)]/15 ml-6" : "bg-black/30 mr-2"}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="skeleton h-10 mr-2" />}
      </div>
      <div className="flex gap-2 p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={busy ? "tutor is thinking…" : "ask, answer, or say “quiz me”"}
          className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <button onClick={send} disabled={busy}
          className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-40">↑</button>
      </div>
      {note && <p className="text-xs text-orange-400 px-4 pb-3 -mt-1">{note}</p>}
    </Card>
  );
}

export default function Learning({ uid, onOpenAdvisor }: { uid: string; onOpenAdvisor?: (advisor: string, topicId?: string) => void }) {
  const [topics, setTopics] = useState<LearningTopic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("learning_topics").select("*").eq("user_id", uid).eq("status", "active").order("created_at", { ascending: false });
    if (error) return; // keep the topics already on screen; don't wipe on a transient read
    setTopics((data ?? []) as LearningTopic[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const topic = topics.find((t) => t.id === selected);

  if (topic) {
    return <TopicView uid={uid} topic={topic} onBack={() => setSelected(null)} onOpenAdvisor={onOpenAdvisor} onUpdated={load} />;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🌳 Learning Hub</h1>
      <p className="opacity-50 text-sm mt-1">The 3C Protocol — Root → Compress → Compile → Consolidate. Trunk before leaves, retrieval over re-reading.</p>

      <Card tone="neon" className="mt-4">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)] mb-1">🌳 The method</p>
        <p className="text-sm"><b>Root</b> — trunk (one base truth) → branches (2–4 concepts) → leaves (facts last).</p>
        <p className="text-sm mt-1"><b>Compress</b> — the 20% that matters, ≤4 chunks, anchor to what you know.</p>
        <p className="text-sm mt-1"><b>Compile</b> — apply it, teach it back, free-recall quiz every few minutes.</p>
        <p className="text-sm mt-1"><b>Consolidate</b> — micro-rest, a real break each 90 min, sleep locks it in.</p>
      </Card>

      <SectionTitle>Your topics</SectionTitle>
      {topics.length === 0 && <p className="opacity-40 text-sm">No active topics — start one below.</p>}
      <div className="space-y-2">
        {topics.map((t) => (
          <button key={t.id} onClick={() => setSelected(t.id)} className="w-full text-left">
            <Card padded={false} className="p-3.5">
              <p className="font-bold">{t.title}</p>
              {t.trunk && <p className="text-xs opacity-50 mt-0.5">🌳 {t.trunk}</p>}
            </Card>
          </button>
        ))}
      </div>

      {!creating ? (
        <button onClick={() => setCreating(true)} className="mt-4 w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95">+ Start a new topic</button>
      ) : (
        <NewTopic uid={uid} onDone={() => { setCreating(false); load(); }} onCancel={() => setCreating(false)} />
      )}
    </div>
  );
}

function NewTopic({ uid, onDone, onCancel }: { uid: string; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [why, setWhy] = useState("");
  const [err, setErr] = useState(false);

  async function create() {
    if (!title.trim()) return;
    setErr(false);
    const { error } = await supabase.from("learning_topics").insert({ user_id: uid, title: title.trim(), goal: goal.trim(), why: why.trim() });
    if (error) { setErr(true); return; } // keep the form + typed title/goal/why
    onDone();
  }

  return (
    <Card className="mt-3">
      <p className="text-xs uppercase tracking-widest opacity-50 mb-2">New topic</p>
      <div className="space-y-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what do you want to learn?"
          className="w-full rounded-xl bg-black/30 px-4 py-3 outline-none" />
        <input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="what does mastery look like?"
          className="w-full rounded-xl bg-black/30 px-4 py-3 outline-none" />
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="why do you want it?"
          className="w-full rounded-xl bg-black/30 px-4 py-3 outline-none" />
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl bg-white/10 py-2.5 active:scale-95">Cancel</button>
          <button onClick={create} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Start (find the trunk first)</button>
        </div>
        {err && <p className="text-xs text-orange-400">Couldn&apos;t start the topic — your details are still here. Try again.</p>}
      </div>
    </Card>
  );
}

function TopicView({ uid, topic, onBack, onOpenAdvisor, onUpdated }: {
  uid: string; topic: LearningTopic; onBack: () => void; onOpenAdvisor?: (advisor: string, topicId?: string) => void; onUpdated: () => void;
}) {
  const [trunk, setTrunk] = useState(topic.trunk);
  const [branches, setBranches] = useState<string[]>(topic.branches.length ? topic.branches : ["", ""]);
  const [leaves, setLeaves] = useState(topic.leaves);
  const [editingTree, setEditingTree] = useState(!topic.trunk);
  const [retrieval, setRetrieval] = useState<LearningRetrieval[]>([]);
  const [weakSpots, setWeakSpots] = useState<LearningWeakSpot[]>([]);
  const [q, setQ] = useState("");
  const [weakText, setWeakText] = useState("");
  const [brainDump, setBrainDump] = useState("");
  const [chunks, setChunks] = useState<string[]>(["", "", "", ""]);
  const [sessions, setSessions] = useState<{ id: string; day: string; chunks: { note: string }[]; brain_dump: string }[]>([]);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [treeErr, setTreeErr] = useState(false);
  const [retrievalErr, setRetrievalErr] = useState(false);
  const [weakErr, setWeakErr] = useState(false);
  const [sessionErr, setSessionErr] = useState(false);
  const game = useGame();

  const load = useCallback(async () => {
    const [{ data: r, error: rErr }, { data: w, error: wErr }, { data: s, error: sErr }] = await Promise.all([
      supabase.from("learning_retrieval").select("*").eq("topic_id", topic.id).order("created_at", { ascending: false }).limit(20),
      supabase.from("learning_weak_spots").select("*").eq("topic_id", topic.id).eq("resolved", false),
      supabase.from("learning_sessions").select("id,day,chunks,brain_dump").eq("topic_id", topic.id).order("created_at", { ascending: false }).limit(20),
    ]);
    if (rErr || wErr || sErr) return; // keep prior state; a transient read must not blank the topic
    setRetrieval((r ?? []) as LearningRetrieval[]);
    setWeakSpots((w ?? []) as LearningWeakSpot[]);
    setSessions((s ?? []) as typeof sessions);
  }, [topic.id]);
  useEffect(() => { load(); }, [load]);

  async function saveTree() {
    setTreeErr(false);
    const { error } = await supabase.from("learning_topics").update({ trunk, branches: branches.filter((b) => b.trim()), leaves, updated_at: new Date().toISOString() }).eq("id", topic.id);
    if (error) { setTreeErr(true); return; } // keep the editor open — edits intact
    setEditingTree(false);
    onUpdated();
  }

  async function addRetrieval(gotIt: boolean) {
    if (!q.trim()) return;
    setRetrievalErr(false);
    const { error } = await supabase.from("learning_retrieval").insert({ user_id: uid, topic_id: topic.id, question: q.trim(), got_it: gotIt });
    if (error) { setRetrievalErr(true); return; } // keep the question in the box
    setQ("");
    load();
  }
  async function addWeakSpot() {
    if (!weakText.trim()) return;
    setWeakErr(false);
    const { error } = await supabase.from("learning_weak_spots").insert({ user_id: uid, topic_id: topic.id, text: weakText.trim() });
    if (error) { setWeakErr(true); return; } // keep the text in the box
    setWeakText("");
    load();
  }
  async function resolveWeakSpot(id: string) {
    setWeakSpots((w) => w.filter((x) => x.id !== id));
    await supabase.from("learning_weak_spots").update({ resolved: true }).eq("id", id);
  }
  async function saveSession() {
    const filledChunks = chunks.filter((c) => c.trim()).map((c) => ({ note: c.trim() }));
    if (filledChunks.length === 0 && !brainDump.trim()) return;
    setSessionErr(false);
    const { error } = await supabase.from("learning_sessions").insert({
      user_id: uid, topic_id: topic.id, day: todayStr(), chunks: filledChunks, brain_dump: brainDump.trim(),
    });
    if (error) { setSessionErr(true); return; } // keep chunks + brain dump — nothing lost
    setChunks(["", "", "", ""]); setBrainDump("");
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2500);
    load();
    game.refresh(); // saved sessions feed the Twenty Sessions achievement
  }

  const recentScore = retrieval.length ? Math.round((retrieval.filter((r) => r.got_it).length / retrieval.length) * 100) : null;

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mt-3">← Topics</button>
      <h1 className="text-2xl font-bold mt-1">{topic.title}</h1>
      {topic.goal && <p className="text-sm opacity-60 mt-1">🎯 {topic.goal}</p>}

      <TutorChat uid={uid} topicId={topic.id} onFullScreen={onOpenAdvisor ? () => onOpenAdvisor("tutor", topic.id) : undefined} />
      <p className="text-[10px] opacity-40 mt-1.5">Same conversation everywhere — ⛶ full screen adds 📝 Recap &amp; save, which turns the session into chunks, weak spots, and retrieval log below.</p>

      <Sources uid={uid} topicId={topic.id} />
      <NotebookBridge uid={uid} topic={topic} />

      <SectionTitle>🌳 The Tree (first principles)</SectionTitle>
      {!editingTree ? (
        <Card>
          <p className="text-sm"><b>Trunk:</b> {topic.trunk || <span className="opacity-40">not set</span>}</p>
          {topic.branches.length > 0 && (
            <ul className="text-sm mt-1 list-disc pl-5">
              {topic.branches.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
          {topic.leaves && <p className="text-sm mt-1 opacity-70"><b>Leaves:</b> {topic.leaves}</p>}
          <button onClick={() => setEditingTree(true)} className="text-xs text-[var(--neon)]/70 underline mt-2">edit</button>
        </Card>
      ) : (
        <Card>
          <p className="text-xs opacity-50 mb-1">Trunk — the one root truth this rests on</p>
          <input value={trunk} onChange={(e) => setTrunk(e.target.value)} className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none mb-2" />
          <p className="text-xs opacity-50 mb-1">Branches — 2–4 core concepts</p>
          {branches.map((b, i) => (
            <input key={i} value={b} onChange={(e) => setBranches((arr) => arr.map((x, idx) => idx === i ? e.target.value : x))}
              className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none mb-2" placeholder={`branch ${i + 1}`} />
          ))}
          {branches.length < 4 && <button onClick={() => setBranches((b) => [...b, ""])} className="text-xs text-[var(--neon)]/70 mb-2">+ branch</button>}
          <p className="text-xs opacity-50 mb-1 mt-1">Leaves — facts, only after branches are named</p>
          <textarea value={leaves} onChange={(e) => setLeaves(e.target.value)} rows={2} className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none mb-2" />
          <button onClick={saveTree} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Save tree</button>
          {treeErr && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t save the tree — check your connection and try again.</p>}
        </Card>
      )}

      <SectionTitle>🔁 Retrieval log — free recall, no peeking</SectionTitle>
      {recentScore != null && <p className="text-xs opacity-50 mb-2">Recent accuracy: {recentScore}% {recentScore >= 70 && recentScore <= 85 ? "(the sweet spot)" : recentScore > 85 ? "— ramp up difficulty" : "— ease off, revisit fundamentals"}</p>}
      <div className="flex gap-2 mb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="question the tutor asked, or self-quiz"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
      </div>
      <div className="flex gap-2 mb-3">
        <button onClick={() => addRetrieval(true)} className="flex-1 rounded-xl bg-[var(--neon)]/20 text-[var(--neon)] font-semibold py-2 active:scale-95">✓ Got it</button>
        <button onClick={() => addRetrieval(false)} className="flex-1 rounded-xl bg-white/10 font-semibold py-2 active:scale-95">✗ Missed it</button>
      </div>
      {retrievalErr && <p className="text-xs text-orange-400 mb-3 -mt-1">Couldn&apos;t log that — your question is still here. Try again.</p>}
      <div className="space-y-1.5">
        {retrieval.slice(0, 6).map((r) => (
          <p key={r.id} className="text-xs opacity-60">{r.got_it ? "✅" : "❌"} {r.question}</p>
        ))}
      </div>

      <SectionTitle>⚠️ Weak spots — loop back until they stick</SectionTitle>
      <div className="flex gap-2 mb-2">
        <input value={weakText} onChange={(e) => setWeakText(e.target.value)} placeholder="what keeps tripping you up?"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <button onClick={addWeakSpot} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
      </div>
      {weakErr && <p className="text-xs text-orange-400 mb-2 -mt-1">Couldn&apos;t add that — your text is still here. Try again.</p>}
      <div className="space-y-1.5">
        {weakSpots.map((w) => (
          <div key={w.id} className="flex items-center gap-2 text-sm">
            <button onClick={() => resolveWeakSpot(w.id)} className="w-5 h-5 shrink-0 rounded border border-white/30 active:scale-90" />
            <span className="flex-1">{w.text}</span>
          </div>
        ))}
        {weakSpots.length === 0 && <p className="opacity-30 text-xs">None open — nice.</p>}
      </div>

      <SectionTitle>🗜️ This session — chunks (≤4)</SectionTitle>
      <div className="space-y-2">
        {chunks.map((c, i) => (
          <input key={i} value={c} onChange={(e) => setChunks((arr) => arr.map((x, idx) => idx === i ? e.target.value : x))}
            placeholder={`chunk ${i + 1}`} className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        ))}
      </div>

      <SectionTitle>🧠 Brain dump — without scrolling, everything you remember</SectionTitle>
      <textarea value={brainDump} onChange={(e) => setBrainDump(e.target.value)} rows={3}
        className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none resize-none" />
      <button onClick={saveSession} className="mt-2 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">
        {savedFlash ? "✓ Saved — it's in the log below" : "Save session"}
      </button>
      {sessionErr && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t save the session — your chunks and brain dump are still here. Try again.</p>}

      {sessions.length > 0 && (
        <>
          <SectionTitle>📚 Past sessions · {sessions.length}</SectionTitle>
          <div className="space-y-2">
            {sessions.map((s) => {
              const open = openSession === s.id;
              const chunkNotes = (s.chunks ?? []).map((c) => c.note).filter(Boolean);
              return (
                <button key={s.id} onClick={() => setOpenSession(open ? null : s.id)} className="w-full text-left">
                  <Card padded={false} className="p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{new Date(s.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</p>
                      <span className="text-xs opacity-40">{chunkNotes.length} chunk{chunkNotes.length === 1 ? "" : "s"} {open ? "▾" : "▸"}</span>
                    </div>
                    {open && (
                      <div className="mt-2 space-y-1">
                        {chunkNotes.map((n, i) => <p key={i} className="text-sm opacity-80">• {n}</p>)}
                        {s.brain_dump && <p className="text-xs opacity-50 italic mt-1.5 whitespace-pre-wrap">{s.brain_dump}</p>}
                      </div>
                    )}
                  </Card>
                </button>
              );
            })}
          </div>
        </>
      )}

      <Card tone="default" className="mt-4 opacity-70">
        <p className="text-xs">😴 <b>Consolidate:</b> 10s look-away after dense bits · 20-min real break per ~90 min · sleep locks it in.</p>
      </Card>
    </div>
  );
}
