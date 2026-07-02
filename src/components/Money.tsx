"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, type Asset, type Subscription } from "@/lib/supabase";
import { SectionTitle } from "./ui";

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Money({ uid }: { uid: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [aName, setAName] = useState(""); const [aVal, setAVal] = useState(""); const [aKind, setAKind] = useState<"asset" | "liability">("asset");
  const [sName, setSName] = useState(""); const [sCost, setSCost] = useState(""); const [sCycle, setSCycle] = useState<"monthly" | "yearly">("monthly");

  const load = useCallback(async () => {
    const [{ data: a }, { data: s }] = await Promise.all([
      supabase.from("assets").select("*").eq("user_id", uid),
      supabase.from("subscriptions").select("*").eq("user_id", uid).eq("active", true),
    ]);
    setAssets((a ?? []) as Asset[]);
    setSubs((s ?? []) as Subscription[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function addAsset() {
    if (!aName.trim()) return;
    const row = { user_id: uid, name: aName.trim(), value: Number(aVal) || 0, kind: aKind };
    const { data } = await supabase.from("assets").insert(row).select().single();
    if (data) setAssets((x) => [...x, data as Asset]);
    setAName(""); setAVal("");
  }
  async function delAsset(id: string) { setAssets((x) => x.filter((a) => a.id !== id)); await supabase.from("assets").delete().eq("id", id); }

  async function addSub() {
    if (!sName.trim()) return;
    const row = { user_id: uid, name: sName.trim(), cost: Number(sCost) || 0, cycle: sCycle, active: true };
    const { data } = await supabase.from("subscriptions").insert(row).select().single();
    if (data) setSubs((x) => [...x, data as Subscription]);
    setSName(""); setSCost("");
  }
  async function delSub(id: string) { setSubs((x) => x.filter((s) => s.id !== id)); await supabase.from("subscriptions").delete().eq("id", id); }

  const netWorth = assets.reduce((s, a) => s + (a.kind === "asset" ? a.value : -a.value), 0);
  const monthlyBurn = subs.reduce((s, x) => s + (x.cycle === "yearly" ? x.cost / 12 : x.cost), 0);

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">💰 Money</h1>

      <div className="mt-4 rounded-2xl bg-[var(--neon)]/10 border border-[var(--neon)]/40 p-5">
        <p className="text-xs uppercase tracking-widest opacity-60">Net worth</p>
        <p className="text-4xl font-extrabold mt-1">{fmt(netWorth)}</p>
      </div>

      <SectionTitle>Assets & liabilities</SectionTitle>
      <div className="flex gap-2 mb-2">
        <input value={aName} onChange={(e) => setAName(e.target.value)} placeholder="name"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none" />
        <input value={aVal} onChange={(e) => setAVal(e.target.value)} inputMode="numeric" placeholder="$"
          className="w-24 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
        <select value={aKind} onChange={(e) => setAKind(e.target.value as "asset" | "liability")}
          className="rounded-xl bg-white/5 border border-white/10 px-2 py-2.5 outline-none text-sm">
          <option value="asset">＋</option><option value="liability">−</option>
        </select>
        <button onClick={addAsset} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
      </div>
      <div className="space-y-2">
        {assets.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
            <span className="flex-1">{a.name}</span>
            <span className={a.kind === "asset" ? "text-[var(--neon)]" : "text-red-400"}>{a.kind === "asset" ? "" : "−"}{fmt(a.value)}</span>
            <button onClick={() => delAsset(a.id)} className="opacity-40 active:scale-90">✕</button>
          </div>
        ))}
      </div>

      <SectionTitle>Subscriptions · {fmt(monthlyBurn)}/mo</SectionTitle>
      <div className="flex gap-2 mb-2">
        <input value={sName} onChange={(e) => setSName(e.target.value)} placeholder="name"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none" />
        <input value={sCost} onChange={(e) => setSCost(e.target.value)} inputMode="numeric" placeholder="$"
          className="w-20 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
        <select value={sCycle} onChange={(e) => setSCycle(e.target.value as "monthly" | "yearly")}
          className="rounded-xl bg-white/5 border border-white/10 px-2 py-2.5 outline-none text-sm">
          <option value="monthly">/mo</option><option value="yearly">/yr</option>
        </select>
        <button onClick={addSub} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
      </div>
      <div className="space-y-2">
        {subs.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
            <span className="flex-1">{s.name}</span>
            <span className="opacity-70 text-sm">{fmt(s.cost)}/{s.cycle === "yearly" ? "yr" : "mo"}</span>
            <button onClick={() => delSub(s.id)} className="opacity-40 active:scale-90">✕</button>
          </div>
        ))}
      </div>
      <p className="text-xs opacity-40 mt-3 mb-4">Annual subscription spend: {fmt(monthlyBurn * 12)}</p>
    </div>
  );
}
