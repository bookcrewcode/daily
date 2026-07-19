"use client";

// 🧪 NotebookLM bridge.
//
// Straight answer on why this isn't an embed: notebooklm.google.com responds
// with `X-Frame-Options: DENY` (verified), so it cannot be iframed by anything,
// and Google ships no public API for creating notebooks or uploading sources.
// Nobody can "install" it into another app — not this app, not any app.
//
// So this does the next best thing, and does it in one tap: it packages
// EVERYTHING valuable about a topic — the 3C protocol rules, the tree, weak
// spots, retrieval history, session notes, and the full text of every source —
// into a single Markdown file formatted as a NotebookLM source, downloads it,
// and opens NotebookLM. Upload once and the notebook knows his whole system.
// The notebook URL is then saved so the app deep-links straight back to it.

import { useCallback, useEffect, useState } from "react";
import { supabase, type LearningTopic } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";
import type { Source } from "./Sources";

// The rules the tutor runs on — exported so the notebook coaches the same way.
const PROTOCOL = `## The 3C Protocol (how I want to be taught)

**ROOT — first principles before detail**
- Find the TRUNK before the leaves: "what's the most basic truth this rests on?"
- Map 2–4 BRANCHES (the major concepts growing from the trunk).
- Hang LEAVES (facts, numbers) last — only once I can say which branch they attach to.
- If I skip to details, stop me and go back to the trunk.

**COMPRESS — my working memory holds ~4 things**
- 80/20: teach the 20% that carries 80% of the value.
- Anchor every new idea to something I already know.
- Max 3–5 named chunks per explanation.

**COMPILE — consumption → mastery**
- ~90-minute blocks; tell me where I am if it's longer.
- Learn → test → learn: 2–3 questions before moving on.
- Give me a real scenario to apply it, not just a definition.
- Make me explain it back in my own words (Feynman), then correct me gently.

**CONSTANT RETRIEVAL (non-negotiable)**
- Free-recall questions every 2–3 minutes of new content — never multiple choice.
- Spaced callbacks to earlier concepts; interleave across chunks.
- Target 70–85% correct. 100% → make it harder. Under 60% → ease off.
- Brain dumps: "without scrolling, list everything you remember about X."
- Track what I miss and loop it back until it sticks.

**CONSOLIDATE**
- Micro-rest after dense sections; a real break every ~90 minutes; sleep locks it in.

**MINDSETS**
- Don't rescue me when I struggle — hints, not answers (the generation effect).
- Benchmark me against MY past answers, never "most people."
- Never info-dump. If I ask for one, route me back through this protocol.`;

