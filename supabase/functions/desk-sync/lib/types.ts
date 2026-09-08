// The Desk — shared types. Pure, dependency-free: these files are copied
// byte-for-byte into the edge functions (scripts/desk-sync-libs.mjs), so
// nothing in src/lib/desk may import from outside src/lib/desk.

export type Venue = "robinhood" | "blofin";
export type Instrument = "stock" | "etf" | "crypto_spot" | "crypto_perp";
export type Side = "long" | "short";
export type TradeStatus = "pending" | "open" | "closed" | "cancelled";
export type ExitReason = "stop" | "target" | "time" | "thesis_broke" | "liquidated" | "halt" | "cancelled";
export type Owner = string; // "desk" or a model id such as "anthropic/claude-sonnet-5"
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number }; // t = epoch ms of the bar's OPEN
export type PresetKey = "aggressive" | "very_aggressive" | "moderate";

export type Rules = {
  risk_pct: number;          // % of equity at risk per trade (entry → stop)
  max_notional_pct: number;  // % of equity, notional per position
  max_open: number;
  gross_cap_pct: number;     // % of equity, sum of open notionals
  max_leverage: number;      // perps only
  daily_halt_pct: number;    // −% day → no new entries next session
  weekly_pause_pct: number;  // −% week → pause a week
  heat_cap_pct: number;      // % of equity, sum of open risk
  max_new_per_night: number;
  min_rr: number;            // reward:risk floor
  min_stop_atr: number;      // stop at least this many ATRs from entry
  liq_buffer: number;        // perps: |entry − liq| ≥ |entry − stop| × (1 + buffer)
};

export type Plan = {
  venue: Venue; instrument: Instrument; symbol: string; side: Side; leverage: number;
  template: number; thesis: string; catalyst: string; falsifier: string; confidence: number;
  entry_ref: number; stop: number; target: number; horizon_days: number; risk_pct: number;
  evidence: number[]; key_risks: string[]; crosses_event: boolean;
};

export type InstrumentMeta = { max_leverage: number; contract_value: number; lot_size: number; tick_size: number };

export type Trade = {
  id: string; owner: Owner; session_id: string | null; proposal_id: string;
  venue: Venue; instrument: Instrument; symbol: string; name: string; side: Side; status: TradeStatus;
  template: number; thesis: string; catalyst: string; falsifier: string; confidence: number;
  evidence: number[]; regime: string; decided_at: string;
  entry_ref: number; stop: number; target: number; horizon_days: number; risk_pct: number;
  leverage: number; qty: number; unit: "share" | "coin" | "contract"; contract_value: number;
  notional: number; margin: number; liq_price: number | null;
  entry_price: number | null; entry_at: string | null; fill_rule: string; slippage_bps: number;
  fees: number; funding: number; funding_at: string | null; checked_until: string | null; expires_on: string | null;
  exit_price: number | null; exit_at: string | null; exit_reason: ExitReason | null; ambiguous_bar: boolean;
  pnl: number | null; pnl_pct: number | null; r_multiple: number | null; mae_r: number | null; mfe_r: number | null;
  spy_entry: number | null; spy_exit: number | null; review: Record<string, unknown> | null;
};

export type TapeCard = {
  symbol: string; venue: Venue; instrument: Instrument; name: string; price: number; asOf: number;
  ret1d: number; ret5d: number; ret20d: number; sma20: number | null; sma50: number | null; sma200: number | null;
  trend: "up" | "down" | "mixed"; rsi14: number | null; atr14: number | null; atrPct: number | null; vol20: number | null;
  hi52: number; lo52: number; pctFromHi52: number; pctFromLo52: number; volRatio20: number | null; gapPct: number;
  rs20: number | null; rs60: number | null; bars: number; prevClose: number;
  funding?: number; vol24hUsd?: number; maxLeverage?: number;
};

export function instrumentOf(symbol: string, venue: Venue, quoteType?: string): Instrument {
  if (venue === "blofin") return "crypto_perp";
  if (/^[A-Z0-9]{2,10}-USD$/.test(symbol)) return "crypto_spot";
  return quoteType === "ETF" ? "etf" : "stock";
}

export function venueOf(instrument: Instrument): Venue {
  return instrument === "crypto_perp" ? "blofin" : "robinhood";
}

export function baseOf(symbol: string): string {
  return symbol.split("-")[0];
}

export function isMajorCrypto(symbol: string): boolean {
  return ["BTC", "ETH", "SOL"].includes(baseOf(symbol));
}

export function unitValue(t: Pick<Trade, "unit" | "contract_value">): number {
  return t.unit === "contract" ? t.contract_value : 1;
}
