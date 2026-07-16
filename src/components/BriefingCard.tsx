"use client";

// ☀️ Morning briefing — the app reads your whole state (streak, shields,
// priorities, quests, Engine rows, memories) and hands you ONE clear picture.
// Generated once per day and cached on the day row; regenerate anytime.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, ADVISOR_FN, SUPABASE_ANON } from "@/lib/supabase";

export default function BriefingCard({ uid }: { uid: string }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "generating" | "ready" | "failed">("loading");
  const generating = useRef(false);

  const generate = useCallback(async () => {
    if (generating.current) return;
    generating.current = true;
    setState("generating");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        // clientDay anchors the edge function's streak/day math to Ben's LOCAL
        // day (todayStr is local time) instead of the function's UTC clock
        body: JSON.stringify({ advisor: "briefing", clientDay: todayStr() }),
      });
      const json = await res.json();
      if (json.text) {
        setText(json.text);
        setState("ready");
        localStorage.setItem(`daily.brief.${todayStr()}`, json.text);
        await supabase.from("days").upsert({ user_id: uid, day: todayStr(), briefing: json.text }, { onConflict: "user_id,day" });
      } else {
        setState("failed");
      }
    } catch {
      setState("failed");
    } finally {
      generating.current = false;
    }
  }, [uid]);

  const loadedDay = useRef("");
  const loadForToday = useCallback(async () => {
    const day = todayStr();
    if (loadedDay.current === day) return;
    loadedDay.current = day;
    // localStorage backstop: if the DB cache write ever fails persistently,
    // this stops a fresh Opus call on every single app open
    const local = localStorage.getItem(`daily.brief.${day}`);
    if (local) { setText(local); setState("ready"); return; }
    const { data } = await supabase.from("days").select("briefing").eq("user_id", uid).eq("day", day).maybeSingle();
    if (data?.briefing) {
      setText(data.briefing);
      setState("ready");
      localStorage.setItem(`daily.brief.${day}`, data.briefing);
    } else {
      generate(); // first open of the day — write it fresh
    }
  }, [uid, generate]);

  useEffect(() => { loadForToday(); }, [loadForToday]);

  // midnight rollover: a PWA left open overnight must not present yesterday's
  // text as "Today's briefing" — same guard the other date-keyed cards carry
  useEffect(() => {
    const check = () => { if (todayStr() !== loadedDay.current) { setState("loading"); loadForToday(); } };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 60000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [loadForToday]);

  if (state === "loading") return null;

  return (
    <div className="mt-3 rounded-2xl border border-[var(--neon)]/25 bg-gradient-to-br from-[var(--neon)]/10 to-transparent p-4">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]/80">☀️ Today&apos;s briefing</p>
        <button onClick={generate} disabled={state === "generating"}
          className={`text-xs opacity-50 active:scale-90 ${state === "generating" ? "animate-spin" : ""}`}>↻</button>
      </div>
      {state === "generating" && (
        <div className="space-y-1.5"><div className="skeleton h-4" /><div className="skeleton h-4 w-5/6" /><div className="skeleton h-4 w-2/3" /></div>
      )}
      {state === "failed" && (
        <button onClick={generate} className="text-sm opacity-60 underline">Couldn&apos;t reach the Overseer — tap to retry</button>
      )}
      {state === "ready" && text && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
      )}
    </div>
  );
}
