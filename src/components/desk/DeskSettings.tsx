"use client";

// Desk settings — the roster of jurors, the judge, the risk preset, the
// budget per night and a hard leverage cap. Saved straight to the account
// row; tonight's run reads it. Every field says what it changes.

import { useState } from "react";
import { Card, Eyebrow, Segmented } from "../ui";
import { updateAccount, modelLabel, fmtMoney, MODEL_ID, type Account } from "@/lib/desk/api";
import { PRESETS } from "@/lib/desk/risk";
import type { PresetKey, Rules } from "@/lib/desk/types";

const PRESET_LABEL: Record<PresetKey, string> = { moderate: "Moderate", aggressive: "Aggressive", very_aggressive: "Very aggressive" };

export default function DeskSettings({ uid, account, onSaved }: { uid: string; account: Account; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<PresetKey>(account.preset);
  const [roster, setRoster] = useState(account.roster.join("\n"));
  const [judge, setJudge] = useState(account.judge);
  const [budget, setBudget] = useState(String(account.budget_usd_per_run));
  const [levCap, setLevCap] = useState(account.leverage_cap_override === null ? "" : String(account.leverage_cap_override));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const rules = PRESETS[preset];
  const models = roster.split(/\n|,/).map((m) => m.trim()).filter(Boolean);
  const badModels = models.filter((m) => !MODEL_ID.test(m));
  const budgetN = Number(budget);
  const levN = levCap.trim() === "" ? null : Number(levCap);
  const problems: string[] = [];
  if (models.length < 3) problems.push("the roster needs at least three models");
  if (models.length > 12) problems.push("twelve jurors is the most the desk seats");
  if (badModels.length) problems.push(`not a model id: ${badModels.slice(0, 3).join(", ")}`);
  if (!MODEL_ID.test(judge.trim())) problems.push("the judge needs a model id like anthropic/claude-opus-5");
  if (!(budgetN >= 0.1 && budgetN <= 20)) problems.push("budget per night must be between $0.10 and $20");
  if (levN !== null && !(levN >= 1 && levN <= 100)) problems.push("leverage cap must be between 1 and 100, or blank");

  async function save() {
    if (saving || problems.length) return;
    setSaving(true); setErr(""); setMsg("");
    const nextRules: Partial<Rules> = { ...account.rules };
    if (levN === null) delete nextRules.max_leverage; else nextRules.max_leverage = levN;
    const r = await updateAccount(uid, { preset, roster: models, judge: judge.trim(), budget_usd_per_run: budgetN, leverage_cap_override: levN, rules: nextRules });
    setSaving(false);
    if (r.error) { setErr(r.error); return; }
    setMsg("Saved. Tonight's run uses these.");
    onSaved();
  }

  return (
    <Card className="mt-3">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left flex items-baseline justify-between active:scale-[0.995]">
        <Eyebrow>Desk settings</Eyebrow>
        <span className="mono text-[10px] text-[var(--text-4)]">{PRESET_LABEL[account.preset]} · {account.roster.length} jurors · {fmtMoney(account.budget_usd_per_run, 2)}/night {open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="mt-3 rise-in space-y-4">
          <div>
            <p className="text-[11px] font-semibold mb-1.5">Risk preset</p>
            <Segmented value={preset} onChange={setPreset} options={[{ key: "moderate", label: "Moderate" }, { key: "aggressive", label: "Aggressive" }, { key: "very_aggressive", label: "Very aggressive" }]} />
            <p className="text-[10.5px] text-[var(--text-3)] mt-2 leading-relaxed">
              Risk {rules.risk_pct}% of equity per trade (entry to stop) · one position up to {rules.max_notional_pct}% of equity · at most {rules.max_open} open and {rules.max_new_per_night} new a night · gross exposure up to {rules.gross_cap_pct}% · perps up to {rules.max_leverage}x · open risk (heat) capped at {rules.heat_cap_pct}% · the desk halts for the day at −{rules.daily_halt_pct}% and pauses the week at −{rules.weekly_pause_pct}%.
              {preset === "very_aggressive" ? " This is the top of the ladder: it only means something once the measured edge is real. The desk unlocks it on its own after 20 closed trades with a positive trailing mean R." : ""}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold mb-1">Jurors <span className="mono text-[9px] text-[var(--text-4)] font-normal">one OpenRouter model id per line · 3 to 12</span></p>
            <textarea value={roster} onChange={(e) => setRoster(e.target.value)} rows={Math.min(12, Math.max(4, models.length + 1))} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] leading-relaxed outline-none focus:border-[var(--neon)]/50" />
            <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">{models.map(modelLabel).join(" · ")}. Each juror proposes in round 1 and votes on the others in round 2. Seven costs about {fmtMoney(0.45, 2)} a night.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[11px] font-semibold mb-1">Judge</p>
              <input value={judge} onChange={(e) => setJudge(e.target.value)} spellCheck={false} className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
              <p className="text-[10px] text-[var(--text-4)] mt-1 leading-snug">Reads the whole debate and may only veto or shrink what the room voted through. Never adds a trade.</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold mb-1">Budget per night</p>
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
              <p className="text-[10px] text-[var(--text-4)] mt-1 leading-snug">Dollars of OpenRouter credit. If round 1 has spent 60% of it, round 2 is skipped and jurors count as backing their own proposals.</p>
            </div>
          </div>
          <div>
            <p className="text-[11px] font-semibold mb-1">Leverage cap <span className="mono text-[9px] text-[var(--text-4)] font-normal">blank = the preset&apos;s {rules.max_leverage}x</span></p>
            <input value={levCap} onChange={(e) => setLevCap(e.target.value)} inputMode="numeric" placeholder={`${rules.max_leverage}`} className="w-32 rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
            <p className="text-[10px] text-[var(--text-4)] mt-1 leading-snug">A hard ceiling on BloFin perps regardless of preset. The guardrail still cuts leverage further whenever a stop would sit outside the liquidation price.</p>
          </div>
          {problems.length > 0 && <p className="text-[11px] text-orange-400 leading-relaxed">Not saved yet: {problems.join("; ")}.</p>}
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving || problems.length > 0} className="rounded-lg bg-[var(--neon)] text-black text-xs font-bold px-4 py-2 active:scale-95 disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
            {msg && <span className="text-[11px] text-[var(--ok)]">{msg}</span>}
            {err && <span className="text-[11px] text-orange-400">{err}</span>}
          </div>
          <p className="text-[10px] text-[var(--text-4)] leading-relaxed">Paper only. There is no broker key anywhere in this app and the desk cannot place a real order.</p>
        </div>
      )}
    </Card>
  );
}
