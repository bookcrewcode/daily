"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, type Affirmation, type UserSettings } from "@/lib/supabase";
import { SectionTitle, Card } from "./ui";

function youtubeEmbedId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

export default function Affirmations({ uid }: { uid: string }) {
  const [videoUrl, setVideoUrl] = useState("");
  const [editingVideo, setEditingVideo] = useState(false);
  const [morning, setMorning] = useState("");
  const [night, setNight] = useState("");
  const [log, setLog] = useState<Affirmation[]>([]);

  const load = useCallback(async () => {
    const [{ data: settings }, { data: entries }] = await Promise.all([
      supabase.from("user_settings").select("affirmation_video_url").eq("user_id", uid).maybeSingle(),
      supabase.from("affirmations").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
    ]);
    setVideoUrl((settings as UserSettings | null)?.affirmation_video_url ?? "");
    setLog((entries ?? []) as Affirmation[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function saveVideo() {
    await supabase.from("user_settings").upsert({ user_id: uid, affirmation_video_url: videoUrl.trim() }, { onConflict: "user_id" });
    setEditingVideo(false);
  }

  async function save(period: "morning" | "night", text: string) {
    if (!text.trim()) return;
    await supabase.from("affirmations").insert({ user_id: uid, day: todayStr(), period, text: text.trim() });
    await supabase.from("days").upsert({ user_id: uid, day: todayStr(), ws_affirmations: true }, { onConflict: "user_id,day" });
    if (period === "morning") setMorning(""); else setNight("");
    load();
  }

  const embedId = youtubeEmbedId(videoUrl);
  const todayEntries = log.filter((a) => a.day === todayStr());

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">💫 Affirmations</h1>
      <p className="opacity-50 text-sm mt-1">Morning sets the frame. Night locks it in. +5 XP for showing up.</p>

      <SectionTitle>🎵 Music</SectionTitle>
      {embedId && !editingVideo ? (
        <div>
          <div className="rounded-2xl overflow-hidden border border-white/10" style={{ aspectRatio: "16/9" }}>
            <iframe className="w-full h-full" src={`https://www.youtube.com/embed/${embedId}`} title="Affirmation music"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          </div>
          <button onClick={() => setEditingVideo(true)} className="text-xs text-[var(--neon)]/70 underline mt-2">change video</button>
        </div>
      ) : (
        <Card>
          <p className="text-xs opacity-50 mb-2">Paste a YouTube link — background music or a guided affirmation video.</p>
          <div className="flex gap-2">
            <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."
              className="flex-1 rounded-xl bg-black/30 px-3 py-2.5 outline-none" />
            <button onClick={saveVideo} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Save</button>
          </div>
        </Card>
      )}

      <SectionTitle>☀️ This morning</SectionTitle>
      {todayEntries.some((a) => a.period === "morning") ? (
        <Card tone="neon"><p className="text-sm">✓ {todayEntries.find((a) => a.period === "morning")?.text}</p></Card>
      ) : (
        <div className="space-y-2">
          <textarea value={morning} onChange={(e) => setMorning(e.target.value)} rows={3} placeholder="I am..."
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none resize-none" />
          <button onClick={() => save("morning", morning)} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Save morning affirmation</button>
        </div>
      )}

      <SectionTitle>🌙 Tonight</SectionTitle>
      {todayEntries.some((a) => a.period === "night") ? (
        <Card tone="neon"><p className="text-sm">✓ {todayEntries.find((a) => a.period === "night")?.text}</p></Card>
      ) : (
        <div className="space-y-2">
          <textarea value={night} onChange={(e) => setNight(e.target.value)} rows={3} placeholder="Tonight I'm proud that..."
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none resize-none" />
          <button onClick={() => save("night", night)} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Save night affirmation</button>
        </div>
      )}

      <SectionTitle>📖 Past affirmations</SectionTitle>
      {log.length === 0 && <p className="opacity-40 text-sm">Nothing yet — your first one starts the log.</p>}
      <div className="space-y-2">
        {log.map((a) => (
          <Card key={a.id} padded={false} className="p-3">
            <p className="text-[10px] uppercase tracking-widest opacity-40">{a.period === "morning" ? "☀️" : "🌙"} {a.day}</p>
            <p className="text-sm mt-1">{a.text}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
