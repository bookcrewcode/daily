"use client";

// Chart — the price picture behind a decision. Two views: the desk's own
// candles, drawn from the same tape the scan reads, with the trade's levels
// and the moments that mattered marked on them; or TradingView's free chart
// for anyone who wants its own tools. Nothing here places a trade, and a
// crash in either view is caught so the page around it stays up.

import { Component, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createChart, CandlestickSeries, createSeriesMarkers, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi,
  type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { Segmented } from "../ui";
import { callFn, TAPE_FN, fmtPrice } from "@/lib/desk/api";
import type { Instrument, Venue } from "@/lib/desk/types";

export type ChartLevels = { entry?: number | null; stop?: number | null; target?: number | null; liq?: number | null };
export type ChartMarker = { t: number; kind: "entry" | "exit" | "decision"; price?: number; label: string; color?: string }; // t = epoch ms

type Interval = "5m" | "15m" | "1h" | "4h" | "1d";
type View = "ours" | "tv";
type TapeBar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Colors = { ok: string; bad: string; warn: string; neon: string; text3: string; text4: string; grid: string; entry: string };

type Props = {
  symbol: string; venue: Venue; instrument: Instrument;
  interval?: Interval; levels?: ChartLevels; markers?: ChartMarker[]; height?: number; title?: string;
};

const IV_LABEL: Record<Interval, string> = { "5m": "5 min", "15m": "15 min", "1h": "1 hour", "4h": "4 hour", "1d": "1 day" };
const SOURCE_NAME: Record<string, string> = { blofin: "BloFin", coinbase: "Coinbase", yahoo: "Yahoo Finance", stooq: "Stooq" };
const isStockLike = (i: Instrument) => i === "stock" || i === "etf";
const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** The symbol as TradingView spells it: perps on BloFin, spot pairs on Coinbase, stocks bare. */
export function tvSymbol(symbol: string, venue: Venue): string {
  const s = String(symbol ?? "").trim().toUpperCase();
  const base = s.split("-")[0];
  if (venue === "blofin") return `BLOFIN:${base}USDT.P`;
  if (s.includes("-")) return `COINBASE:${s.replace(/-/g, "")}`;
  return s;
}

/* ── TradingView's script, loaded once for the whole app ───────────────── */
interface TradingViewWidgetConfig {
  autosize: boolean; symbol: string; interval: string; timezone: string; theme: string; style: string;
  locale: string; hide_side_toolbar: boolean; allow_symbol_change: boolean; container_id: string;
}
interface TradingViewApi { widget: new (config: TradingViewWidgetConfig) => unknown }
declare global { interface Window { TradingView?: TradingViewApi } }

let tvScript: Promise<void> | null = null;
function loadTradingView(): Promise<void> {
  if (tvScript) return tvScript;
  const p = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") { reject(new Error("no document")); return; }
    if (window.TradingView) { resolve(); return; }
    const el = document.createElement("script");
    el.src = "https://s3.tradingview.com/tv.js";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("blocked"));
    document.head.appendChild(el);
  });
  tvScript = p;
  p.catch(() => { tvScript = null; }); // a blocked load must not poison every later try
  return p;
}

/* ── the component ─────────────────────────────────────────────────────── */
export default function Chart(props: Props) {
  return <ChartBoundary><ChartInner {...props} /></ChartBoundary>;
}

