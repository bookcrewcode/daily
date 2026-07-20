"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { GameProvider, useGame } from "@/lib/useGameData";
import { Celebration, LevelUpModal } from "@/components/ui";
import Today from "@/components/Today";
import Food from "@/components/Food";
import Lifts from "@/components/Lifts";
import Night from "@/components/Night";
import Goals from "@/components/Goals";
import Money from "@/components/Money";
import TradingBot from "@/components/TradingBot";
import IncomeEngine from "@/components/IncomeEngine";
import Vocab from "@/components/Vocab";
import Tools from "@/components/Tools";
import Notebooks from "@/components/Notebooks";
import Affirmations from "@/components/Affirmations";
import Board from "@/components/Board";
import Plan from "@/components/Plan";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { sfx, buzz } from "@/lib/fx";

type Tab = "today" | "plan" | "goals" | "food" | "lifts" | "vocab" | "money" | "hustle" | "night" | "tools" | "learning" | "affirmations";
const PRIMARY: { key: Tab; emoji: string; label: string }[] = [
  { key: "today", emoji: "✅", label: "Today" },
  { key: "plan", emoji: "🧭", label: "Plan" },
  { key: "food", emoji: "🍎", label: "Food" },
  { key: "lifts", emoji: "🏋️", label: "Lifts" },
];
const SECONDARY: { key: Tab; emoji: string; label: string }[] = [
  { key: "goals", emoji: "🎯", label: "Goals" },
  { key: "vocab", emoji: "✍️", label: "Vocab" },
  { key: "learning", emoji: "📓", label: "Learn" },
  { key: "affirmations", emoji: "💫", label: "Affirm" },
  { key: "hustle", emoji: "💸", label: "Hustle" },
  { key: "money", emoji: "💰", label: "Money" },
  { key: "night", emoji: "🌙", label: "Night" },
  { key: "tools", emoji: "🛠️", label: "Tools" },
];
const ALL = [...PRIMARY, ...SECONDARY];
const isTab = (v: string | null): v is Tab => !!v && ALL.some((t) => t.key === v);

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
        <div className="text-center">
          <div className="text-4xl mb-3 flame">✅</div>
          <p className="opacity-40 text-sm">Loading your day…</p>
        </div>
      </main>
    );
  }
  if (!session) return <Login />;

  return (
    <GameProvider uid={session.user.id}>
      <Shell uid={session.user.id} />
      <GameOverlays />
    </GameProvider>
  );
}

// Root-level game moments — achievements and level-ups now fire on ANY tab.
function GameOverlays() {
  const game = useGame();
  const toast = game.newlyUnlocked[0];
  return (
    <>
      {toast && <Celebration emoji={toast.emoji} title={toast.name} subtitle={`+${toast.xp} XP`} onClose={game.dismissNew} />}
      {game.levelUp && <LevelUpModal level={game.levelUp.level} title={game.levelUp.title} onClose={game.dismissLevelUp} />}
    </>
  );
}

