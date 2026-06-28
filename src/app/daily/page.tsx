"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, WIN_KEYS, type DayRow } from "@/lib/supabase";

type WinKey = (typeof WIN_KEYS)[number];

const WINS: { key: WinKey; emoji: string; label: string; link?: string; linkLabel?: string }[] = [
  { key: "ws_meds", emoji: "💊", label: "Meds + water" },
  { key: "ws_eat", emoji: "🍽️", label: "Ate clean + logged" },
  { key: "ws_lift", emoji: "🏋️", label: "Lifts (or rest day)" },
  { key: "ws_stretch", emoji: "🧘", label: "Stretch 5 min", link: "https://www.youtube.com/watch?v=TTN7-Aw5G2s", linkLabel: "Play" },
  { key: "ws_vocab", emoji: "✍️", label: "Vocab word" },
  { key: "ws_chinese", emoji: "🐼", label: "Chinese", link: "https://www.duolingo.com/learn", linkLabel: "Duolingo" },
  { key: "ws_work", emoji: "💼", label: "30 min BookCrew / research" },
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const EMPTY: DayRow = {
  day: todayStr(),
  ws_meds: false, ws_eat: false, ws_lift: false, ws_stretch: false,
  ws_vocab: false, ws_chinese: false, ws_work: false,
  calories: 0, protein: 0, bodyweight: null, vocab_count: 0,
};

export default function DailyPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [row, setRow] = useState<DayRow>(EMPTY);
  const [history, setHistory] = useState<{ day: string; score: number }[]>([]);
  const [now, setNow] = useState<string>("");

  // clock
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 1000 * 30);
    return () => clearInterval(id);
  }, []);

  // auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadDay = useCallback(async (uid: string) => {
    const day = todayStr();
    const { data } = await supabase.from("days").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
    if (data) setRow({ ...EMPTY, ...data, day });
    else setRow({ ...EMPTY, day });

    const since = new Date();
    since.setDate(since.getDate() - 6);
    const sinceStr = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
    const { data: hist } = await supabase.from("days").select("*").eq("user_id", uid).gte("day", sinceStr).order("day");
    const map = new Map((hist ?? []).map((r) => [r.day, r]));
    const out: { day: string; score: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const r = map.get(ds);
      const score = r ? WIN_KEYS.reduce((s, k) => s + (r[k] ? 1 : 0), 0) : 0;
      out.push({ day: ds, score });
    }
    setHistory(out);
  }, []);

  useEffect(() => {
    if (session?.user) loadDay(session.user.id);
  }, [session, loadDay]);

  async function save(patch: Partial<DayRow>) {
    if (!session?.user) return;
    const next = { ...row, ...patch };
    setRow(next);
    await supabase.from("days").upsert(
      { user_id: session.user.id, day: next.day, ...patch },
      { onConflict: "user_id,day" }
    );
    // refresh today's tile in the strip
    setHistory((h) =>
      h.map((d) =>
        d.day === next.day ? { ...d, score: WIN_KEYS.reduce((s, k) => s + (next[k] ? 1 : 0), 0) } : d
      )
    );
  }

  const score = WIN_KEYS.reduce((s, k) => s + (row[k] ? 1 : 0), 0);

  if (checking) return <Shell><p className="opacity-50 text-center mt-20">Loading…</p></Shell>;
  if (!session) return <Login />;

  return (
    <Shell>
      {/* header */}
      <div className="pt-3 pb-1">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]/70">{now}</p>
        <h1 className="text-2xl font-bold mt-1">Daily Win Stack</h1>
      </div>

      {/* progress */}
      <div className="flex items-center gap-3 my-4">
        <Ring score={score} total={WINS.length} />
        <div>
          <p className="text-3xl font-extrabold leading-none">{score}<span className="text-base opacity-50">/{WINS.length}</span></p>
          <p className="text-sm opacity-60">{score === WINS.length ? "Day won. 🔥" : "Tap to bank a win."}</p>
        </div>
      </div>

      {/* win stack */}
      <div className="space-y-2">
        {WINS.map((w) => {
          const on = row[w.key];
          return (
            <div key={w.key}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 border transition ${on ? "bg-[var(--neon)]/15 border-[var(--neon)]/60" : "bg-white/5 border-white/10"}`}>
              <button onClick={() => save({ [w.key]: !on } as Partial<DayRow>)} className="flex items-center gap-3 flex-1 text-left">
                <span className="text-2xl">{w.emoji}</span>
                <span className={`flex-1 font-medium ${on ? "" : "opacity-90"}`}>{w.label}</span>
                <span className={`w-7 h-7 rounded-full grid place-items-center text-sm font-bold ${on ? "bg-[var(--neon)] text-black" : "border border-white/30"}`}>{on ? "✓" : ""}</span>
              </button>
              {w.link && (
                <a href={w.link} target="_blank" rel="noreferrer"
                  className="text-xs font-semibold px-3 py-1.5 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95">
                  {w.linkLabel} ↗
                </a>
              )}
            </div>
          );
        })}
      </div>

      {/* quick log */}
      <h2 className="mt-7 mb-2 text-sm uppercase tracking-widest opacity-50">Quick log</h2>
      <div className="grid grid-cols-2 gap-2">
        <NumCard label="🔥 Calories" value={row.calories} onChange={(v) => save({ calories: v })} step={50} />
        <NumCard label="💪 Protein g" value={row.protein} onChange={(v) => save({ protein: v })} step={5} />
        <NumCard label="✍️ Vocab" value={row.vocab_count} onChange={(v) => save({ vocab_count: v })} step={1} />
        <NumCard label="⚖️ Weight lb" value={row.bodyweight ?? 0} onChange={(v) => save({ bodyweight: v })} step={1} decimals />
      </div>

      {/* 7-day strip */}
      <h2 className="mt-7 mb-2 text-sm uppercase tracking-widest opacity-50">Last 7 days</h2>
      <div className="flex justify-between gap-1">
        {history.map((d) => {
          const pct = d.score / WINS.length;
          const label = new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
          return (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full h-20 rounded-lg bg-white/5 flex items-end overflow-hidden">
                <div className="w-full rounded-lg bg-[var(--neon)]" style={{ height: `${Math.max(pct * 100, d.score ? 8 : 0)}%` }} />
              </div>
              <span className="text-[10px] opacity-50">{label}</span>
            </div>
          );
        })}
      </div>

      <button onClick={() => supabase.auth.signOut()} className="mt-8 mb-10 mx-auto block text-xs opacity-40 underline">
        Sign out
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="max-w-md mx-auto px-4 min-h-full">{children}</main>;
}

function Ring({ score, total }: { score: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, pct = total ? score / total : 0;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--neon)" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 34 34)" />
    </svg>
  );
}

function NumCard({ label, value, onChange, step, decimals }: { label: string; value: number; onChange: (v: number) => void; step: number; decimals?: boolean }) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-3">
      <p className="text-xs opacity-60 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(Math.max(0, +(value - step).toFixed(decimals ? 1 : 0)))}
          className="w-8 h-8 rounded-lg bg-white/10 text-lg active:scale-90">−</button>
        <input
          type="number" inputMode="decimal" value={value || ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="flex-1 w-full bg-transparent text-center text-xl font-bold outline-none" placeholder="0" />
        <button onClick={() => onChange(+(value + step).toFixed(decimals ? 1 : 0))}
          className="w-8 h-8 rounded-lg bg-white/10 text-lg active:scale-90">+</button>
      </div>
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
    <Shell>
      <div className="min-h-screen flex flex-col justify-center max-w-xs mx-auto">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-2xl font-bold">Daily</h1>
          <p className="opacity-50 text-sm mt-1">Your win stack. Private.</p>
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
    </Shell>
  );
}