function ChartInner({ symbol, venue, instrument, interval, levels, markers, height = 260, title }: Props) {
  const [view, setView] = useState<View>("ours");
  const [iv, setIv] = useState<Interval>(interval ?? "1h");
  const stock = isStockLike(instrument);
  const ivUsed: Interval = stock && iv === "4h" ? "1h" : iv; // stocks have no 4-hour bars

  // Props that are objects arrive fresh on every parent render; round-trip them
  // so the drawing effect only fires when the numbers actually changed.
  const levelsKey = JSON.stringify(levels ?? {});
  const markersKey = JSON.stringify(markers ?? []);
  const lv = useMemo(() => JSON.parse(levelsKey) as ChartLevels, [levelsKey]);
  const mk = useMemo(() => JSON.parse(markersKey) as ChartMarker[], [markersKey]);

  const ivOptions = useMemo(
    () => (["5m", "15m", "1h", "4h", "1d"] as Interval[])
      .filter((k) => (k === "15m" ? interval === "15m" : true))
      .filter((k) => !(stock && k === "4h"))
      .map((k) => ({ key: k, label: IV_LABEL[k] })),
    [interval, stock],
  );

  const [bars, setBars] = useState<TapeBar[]>([]);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqRef.current;
    setLoading(true); setErr("");
    const body: Record<string, unknown> = { mode: "bars", symbol, venue, instrument, interval: ivUsed, limit: 300 };
    if (stock && (ivUsed === "5m" || ivUsed === "15m")) body.range = "5d";
    const r = await callFn<{ bars?: TapeBar[]; source?: string }>(TAPE_FN, body);
    if (reqRef.current !== mine) return; // a newer interval already asked
    const rows = Array.isArray(r.bars) ? r.bars : [];
    if (r.error || rows.length === 0) {
      setBars([]); setSource("");
      setErr(r.error || "No bars came back for this symbol at this interval.");
    } else {
      setBars(rows); setSource(String(r.source ?? "")); setErr("");
    }
    setLoading(false);
  }, [symbol, venue, instrument, ivUsed, stock]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const colorsRef = useRef<Colors | null>(null);
  const [epoch, setEpoch] = useState(0); // bumped when a fresh chart exists, so the data effect re-runs

  useEffect(() => {
    if (view !== "ours") return;
    const el = boxRef.current;
    if (!el) return;
    const css = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };
    const c: Colors = {
      ok: css("--ok", "#4ade80"), bad: css("--bad", "#f87171"), warn: css("--warn", "#fbbf24"),
      neon: css("--neon", "#7c87f0"), text3: css("--text-3", "#8a8f98"), text4: css("--text-4", "#62666d"),
      grid: "rgba(255,255,255,0.05)", entry: "#9aa0aa",
    };
    colorsRef.current = c;
    const chart = createChart(el, {
      width: el.clientWidth || 320,
      height,
      autoSize: false,
      layout: { background: { color: "transparent" }, textColor: c.text3, fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { visible: true, borderVisible: false },
      leftPriceScale: { visible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { color: c.text4, labelBackgroundColor: c.text4 }, vertLine: { color: c.text4, labelBackgroundColor: c.text4 } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: c.ok, downColor: c.bad, borderUpColor: c.ok, borderDownColor: c.bad, wickUpColor: c.ok, wickDownColor: c.bad,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w > 0) chart.applyOptions({ width: w, height }); });
    ro.observe(el);
    setEpoch((n) => n + 1);
    return () => {
      ro.disconnect();
      markersRef.current = null;
      linesRef.current = [];
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [view, height]);

  useEffect(() => {
    const chart = chartRef.current, series = seriesRef.current, c = colorsRef.current;
    if (!chart || !series || !c) return;
    const data = bars
      .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
      .map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
      .sort((a, b) => (a.time as number) - (b.time as number))
      .filter((b, i, all) => i === 0 || b.time !== all[i - 1].time);
    series.setData(data);

    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    const wanted: { v: number | null | undefined; title: string; color: string; style: LineStyle }[] = [
      { v: lv.entry, title: "entry", color: c.entry, style: LineStyle.Solid },
      { v: lv.stop, title: "stop", color: c.bad, style: LineStyle.Solid },
      { v: lv.target, title: "target", color: c.ok, style: LineStyle.Solid },
      { v: lv.liq, title: "liquidation", color: c.warn, style: LineStyle.Dashed },
    ];
    for (const w of wanted) {
      if (!finite(w.v)) continue;
      linesRef.current.push(series.createPriceLine({ price: w.v, color: w.color, lineWidth: 1, lineStyle: w.style, title: w.title, axisLabelVisible: true }));
    }

    const times = data.map((d) => d.time as number);
    const snap = (ms: number): UTCTimestamp => {
      const s = Math.floor(ms / 1000);
      if (times.length === 0) return s as UTCTimestamp;
      let best = times[0];
      for (const t of times) { if (t <= s) best = t; else break; }
      return best as UTCTimestamp;
    };
    const shaped: SeriesMarker<Time>[] = mk
      .filter((m) => Number.isFinite(m.t))
      .slice()
      .sort((a, b) => a.t - b.t)
      .map((m) => ({
        time: snap(m.t),
        position: m.kind === "entry" ? ("belowBar" as const) : ("aboveBar" as const),
        shape: m.kind === "entry" ? ("arrowUp" as const) : m.kind === "exit" ? ("arrowDown" as const) : ("circle" as const),
        color: m.color || (m.kind === "entry" ? c.ok : m.kind === "exit" ? c.bad : c.neon),
        text: m.label,
      }));
    if (markersRef.current) markersRef.current.setMarkers(shaped);
    else markersRef.current = createSeriesMarkers(series, shaped);

    if (data.length > 0) chart.timeScale().fitContent();
  }, [epoch, bars, lv, mk]);

  const levelText = [
    finite(lv.entry) ? `entry ${fmtPrice(lv.entry)}` : "",
    finite(lv.stop) ? `stop ${fmtPrice(lv.stop)}` : "",
    finite(lv.target) ? `target ${fmtPrice(lv.target)}` : "",
    finite(lv.liq) ? `liquidation ${fmtPrice(lv.liq)}` : "",
  ].filter(Boolean).join(", ");

  return (
    <div>
      {title ? <p className="mono text-[10px] uppercase tracking-widest text-[var(--text-4)] mb-1.5">{title}</p> : null}
      <Segmented value={view} onChange={setView} options={[{ key: "ours", label: "Our chart" }, { key: "tv", label: "TradingView" }]} />
      {view === "ours" ? (
        <div className="mt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">Bar size · how much time each candle covers</p>
          <Segmented value={ivUsed} onChange={setIv} options={ivOptions} />
          <div className="mt-2 relative rounded-lg overflow-hidden border border-[var(--border-1)]" style={{ height }}>
            <div ref={boxRef} className="absolute inset-0" />
            {loading && bars.length === 0 && <div className="skeleton absolute inset-0" />}
            {!loading && err && (
              <div className="absolute inset-0 grid place-items-center px-4 text-center bg-[var(--card)]">
                <div>
                  <p className="text-[11.5px] text-[var(--text-2)] leading-snug">{err}</p>
                  <button onClick={load} className="mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold px-4 py-2 active:scale-95">Try again</button>
                </div>
              </div>
            )}
          </div>
          <p className="text-[10.5px] text-[var(--text-3)] leading-snug mt-1.5">
            Lines: entry, stop (where the trade is wrong), target, liquidation (where the exchange closes it)
          </p>
          <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">
            {symbol} · {IV_LABEL[ivUsed]} bars{bars.length ? ` · ${bars.length} of them` : ""}{source ? ` · from ${SOURCE_NAME[source] ?? source}` : ""}
          </p>
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-[11px] text-[var(--text-2)] leading-snug">
            {levelText
              ? `TradingView cannot draw the desk's levels; they are: ${levelText}`
              : "TradingView cannot draw the desk's levels, and this decision has none yet."}
          </p>
          <p className="text-[10.5px] text-[var(--text-3)] leading-snug mt-0.5">If the symbol does not resolve, change it in the widget.</p>
          <TradingViewPane symbol={symbol} venue={venue} height={height} />
        </div>
      )}
    </div>
  );
}

function TradingViewPane({ symbol, venue, height }: { symbol: string; venue: Venue; height: number }) {
  const raw = useId();
  const containerId = `tv-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [tries, setTries] = useState(0);
  // The failure is stamped with the try it belongs to, so a new symbol or a
  // retry clears it without an effect writing state on the way in.
  const attempt = `${symbol}|${venue}|${tries}`;
  const [failed, setFailed] = useState<{ attempt: string; msg: string } | null>(null);
  const tvErr = failed && failed.attempt === attempt ? failed.msg : "";

  useEffect(() => {
    let alive = true;
    loadTradingView()
      .then(() => {
        if (!alive) return;
        const el = document.getElementById(containerId);
        const tv = window.TradingView;
        if (!el || !tv) { setFailed({ attempt, msg: "TradingView loaded but did not hand back its widget." }); return; }
        el.innerHTML = "";
        new tv.widget({
          autosize: true,
          symbol: tvSymbol(symbol, venue),
          interval: "60",
          timezone: "America/New_York",
          theme: "dark",
          style: "1",
          locale: "en",
          hide_side_toolbar: false,
          allow_symbol_change: true,
          container_id: containerId,
        });
      })
      .catch(() => { if (alive) setFailed({ attempt, msg: "TradingView's script did not load. A blocker or the network may be stopping it." }); });
    return () => {
      alive = false;
      const el = document.getElementById(containerId);
      if (el) el.innerHTML = "";
    };
  }, [symbol, venue, containerId, attempt]);

  return (
    <div className="mt-2">
      <div id={containerId} className="rounded-lg overflow-hidden border border-[var(--border-1)]" style={{ height: Math.max(height, 320) }} />
      {tvErr && (
        <div className="mt-1.5">
          <p className="text-[11.5px] text-[var(--text-2)] leading-snug">{tvErr}</p>
          <button onClick={() => setTries((n) => n + 1)} className="mt-1.5 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold px-4 py-2 active:scale-95">Try again</button>
        </div>
      )}
      <p className="mono text-[9px] text-[var(--text-4)] mt-1">{tvSymbol(symbol, venue)} · hourly · New York time</p>
    </div>
  );
}

/* ── a crash in one view must not blank the page around it ─────────────── */
class ChartBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() { return { broken: true }; }
  componentDidCatch(error: unknown) { console.error("Chart crashed", error); }
  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <div className="rounded-lg border border-orange-400/40 bg-orange-500/10 px-3 py-3">
        <p className="text-[12px] font-semibold text-orange-200">The chart could not be drawn.</p>
        <p className="text-[11px] text-[var(--text-3)] mt-0.5 leading-snug">Everything else on this card still reads. Reload the page to try the chart again.</p>
      </div>
    );
  }
}
