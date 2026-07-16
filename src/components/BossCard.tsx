"use client";

// 🥊 Weekly Boss Battle — the Challenge lever of INCUP, aimed at YOURSELF.
// Auto-generated each week from last week's real numbers: beat last-week-you.
// Big banked XP on the claim. Rotates type weekly so it never goes stale.

import { useCallback, useEffect, useState } from "react";
import { supabase, dateStr, WIN_KEYS } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { scoreOf, WIN_TOTAL } from "@/lib/gamification";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx } from "@/lib/fx";
import { Card } from "./ui";

const BOSS_XP = 75;

function mondayOf(d = new Date()): string {
  const c = new Date(d);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return dateStr(c);
}

type Boss = { key: string; emoji: string; name: string; desc: string; target: number; progress: number };

export default function BossCard() {
  const game = useGame();
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [claimErr, setClaimErr] = useState(false);
  const ws = mondayOf();

  const checkClaim = useCallback(async () => {
    const { data } = await supabase.from("quest_claims").select("id").eq("user_id", game.uid).eq("quest_key", `boss_${ws}`).limit(1);
    setClaimed((data ?? []).length > 0);
  }, [game.uid, ws]);
  useEffect(() => { checkClaim(); }, [checkClaim]);
  // a stale tab left open across midnight must not offer a second kill
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") checkClaim(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkClaim]);

  if (game.loading || claimed === null) return null;

  // last week vs this week, from data already in the game context
  const lastWs = (() => { const d = new Date(ws + "T00:00:00"); d.setDate(d.getDate() - 7); return dateStr(d); })();
  const thisWeek = game.days.filter((d) => d.day >= ws);
  const lastWeek = game.days.filter((d) => d.day >= lastWs && d.day < ws);

  // rotate boss type by ISO week parity-ish (seeded by week string)
  const seed = ws.split("-").reduce((s, x) => s + Number(x), 0);
  const bossType = seed % 3;

  let boss: Boss;
  if (bossType === 0) {
    const lastLifts = lastWeek.filter((d) => d.ws_lift).length;
    const target = Math.min(Math.max(lastLifts + 1, 3), 6);
    boss = {
      key: "lifts", emoji: "🏋️", name: "Iron Week",
      desc: `Beat last week's you: lift ${target} days (last week: ${lastLifts})`,
      target, progress: thisWeek.filter((d) => d.ws_lift).length,
    };
  } else if (bossType === 1) {
    const lastFull = lastWeek.filter((d) => scoreOf(d) === WIN_TOTAL).length;
    const target = Math.min(Math.max(lastFull + 1, 2), 7);
    boss = {
      key: "full", emoji: "👑", name: "Perfect Run",
      desc: `Win ${target} full days — all ${WIN_TOTAL} habits (last week: ${lastFull})`,
      target, progress: thisWeek.filter((d) => scoreOf(d) === WIN_TOTAL).length,
    };
  } else {
    // wins volume: total habit checks this week vs last
    const count = (rows: typeof thisWeek) => rows.reduce((s, d) => s + WIN_KEYS.reduce((x, k) => x + (d[k] ? 1 : 0), 0), 0);
    const lastWins = count(lastWeek);
    const target = Math.max(lastWins + 5, 25);
    boss = {
      key: "volume", emoji: "⚡", name: "Volume War",
      desc: `Bank ${target} total wins this week (last week: ${lastWins})`,
      target, progress: count(thisWeek),
    };
  }

  const pct = Math.min(boss.progress / boss.target, 1);
  const beaten = boss.progress >= boss.target;

  async function claim() {
    // insert with day = the week's Monday, so the (user_id, day, quest_key)
    // unique constraint makes one-claim-per-week a DATABASE guarantee, not a
    // client hope — a stale second tab physically cannot double-bank it
    setClaimErr(false);
    const { error } = await supabase.from("quest_claims").insert({
      user_id: game.uid, day: ws, quest_key: `boss_${ws}`, xp: BOSS_XP,
    });
    if (error) {
      // WRITE-THEN-CELEBRATE: only mark defeated once the insert lands. A false
      // "defeated ✓" here permanently loses 75 XP — the button is gone next week.
      // Re-check: a duplicate-key error means it's genuinely already claimed
      // (flip to defeated); a real failure keeps it claimable with a retry note.
      setClaimErr(true);
      checkClaim();
      return;
    }
    setClaimed(true);
    burstConfetti("big");
    sfx.levelup();
    xpToast(BOSS_XP, "boss defeated");
    game.refresh();
  }

  return (
    <Card className={`mt-3 ${beaten && !claimed ? "border-[#ffd54a]/60 glow-neon" : "border-fuchsia-400/30 bg-fuchsia-400/[0.05]"}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs uppercase tracking-widest text-fuchsia-300/90">🥊 This week&apos;s boss</p>
        {claimed && <p className="text-xs font-bold text-[#ffd54a]">defeated ✓</p>}
      </div>
      <p className="font-bold">{boss.emoji} {boss.name}</p>
      <p className="text-xs opacity-60 mb-2">{boss.desc}</p>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct * 100}%`, background: claimed ? "rgba(255,255,255,0.3)" : "linear-gradient(90deg,#e879f9,#f0abfc)" }} />
        </div>
        <span className="text-xs font-bold tabular-nums shrink-0">{boss.progress}/{boss.target}</span>
      </div>
      {beaten && !claimed && (
        <button onClick={claim} className="mt-3 w-full rounded-xl bg-[#ffd54a] text-black font-bold py-2.5 active:scale-95">
          ⚔️ CLAIM VICTORY · +{BOSS_XP} XP
        </button>
      )}
      {claimErr && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t bank the win — tap CLAIM to try again.</p>}
      {!beaten && <p className="text-[10px] opacity-40 mt-1.5">the only opponent is last-week-you · +{BOSS_XP} XP on the kill</p>}
    </Card>
  );
}
