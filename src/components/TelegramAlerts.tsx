"use client";

// Telegram alerts — connect the "Daily alerts" bot and see that it works.
//
// The bot token goes from this box straight into the encrypted vault through
// the set_telegram_token rpc (the same path as the AI key). It is never shown
// again, only its last 4 characters. Connect then registers the bot with the
// server and hands back a one-time Start link that ties the bot to Ben's
// Telegram chat; this card watches for that to land.

import { useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_ANON, TELEGRAM_FN } from "@/lib/supabase";
import { Card } from "./ui";

type Status = { is_set: boolean; hint: string | null; linked: boolean; bot_username: string | null; blocked: boolean; paused_until: string | null };
type Reply = { error?: string; link?: string; bot_username?: string };

async function call(body: Record<string, unknown>): Promise<Reply> {
  try {
    const { data } = await supabase.auth.getSession();
    const r = await fetch(TELEGRAM_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Reply;
    if (!r.ok || j.error) return { error: j.error || `The server said no (${r.status}).` };
    return j;
  } catch { return { error: "Couldn't reach the server. Try again." }; }
}

// null = unknown (a failed read), never "not connected"
async function fetchStatus(): Promise<Status | null> {
  try {
    const { data, error } = await supabase.rpc("telegram_status");
    if (error) return null;
    return ((Array.isArray(data) ? data[0] : data) as Status | undefined) ?? null;
  } catch { return null; }
}

function endOfToday(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

export default function TelegramAlerts() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [link, setLink] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const row = await fetchStatus();
    if (row) setStatus(row);
  }, []);
  useEffect(() => {
    let live = true;
    fetchStatus().then((row) => { if (live && row) setStatus(row); });
    return () => { live = false; };
  }, []);

  // while a Start link is out, look every 3 seconds (up to 2 minutes) for the chat to link
  useEffect(() => {
    if (!link || status?.linked) return;
    let tries = 0;
    const t = setInterval(() => { tries++; if (tries > 40) clearInterval(t); else load(); }, 3000);
    return () => clearInterval(t);
  }, [link, status?.linked, load]);

  async function connect(fresh: string) {
    if (busy) return;
    setBusy("connect"); setErr(""); setMsg("");
    try {
      if (fresh) {
        const { error } = await supabase.rpc("set_telegram_token", { p_token: fresh });
        if (error) { setErr(error.message.replace(/^.*?:\s*/, "") || "Couldn't save that token."); return; }
        setToken(""); // don't leave the secret sitting in a form field
        setOpen(false);
      }
      const r = await call({ mode: "connect" });
      if (r.error) { setErr(r.error); return; }
      setLink(r.link ?? "");
      setMsg(`Now open @${r.bot_username} and tap Start. The link works for 10 minutes.`);
      await load();
    } finally { setBusy(""); }
  }

  async function run(mode: "test" | "pause" | "resume") {
    if (busy) return;
    setBusy(mode); setErr(""); setMsg("");
    try {
      const r = await call(mode === "pause" ? { mode, until: endOfToday() } : { mode });
      if (r.error) { setErr(r.error); return; }
      setMsg(mode === "test" ? "Sent. Check Telegram." : mode === "pause" ? "Paused until midnight." : "Alerts are back on.");
      await load();
    } finally { setBusy(""); }
  }

  const paused = !!status?.paused_until && new Date(status.paused_until) > new Date();
  const line = status === null ? "checking…"
    : !status.is_set ? "Not connected"
    : status.blocked ? "The bot was blocked or the chat is gone. Get a new Start link."
    : status.linked ? `Connected to @${status.bot_username ?? "your bot"}${paused ? " · paused for today" : ""}`
    : "Token saved. Tap Start in Telegram to finish.";

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest opacity-60">Telegram alerts</p>
          <p className="text-[11px] opacity-50 mt-0.5">{line}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          {status?.linked && (
            <button onClick={() => run("test")} disabled={!!busy} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-semibold active:scale-95 disabled:opacity-50">
              {busy === "test" ? "sending…" : "Send a test"}
            </button>
          )}
          <button onClick={() => { setOpen((v) => !v); setErr(""); setMsg(""); }} className="px-3 py-2 rounded-lg bg-[var(--neon)] text-black text-xs font-bold active:scale-95">
            {open ? "Cancel" : status?.is_set ? "Replace token" : "Connect"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          <input
            type="password" autoComplete="off" spellCheck={false}
            value={token} onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) connect(token.trim()); }}
            placeholder="Token from BotFather, like 1234567890:AA…"
            className="w-full rounded-lg bg-black/40 px-3 py-2.5 outline-none text-sm font-mono" />
          <button onClick={() => connect(token.trim())} disabled={!!busy || !token.trim()}
            className="mt-2 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-40">
            {busy === "connect" ? "connecting…" : "Save and connect"}
          </button>
          <p className="text-[10px] opacity-40 mt-2 leading-relaxed">
            In Telegram: @BotFather, /mybots, your bot, API Token. The token goes straight into your encrypted vault
            and is never shown again, only its last 4 characters.
          </p>
        </div>
      )}

      {status?.is_set && (!status.linked || status.blocked) && !open && !link && (
        <button onClick={() => connect("")} disabled={!!busy}
          className="mt-3 w-full rounded-xl bg-white/10 py-2.5 text-xs font-semibold active:scale-95 disabled:opacity-50">
          {busy === "connect" ? "getting a link…" : "Get a new Start link"}
        </button>
      )}
      {link && !status?.linked && (
        <a href={link} target="_blank" rel="noreferrer"
          className="mt-3 block w-full rounded-xl bg-[var(--neon)] text-black text-center font-bold py-2.5 active:scale-95">
          Open the bot and tap Start
        </a>
      )}
      {status?.linked && !status.blocked && (
        <button onClick={() => run(paused ? "resume" : "pause")} disabled={!!busy}
          className="mt-3 w-full rounded-xl bg-white/10 py-2.5 text-xs font-semibold active:scale-95 disabled:opacity-50">
          {busy === "pause" || busy === "resume" ? "saving…" : paused ? "Resume alerts" : "Pause for the rest of today"}
        </button>
      )}

      {msg && <p className="text-xs text-[var(--neon)] mt-2">{msg}</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}

      <p className="text-[11px] opacity-60 mt-3 leading-relaxed">
        What it sends: your plan at 7:45 with a first step for each of the top 3, a ping when each block starts
        (not classes), one nudge if a block goes 15 minutes untouched, and a heads-up at 6pm the day before
        something is due. Done on a ping ticks it on your Card. It stays quiet during class, the gym and
        10pm to 7:30am, then sends what it held in one message. Pings during a drive arrive without sound.
        In Telegram: /today, /pause 2h, /resume.
      </p>
    </Card>
  );
}
