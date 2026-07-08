"use client";

import { useEffect } from "react";
import { burstConfetti } from "@/lib/confetti";
import { REWARDS } from "@/lib/gamification";

export function Ring({ score, total }: { score: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, pct = total ? score / total : 0;
  const full = pct >= 1;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" className={full ? "glow-neon rounded-full" : ""}>
      <defs>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#2dd4bf" />
        </linearGradient>
      </defs>
      <circle cx="34" cy="34" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="url(#ringGrad)" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 34 34)"
        style={{ transition: "stroke-dashoffset 0.5s ease" }} />
      {full && <text x="34" y="39" textAnchor="middle" fontSize="16">🔥</text>}
    </svg>
  );
}

export function NumCard({ label, value, onChange, step, decimals }: {
  label: string; value: number; onChange: (v: number) => void; step: number; decimals?: boolean;
}) {
  return (
    <Card padded={false} className="p-3">
      <p className="text-xs opacity-60 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(Math.max(0, +(value - step).toFixed(decimals ? 1 : 0)))}
          className="w-8 h-8 rounded-lg bg-white/10 text-lg active:scale-90">−</button>
        <input type="number" inputMode="decimal" value={value || ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="flex-1 w-full bg-transparent text-center text-xl font-bold outline-none" placeholder="0" />
        <button onClick={() => onChange(+(value + step).toFixed(decimals ? 1 : 0))}
          className="w-8 h-8 rounded-lg bg-white/10 text-lg active:scale-90">+</button>
      </div>
    </Card>
  );
}

export function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h2 id={id} className="mt-7 mb-2 text-sm uppercase tracking-widest opacity-50 scroll-mt-20">{children}</h2>;
}

// ── Shared visual primitives (design system) ─────────────────────────
export function Card({ children, className = "", tone = "default", padded = true }: {
  children: React.ReactNode; className?: string; tone?: "default" | "neon" | "warn"; padded?: boolean;
}) {
  const tones: Record<string, string> = {
    default: "bg-white/5 border-white/10 shadow-[0_2px_12px_rgba(0,0,0,0.25)]",
    neon: "bg-[var(--neon)]/10 border-[var(--neon)]/40 shadow-[0_2px_16px_rgba(52,211,153,0.08)]",
    warn: "bg-orange-500/10 border-orange-500/40",
  };
  return (
    <div className={`rounded-2xl border backdrop-blur-[2px] ${tones[tone]} ${padded ? "p-4" : ""} ${className}`}>{children}</div>
  );
}

export function ProgressBar({ pct, tone = "neon" }: { pct: number; tone?: "neon" | "gold" }) {
  const color = tone === "gold"
    ? "linear-gradient(90deg,#fbbf24,#f59e0b)"
    : "linear-gradient(90deg,#34d399,#2dd4bf)";
  return (
    <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(Math.max(pct * 100, pct > 0 ? 2 : 0), 100)}%`, background: color }} />
    </div>
  );
}

// Multi-series sparkline with optional dashed goal line. Normalized to the
// combined min/max so series and goal share one scale.
export function Sparkline({ series, goal, height = 56 }: {
  series: { values: number[]; color: string; width?: number; opacity?: number }[];
  goal?: number;
  height?: number;
}) {
  const all = series.flatMap((s) => s.values).concat(goal != null ? [goal] : []);
  if (all.length < 2) return null;
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const y = (v: number) => 38 - ((v - min) / span) * 34; // 2..38 padding
  const line = (values: number[]) =>
    values.map((v, i) => `${(i / (values.length - 1)) * 100},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: "100%", height }} aria-hidden>
      {goal != null && (
        <line x1="0" x2="100" y1={y(goal)} y2={y(goal)} stroke="rgba(255,255,255,0.35)" strokeWidth="0.7" strokeDasharray="3 2.5" vectorEffect="non-scaling-stroke" />
      )}
      {series.map((s, i) => s.values.length >= 2 && (
        <polyline key={i} points={line(s.values)} fill="none" stroke={s.color}
          strokeWidth={s.width ?? 1.6} strokeLinejoin="round" strokeLinecap="round"
          opacity={s.opacity ?? 1} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition ${active ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>
      {children}
    </button>
  );
}

// Full-screen level-up moment — there are only ~50 of these, make them count.
export function LevelUpModal({ level, title, onClose }: { level: number; title: string; onClose: () => void }) {
  useEffect(() => {
    burstConfetti("big");
    import("@/lib/fx").then((fx) => fx.sfx.levelup());
  }, []);
  const rewards = REWARDS.filter((r) => r.level === level);
  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm grid place-items-center p-6" onClick={onClose}>
      <div className="text-center" style={{ animation: "levelPop 0.5s ease" }}>
        <p className="text-xs uppercase tracking-[0.3em] text-[var(--neon)]/70 mb-3">Level up</p>
        <p className="text-7xl font-black text-glow text-[var(--neon)]">{level}</p>
        <p className="text-2xl font-extrabold mt-2">{title}</p>
        {rewards.map((r) => (
          <div key={r.key} className="mt-4 rounded-2xl border border-[#ffd54a]/50 bg-[#ffd54a]/10 px-4 py-3">
            <p className="text-xs uppercase tracking-widest text-[#ffd54a]">🎁 Reward unlocked</p>
            <p className="font-bold mt-1">{r.emoji} {r.name}</p>
          </div>
        ))}
        <button onClick={onClose} className="mt-8 px-8 py-3 rounded-xl bg-[var(--neon)] text-black font-bold glow-neon active:scale-95">
          Keep going →
        </button>
      </div>
    </div>
  );
}

// Achievement toast — slides in with a little confetti, self-dismisses.
export function Celebration({ emoji, title, subtitle, onClose }: {
  emoji: string; title: string; subtitle?: string; onClose: () => void;
}) {
  useEffect(() => {
    burstConfetti("small");
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div onClick={onClose} className="fixed top-3 left-3 right-3 z-40 mx-auto max-w-sm cursor-pointer" style={{ animation: "slideDown 0.25s ease" }}>
      <div className="rounded-2xl border border-[var(--neon)]/40 bg-[var(--background)] glow-neon px-4 py-3 flex items-center gap-3">
        <span className="text-2xl shrink-0">{emoji}</span>
        <div className="min-w-0">
          <p className="text-xs opacity-50">Achievement unlocked</p>
          <p className="font-semibold truncate">{title}{subtitle && <span className="text-[var(--neon)] font-normal"> · {subtitle}</span>}</p>
        </div>
      </div>
    </div>
  );
}
