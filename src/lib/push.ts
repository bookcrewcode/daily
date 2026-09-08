// 🔔 PUSH — "remind me": the phone side of the nightly nudge.
//
// The nudge function (server) picks the hour and the words; this file only
// gets the phone to accept notifications and tells the server where to send
// them. iOS rules shape every step: a web app gets push ONLY when it was added
// to the Home Screen (standalone), permission may ONLY be asked inside a tap,
// and the service worker has to be registered from the standalone app.
//
// Nothing here throws — every function answers {error} with words for the screen.

import { supabase, SUPABASE_ANON, NUDGE_FN } from "./supabase";

// Public half of the VAPID pair (the private half lives in the vault). Safe in
// the client by design — it only lets the push service check who signed a push.
export const VAPID_PUBLIC_KEY = "BM93o0Z0wuIOHmY0f9Q_Vi2aS_b8matheaHaH5Eu5nRMLTyRannoM7_StQNBxVQRLpQBYG0gbmBxuZSMDjMRIJA";
const SW_URL = "/daily/sw.js";
const SW_SCOPE = "/daily/";
export const DEFAULT_NUDGE_AT = "08:30";

const NO_WINDOW = { error: "Not on a phone screen." };

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
export function permissionState(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

// Registered only from the standalone app (a Safari-tab registration would be
// a different worker that can never receive push on iOS). Idempotent.
export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (!isStandalone() || !pushSupported()) return null;
  try { return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }); } catch { return null; }
}

function urlBase64ToUint8Array(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

// One merge-writer for user_settings.learn on the client: read the row, merge,
// write, check {error}. (finishSession has its own for best_week — a race
// between the two is one tap during one finish, and the loser only loses a
// setting Ben can tap again.)
export async function patchLearn(uid: string, patch: Record<string, unknown>): Promise<{ error: string }> {
  try {
    const { data, error } = await supabase.from("user_settings").select("learn").eq("user_id", uid).maybeSingle();
    if (error) return { error: "Couldn't read your settings — try again." };
    const learn = ((data as { learn?: Record<string, unknown> } | null)?.learn ?? {});
    const { error: e2 } = await supabase.from("user_settings").upsert({ user_id: uid, learn: { ...learn, ...patch } }, { onConflict: "user_id" });
    return { error: e2 ? "Couldn't save that — try again." : "" };
  } catch { return { error: "Couldn't reach the server — try again." }; }
}

// The server needs the endpoint + keys to send; the row is keyed by endpoint
// so a re-subscribe on the same phone replaces, never duplicates.
async function saveSubscription(uid: string, sub: PushSubscription): Promise<{ error: string }> {
  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions")
    .upsert({ endpoint: sub.endpoint, user_id: uid, keys: json.keys ?? {}, ua: navigator.userAgent.slice(0, 200) }, { onConflict: "endpoint" });
  return { error: error ? "The phone said yes, but the server couldn't save it — tap again." : "" };
}

// Must run inside the tap: iOS refuses a permission prompt from anywhere else.
export async function subscribePush(uid: string, hour = DEFAULT_NUDGE_AT): Promise<{ error: string }> {
  if (typeof window === "undefined") return NO_WINDOW;
  if (!isStandalone()) return { error: "Add Daily to your Home Screen first: Share → Add to Home Screen. Then this button works." };
  if (!pushSupported()) return { error: "This phone can't do notifications for web apps yet (iPhone needs iOS 16.4 or newer)." };
  try {
    const perm = await Notification.requestPermission();
    if (perm === "denied") return { error: "iPhone blocked it. Settings → Notifications → Daily → Allow, then come back." };
    if (perm !== "granted") return { error: "No answer from the phone — tap Turn on again." };
    const reg = (await registerSw()) ?? (await navigator.serviceWorker.getRegistration(SW_SCOPE));
    if (!reg) return { error: "Couldn't start the background worker — close the app fully and open it again." };
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
    const saved = await saveSubscription(uid, sub);
    if (saved.error) return saved;
    return patchLearn(uid, { nudge_on: true, nudge_at: hour, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York" });
  } catch { return { error: "The phone didn't hand over a subscription — try again in a moment." }; }
}

// The SW's pushsubscriptionchange can't write the DB (no user token in a
// worker), so the app re-saves whatever subscription the phone holds now on
// each open. Nothing to do when there is none — that is RemindRow's "turned
// off by the phone" state, not an error.
export async function syncSubscription(uid: string): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  return !(await saveSubscription(uid, sub)).error;
}

export async function unsubscribePush(uid: string): Promise<{ error: string }> {
  try {
    const sub = await currentSubscription();
    if (sub) {
      const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      if (error) return { error: "Couldn't tell the server to stop — try again." };
      await sub.unsubscribe();
    }
    return patchLearn(uid, { nudge_on: false });
  } catch { return { error: "Couldn't reach the server — try again." }; }
}

// One real notification, now, to this user's phones — proof the whole chain works.
export async function sendTestPush(): Promise<{ error: string }> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const res = await fetch(NUDGE_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
      body: JSON.stringify({ mode: "test" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) return { error: json.error || `The server said no (${res.status}).` };
    return { error: "" };
  } catch { return { error: "Couldn't reach the server — try again." }; }
}
