"use client";

// Is the AI actually usable right now?
//
// Every AI feature in this app depends on one key. When that key is missing or
// dead, the old behaviour was: each button spins, then fails with its own
// cryptic message. That reads as "the app is broken" rather than "the engine is
// off". This gives the whole app ONE shared answer to "is the AI on?", checked
// once, so features can say so up front instead of failing after a wait.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export type AIState = "checking" | "on" | "off";

let cached: AIState = "checking";
let inflight: Promise<AIState> | null = null;
const listeners = new Set<(s: AIState) => void>();

function broadcast(s: AIState) {
  cached = s;
  listeners.forEach((l) => l(s));
}

export async function refreshAIStatus(): Promise<AIState> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supabase.rpc("ai_key_status");
      if (error) return cached === "checking" ? "off" : cached; // don't flap on a transient read
      const row = (Array.isArray(data) ? data[0] : data) as { is_set?: boolean } | undefined;
      return row?.is_set ? "on" : "off";
    } catch {
      return cached === "checking" ? "off" : cached;
    } finally {
      inflight = null;
    }
  })().then((s) => { broadcast(s as AIState); return s as AIState; });
  return inflight;
}

// Call after saving a key so every screen updates at once.
export function setAIStatus(s: AIState) { broadcast(s); }

export function useAIStatus(): AIState {
  const [state, setState] = useState<AIState>(cached);
  useEffect(() => {
    listeners.add(setState);
    if (cached === "checking") refreshAIStatus();
    else setState(cached);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}
