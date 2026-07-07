"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, type LearningTopic, type LearningRetrieval, type LearningWeakSpot } from "@/lib/supabase";
import { SectionTitle, Card, Pill } from "./ui";

export default function Learning({ uid, onOpenAdvisor }: { uid: string; onOpenAdvisor?: (advisor: string, topicId?: string) => void }) {
  const [topics, setTopics] = useState<LearningTopic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("learning_topics").select("*").eq("user_id", uid).eq("status", "active").order("created_at", { ascending: false });
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

  async function create() {
    if (!title.trim()) return;
    await supabase.from("learning_topics").insert({ user_id: uid, title: title.trim(), goal: goal.trim(), why: why.trim() });
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

  const load = useCallback(async () => {
    const [{ data: r }, { data: w }] = await Promise.all([
      supabase.from("learning_retrieval").select("*").eq("topic_id", topic.id).order("created_at", { ascending: false }).limit(20),
      supabase.from("learning_weak_spots").select("*").eq("topic_id", topic.id).eq("resolved", false),
    ]);
    setRetrieval((r ?? []) as LearningRetrieval[]);
    setWeakSpots((w ?? []) as LearningWeakSpot[]);
  }, [topic.id]);
  useEffect(() => { load(); }, [load]);

  async function saveTree() {
    await supabase.from("learning_topics").update({ trunk, branches: branches.filter((b) => b.trim()), leaves, updated_at: new Date().toISOString() }).eq("id", topic.id);
    setEditingTree(false);
    onUpdated();
  }

  async function addRetrieval(gotIt: boolean) {
    if (!q.trim()) return;
    await supabase.from("learning_retrieval").insert({ user_id: uid, topic_id: topic.id, question: q.trim(), got_it: gotIt });
    setQ("");
    load();
  }
  async function addWeakSpot() {
    if (!weakText.trim()) return;
    await supabase.from("learning_weak_spots").insert({ user_id: uid, topic_id: topic.id, text: weakText.trim() });
    setWeakText("");
    load();
  }
  async function resolveWeakSpot(id: string) {
    setWeakSpots((w) => w.filter((x) => x.id !== id));
    await supabase.from("learning_weak_spots").update({ resolved: true }).eq("id", id);
  }
  async function saveSession() {
    const filledChunks = chunks.filter((c) => c.trim()).map((c) => ({ note: c.trim() }));
    await supabase.from("learning_sessions").insert({
      user_id: uid, topic_id: topic.id, day: todayStr(), chunks: filledChunks, brain_dump: brainDump.trim(),
    });
    setChunks(["", "", "", ""]); setBrainDump("");
  }

  const recentScore = retrieval.length ? Math.round((retrieval.filter((r) => r.got_it).length / retrieval.length) * 100) : null;

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mt-3">← Topics</button>
      <h1 className="text-2xl font-bold mt-1">{topic.title}</h1>
      {topic.goal && <p className="text-sm opacity-60 mt-1">🎯 {topic.goal}</p>}

      <button onClick={() => onOpenAdvisor?.("tutor", topic.id)}
        className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">
        🎓 Ask the Tutor — 3C session
      </button>

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
      <button onClick={saveSession} className="mt-2 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Save session</button>

      <Card tone="default" className="mt-4 opacity-70">
        <p className="text-xs">😴 <b>Consolidate:</b> 10s look-away after dense bits · 20-min real break per ~90 min · sleep locks it in.</p>
      </Card>
    </div>
  );
}