export default function NotebookBridge({ uid, topic, sources }: {
  uid: string; topic: LearningTopic; sources: Source[];
}) {
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("user_settings").select("notebooklm_url").eq("user_id", uid).maybeSingle();
    if (error) return; // keep whatever's on screen
    setUrl(data?.notebooklm_url ?? "");
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function saveUrl() {
    const u = draft.trim();
    if (u && !/^https:\/\/notebooklm\.google\.com\//i.test(u)) {
      setErr("That should be a https://notebooklm.google.com/... link.");
      return;
    }
    setBusy(true); setErr("");
    const { error } = await supabase.from("user_settings").upsert({ user_id: uid, notebooklm_url: u }, { onConflict: "user_id" });
    setBusy(false);
    if (error) { setErr("Couldn't save the link — try again."); return; }
    setUrl(u); setEditing(false); sfx.pop();
  }

  // Build the whole topic as ONE NotebookLM-ready source document.
  async function buildAndDownload() {
    if (busy) return;
    setBusy(true); setErr(""); setNote("");
    // pull the study record fresh so the export is never stale
    const [{ data: weak, error: wErr }, { data: retr, error: rErr }, { data: sess, error: sErr }] = await Promise.all([
      supabase.from("learning_weak_spots").select("text,resolved").eq("topic_id", topic.id),
      supabase.from("learning_retrieval").select("question,got_it,created_at").eq("topic_id", topic.id).order("created_at", { ascending: false }).limit(200),
      supabase.from("learning_sessions").select("day,chunks,brain_dump").eq("topic_id", topic.id).order("created_at", { ascending: false }).limit(100),
    ]);
    setBusy(false);
    if (wErr || rErr || sErr) { setErr("Couldn't read the full study record — try again."); return; }

    const open = (weak ?? []).filter((w) => !w.resolved).map((w) => `- ${w.text}`).join("\n") || "- (none open)";
    const rl = retr ?? [];
    const acc = rl.length ? Math.round((rl.filter((r) => r.got_it).length / rl.length) * 100) : null;
    const rlLines = rl.map((r) => `- ${r.got_it ? "✅" : "❌"} ${r.question}`).join("\n") || "- (none yet)";
    const sessLines = (sess ?? []).map((s) => {
      const chunks = ((s.chunks as { note: string }[]) ?? []).map((c) => `  - ${c.note}`).join("\n");
      return `### ${s.day}\n${chunks || "  - (no chunks)"}${s.brain_dump ? `\n  Brain dump: ${s.brain_dump}` : ""}`;
    }).join("\n\n") || "(no sessions logged yet)";

    const srcLines = sources.length
      ? sources.map((s, i) => `### Source ${i + 1}: ${s.title}${s.url ? ` (${s.url})` : ""}\n\n${s.content || "(link only — no text captured)"}`).join("\n\n---\n\n")
      : "(no sources added yet)";

    const doc = `# ${topic.title} — my complete learning file

> Generated by my Daily app. Treat this whole file as context: the protocol below
> is HOW I want to be taught, and everything after it is what I already know,
> what I keep getting wrong, and the source material itself.

${PROTOCOL}

---

## What I'm trying to learn
- **Topic:** ${topic.title}
- **What mastery looks like:** ${topic.goal || "(not set)"}
- **Why I want it:** ${topic.why || "(not set)"}

## My current tree
- **Trunk (the one root truth):** ${topic.trunk || "NOT FOUND YET — start here"}
- **Branches:** ${(topic.branches ?? []).filter(Boolean).join(" · ") || "(not named yet)"}
- **Leaves:** ${topic.leaves || "(none hung yet)"}

## Weak spots I keep missing (loop these back in)
${open}

## My retrieval history${acc != null ? ` — ${acc}% accuracy (target 70–85%)` : ""}
${rlLines}

## My past sessions
${sessLines}

---

# SOURCE MATERIAL

${srcLines}
`;

    const blob = new Blob([doc], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${topic.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}-learning-file.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    sfx.coin();
    setNote("Downloaded. Upload it as a source in NotebookLM — the notebook then knows your protocol, your tree, your weak spots, and your material.");
  }

  return (
    <Card className="mt-3">
      <p className="text-xs uppercase tracking-widest opacity-60 mb-1">🧪 NotebookLM</p>
      <p className="text-[10px] opacity-40 mb-2">
        NotebookLM can&apos;t be embedded (Google blocks framing and offers no API), so this packages
        everything — protocol, tree, weak spots, retrieval history, sessions and every source — into
        one file to upload, then keeps a one-tap link back to your notebook.
      </p>

      <button onClick={buildAndDownload} disabled={busy}
        className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 text-sm active:scale-95 disabled:opacity-50">
        {busy ? "building…" : "⬇︎ Build my learning file"}
      </button>

      <div className="flex gap-2 mt-2">
        <a href="https://notebooklm.google.com/" target="_blank" rel="noreferrer"
          className="flex-1 rounded-xl bg-white/10 text-center text-xs font-semibold py-2 active:scale-95">
          Open NotebookLM ↗
        </a>
        {url && !editing && (
          <a href={url} target="_blank" rel="noreferrer"
            className="flex-1 rounded-xl bg-[var(--neon)]/15 text-[var(--neon)] text-center text-xs font-semibold py-2 active:scale-95">
            My notebook ↗
          </a>
        )}
      </div>

      {!editing ? (
        <button onClick={() => { setDraft(url); setEditing(true); setErr(""); }} className="text-[10px] opacity-40 underline mt-2">
          {url ? "change saved notebook link" : "save my notebook link for one-tap access"}
        </button>
      ) : (
        <div className="flex gap-2 mt-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://notebooklm.google.com/notebook/…"
            className="flex-1 min-w-0 rounded-lg bg-black/40 px-3 py-2 outline-none text-xs" />
          <button onClick={saveUrl} disabled={busy} className="px-3 rounded-lg bg-[var(--neon)] text-black text-xs font-bold active:scale-95 disabled:opacity-50">Save</button>
        </div>
      )}

      {note && <p className="text-xs opacity-70 mt-2">{note}</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
