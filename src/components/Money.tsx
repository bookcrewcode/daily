"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, type Asset, type Subscription } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { SectionTitle } from "./ui";
import GigWork from "./GigWork";

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Money({ uid }: { uid: string }) {
  const game = useGame();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [aName, setAName] = useState(""); const [aVal, setAVal] = useState(""); const [aKind, setAKind] = useState<"asset" | "liability">("asset");
  const [sName, setSName] = useState(""); const [sCost, setSCost] = useState(""); const [sCycle, setSCycle] = useState<"monthly" | "yearly">("monthly");
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [offline, setOffline] = useState(false);          // last read failed — showing prior data
  const [assetNote, setAssetNote] = useState<string | null>(null);
  const [subNote, setSubNote] = useState<string | null>(null);
  const [editError, setEditError] = useState(false);

  const load = useCallback(async () => {
    const [{ data: a, error: aErr }, { data: s, error: sErr }] = await Promise.all([
      supabase.from("assets").select("*").eq("user_id", uid),
      supabase.from("subscriptions").select("*").eq("user_id", uid).eq("active", true),
    ]);
    // READ-ERROR GUARD: a transient read must never overwrite good state with an
    // empty list — that would render a fabricated "Net worth $0" and let a later
    // write clobber real DB rows. Keep what we have and flag it.
    if (aErr || sErr) { setOffline(true); return; }
    setOffline(false);
    setAssets((a ?? []) as Asset[]);
    setSubs((s ?? []) as Subscription[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function addAsset() {
    if (!aName.trim()) return;
    const row = { user_id: uid, name: aName.trim(), value: Number(aVal) || 0, kind: aKind };
    const { data, error } = await supabase.from("assets").insert(row).select().single();
    if (error || !data) { setAssetNote("Couldn't save — your entry is still here. Try again."); return; }
    setAssetNote(null);
    setAssets((x) => [...x, data as Asset]);
    setAName(""); setAVal("");
    game.refresh();
  }
  async function delAsset(id: string) {
    const prev = assets;
    setAssets((x) => x.filter((a) => a.id !== id));
    const { error } = await supabase.from("assets").delete().eq("id", id);
    if (error) { setAssets(prev); setAssetNote("Couldn't remove — try again."); return; }
    setAssetNote(null);
    game.refresh();
  }
  // tap-to-edit — updating a balance shouldn't mean delete + re-add
  async function saveEdit() {
    if (!editing) return;
    const id = editing.id;
    const value = Number(editing.value) || 0;
    const prevValue = assets.find((a) => a.id === id)?.value ?? value;
    setAssets((x) => x.map((a) => (a.id === id ? { ...a, value } : a)));
    const { error } = await supabase.from("assets").update({ value }).eq("id", id);
    if (error) {
      // roll the optimistic value back so Money + the Today scoreboard stay in sync;
      // keep the editor open with the user's typed value so they can retry.
      setAssets((x) => x.map((a) => (a.id === id ? { ...a, value: prevValue } : a)));
      setEditError(true);
      return;
    }
    setEditError(false);
    setEditing(null);
    game.refresh();
  }

  async function addSub() {
    if (!sName.trim()) return;
    const row = { user_id: uid, name: sName.trim(), cost: Number(sCost) || 0, cycle: sCycle, active: true };
    const { data, error } = await supabase.from("subscriptions").insert(row).select().single();
    if (error || !data) { setSubNote("Couldn't save — your entry is still here. Try again."); return; }
    setSubNote(null);
    setSubs((x) => [...x, data as Subscription]);
    setSName(""); setSCost("");
  }
  async function delSub(id: string) {
    const prev = subs;
    setSubs((x) => x.filter((s) => s.id !== id));
    const { error } = await supabase.from("subscriptions").delete().eq("id", id);
    if (error) { setSubs(prev); setSubNote("Couldn't remove — try again."); return; }
    setSubNote(null);
  }

  const netWorth = assets.reduce((s, a) => s + (a.kind === "asset" ? a.value : -a.value), 0);
  const monthlyBurn = subs.reduce((s, x) => s + (x.cycle === "yearly" ? x.cost / 12 : x.cost), 0);

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">💰 Money</h1>

      <div className="mt-4 rounded-2xl bg-[var(--neon)]/10 border border-[var(--neon)]/40 p-5">
        <p className="text-xs uppercase tracking-widest opacity-60">Net worth</p>
        <p className="text-4xl font-extrabold mt-1">{fmt(netWorth)}</p>
        {offline && <p className="text-xs text-orange-400 mt-1">Couldn&apos;t refresh — showing your last saved data.</p>}
      </div>

      <GigWork uid={uid} />

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
      {assetNote && <p className="text-xs text-orange-400 mb-2">{assetNote}</p>}
      <div className="space-y-2">
        {assets.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-2.5">
            <span className="flex-1">{a.name}</span>
            {editing?.id === a.id ? (
              <span className="flex items-center gap-1">
                <input autoFocus value={editing.value} onChange={(e) => setEditing({ id: a.id, value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()} inputMode="numeric"
                  className="w-24 rounded-lg bg-black/30 px-2 py-1 outline-none text-center" />
                <button onClick={saveEdit} className="text-xs font-bold px-2 py-1 rounded-lg bg-[var(--neon)] text-black active:scale-95">✓</button>
              </span>
            ) : (
              <button onClick={() => setEditing({ id: a.id, value: String(a.value) })}
                className={`underline decoration-dotted underline-offset-4 ${a.kind === "asset" ? "text-[var(--neon)]" : "text-red-400"}`}>
                {a.kind === "asset" ? "" : "−"}{fmt(a.value)}
              </button>
            )}
            <button onClick={() => delAsset(a.id)} className="opacity-40 active:scale-90">✕</button>
          </div>
        ))}
      </div>
      {editError && <p className="text-xs text-orange-400 mt-1">Couldn&apos;t update — your value is still here. Try again.</p>}

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
      {subNote && <p className="text-xs text-orange-400 mb-2">{subNote}</p>}
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
