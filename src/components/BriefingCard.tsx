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
        body: JSON.stringify({ advisor: "briefing" }),
      });
      const json = await res.json();
      if (json.text) {
        setText(json.text);
        setState("ready");
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

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("days").select("briefing").eq("user_id", uid).eq("day", todayStr()).maybeSingle();
      if (data?.briefing) {
        setText(data.briefing);
        setState("ready");
      } else {
        generate(); // first open of the day — write it fresh
      }
    })();
  }, [uid, generate]);

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
