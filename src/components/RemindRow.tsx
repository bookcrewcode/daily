"use client";

// 🔔 REMIND ME — one row on the Today card. Every state the phone can be in is
// written out as words, because the failure modes of iOS push (not installed,
// blocked in Settings, subscription dropped) are invisible otherwise and Ben
// would just see a button that does nothing.

import { useEffect, useState } from "react";
import {
  currentSubscription, isStandalone, patchLearn, permissionState, pushSupported, sendTestPush, subscribePush, syncSubscription, unsubscribePush,
  DEFAULT_NUDGE_AT,
} from "@/lib/push";
import { sfx } from "@/lib/fx";

const HOURS = ["07:00", "08:30", "10:00", "12:30"];
const pretty = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")}${h < 12 ? " am" : " pm"}`;
};

type Phone = "checking" | "not-standalone" | "unsupported" | "denied" | "subscribed" | "unsubscribed";

export default function RemindRow({ uid, nudgeOn, nudgeAt, onChanged }: {
  uid: string; nudgeOn: boolean; nudgeAt?: string; onChanged: () => void;
}) {
  const [phone, setPhone] = useState<Phone>("checking");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [picking, setPicking] = useState(false);
  const at = nudgeAt || DEFAULT_NUDGE_AT;

  // What the phone actually holds, read on mount — settings can say "on" while
  // the phone quietly dropped the subscription (a reinstall, a Safari reset).
  useEffect(() => {
    let alive = true;
    (async () => {
      let next: Phone;
      if (!isStandalone()) next = "not-standalone";
      else if (!pushSupported()) next = "unsupported";
      else if (permissionState() === "denied") next = "denied";
      else if (await currentSubscription()) { next = "subscribed"; if (nudgeOn) syncSubscription(uid); }
      else next = "unsubscribed";
      if (alive) setPhone(next);
    })();
    return () => { alive = false; };
  }, [uid, nudgeOn]);

  // one write at a time; true when it landed (the message says which way)
  async function run(key: string, fn: () => Promise<{ error: string }>, okMsg: string): Promise<boolean> {
    if (busy) return false;
    setBusy(key); setMsg("");
    const r = await fn();
    setBusy("");
    if (r.error) { setMsg(r.error); return false; }
    sfx.pop();
    setMsg(okMsg);
    onChanged();
    return true;
  }
  async function turnOn(hour: string) {
    const ok = await run("on", () => subscribePush(uid, hour), `On — tomorrow's first question at ${pretty(hour)}.`);
    if (ok) { setPicking(false); setPhone("subscribed"); }
    else if (permissionState() === "denied") setPhone("denied");
  }
  const setTime = async (hour: string) => { if (await run("time", () => patchLearn(uid, { nudge_at: hour }), `Moved to ${pretty(hour)}.`)) setPicking(false); };
  const turnOff = async () => { if (await run("off", () => unsubscribePush(uid), "Off. Nothing will buzz.")) setPhone("unsubscribed"); };
  const test = () => run("test", sendTestPush, "Sent — it should land on this phone in a few seconds.");

  const line = "text-[12px] text-[var(--text-3)] leading-relaxed";
  const link = "text-[12px] text-[var(--neon)] underline active:scale-95 disabled:opacity-40";
  const chips = (onPick: (h: string) => void) => (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {HOURS.map((h) => (
        <button key={h} onClick={() => onPick(h)} disabled={!!busy}
          className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border active:scale-95 disabled:opacity-40 ${h === at ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
          {pretty(h)}
        </button>
      ))}
    </div>
  );

  let body;
  switch (phone) {
    case "checking":
      body = <p className={line}>Reminder · checking this phone…</p>;
      break;
    case "not-standalone":
      body = <p className={line}>Reminder · Add Daily to your Home Screen first: Share → Add to Home Screen. Then this button works.</p>;
      break;
    case "unsupported":
      body = <p className={line}>Reminder · This phone can&apos;t do notifications for web apps yet (iPhone needs iOS 16.4 or newer).</p>;
      break;
    case "denied":
      body = <p className={line}>Reminder · iPhone blocked it. Settings → Notifications → Daily → Allow, then come back.</p>;
      break;
    case "subscribed":
      body = nudgeOn ? (
        <>
          <p className={line}>
            <span className="text-[var(--neon)] font-semibold">On · {pretty(at)}</span> — tomorrow&apos;s first question, as a notification.{" "}
            <button onClick={() => setPicking((p) => !p)} disabled={!!busy} className={link}>Change time</button>{" · "}
            <button onClick={test} disabled={!!busy} className={link}>{busy === "test" ? "sending…" : "Send a test"}</button>{" · "}
            <button onClick={turnOff} disabled={!!busy} className={link}>{busy === "off" ? "…" : "Turn off"}</button>
          </p>
          {picking && chips(setTime)}
        </>
      ) : (
        // the phone still holds a subscription from before; one tap turns the sending back on
        <p className={line}>Reminder is off. <button onClick={() => turnOn(at)} disabled={!!busy} className={link}>{busy === "on" ? "turning on…" : `Turn on · ${pretty(at)}`}</button></p>
      );
      break;
    case "unsubscribed":
      body = nudgeOn ? (
        <p className={line}>Reminder · Turned off by the phone — <button onClick={() => turnOn(at)} disabled={!!busy} className={link}>{busy === "on" ? "turning on…" : "tap to turn back on"}</button>.</p>
      ) : (
        <>
          <p className={line}>
            Tomorrow&apos;s first question at {pretty(at)} —{" "}
            <button onClick={() => turnOn(at)} disabled={!!busy} className={`${link} font-semibold`}>{busy === "on" ? "turning on…" : "Turn on"}</button>
            {" · "}<button onClick={() => setPicking((p) => !p)} disabled={!!busy} className={link}>other time</button>
          </p>
          {picking && chips(turnOn)}
        </>
      );
      break;
  }

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
      {body}
      {msg && <p className="text-[12px] mt-1 text-[var(--text-2)]">{msg}</p>}
    </div>
  );
}
