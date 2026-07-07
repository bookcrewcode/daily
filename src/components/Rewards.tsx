"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { REWARDS, type Reward } from "@/lib/gamification";
import { Card, SectionTitle } from "./ui";

const TIER_STYLE: Record<Reward["tier"], string> = {
  small: "border-white/10 bg-white/5",
  medium: "border-[var(--neon)]/30 bg-[var(--neon)]/5",
  big: "border-[#ffd54a]/40 bg-[#ffd54a]/10",
  legendary: "border-fuchsia-400/50 bg-fuchsia-400/10",
};

export default function Rewards({ uid, level }: { uid: string; level: number }) {
  const [claimed, setClaimed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const { data } = await supabase.from("claimed_rewards").select("key").eq("user_id", uid);
    setClaimed(new Set((data ?? []).map((r) => r.key as string)));
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function claim(key: string) {
    setClaimed((s) => new Set(s).add(key));
    await supabase.from("claimed_rewards").insert({ user_id: uid, key });
  }

  const unlocked = REWARDS.filter((r) => level >= r.level);
  const nextUp = REWARDS.find((r) => level < r.level);
  const readyToClaim = unlocked.filter((r) => !claimed.has(r.key));

  return (
    <div>
      <SectionTitle id="rewards">🎁 Rewards</SectionTitle>
      {readyToClaim.length > 0 && (
        <p className="text-xs text-[var(--neon)] mb-2">✨ {readyToClaim.length} unclaimed — go treat yourself.</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {REWARDS.map((r) => {
          const isUnlocked = level >= r.level;
          const isClaimed = claimed.has(r.key);
          return (
            <Card key={r.key} padded={false}
              className={`p-3 ${isUnlocked ? TIER_STYLE[r.tier] : "border-white/5 bg-white/[0.02] opacity-40"} ${isUnlocked && !isClaimed ? "animate-pulse" : ""}`}>
              <p className="text-2xl">{r.emoji}</p>
              <p className="text-sm font-bold leading-tight mt-1">{r.name}</p>
              <p className="text-[10px] opacity-50 mt-0.5">Lv.{r.level}</p>
              {isUnlocked ? (
                isClaimed ? (
                  <p className="text-[10px] text-[var(--neon)] mt-2">✓ claimed</p>
                ) : (
                  <button onClick={() => claim(r.key)} className="mt-2 w-full text-xs font-bold rounded-lg bg-[var(--neon)] text-black py-1.5 active:scale-95">Claim</button>
                )
              ) : (
                <p className="text-[10px] opacity-40 mt-2">🔒 locked</p>
              )}
            </Card>
          );
        })}
      </div>
      {nextUp && (
        <p className="text-xs opacity-40 mt-3">Next unlock: <span className="opacity-70">{nextUp.emoji} {nextUp.name}</span> at Level {nextUp.level} ({nextUp.level - level} to go)</p>
      )}
    </div>
  );
}
