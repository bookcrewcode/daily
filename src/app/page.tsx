"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import Today from "@/components/Today";
import Food from "@/components/Food";
import Lifts from "@/components/Lifts";
import Night from "@/components/Night";
import Goals from "@/components/Goals";
import Money from "@/components/Money";
import Vocab from "@/components/Vocab";
import Tools from "@/components/Tools";
import Learning from "@/components/Learning";
import Affirmations from "@/components/Affirmations";
import Board from "@/components/Board";

type Tab = "today" | "goals" | "food" | "lifts" | "vocab" | "money" | "night" | "tools" | "learning" | "affirmations";
const PRIMARY: { key: Tab; emoji: string; label: string }[] = [
  { key: "today", emoji: "✅", label: "Today" },
  { key: "goals", emoji: "🎯", label: "Goals" },
  { key: "food", emoji: "🍎", label: "Food" },
  { key: "lifts", emoji: "🏋️", label: "Lifts" },
];
const SECONDARY: { key: Tab; emoji: string; label: string }[] = [
  { key: "vocab", emoji: "✍️", label: "Vocab" },
  { key: "learning", emoji: "🌳", label: "Learning" },
  { key: "affirmations", emoji: "💫", label: "Affirm" },
  { key: "money", emoji: "💰", label: "Money" },
  { key: "night", emoji: "🌙", label: "Night" },
  { key: "tools", emoji: "🛠️", label: "Tools" },
];
const ALL = [...PRIMARY, ...SECONDARY];
const isTab = (v: string | null): v is Tab => !!v && ALL.some((t) => t.key === v);

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("today");
  const [moreOpen, setMoreOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardAdvisor, setBoardAdvisor] = useState<string | undefined>(undefined);
  const [boardTopicId, setBoardTopicId] = useState<string | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    const remembered = localStorage.getItem("daily.tab");
    if (isTab(remembered)) setTab(remembered);
    return () => sub.subscription.unsubscribe();
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

  const uid = session.user.id;
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

      <main className="flex-1 max-w-md md:max-w-2xl mx-auto px-4 pb-28 md:pb-10 md:pt-8 min-h-full w-full">
        <div key={tab} className="tab-enter">
          {tab === "today" && <Today uid={uid} onOpenAdvisor={openAdvisor} />}
          {tab === "goals" && <Goals uid={uid} />}
          {tab === "food" && <Food uid={uid} />}
          {tab === "lifts" && <Lifts uid={uid} />}
          {tab === "vocab" && <Vocab uid={uid} />}
          {tab === "money" && <Money uid={uid} />}
          {tab === "night" && <Night uid={uid} />}
          {tab === "tools" && <Tools />}
          {tab === "learning" && <Learning uid={uid} onOpenAdvisor={openAdvisor} />}
          {tab === "affirmations" && <Affirmations uid={uid} />}
        </div>

        <button onClick={() => supabase.auth.signOut()} className="mt-8 mx-auto block text-xs opacity-30 underline md:hidden">Sign out</button>

        {/* floating Coach button — mobile only (desktop has it in the sidebar) */}
        <button onClick={() => openAdvisor("overseer")}
          className="fixed z-20 bottom-24 right-4 w-14 h-14 rounded-full bg-[var(--neon)] text-black text-2xl grid place-items-center glow-neon active:scale-90 md:hidden">
          🎮
        </button>
        {boardOpen && <Board onClose={() => setBoardOpen(false)} initialAdvisor={boardAdvisor} topicId={boardTopicId} />}

        {/* Mobile bottom nav: 4 primary + More */}
        <nav className="fixed bottom-0 left-0 right-0 z-10 border-t border-white/10 bg-[var(--background)]/90 backdrop-blur-lg md:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
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
