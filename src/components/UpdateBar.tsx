"use client";

// A shipped change nobody can see is not shipped.
//
// This app has no service worker, so an installed home-screen PWA can keep
// serving a cached index.html that points at old JS forever. That has now
// hidden three separate releases — the app looked unchanged and the only
// symptom was Ben saying "did you even change it?". So the app checks its own
// build id against the one on the server and says plainly when it's stale.
//
// Never auto-reloads: a surprise refresh mid-set or mid-run would destroy
// unsaved input. It offers, he taps.

import { useCallback, useEffect, useRef, useState } from "react";
import { BUILD_ID } from "@/lib/buildId";

const VERSION_URL = "/daily/version.json";
const EVERY_MS = 5 * 60 * 1000;

export default function UpdateBar() {
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const dismissed = useRef(false);

  const check = useCallback(async () => {
    if (dismissed.current || stale) return;
    try {
      // cache-busted, and no-store, or the check itself gets cached and the
      // stale app happily reports that it is current
      const r = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;                       // offline or a bad deploy: stay quiet
      const { id } = (await r.json()) as { id?: string };
      if (id && BUILD_ID && id !== BUILD_ID) setStale(true);
    } catch { /* a failed check is not news */ }
  }, [stale]);

  useEffect(() => {
    check();
    const t = setInterval(check, EVERY_MS);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [check]);

  async function update() {
    setBusy(true);
    try {
      // clear any HTTP-cached shell so the reload actually fetches the new one
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch { /* best effort */ }
    // cache-busting the URL forces a real fetch even from a stubborn webview
    window.location.replace(`/daily/?v=${Date.now()}`);
  }

  if (!stale) return null;

  return (
    <div className="fixed left-3 right-3 z-[60] rounded-xl border border-[var(--neon)]/40 bg-[var(--raised)] px-3 py-2.5 flex items-center gap-3"
      style={{ top: "max(0.75rem, env(safe-area-inset-top))", animation: "slideDown 0.25s ease" }}>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">A newer version is live</p>
        <p className="mono text-[10px] text-[var(--text-4)] truncate">you&apos;re on {BUILD_ID}</p>
      </div>
      <button onClick={update} disabled={busy}
        className="shrink-0 rounded-lg bg-[var(--neon)] text-black text-xs font-bold px-3 py-2 active:scale-95 disabled:opacity-50">
        {busy ? "…" : "Update"}
      </button>
      <button onClick={() => { dismissed.current = true; setStale(false); }}
        className="shrink-0 opacity-40 text-xs px-1 active:scale-90" aria-label="dismiss">✕</button>
    </div>
  );
}
