"use client";

import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";
import { burstConfetti } from "@/lib/confetti";
import { REWARDS } from "@/lib/gamification";

// Every changing number rolls like an odometer — the machine registers effort.
export function Num({ value, className = "" }: { value: number; className?: string }) {
  return (
    <NumberFlow value={value} className={`mono ${className}`}
      transformTiming={{ duration: 450, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }} />
  );
}

export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`eyebrow ${className}`}>{children}</p>;
}

// Segmented status ring (WHOOP/Apple grammar): n equal arcs closing clockwise,
// each colored by its own state. The Card's hero and the season map's TODAY node.
export function SegRing({ size = 112, stroke = 8, done, color = "var(--neon)", children }: {
  size?: number; stroke?: number; done: boolean[]; color?: string; children?: React.ReactNode;
}) {
  const n = Math.max(1, done.length);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = n > 1 ? Math.max(3, c * 0.012) : 0;
  const seg = c / n - gap;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {done.map((ok, i) => (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={ok ? color : "rgba(255,255,255,0.07)"}
            strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${seg} ${c - seg}`}
            strokeDashoffset={-(i * (seg + gap))}
            style={{ transition: "stroke 0.35s ease" }} />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

// Single-value progress ring — rep counter, fuel gauge.
export function ProgressCircle({ pct, size = 64, stroke = 6, color = "var(--neon)", children }: {
  pct: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, pct));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p)}
          style={{ transition: "stroke-dashoffset 0.5s cubic-bezier(0.2,0.7,0.2,1), stroke 0.3s ease" }} />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

// Numeric stepper (Origin UI density): tap ± for discrete writes, type for exact.
// Commit-on-blur like NumCard so a typed "225" never races as 2 → 22 → 225.
export function Stepper({ value, onCommit, step = 5, min = 0, placeholder, className = "" }: {
  value: number | null; onCommit: (v: number | null) => void; step?: number; min?: number;
  placeholder?: string; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? "" : String(value));
  const commit = () => {
    if (draft === null) return;
    const t = draft.trim();
    setDraft(null);
    if (t === "") { if (value !== null) onCommit(null); return; }
    const v = Number(t);
    if (!Number.isNaN(v) && v !== value) onCommit(Math.max(min, v));
  };
  const bump = (d: number) => {
    // an unblurred typed draft is the user's freshest intent — step from IT,
    // never from the stale committed value (iOS Safari doesn't blur inputs
    // when a button is tapped, so commit-on-blur alone can't be relied on)
    const typed = draft !== null && draft.trim() !== "" && !Number.isNaN(Number(draft)) ? Number(draft) : null;
    setDraft(null);
    onCommit(Math.max(min, (typed ?? value ?? 0) + d));
  };
  return (
    <div className={`flex items-center rounded-lg bg-black/30 border border-[var(--border-1)] ${className}`}>
      <button onClick={() => bump(-step)} className="px-2.5 py-2 text-sm opacity-50 active:scale-90" tabIndex={-1}>−</button>
      <input type="number" inputMode="decimal" value={shown} placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-full min-w-0 bg-transparent text-center outline-none text-sm font-semibold mono" />
      <button onClick={() => bump(step)} className="px-2.5 py-2 text-sm opacity-50 active:scale-90" tabIndex={-1}>＋</button>
    </div>
  );
}

export function Ring({ score, total }: { score: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, pct = total ? score / total : 0;
  const full = pct >= 1;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" className={full ? "glow-neon rounded-full" : ""}>
      <defs>
        <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c87f0" />
          <stop offset="100%" stopColor="#7c87f0" />
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
  // Typing "185" used to fire onChange on every keystroke (1 → 18 → 185), so
  // three DB upserts raced and an out-of-order one could bank a wrong prefix.
  // Hold a local draft and commit ONCE on blur / Enter; the steppers commit
  // immediately (they're discrete, single writes).
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(value) : "");
  const round = (v: number) => +v.toFixed(decimals ? 1 : 0);
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim() === "" ? 0 : Number(draft);
    setDraft(null);
    if (!Number.isNaN(v) && round(v) !== value) onChange(round(v));
  };
  const bump = (delta: number) => { setDraft(null); onChange(Math.max(0, round(value + delta))); };
  return (
    <Card padded={false} className="p-3">
      <p className="text-xs opacity-60 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <button onClick={() => bump(-step)}
          className="w-8 h-8 rounded-lg bg-white/10 text-lg active:scale-90">−</button>
        <input type="number" inputMode="decimal" value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="flex-1 w-full bg-transparent text-center text-xl font-bold outline-none" placeholder="0" />
        <button onClick={() => bump(step)}
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
  children: React.ReactNode; className?: string; tone?: "default" | "raised" | "neon" | "warn" | "paper"; padded?: boolean;
}) {
  const tones: Record<string, string> = {
    default: "bg-[var(--card)] border-[var(--border-1)]",
    raised: "bg-[var(--raised)] border-[var(--border-2)]",
    neon: "bg-[var(--neon)]/[0.08] border-[var(--neon)]/30",
    warn: "bg-orange-500/[0.08] border-orange-500/30",
    paper: "paper",
  };
  return (
    <div className={`rounded-xl border ${tones[tone]} ${padded ? "p-4" : ""} ${className}`}>{children}</div>
  );
}

// Clean segmented control — one accent, muscle-memory friendly. For the
// notebook's section switcher (Guide / Learn / Cards / Map / Chat).
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { key: T; label: string; icon?: string }[];
}) {
  return (
    // scrolls rather than overflowing when there are many tabs (6 at 375px)
    <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/10 overflow-x-auto no-scrollbar">
      {options.map((o) => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`shrink-0 whitespace-nowrap px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${value === o.key ? "bg-[var(--neon)] text-black" : "opacity-55 hover:opacity-90"}`}>
          {o.icon ? <span className="mr-1">{o.icon}</span> : null}{o.label}
        </button>
      ))}
    </div>
  );
}

// Minimal, SAFE inline renderer — **bold**, *italic*, `code`. No innerHTML.
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={`${keyBase}-${i++}`} className="px-1 rounded bg-white/10 text-[0.88em] font-mono">{tok.slice(1, -1)}</code>);
    else parts.push(<em key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Editorial prose — teaching text reads like a book (serif, generous leading).
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  const paras = (text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`study-prose ${className}`}>
      {paras.map((p, i) => {
        if (/^#{1,3}\s/.test(p)) return <h3 key={i}>{renderInline(p.replace(/^#{1,3}\s+/, ""), `h${i}`)}</h3>;
        const lines = p.split(/\n/);
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <span key={j}>{renderInline(line, `p${i}-${j}`)}{j < lines.length - 1 ? <br /> : null}</span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function ProgressBar({ pct, tone = "neon" }: { pct: number; tone?: "neon" | "gold" }) {
  const color = tone === "gold"
    ? "linear-gradient(90deg,#fbbf24,#f59e0b)"
    : "var(--neon)";
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
