"use client";

// 🌍 Tonight's briefing — what actually happened in the world today.
//
// Ben's ask: economics, finance, crypto, conflicts, science — "no garbage".
// The garbage filter is structural: the server synthesizes ONLY from live
// headlines pulled from a fixed list of reputable feeds, and every item shows
// the real sources it came from, so nothing has to be taken on trust.
//
// Collapsed to the lede by default. He opens it when he wants it — a wall of
// news on the Card every morning would be exactly the noise he asked to avoid.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_ANON, NEWS_FN, todayStr } from "@/lib/supabase";
import { Card, Eyebrow } from "./ui";
import { sfx } from "@/lib/fx";

type Src = { title: string; url: string };
type Exposure = { name: string; ticker: string; dir: string; note: string };
type Item = { headline: string; why: string; sources: Src[]; exposure?: Exposure[]; thesis?: string };
type Section = { key: string; title: string; items: Item[] };
type Briefing = {
  id: string; day: string; lede: string; sections: Section[]; watch: string;
  sources_used: number; feeds_failed: string[]; created_at: string;
};

const BEAT_TONE: Record<string, string> = {
  econ: "var(--ok)", crypto: "var(--warn)", world: "var(--bad)", science: "var(--neon)", tech: "var(--text-2)",
};

// Direction, not a call. A tailwind is not "buy" and a headwind is not "sell" —
// it is which way the story points for that company's actual business.
// The arrow and its colour carry the meaning; the legend under the briefing
// spells it out in words, because a hover title is invisible on a phone.
const DIR: Record<string, { sign: string; tone: string }> = {
  tailwind: { sign: "\u2191", tone: "var(--ok)" },
  headwind: { sign: "\u2193", tone: "var(--bad)" },
  mixed: { sign: "\u2194", tone: "var(--warn)" },
};

export default function WorldBriefing({ uid }: { uid: string }) {
  const [b, setB] = useState<Briefing | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const gen = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("world_briefings")
        .select("*").eq("user_id", uid).order("day", { ascending: false }).limit(1);
      // a failed read must not look like "no briefing yet" and prompt a needless regenerate
      if (error) { setLoadErr(true); setLoaded(true); return; }
      const row = (data ?? [])[0] as Briefing | undefined;
      setB(row ?? null); setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function build() {
    if (gen.current) return;
    gen.current = true; setBusy(true); setErr("");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(NEWS_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ day: todayStr(), force: b?.day === todayStr() }),
      });
      const json = await res.json();
      if (json.error) { setErr(json.error); return; }
      if (json.briefing) { setB(json.briefing as Briefing); setOpen(true); sfx.pop(); }
    } catch { setErr("Couldn't reach the server — try again."); }
    finally { gen.current = false; setBusy(false); }
  }

  if (!loaded) return <div className="skeleton h-16 mt-3" />;

  const today = todayStr();
  const fresh = b?.day === today;

  return (
    <Card className="mt-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Tonight&apos;s briefing</Eyebrow>
        {b && (
          <span className="mono text-[9px] text-[var(--text-4)]">
            {fresh ? "today" : b.day} · {b.sources_used} headlines
          </span>
        )}
      </div>

      {loadErr ? (
        <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">
          Couldn&apos;t load the briefing — tap to retry
        </button>
      ) : !b ? (
        <div className="mt-2">
          <p className="text-sm text-[var(--text-3)]">Economy, crypto, world, science — pulled from real sources, no filler.</p>
          <button onClick={build} disabled={busy}
            className="mt-2.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold px-4 py-2 active:scale-95 disabled:opacity-50">
            {busy ? "reading the news…" : "Build tonight's briefing"}
          </button>
        </div>
      ) : (
        <>
          <button onClick={() => setOpen((v) => !v)} className="w-full text-left mt-1.5 active:scale-[0.99]">
            <p className="text-sm leading-snug">{b.lede}</p>
            <p className="mono text-[10px] text-[var(--neon)] mt-1.5">
              {open ? "▴ close" : `▾ ${b.sections.reduce((t, s) => t + s.items.length, 0)} things worth knowing`}
            </p>
          </button>

          {open && (
            <div className="mt-3 space-y-4 rise-in">
              {b.sections.map((sec) => (
                <div key={sec.key}>
                  <p className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: BEAT_TONE[sec.key] ?? "var(--text-2)" }}>
                    {sec.title}
                  </p>
                  <div className="space-y-2.5">
                    {sec.items.map((it, i) => (
                      <div key={i} className="border-l-2 pl-2.5" style={{ borderColor: BEAT_TONE[sec.key] ?? "var(--border-2)" }}>
                        <p className="text-[13px] font-semibold leading-snug">{it.headline}</p>
                        <p className="text-[12px] text-[var(--text-2)] leading-relaxed mt-0.5">{it.why}</p>
                        {it.sources.length > 0 && (
                          <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-1">
                            {it.sources.map((s, k) => (
                              <a key={k} href={s.url} target="_blank" rel="noopener noreferrer"
                                className="mono text-[9px] text-[var(--text-4)] underline decoration-dotted underline-offset-2 active:scale-95">
                                {s.title} ↗
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {b.watch && (
                <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-4)] mb-0.5">Watch tomorrow</p>
                  <p className="text-[12px] text-[var(--text-2)] leading-relaxed">{b.watch}</p>
                </div>
              )}

              {/* The tickers and the read are the model's interpretation, not a
                  data feed and not advice. Say so where he'll actually see it. */}
              <p className="text-[10px] text-[var(--text-4)] leading-relaxed">
                Arrows are which way a story points for that company&apos;s business
                (<span className="text-[var(--ok)]">&#8593;</span> tailwind,{" "}
                <span className="text-[var(--bad)]">&#8595;</span> headwind,{" "}
                <span className="text-[var(--warn)]">&#8596;</span> both ways) &mdash; not a call to buy or sell anything.
                The italic line is a read on what it means, written to be arguable. Both are interpretation, not a market
                data feed: check a ticker before you act on it.
              </p>

              {/* honesty: a thin briefing should say why it was thin */}
              {b.feeds_failed?.length > 0 && (
                <p className="mono text-[9px] text-[var(--text-4)]">
                  Didn&apos;t answer tonight: {b.feeds_failed.join(", ")}.
                </p>
              )}

              <div className="flex items-center gap-3">
                <button onClick={build} disabled={busy} className="mono text-[10px] text-[var(--neon)] active:scale-95 disabled:opacity-40">
                  {busy ? "rebuilding…" : fresh ? "rebuild" : "build tonight's"}
                </button>
                <span className="mono text-[9px] text-[var(--text-4)]">auto-builds nightly at 9pm</span>
              </div>
            </div>
          )}

          {!open && !fresh && (
            <button onClick={build} disabled={busy} className="mono text-[10px] text-[var(--neon)] mt-2 active:scale-95 disabled:opacity-40">
              {busy ? "reading the news…" : "build tonight's"}
            </button>
          )}
        </>
      )}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
