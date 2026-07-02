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

type Tab = "today" | "goals" | "food" | "lifts" | "money" | "night";
const TABS: { key: Tab; emoji: string; label: string }[] = [
  { key: "today", emoji: "✅", label: "Today" },
  { key: "goals", emoji: "🎯", label: "Goals" },
  { key: "food", emoji: "🍎", label: "Food" },
  { key: "lifts", emoji: "🏋️", label: "Lifts" },
  { key: "money", emoji: "💰", label: "Money" },
  { key: "night", emoji: "🌙", label: "Night" },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("today");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setChecking(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) return <main className="max-w-md mx-auto px-4"><p className="opacity-50 text-center mt-20">Loading…</p></main>;
  if (!session) return <Login />;

  const uid = session.user.id;
  return (
    <main className="max-w-md mx-auto px-4 pb-28 min-h-full">
      {tab === "today" && <Today uid={uid} />}
      {tab === "goals" && <Goals uid={uid} />}
      {tab === "food" && <Food uid={uid} />}
      {tab === "lifts" && <Lifts uid={uid} />}
      {tab === "money" && <Money uid={uid} />}
      {tab === "night" && <Night uid={uid} />}

      <button onClick={() => supabase.auth.signOut()} className="mt-8 mx-auto block text-xs opacity-30 underline">Sign out</button>

      <nav className="fixed bottom-0 left-0 right-0 z-10 border-t border-white/10 bg-[var(--background)]/95 backdrop-blur">
        <div className="max-w-md mx-auto grid grid-cols-6">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex flex-col items-center gap-0.5 py-3 ${tab === t.key ? "text-[var(--neon)]" : "opacity-50"}`}>
              <span className="text-lg">{t.emoji}</span>
              <span className="text-[9px] font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </main>
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
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-2xl font-bold">Daily</h1>
          <p className="opacity-50 text-sm mt-1">Your day, one place. Private.</p>
        </div>
        <form onSubmit={go} className="space-y-3">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="email"
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
          <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="password"
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}
