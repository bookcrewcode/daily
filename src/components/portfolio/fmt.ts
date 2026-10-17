import { fmtMoney } from "@/lib/desk/api";

export const toneOf = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
export const signed = (v: number) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), 2);
export const fmtShares = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 6 });