function Shell({ uid }: { uid: string }) {
  const [tab, setTab] = useState<Tab>("today");
  const [moreOpen, setMoreOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardAdvisor, setBoardAdvisor] = useState<string | undefined>(undefined);
  const [boardTopicId, setBoardTopicId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const remembered = localStorage.getItem("daily.tab");
    if (isTab(remembered)) setTab(remembered);
  }, []);

  function openAdvisor(advisor: string, topicId?: string) {
    setBoardAdvisor(advisor);
    setBoardTopicId(topicId);
    setBoardOpen(true);
  }
  function go(t: Tab) {
    setTab(t);
    setMoreOpen(false);
    localStorage.setItem("daily.tab", t);
    window.scrollTo({ top: 0 });
  }

  const activeMeta = ALL.find((t) => t.key === tab)!;

  return (
    <div className="md:flex md:min-h-full">
      {/* Desktop sidebar */}
      <nav className="hidden md:flex md:flex-col md:w-56 md:shrink-0 md:border-r md:border-white/10 md:py-6 md:px-3 md:gap-1 md:sticky md:top-0 md:h-screen">
        <p className="px-3 pb-4 font-extrabold text-lg">✅ Daily</p>
        {ALL.map((t) => (
          <button key={t.key} onClick={() => go(t.key)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition ${tab === t.key ? "bg-[var(--neon)]/15 text-[var(--neon)] glow-neon" : "opacity-60 hover:opacity-100 hover:bg-white/5"}`}>
            <span className="text-lg">{t.emoji}</span><span className="text-sm font-semibold">{t.label}</span>
          </button>
        ))}
        <button onClick={() => openAdvisor("overseer")}
          className="mt-4 flex items-center gap-3 px-3 py-2.5 rounded-xl text-left bg-[var(--neon)] text-black font-bold glow-neon active:scale-95">
          <span className="text-lg">🎮</span><span className="text-sm">Coach</span>
        </button>
        <button onClick={() => supabase.auth.signOut()} className="mt-auto px-3 py-2 text-xs opacity-30 underline text-left">Sign out</button>
      </nav>

      <main className="flex-1 max-w-md md:max-w-2xl mx-auto px-4 pb-32 md:pb-10 md:pt-8 min-h-full w-full">
        <div key={tab} className="tab-enter">
          {tab === "today" && <Today uid={uid} onOpenAdvisor={openAdvisor} onGoTab={(t) => go(t as Tab)} />}
          {tab === "plan" && <Plan uid={uid} onGoTab={(t) => go(t as Tab)} />}
          {tab === "goals" && <Goals uid={uid} />}
          {tab === "food" && <Food uid={uid} />}
          {tab === "lifts" && <Lifts uid={uid} />}
          {tab === "vocab" && <Vocab uid={uid} />}
          {tab === "money" && (<><Money uid={uid} /><TradingBot /></>)}
          {tab === "hustle" && <IncomeEngine />}
          {tab === "night" && <Night uid={uid} />}
          {tab === "tools" && <Tools />}
          {tab === "learning" && <Notebooks uid={uid} />}
          {tab === "affirmations" && <Affirmations uid={uid} />}
        </div>

        <button onClick={() => supabase.auth.signOut()} className="mt-8 mx-auto block text-xs opacity-30 underline md:hidden">Sign out</button>

        {/* floating buttons — capture (top) + coach. Capture is ALWAYS one tap
            away: an un-captured thought is an open loop eating working memory. */}
        <QuickCapture uid={uid} />
        <button onClick={() => openAdvisor("overseer")}
          className="fixed z-20 bottom-24 right-4 w-14 h-14 rounded-full bg-[var(--neon)] text-black text-2xl grid place-items-center glow-neon active:scale-90 md:hidden">
          🎮
        </button>
        {boardOpen && <Board onClose={() => setBoardOpen(false)} initialAdvisor={boardAdvisor} topicId={boardTopicId} />}

        {/* Mobile bottom nav: floating dock */}
        <nav className="fixed left-3 right-3 z-10 rounded-[1.75rem] border border-white/10 bg-[var(--background)]/85 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.55)] md:hidden"
          style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="max-w-md mx-auto grid grid-cols-5">
            {PRIMARY.map((t) => (
              <button key={t.key} onClick={() => go(t.key)}
                className={`relative flex flex-col items-center gap-0.5 py-3 transition ${tab === t.key ? "text-[var(--neon)]" : "opacity-50"}`}>
                {tab === t.key && <span className="absolute top-0 w-8 h-0.5 rounded-full bg-[var(--neon)]" />}
                <span className="text-lg">{t.emoji}</span>
                <span className="text-[9px] font-medium">{t.label}</span>
              </button>
            ))}
            <button onClick={() => setMoreOpen(true)}
              className={`relative flex flex-col items-center gap-0.5 py-3 transition ${SECONDARY.some((t) => t.key === tab) ? "text-[var(--neon)]" : "opacity-50"}`}>
              {SECONDARY.some((t) => t.key === tab) && <span className="absolute top-0 w-8 h-0.5 rounded-full bg-[var(--neon)]" />}
              <span className="text-lg">{SECONDARY.some((t) => t.key === tab) ? activeMeta.emoji : "☰"}</span>
              <span className="text-[9px] font-medium">More</span>
            </button>
          </div>
        </nav>

        {moreOpen && (
          <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-end md:hidden" onClick={() => setMoreOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} className="w-full bg-[var(--background)] rounded-t-3xl border-t border-white/10 p-4 pb-8"
              style={{ animation: "fadeSlide 0.2s ease" }}>
              <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-4" />
              <div className="grid grid-cols-3 gap-2">
                {SECONDARY.map((t) => (
                  <button key={t.key} onClick={() => go(t.key)}
                    className={`flex flex-col items-center gap-1 py-4 rounded-2xl active:scale-95 transition ${tab === t.key ? "bg-[var(--neon)]/15 text-[var(--neon)]" : "bg-white/5 opacity-70"}`}>
                    <span className="text-2xl">{t.emoji}</span>
                    <span className="text-[10px] font-medium">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// One-tap capture from anywhere in the app — type or dictate, it lands in
// the Plan tab's inbox. Zero decisions at capture time.
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
    // "captured = safe" has to be TRUE — only celebrate once the write landed
    const { error } = await supabase.from("captures").insert({ user_id: uid, text: t });
    setSaving(false);
    if (error) {
      setFailed(true); // text stays in the box — nothing lost
      return;
    }
    setText("");
    sfx.pop(); buzz(15);
    setFlash(true);
    setTimeout(() => { setFlash(false); setOpen(false); }, 900);
  }

  return (
    <>
      <button onClick={() => setOpen(true)}
        className="fixed z-20 bottom-[10.5rem] right-4 w-11 h-11 rounded-full bg-white/10 border border-white/20 backdrop-blur text-lg grid place-items-center active:scale-90 md:bottom-8 md:right-8">
        ✍️
      </button>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end md:items-center md:justify-center" onClick={() => setOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-md bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-4 pb-8 md:pb-4" style={{ animation: "fadeSlide 0.2s ease" }}>
            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3 md:hidden" />
            <p className="text-xs uppercase tracking-widest opacity-50 mb-2">✍️ Get it out of your head</p>
            {flash ? (
              <p className="text-center py-4 text-[var(--neon)] font-bold">Captured. It&apos;s safe — mind off it. ✓</p>
            ) : (
              <div className="flex gap-2">
                <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder={voice.listening ? "listening…" : "thought, task, worry, idea…"}
                  className="flex-1 min-w-0 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
                {voice.supported && (
                  <button onClick={voice.toggle}
                    className={`w-12 rounded-xl font-bold active:scale-95 ${voice.listening ? "bg-red-500 text-white animate-pulse" : "bg-white/10"}`}>🎤</button>
                )}
                <button onClick={save} disabled={saving} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">{saving ? "…" : "＋"}</button>
              </div>
            )}
            {failed && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t save — your text is still here. Check connection and tap ＋ again.</p>}
            <p className="text-[10px] opacity-40 mt-2">Lands in 🧭 Plan → Inbox. Sort it later — or never. Captured beats organized.</p>
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
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-2xl font-bold">Daily</h1>
          <p className="opacity-50 text-sm mt-1">Your day, one place. Private.</p>
        </div>
        <form onSubmit={go} className="space-y-3">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email"
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none focus:border-[var(--neon)]/50 transition" />
          <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="password"
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none focus:border-[var(--neon)]/50 transition" />
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50 glow-neon">
            {busy ? "…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}
