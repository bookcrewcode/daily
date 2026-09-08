// The Desk — technical indicators and the tape card the jurors read. Pure.
// Only tools with evidence behind them as RISK and REGIME tools (research
// brief 1): trend state, RSI as an over-extension flag, ATR for stops and
// sizing, realized vol, 52-week distance, relative strength, volume, gap.
import type { Bar, Instrument, TapeCard, Venue } from "./types";

export function sma(values: number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

export function pctChange(closes: number[], n: number): number {
  const len = closes.length;
  if (n <= 0 || len < n + 1 || !(closes[len - 1 - n] > 0)) return 0;
  return closes[len - 1] / closes[len - 1 - n] - 1;
}

export function rsi14(closes: number[]): number | null {
  const P = 14;
  if (closes.length < P + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= P; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= P; l /= P;
  for (let i = P + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (P - 1) + Math.max(d, 0)) / P;
    l = (l * (P - 1) + Math.max(-d, 0)) / P;
  }
  if (g === 0 && l === 0) return 50;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

export function atr14(bars: Bar[]): number | null {
  const P = 14;
  if (bars.length < P + 1) return null;
  const tr = (i: number) => {
    const b = bars[i], pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  };
  let a = 0;
  for (let i = 1; i <= P; i++) a += tr(i);
  a /= P;
  for (let i = P + 1; i < bars.length; i++) a = (a * (P - 1) + tr(i)) / P;
  return a;
}

export function realizedVol20(closes: number[], periodsPerYear = 252): number | null {
  const P = 20;
  if (closes.length < P + 1) return null;
  const r: number[] = [];
  for (let i = closes.length - P; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(periodsPerYear);
}

export function buildCard(input: {
  symbol: string; venue: Venue; instrument: Instrument; name: string; bars: Bar[]; spyBars?: Bar[];
  extra?: { funding?: number; vol24hUsd?: number; maxLeverage?: number };
}): TapeCard {
  const bars = input.bars;
  const closes = bars.map((b) => b.c);
  const n = bars.length;
  const price = n ? closes[n - 1] : 0;
  const prevClose = n > 1 ? closes[n - 2] : price;
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  let trend: TapeCard["trend"] = "mixed";
  if (s50 !== null && s200 !== null) {
    if (price > s50 && s50 > s200) trend = "up";
    else if (price < s50 && s50 < s200) trend = "down";
  } else if (s20 !== null && s50 !== null) {
    if (price > s20 && s20 > s50) trend = "up";
    else if (price < s20 && s20 < s50) trend = "down";
  }
  const win = bars.slice(-252);
  const hi52 = win.length ? Math.max(...win.map((b) => b.h)) : price;
  const lo52 = win.length ? Math.min(...win.map((b) => b.l)) : price;
  const atr = atr14(bars);
  const vols = bars.map((b) => b.v);
  const v20 = sma(vols, 20);
  const spyCloses = input.spyBars?.map((b) => b.c) ?? [];
  const rs = (k: number) => (spyCloses.length > k && closes.length > k ? pctChange(closes, k) - pctChange(spyCloses, k) : null);
  return {
    symbol: input.symbol, venue: input.venue, instrument: input.instrument, name: input.name,
    price, asOf: n ? bars[n - 1].t : 0,
    ret1d: pctChange(closes, 1), ret5d: pctChange(closes, 5), ret20d: pctChange(closes, 20),
    sma20: s20, sma50: s50, sma200: s200, trend,
    rsi14: rsi14(closes), atr14: atr, atrPct: atr !== null && price > 0 ? atr / price : null,
    vol20: realizedVol20(closes, input.instrument === "stock" || input.instrument === "etf" ? 252 : 365),
    hi52, lo52,
    pctFromHi52: hi52 > 0 ? price / hi52 - 1 : 0,
    pctFromLo52: lo52 > 0 ? price / lo52 - 1 : 0,
    volRatio20: v20 !== null && v20 > 0 && n ? vols[n - 1] / v20 : null,
    gapPct: n > 1 && prevClose > 0 ? bars[n - 1].o / prevClose - 1 : 0,
    rs20: rs(20), rs60: rs(60),
    bars: n, prevClose,
    ...(input.extra?.funding !== undefined ? { funding: input.extra.funding } : {}),
    ...(input.extra?.vol24hUsd !== undefined ? { vol24hUsd: input.extra.vol24hUsd } : {}),
    ...(input.extra?.maxLeverage !== undefined ? { maxLeverage: input.extra.maxLeverage } : {}),
  };
}

const pc = (x: number | null, d = 1) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);

// One compact line per symbol for the prompt: features, not raw candles
// (models read time series badly; they read labelled numbers fine).
export function cardLine(c: TapeCard): string {
  const px = c.price >= 100 ? c.price.toFixed(2) : c.price >= 1 ? c.price.toFixed(3) : c.price.toPrecision(4);
  const parts = [
    `${c.symbol} $${px}`,
    `1d ${pc(c.ret1d)} 5d ${pc(c.ret5d)} 20d ${pc(c.ret20d)}`,
    `trend ${c.trend}`,
    `rsi ${c.rsi14 === null ? "n/a" : c.rsi14.toFixed(0)}`,
    `atr ${pc(c.atrPct)}`,
    `vol20 ${c.vol20 === null ? "n/a" : (c.vol20 * 100).toFixed(0) + "%"}`,
    `52w ${pc(c.pctFromHi52)}/${pc(c.pctFromLo52)}`,
    `volx ${c.volRatio20 === null ? "n/a" : c.volRatio20.toFixed(1)}`,
    `gap ${pc(c.gapPct)}`,
    `rs20 ${pc(c.rs20)}`,
  ];
  if (c.funding !== undefined) parts.push(`funding ${(c.funding * 100).toFixed(3)}%/8h`);
  if (c.vol24hUsd !== undefined) parts.push(`24hvol $${(c.vol24hUsd / 1e6).toFixed(0)}M`);
  if (c.maxLeverage !== undefined) parts.push(`maxlev ${c.maxLeverage}x`);
  if (c.bars < 60) parts.push(`(${c.bars} bars only)`);
  return parts.join(" · ");
}
