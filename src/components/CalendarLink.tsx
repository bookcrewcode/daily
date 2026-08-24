"use client";

// 🔗 GOOGLE CALENDAR STATUS — because "I don't think it was ever connected"
// should be answerable by looking, not by guessing.
//
// The connection was real (events have been pushed before) but invisible: the
// OAuth client ID lives in the database while the GRANT lives in this browser's
// localStorage plus an in-memory access token. So a new phone, a reinstalled
// PWA, or cleared site data silently reverts to "not connected" and the only
// hint was a word on a button that appeared just when a plan already existed.
//
// This row proves the state instead of asserting it: it makes a real read
// against the Calendar API. "Connected" here means a live call succeeded.

import { useCallback, useEffect, useRef, useState } from "react";
import { listDay, acquireToken, NeedsAuth } from "@/lib/gcal";

type State = "checking" | "unset" | "live" | "needs" | "error";

export default function CalendarLink({ clientId }: { clientId: string }) {
  const [state, setState] = useState<State>("checking");
  const [count, setCount] = useState(0);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const checking = useRef(false);

  const verify = useCallback(async () => {
    if (!clientId) { setState("unset"); return; }
    if (checking.current) return;
    checking.current = true;
    try {
      // silent probe — never pops a window on its own; a popup nobody asked for
      // is worse than an unknown state
      const evs = await listDay(clientId, new Date());
      setCount(evs.length);
      setState("live"); setMsg("");
    } catch (e) {
      if (e instanceof NeedsAuth) { setState("needs"); setMsg(""); }
      else { setState("error"); setMsg(e instanceof Error ? e.message : "Couldn't reach Google."); }
    } finally { checking.current = false; }
  }, [clientId]);

  useEffect(() => { verify(); }, [verify]);

  // Google's popup rules: the interactive grant MUST originate in a click.
  async function connect() {
    if (!clientId || busy) return;
    setBusy(true); setMsg("");
    try {
      const t = await acquireToken(clientId, true);
      if (!t) { setMsg("The Google window closed without approving — nothing changed."); setBusy(false); return; }
      await verify();
    } catch { setMsg("Couldn't reach Google — try again."); }
    finally { setBusy(false); }
  }

  if (state === "checking") return <div className="skeleton h-9 mt-3" />;

  const dot = state === "live" ? "var(--ok)" : state === "needs" ? "var(--warn)" : "var(--bad)";
  const label = state === "live"
    ? `Google Calendar connected${count > 0 ? ` · ${count} event${count === 1 ? "" : "s"} today` : " · nothing on today"}`
    : state === "needs" ? "Google Calendar — not connected on this device"
    : state === "unset" ? "Google Calendar — not set up yet"
    : "Google Calendar — couldn't reach it";

  return (
    <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
        <p className="text-[11px] flex-1 min-w-0 text-[var(--text-2)]">{label}</p>
        {state === "needs" && (
          <button onClick={connect} disabled={busy}
            className="rounded-lg bg-[var(--neon)] text-black text-[11px] font-bold px-2.5 py-1.5 active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Connect"}
          </button>
        )}
        {state === "error" && (
          <button onClick={verify} className="rounded-lg bg-white/10 text-[11px] font-semibold px-2.5 py-1.5 active:scale-95">retry</button>
        )}
        {state === "live" && (
          <button onClick={() => setOpen((v) => !v)} className="text-[10px] opacity-35 px-1 active:scale-90">{open ? "▴" : "?"}</button>
        )}
      </div>

      {msg && <p className="text-[10px] text-orange-400 mt-1.5">{msg}</p>}

      {(open || state === "needs" || state === "unset") && (
        <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
          {state === "unset"
            ? "The one-time setup (an OAuth client ID from Google Cloud Console) lives in Legacy → Today."
            : "Google only grants this app a one-hour key, and it's stored in this browser — not on the server. So a new phone, a reinstalled app, or cleared site data needs one tap here again. Everything you plan still saves either way; only the push to Google needs the key."}
        </p>
      )}
    </div>
  );
}
