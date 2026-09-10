"use client";

// Feed — the news funnel, live. Seventeen sources every fifteen minutes,
// each headline tagged by a cheap model with the tickers it touches, an
// impact score, a direction, a horizon, a plain-words line on what actually
// happened and what it means for the price, and one line on the mechanism.
// The scan turns the strong ones into setups; here Ben sees the raw stream
// and learns to read it. Every label is explained where it sits.

import { useCallback, useEffect, useState } from "react";
import { Card, Pill } from "../ui";
import { callFn, FEED_FN, loadNews, fmtMoney, type NewsItem } from "@/lib/desk/api";
import { sfx, buzz } from "@/lib/fx";

type Filter = "all" | "high" | "stocks" | "crypto" | "macro";
const CATEGORY: Record<string, string> = { macro: "macro", earnings: "earnings", guidance: "guidance", deal: "deal", regulation: "regulation", geopolitics: "geopolitics", crypto: "crypto", company: "company", other: "" };
const HORIZON: Record<string, string> = { scalp: "hours", swing: "days", position: "weeks" };

export default function Feed() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadNews(200, { sinceHours: 48 });
    setErr(r.error);
    if (!r.error) setItems(r.items);
    setNow(Date.now());
    setLoaded(true);
  }, []);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  useEffect(() => { const id = setInterval(load, 5 * 60_000); return () => clearInterval(id); }, [load]);

  async function refresh() {
    if (busy) return;
    setBusy(true); setNote("");
    const r = await callFn<{ new?: number; tagged?: number; cost?: number; tag_error?: string }>(FEED_FN, { mode: "ingest" }, 140_000);
    setBusy(false);
    if (r.error) { setNote(r.error); return; }
    setNote(`${r.new ?? 0} new, ${r.tagged ?? 0} tagged for ${fmtMoney(r.cost ?? 0, 3)}${r.tag_error ? ` (tagging: ${r.tag_error})` : ""}`);
    sfx.coin(); buzz(8);
    await load();
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-10" /><div className="skeleton h-64 mt-3" /></div>;

  const shown = items.filter((x) => filter === "all" ? true : filter === "high" ? x.impact >= 4 : filter === "stocks" ? x.venue === "stock" : filter === "crypto" ? x.venue === "crypto" : x.venue === "macro");
  const untagged = items.filter((x) => !x.tagged).length;

  return (
    <div className="pt-3">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {(["all", "high", "stocks", "crypto", "macro"] as Filter[]).map((f) => (
          <Pill key={f} active={filter === f} onClick={() => setFilter(f)}>{f === "high" ? "high impact" : f}</Pill>
        ))}
        <span className="flex-1" />
        <button onClick={refresh} disabled={busy} className="shrink-0 mono text-[10px] text-[var(--neon)] px-2 py-1.5 active:scale-95 disabled:opacity-50">{busy ? "pulling…" : "pull now"}</button>
      </div>
      {(note || err) && <p className={`text-[11px] mt-1 ${err ? "text-orange-400" : "text-[var(--text-3)]"}`}>{err || note}</p>}
      <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">
        {items.length} headlines from the last two days{untagged ? `, ${untagged} not tagged yet` : ""}. Dots are impact: five means it can move an index or a major coin today, four moves a specific name, three is context, one is noise. Chips are the tickers the story touches, green for bullish, red for bearish. Under each headline is what actually happened and what it means for the price, in plain words; the smaller line beneath it is the mechanism, how the story reaches the price. Older headlines tagged before the plain line existed show the mechanism alone.
      </p>

      <div className="mt-2 space-y-1.5">
        {shown.length === 0 && <Card><p className="text-[12px] text-[var(--text-3)]">Nothing here yet. The feed pulls every fifteen minutes; press pull now to fetch this minute.</p></Card>}
        {shown.map((x) => {
          const isOpen = open === x.id;
          return (
            <Card key={x.id} padded={false} className={x.impact >= 4 ? "border-[var(--neon)]/30" : ""}>
              <button onClick={() => setOpen(isOpen ? null : x.id)} className="w-full text-left px-3 py-2.5 active:scale-[0.995]">
                <div className="flex items-start gap-2">
                  <Impact n={x.impact} tagged={x.tagged} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] font-semibold leading-snug">{x.title}</p>
                    <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">{x.source} · {ago(x.published, now)}{CATEGORY[x.category] ? ` · ${CATEGORY[x.category]}` : ""}{HORIZON[x.horizon] ? ` · ${HORIZON[x.horizon]}` : ""}</p>
                    {(x.plain || x.why) && <p className="text-[11px] text-[var(--text-2)] mt-1 leading-snug">{x.plain || x.why}</p>}
                    {x.plain && x.why && x.why.trim() !== x.plain.trim() && <p className="text-[10px] text-[var(--text-4)] mt-0.5 leading-snug">How it moves the price: {x.why}</p>}
                    {x.tickers.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {x.tickers.map((t) => (
                          <span key={t} className="mono text-[10px] px-1.5 py-0.5 rounded-md border" style={{ color: tone(x.direction), borderColor: "var(--border-1)", background: "var(--raised)" }}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
              {isOpen && (
                <div className="px-3 pb-3 -mt-1 rise-in">
                  {x.summary && <p className="text-[11.5px] text-[var(--text-3)] leading-relaxed">{x.summary}</p>}
                  <a href={x.link} target="_blank" rel="noopener noreferrer" className="mono text-[10px] text-[var(--neon)] mt-1.5 inline-block">open the source</a>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Impact({ n, tagged }: { n: number; tagged: boolean }) {
  if (!tagged) return <span className="mono text-[9px] text-[var(--text-4)] w-9 shrink-0 pt-1">tagging</span>;
  return (
    <div className="flex flex-col gap-[3px] shrink-0 pt-1 w-9">
      <div className="flex gap-[3px]">
        {[1, 2, 3, 4, 5].map((i) => <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ background: i <= n ? (n >= 4 ? "var(--neon)" : n === 3 ? "var(--warn)" : "var(--text-4)") : "var(--border-1)" }} />)}
      </div>
    </div>
  );
}

const tone = (d: string) => (d === "bullish" ? "var(--ok)" : d === "bearish" ? "var(--bad)" : d === "mixed" ? "var(--warn)" : "var(--text-3)");
function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
