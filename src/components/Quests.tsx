"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { questsForDay, loadQuestCtx, SWEEP_XP, CHEST_CHANCE, chestXP, type QuestCtx } from "@/lib/quests";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";

export default function Quests({ refreshKey }: { refreshKey?: unknown }) {
  const game = useGame();
  const [ctx, setCtx] = useState<QuestCtx | null>(null);
  const [chest, setChest] = useState<number | null>(null);
  const quests = questsForDay(todayStr());

  const load = useCallback(async () => {
    const { data: settings } = await supabase.from("user_settings").select("protein_goal").eq("user_id", game.uid).maybeSingle();
    setCtx(await loadQuestCtx(game.uid, settings?.protein_goal ?? 160));
  }, [game.uid]);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function claim(key: string, xp: number) {
    const ok = await game.bankQuestXP(key, xp);
    if (!ok) return;
    xpToast(xp, "quest");
    burstConfetti("small");
    buzz([20, 30, 20]);

    // surprise chest — variable reward on an unpredictable schedule
    if (Math.random() < CHEST_CHANCE) {
      const bonus = chestXP();
      const banked = await game.bankQuestXP(`chest_${key}`, bonus);
      if (banked) {
        setChest(bonus);
        sfx.chest();
        setTimeout(() => setChest(null), 2600);
      }
    }

  }

  // Sweep bonus for clearing the whole board — awarded from FRESH state (not
  // inside claim(), where rapid taps race a stale snapshot and lose it forever).
  // Idempotent via the (user_id, day, quest_key) unique constraint, and
  // self-healing: a sweep missed to a network blip is re-attempted on any load.
  const allClaimed = quests.every((q) => game.todaysQuestClaims.has(q.key));
  const sweepBanked = game.todaysQuestClaims.has("sweep");
  useEffect(() => {
    if (!allClaimed || sweepBanked) return;
    game.bankQuestXP("sweep", SWEEP_XP).then((ok) => {
      if (ok) { xpToast(SWEEP_XP, "quest sweep!"); burstConfetti("small"); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allClaimed, sweepBanked]);

  const claimed = game.todaysQuestClaims;
  const allDone = quests.every((q) => claimed.has(q.key));

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-widest opacity-60">🗡️ Daily quests</p>
        {allDone
          ? <p className="text-xs font-bold text-[#ffd54a]">Board cleared ✨</p>
          : <p className="text-[10px] opacity-40">fresh at midnight</p>}
      </div>

      <div className="space-y-2.5">
        {quests.map((q) => {
          const isClaimed = claimed.has(q.key);
          const p = ctx ? q.progress(ctx) : { done: false, now: 0, total: 1 };
          return (
            <div key={q.key} className={`${isClaimed ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2.5">
                <span className="text-lg shrink-0">{q.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium leading-tight ${isClaimed ? "line-through" : ""}`}>{q.label}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${Math.min((p.now / p.total) * 100, 100)}%`, background: isClaimed ? "rgba(255,255,255,0.3)" : "linear-gradient(90deg,#34d399,#2dd4bf)" }} />
                    </div>
                    <span className="text-[10px] opacity-40 tabular-nums shrink-0">{p.now}/{p.total}</span>
                  </div>
                </div>
                {isClaimed ? (
                  <span className="text-xs text-[var(--neon)] font-bold shrink-0">✓ +{q.xp}</span>
                ) : p.done ? (
                  <button onClick={() => claim(q.key, q.xp)}
                    className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-full bg-[var(--neon)] text-black glow-neon active:scale-90">
                    Claim +{q.xp}
                  </button>
                ) : (
                  <span className="text-[10px] opacity-30 shrink-0">+{q.xp} XP</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {chest != null && (
        <div className="mt-3 rounded-xl border border-[#ffd54a]/50 bg-[#ffd54a]/10 px-3 py-2.5 flex items-center gap-2" style={{ animation: "fadeSlide 0.25s ease" }}>
          <span className="text-xl chest-shake">🎁</span>
          <p className="text-sm font-bold text-[#ffd54a]">Bonus chest! +{chest} XP</p>
        </div>
      )}
    </Card>
  );
}
