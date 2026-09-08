// The Desk — the playbook: reusable trade templates with the evidence grade
// behind each one (research brief 1). Jurors must name the template they are
// using; the League later shows which templates actually pay.

export type Template = {
  id: number; name: string; trigger: string; direction: string; horizon: string; invalidation: string;
  evidence: "strong" | "medium" | "weak" | "folklore" | "practitioner"; sizeHint: "normal" | "small";
};

export const ORGANISING_RULE = "Quantitative, cash-flow news under-reacts (drift). Qualitative, transient or anticipated news over-reacts (reversal). Never trade the print itself; trade what unfolds over the following days.";

export const PLAYBOOK: Template[] = [
  { id: 1, name: "Earnings drift after a big beat with raised guidance", trigger: "top-decile earnings surprise AND raised guidance; price gaps up and holds above the 200-day", direction: "long the stock, entered after the first 30 minutes or on a day-2 pullback", horizon: "10–60 days", invalidation: "close below the event-day low, or guidance walked back", evidence: "strong", sizeHint: "normal" },
  { id: 2, name: "Earnings miss with cut guidance", trigger: "bottom-decile surprise with lowered guidance; price below the 200-day", direction: "short the stock (or long the sector ETF against it)", horizon: "10–40 days", invalidation: "close above the event-day high", evidence: "strong", sizeHint: "normal" },
  { id: 3, name: "Fade the first spike on ambiguous macro", trigger: "CPI/jobs within one standard deviation of consensus, yet the index moves more than its usual event move with no confirmation from rates", direction: "index ETF against the spike, only after the first half-hour has itself reversed", horizon: "intraday to 2 days", invalidation: "a new extreme beyond the spike", evidence: "weak", sizeHint: "small" },
  { id: 4, name: "Hawkish surprise: long dollar, short duration", trigger: "a hawkish target or path surprise (rates reprice up; statement or projections more hawkish than expected)", direction: "long UUP, short TLT; short-bias equities", horizon: "5–15 days", invalidation: "fed-funds futures retrace the surprise or the next data print reverses the path", evidence: "medium", sizeHint: "normal" },
  { id: 5, name: "Dovish surprise: long the index for 15 days", trigger: "an expansionary policy surprise", direction: "long SPY/QQQ, larger when uncertainty is high", horizon: "15 days", invalidation: "the surprise is reversed by later Fed communication", evidence: "medium", sizeHint: "normal" },
  { id: 6, name: "Sector ETF on a regulatory shock", trigger: "a rule or ruling that changes an industry's cash flows; sector-versus-index dispersion above 5% on day one", direction: "short the hit sector ETF (or long the beneficiary); if the policy is reversible, flip to a fade on the second headline", horizon: "5–30 days", invalidation: "policy paused or reversed, or the sector recovers half the gap", evidence: "medium", sizeHint: "normal" },
  { id: 7, name: "Merger-arb spread on a friendly cash deal", trigger: "cash deal, 3–7% spread, low antitrust risk, committed financing", direction: "long the target", horizon: "to close (3–9 months)", invalidation: "regulatory challenge, financing failure, spread doubles", evidence: "strong", sizeHint: "normal" },
  { id: 8, name: "Geopolitical shock fade", trigger: "a military or terror event with no lasting supply impairment; index down 3–8%", direction: "scale into the index on the second or third down day", horizon: "10–40 days", invalidation: "escalation with real supply or financial-system impact; a new low after five days", evidence: "medium", sizeHint: "normal" },
  { id: 9, name: "Oil supply shock, then the fade", trigger: "a physical outage above 2% of world supply", direction: "long USO/XLE on the gap while repair is uncertain; fade the spike on the first repair headline", horizon: "2–20 days", invalidation: "repair timeline announced (for the long) / repair delayed (for the fade)", evidence: "medium", sizeHint: "normal" },
  { id: 10, name: "Crypto ETF-flow momentum", trigger: "a five-day net spot-ETF inflow streak above $1B with rising BTC and no macro risk-off", direction: "long BTC (IBIT, or MSTR/COIN as high beta)", horizon: "2–10 days", invalidation: "a net outflow day above $500M, or BTC below its 20-day average", evidence: "weak", sizeHint: "small" },
  { id: 11, name: "Crypto sell-the-news", trigger: "a long-anticipated positive event (ETF approval, upgrade, halving) after a run-up above 30%", direction: "reduce or short into the event, cover one to two weeks after", horizon: "3–15 days", invalidation: "a new high within three days of the event", evidence: "folklore", sizeHint: "small" },
  { id: 12, name: "Exchange hack fade versus solvency stand-aside", trigger: "a hack at a solvent exchange (fade the dip in 24–72h) versus a solvency or fraud event (stand aside until contagion clears)", direction: "BTC/ETH, COIN", horizon: "1–10 days", invalidation: "withdrawals halted turns a hack into a solvency event", evidence: "practitioner", sizeHint: "small" },
];

export function templateName(id: number): string {
  return PLAYBOOK.find((t) => t.id === id)?.name ?? "no template";
}

export function playbookForPrompt(): string {
  return PLAYBOOK.map((t) =>
    `${t.id}. ${t.name} — trigger: ${t.trigger}. Direction: ${t.direction}. Horizon ${t.horizon}. Wrong if: ${t.invalidation}. Evidence: ${t.evidence}${t.sizeHint === "small" ? " (smallest size)" : ""}.`,
  ).join("\n");
}
