"use client";

// The shell, v2 — a serious instrument, not an arcade.
//
// FOUR spaces: Card (THE GAME) · Plan · Body · Learn. The app ALWAYS opens on
// the Card — a front door you don't land on isn't a front door (the old shell
// restored the last-visited tab, which is why a whole redesign once shipped
// invisibly). Everything retired from the old twelve-tab era stays reachable
// under Settings → Legacy, so no data is orphaned — it's just out of the way.

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { GameProvider, useGame } from "@/lib/useGameData";
import TheCard from "@/components/TheCard";
import PlanSpace from "@/components/PlanSpace";
import Body from "@/components/Body";
import Notebooks from "@/components/Notebooks";
import AIOffBanner from "@/components/AIOffBanner";
import AIKey from "@/components/AIKey";
import AIModels from "@/components/AIModels";
import UpdateBar from "@/components/UpdateBar";
import Today from "@/components/Today";
import Plan from "@/components/Plan";
import Goals from "@/components/Goals";
import Food from "@/components/Food";
import Night from "@/components/Night";
import Money from "@/components/Money";
import TradingBot from "@/components/TradingBot";
import KalshiHub from "@/components/KalshiHub";
import NewsTrader from "@/components/NewsTrader";
import IncomeEngine from "@/components/IncomeEngine";
import Vocab from "@/components/Vocab";
import Tools from "@/components/Tools";
import Affirmations from "@/components/Affirmations";
import Board from "@/components/Board";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { sfx, buzz } from "@/lib/fx";

type Tab =
  | "home" | "plan" | "body" | "learning"
  | "today" | "planlegacy" | "goals" | "food" | "night" | "money" | "markets" | "hustle" | "vocab" | "affirmations" | "tools";

const SPACES: { key: Tab; label: string }[] = [
  { key: "home", label: "Card" },
  { key: "plan", label: "Plan" },
  { key: "body", label: "Body" },
  { key: "learning", label: "Learn" },
];

const LEGACY: { key: Tab; label: string }[] = [
  { key: "today", label: "Today (old)" },
  { key: "planlegacy", label: "Planner (old)" },
  { key: "goals", label: "Goals (old)" },
  { key: "night", label: "Night" },
  { key: "food", label: "Food" },
  { key: "money", label: "Money" },
  { key: "markets", label: "Markets" },
  { key: "hustle", label: "Hustle" },
  { key: "vocab", label: "Vocab" },
  { key: "affirmations", label: "Affirmations" },
  { key: "tools", label: "Tools" },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) {
    return (
      <main className="min-h-screen grid place-items-center">
        <p className="opacity-40 text-sm">Loading…</p>
      </main>
    );
  }
  if (!session) return <Login />;

  return (
    <GameProvider uid={session.user.id}>
      <UpdateBar />
      <Shell uid={session.user.id} />
      <LegacyGameSync />
    </GameProvider>
  );
}

// The old XP overlays are gone from the shell, but their state machine still
// runs for the legacy tabs — auto-acknowledge it so last_seen_level keeps
// advancing in the DB and nothing accumulates unseen forever.
function LegacyGameSync() {
  const game = useGame();
  useEffect(() => { if (game.levelUp) game.dismissLevelUp(); }, [game, game.levelUp]);
  useEffect(() => { if (game.newlyUnlocked.length) game.dismissNew(); }, [game, game.newlyUnlocked]);
  return null;
}

