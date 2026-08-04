"use client";

// 🖼️ Diagrams — the antidote to "it's just walls of text".
//
// The AI emits a tiny declarative shape (flow / compare / cycle / stack) and we
// render it natively with layout + CSS. No image generation, no latency, no
// broken alt-text — and it reflows properly on a phone, which a generated PNG
// never would.

export type DiagramSpec = {
  kind: "flow" | "compare" | "cycle" | "stack";
  title?: string;
  nodes: { label: string; note?: string }[];
};

function Node({ label, note, tone = "default" }: { label: string; note?: string; tone?: "default" | "accent" }) {
  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${tone === "accent" ? "bg-[var(--neon)]/15 border-[var(--neon)]/40" : "bg-white/[0.06] border-white/12"}`}>
      <p className="text-[13px] font-semibold leading-tight">{label}</p>
      {note && <p className="text-[10px] opacity-55 mt-0.5 leading-tight">{note}</p>}
    </div>
  );
}

export default function Diagram({ spec }: { spec: DiagramSpec }) {
  const { kind, title, nodes } = spec;
  if (!nodes?.length) return null;

  return (
    <div className="my-3 rounded-2xl border border-white/10 bg-black/20 p-3">
      {title && <p className="text-[10px] uppercase tracking-widest opacity-45 mb-2 text-center">{title}</p>}

      {kind === "flow" && (
        <div className="flex flex-col gap-1.5">
          {nodes.map((n, i) => (
            <div key={i}>
              <Node {...n} tone={i === 0 ? "accent" : "default"} />
              {i < nodes.length - 1 && <p className="text-center text-[var(--neon)]/60 text-sm leading-none my-0.5">↓</p>}
            </div>
          ))}
        </div>
      )}

      {kind === "compare" && (
        <div className="grid grid-cols-2 gap-2 items-stretch">
          {nodes.slice(0, 2).map((n, i) => (
            <div key={i} className="flex"><div className="flex-1"><Node {...n} tone={i === 0 ? "accent" : "default"} /></div></div>
          ))}
        </div>
      )}

      {kind === "cycle" && (
        <div className="flex flex-col gap-1.5">
          {nodes.map((n, i) => (
            <div key={i}>
              <Node {...n} tone="accent" />
              <p className="text-center text-[var(--neon)]/60 text-sm leading-none my-0.5">{i < nodes.length - 1 ? "↓" : "↻"}</p>
            </div>
          ))}
          <p className="text-center text-[10px] opacity-40 -mt-1">loops back to the start</p>
        </div>
      )}

      {kind === "stack" && (
        <div className="flex flex-col-reverse gap-1">
          {nodes.map((n, i) => (
            <div key={i} style={{ marginInline: `${i * 6}px` }}>
              <Node {...n} tone={i === 0 ? "accent" : "default"} />
            </div>
          ))}
          <p className="text-center text-[10px] opacity-40 mb-1">built on the layer below</p>
        </div>
      )}
    </div>
  );
}
