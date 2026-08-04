"use client";

// 🔑 AI key — set the Anthropic key from inside the app.
//
// Why this exists: the key used to live only in the Supabase dashboard, so
// losing dashboard access took the whole AI layer offline with no way back.
// Here the key goes straight from this browser into the encrypted Vault via a
// SECURITY DEFINER rpc. It is never returned to the client (status shows only
// the last 4 characters), never logged, and never leaves your machine except
// to your own database.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { setAIStatus, refreshAIStatus } from "@/lib/aiStatus";
import { Card } from "./ui";

type Status = { is_set: boolean; updated_at: string | null; hint: string | null };

export default function AIKey() {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("ai_key_status");
      if (error) return;
      const row = (Array.isArray(data) ? data[0] : data) as Status | undefined;
      setStatus(row ?? { is_set: false, updated_at: null, hint: null });
    } catch { /* leave unknown */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true); setErr(""); setMsg("");
    try {
      const { error } = await supabase.rpc("set_ai_key", { p_key: k });
      if (error) { setErr(error.message.replace(/^.*?:\s*/, "") || "Couldn't save that key."); return; }
      setKey("");            // don't leave the secret sitting in a form field
      setOpen(false);
      sfx.coin();
      setMsg("Saved. Testing it…");
      setAIStatus("on");
      await load();
      await refreshAIStatus();
      await test();
    } catch {
      setErr("Couldn't reach the server — nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  // Prove it actually works, rather than trusting that saving was enough.
  async function test() {
    if (testing) return;
    setTesting(true); setErr("");
    const json = await advisorCall<{ text?: string; error?: string }>({
      advisor: "affirm-gen", period: "morning", clientDay: todayStr(),
    });
    setTesting(false);
    if (json.error) {
      const e = json.error;
      if (/no ai key/i.test(e)) setErr("No key is set yet.");
      else if (/authentication|invalid x-api-key|401/i.test(e)) setErr("That key was rejected by Anthropic — it may be revoked or from the wrong workspace.");
      else if (/credit|billing|quota|429/i.test(e)) setErr("The key works, but the workspace is out of credit or rate-limited.");
      else setErr(e);
      setMsg("");
      return;
    }
    setAIStatus("on");
    setMsg("✅ Working — the AI is live.");
  }

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest opacity-60">🔑 AI key</p>
          <p className="text-[11px] opacity-50 mt-0.5">
            {status === null ? "checking…"
              : status.is_set
                ? `Set${status.hint ? ` (${status.hint})` : ""}${status.updated_at ? ` · ${new Date(status.updated_at).toLocaleDateString()}` : ""}`
                : "Not set — the AI features are off"}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={test} disabled={testing} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-semibold active:scale-95 disabled:opacity-50">
            {testing ? "testing…" : "Test"}
          </button>
          <button onClick={() => { setOpen((v) => !v); setErr(""); setMsg(""); }} className="px-3 py-2 rounded-lg bg-[var(--neon)] text-black text-xs font-bold active:scale-95">
            {open ? "cancel" : status?.is_set ? "Replace" : "Add key"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          <input
            type="password" autoComplete="off" spellCheck={false}
            value={key} onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder="sk-ant-…"
            className="w-full rounded-lg bg-black/40 px-3 py-2.5 outline-none text-sm font-mono" />
          <button onClick={save} disabled={busy || !key.trim()}
            className="mt-2 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-40">
            {busy ? "saving…" : "Save key"}
          </button>
          <p className="text-[10px] opacity-40 mt-2 leading-relaxed">
            Goes straight into your encrypted vault — it&apos;s never shown again, only the last 4 characters.
            Create it at console.anthropic.com under a spend-capped workspace.
          </p>
        </div>
      )}

      {msg && <p className="text-xs text-[var(--neon)] mt-2">{msg}</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
