"use client";

export function Ring({ score, total }: { score: number; total: number }) {
  const r = 26, c = 2 * Math.PI * r, pct = total ? score / total : 0;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68">
      <circle cx="34" cy="34" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" />
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--neon)" strokeWidth="7" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 34 34)" />
    </svg>
  );
}

export function NumCard({ label, value, onChange, step, decimals }: {
  label: string; value: number; onChange: (v: number) => void; step: number; decimals?: boolean;
}) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-3">
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
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-7 mb-2 text-sm uppercase tracking-widest opacity-50">{children}</h2>;
}
