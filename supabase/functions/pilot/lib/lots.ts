export type LotKind = "start" | "weekly" | "manual";
export type Lot = { id: string; symbol: string; shares: number; price: number; day: string; kind: LotKind; assumed: boolean; skipped: boolean; note: string; created_at: string };
export type Quote = { price: number; prevClose: number | null; name?: string };
export type Holding = {
  symbol: string; name: string; shares: number; cost: number; avgCost: number; realized: number;
  price: number | null; value: number | null; gain: number | null; gainPct: number | null; dayChange: number | null; weight: number | null;
  assumedLots: number;
};
export type Totals = { value: number; cost: number; gain: number; gainPct: number | null; dayChange: number; realized: number; missing: string[] };
const EPS = 1e-9;
export function lotOrder(a: Lot, b: Lot): number {
  return a.day.localeCompare(b.day) || a.created_at.localeCompare(b.created_at) || Number(b.shares > 0) - Number(a.shares > 0);
}
export function holdingsOf(lots: Lot[], quotes: Record<string, Quote>): { holdings: Holding[]; totals: Totals } {
  const bySym = new Map<string, Lot[]>();
  for (const l of lots) {
    const s = l.symbol.toUpperCase();
    bySym.set(s, [...(bySym.get(s) ?? []), l]);
  }
  const holdings: Holding[] = [];
  let realizedAll = 0;
  for (const [symbol, list] of bySym) {
    let shares = 0, cost = 0, realized = 0, assumed = 0;
    for (const l of list.filter((x) => !x.skipped).sort(lotOrder)) {
      if (l.kind === "start") { shares = Math.max(0, l.shares); cost = shares * l.price; assumed = 0; continue; }
      if (l.shares > 0) { shares += l.shares; cost += l.shares * l.price; if (l.assumed) assumed++; continue; }
      const sell = Math.min(-l.shares, shares);
      if (sell <= EPS) continue;
      const avg = cost / shares;
      realized += sell * (l.price - avg);
      cost -= sell * avg;
      shares -= sell;
    }
    realizedAll += realized;
    if (shares <= EPS) continue;
    const q = quotes[symbol];
    const price = q && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
    const value = price === null ? null : shares * price;
    holdings.push({
      symbol, name: q?.name || symbol, shares, cost, avgCost: cost / shares, realized,
      price, value,
      gain: value === null ? null : value - cost,
      gainPct: value === null || cost <= EPS ? null : (value - cost) / cost,
      dayChange: price === null || q?.prevClose == null ? null : shares * (price - q.prevClose),
      weight: null, assumedLots: assumed,
    });
  }
  const priced = holdings.filter((h) => h.value !== null);
  const value = priced.reduce((a, h) => a + (h.value as number), 0);
  for (const h of priced) h.weight = value > EPS ? (h.value as number) / value : null;
  const cost = priced.reduce((a, h) => a + h.cost, 0);
  holdings.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.symbol.localeCompare(b.symbol));
  return {
    holdings,
    totals: {
      value, cost, gain: value - cost, gainPct: cost > EPS ? (value - cost) / cost : null,
      dayChange: priced.reduce((a, h) => a + (h.dayChange ?? 0), 0), realized: realizedAll,
      missing: holdings.filter((h) => h.value === null).map((h) => h.symbol),
    },
  };
}
