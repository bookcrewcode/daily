"use client";

import { useEffect } from "react";

export function Ring({ score, total }: { score: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, pct = total ? score / total : 0;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--neon)" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 34 34)"
        style={{ transition: "stroke-dashoffset 0.5s ease" }} />
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
    default: "bg-white/5 border-white/10",
    neon: "bg-[var(--neon)]/10 border-[var(--neon)]/40",
    warn: "bg-orange-500/10 border-orange-500/40",
  };
  return (
    <div className={`rounded-2xl border ${tones[tone]} ${padded ? "p-4" : ""} ${className}`}>{children}</div>
  );
}

export function ProgressBar({ pct, tone = "neon" }: { pct: number; tone?: "neon" | "gold" }) {
  const color = tone === "gold" ? "#ffd54a" : "var(--neon)";
  return (
    <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(Math.max(pct * 100, pct > 0 ? 2 : 0), 100)}%`, background: color }} />
    </div>
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

// Full-screen-friendly celebration modal — used for achievement unlocks / level-ups.
export function Celebration({ emoji, title, subtitle, onClose }: {
  emoji: string; title: string; subtitle?: string; onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 3200);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div onClick={onClose} className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center px-6" style={{ animation: "fadeIn 0.2s ease" }}>
      <div className="text-center" style={{ animation: "popIn 0.4s cubic-bezier(0.34,1.56,0.64,1)" }}>
        <p className="text-7xl mb-3">{emoji}</p>
        <p className="text-xs uppercase tracking-widest text-[var(--neon)] mb-1">Unlocked</p>
        <p className="text-2xl font-extrabold">{title}</p>
        {subtitle && <p className="opacity-60 text-sm mt-1">{subtitle}</p>}
        <p className="opacity-30 text-xs mt-6">tap to dismiss</p>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes popIn { from { opacity: 0; transform: scale(0.7) } to { opacity: 1; transform: scale(1) } }
      `}</style>
    </div>
  );
}