function Shell({ uid }: { uid: string }) {
  // ALWAYS open on the Card. No remembered-tab restore — that "feature" hid an
  // entire redesign from Ben for a day.
  const [tab, setTab] = useState<Tab>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);

  function go(t: Tab) {
    setTab(t);
    setSettingsOpen(false);
    window.scrollTo({ top: 0 });
  }

  const inSpace = SPACES.some((s) => s.key === tab);
  const legacyMeta = LEGACY.find((l) => l.key === tab);

  return (
    <div className="md:flex md:min-h-full">
      {/* desktop rail */}
      <nav className="hidden md:flex md:flex-col md:w-52 md:shrink-0 md:border-r md:border-white/[0.07] md:py-6 md:px-3 md:gap-1 md:sticky md:top-0 md:h-screen">
        <p className="px-3 pb-5 font-display font-bold text-lg tracking-tight">Daily</p>
        {SPACES.map((s) => (
          <button key={s.key} onClick={() => go(s.key)}
            className={`px-3 py-2.5 rounded-lg text-left text-sm font-semibold transition ${tab === s.key ? "bg-[var(--neon)]/12 text-[var(--neon)]" : "opacity-55 hover:opacity-100 hover:bg-white/[0.04]"}`}>
            {s.label}
          </button>
        ))}
        <button onClick={() => setSettingsOpen(true)} className="mt-3 px-3 py-2.5 rounded-lg text-left text-sm opacity-45 hover:opacity-90">Settings</button>
        <button onClick={() => supabase.auth.signOut()} className="mt-auto px-3 py-2 text-xs opacity-30 text-left hover:opacity-60">Sign out</button>
      </nav>

      <main className="flex-1 max-w-md md:max-w-2xl mx-auto px-4 pb-32 md:pb-10 md:pt-6 min-h-full w-full">
        {legacyMeta && (
          <div className="flex items-center justify-between mt-3 -mb-1">
            <button onClick={() => go("home")} className="text-xs opacity-50 active:scale-95">← Card</button>
            <span className="text-[10px] uppercase tracking-widest opacity-35">Legacy · {legacyMeta.label}</span>
          </div>
        )}
        <AIOffBanner onGoFix={() => setSettingsOpen(true)} />

        <div key={tab} className="tab-enter">
          {tab === "home" && <TheCard uid={uid} onGoTab={(t) => go(t as Tab)} />}
          {tab === "plan" && <PlanSpace uid={uid} />}
          {tab === "body" && <Body uid={uid} />}
          {tab === "learning" && <Notebooks uid={uid} onGoFix={() => setSettingsOpen(true)} />}

          {tab === "today" && <Today uid={uid} onOpenAdvisor={() => setBoardOpen(true)} onGoTab={(t) => go(t as Tab)} />}
          {tab === "planlegacy" && <Plan uid={uid} onGoTab={(t) => go(t as Tab)} />}
          {tab === "goals" && <Goals uid={uid} />}
          {tab === "food" && <Food uid={uid} />}
          {tab === "night" && <Night uid={uid} />}
          {tab === "money" && (<><Money uid={uid} /><TradingBot /></>)}
          {tab === "markets" && <><NewsTrader uid={uid} /><KalshiHub /></>}
          {tab === "hustle" && <IncomeEngine />}
          {tab === "vocab" && <Vocab uid={uid} />}
          {tab === "affirmations" && <Affirmations uid={uid} />}
          {tab === "tools" && <Tools />}
        </div>

        <QuickCapture uid={uid} />
        {boardOpen && <Board onClose={() => setBoardOpen(false)} />}

        {/* mobile dock — four words and a settings dot. That's the whole nav. */}
        <nav className="fixed left-3 right-3 z-10 rounded-2xl border border-[var(--border-2)] bg-[var(--raised)]/95 backdrop-blur-sm md:hidden"
          style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="max-w-md mx-auto grid grid-cols-5">
            {SPACES.map((s) => (
              <button key={s.key} onClick={() => go(s.key)}
                className={`relative py-3.5 mono text-[10px] font-semibold uppercase tracking-[0.14em] transition ${tab === s.key ? "text-[var(--neon)]" : "opacity-45"}`}>
                {tab === s.key && <span className="absolute top-0 left-1/4 right-1/4 h-[2px] rounded-full bg-[var(--neon)]" />}
                {s.label}
              </button>
            ))}
            <button onClick={() => setSettingsOpen(true)} className={`py-3.5 mono text-[10px] font-semibold tracking-[0.14em] ${legacyMeta || settingsOpen ? "text-[var(--neon)]" : "opacity-45"}`}>
              •••
            </button>
          </div>
        </nav>

        {/* settings sheet: AI key · legacy · sign out */}
        {settingsOpen && (
          <div className="fixed inset-0 z-30 bg-black/60 flex items-end md:items-center md:justify-center" onClick={() => setSettingsOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-md bg-[var(--background)] rounded-t-2xl md:rounded-2xl border-t md:border border-white/[0.08] p-4 pb-8 md:pb-4 max-h-[85vh] overflow-y-auto" style={{ animation: "fadeSlide 0.2s ease" }}>
              <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-4 md:hidden" />
              <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">Settings</p>
              <AIKey />
              <AIModels />
              <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mt-5 mb-2">Legacy — the old rooms, data intact</p>
              <div className="grid grid-cols-2 gap-1.5">
                {LEGACY.map((l) => (
                  <button key={l.key} onClick={() => go(l.key)}
                    className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-left text-xs font-medium opacity-70 active:scale-95">
                    {l.label}
                  </button>
                ))}
              </div>
              <button onClick={() => supabase.auth.signOut()} className="mt-5 text-xs opacity-35 underline">Sign out</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// One-tap capture from anywhere — a thought lands in Plan → Inbox and stops
// eating working memory. Zero decisions at capture time.
function QuickCapture({ uid }: { uid: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [flash, setFlash] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const voice = useVoiceInput((t) => setText(t));

  async function save() {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true); setFailed(false);
    try {
      const { error } = await supabase.from("captures").insert({ user_id: uid, text: t });
      if (error) { setFailed(true); return; }
      setText("");
      window.dispatchEvent(new CustomEvent("daily:captured"));
      sfx.pop(); buzz(15);
      setFlash(true);
      setTimeout(() => { setFlash(false); setOpen(false); }, 800);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="capture a thought"
        className="fixed z-20 bottom-24 right-4 w-11 h-11 rounded-full bg-white/[0.06] border border-white/[0.12] text-xl font-light grid place-items-center active:scale-90 md:bottom-8 md:right-8">
        ＋
      </button>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-end md:items-center md:justify-center" onClick={() => setOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-md bg-[var(--background)] rounded-t-2xl md:rounded-2xl border-t md:border border-white/[0.08] p-4 pb-8 md:pb-4" style={{ animation: "fadeSlide 0.2s ease" }}>
            <div className="w-10 h-1 rounded-full bg-white/15 mx-auto mb-3 md:hidden" />
            <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Get it out of your head</p>
            {flash ? (
              <p className="text-center py-4 text-[var(--neon)] font-semibold">Captured — mind off it.</p>
            ) : (
              <div className="flex gap-2">
                <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder={voice.listening ? "listening…" : "thought, task, worry, idea…"}
                  className="flex-1 min-w-0 rounded-lg bg-white/[0.04] border border-white/[0.09] px-4 py-3 outline-none text-sm" />
                {voice.supported && (
                  <button onClick={voice.toggle}
                    className={`w-12 rounded-lg font-bold active:scale-95 ${voice.listening ? "bg-red-500/80 text-white" : "bg-white/[0.07]"}`}>●</button>
                )}
                <button onClick={save} disabled={saving} className="px-4 rounded-lg bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">{saving ? "…" : "＋"}</button>
              </div>
            )}
            {failed && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t save — your text is still here. Tap ＋ again.</p>}
            <p className="text-[10px] opacity-35 mt-2">Lands in Plan → Inbox. Park it or date it on Sunday — captured beats organized.</p>
          </div>
        </div>
      )}
    </>
  );
}

function Login() {
  const [email, setEmail] = useState("bengarnet@gmail.com");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  }

  return (
    <main className="max-w-xs mx-auto px-4">
      <div className="min-h-screen flex flex-col justify-center">
        <div className="text-center mb-8" style={{ animation: "fadeSlide 0.4s ease" }}>
          <h1 className="font-display text-3xl font-bold tracking-tight">Daily</h1>
          <p className="opacity-45 text-sm mt-1.5">The game runs Aug 18 → Dec 15.</p>
        </div>
        <form onSubmit={go} className="space-y-3">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email"
            className="w-full rounded-lg bg-white/[0.04] border border-white/[0.09] px-4 py-3 outline-none focus:border-[var(--neon)]/50 transition text-sm" />
          <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="password"
            className="w-full rounded-lg bg-white/[0.04] border border-white/[0.09] px-4 py-3 outline-none focus:border-[var(--neon)]/50 transition text-sm" />
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <button disabled={busy} className="w-full rounded-lg bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}
