// Daily — service worker. PUSH ONLY.
//
// There is deliberately NO fetch listener and NO cache here. A worker that
// caches the app shell once kept serving a day-old bundle after a deploy (the
// stale-cache bug), so this file never sits between the app and the network.
// Three listeners, nothing else. If you add a fourth, say why above it.

// Keep in step with VAPID_PUBLIC_KEY in src/lib/push.ts (a worker can't import it).
const VAPID_PUBLIC_KEY = "BM93o0Z0wuIOHmY0f9Q_Vi2aS_b8matheaHaH5Eu5nRMLTyRannoM7_StQNBxVQRLpQBYG0gbmBxuZSMDjMRIJA";
const LEARN_URL = "/daily/?go=learn";
const TAG = "daily-round";

function keyBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ALWAYS show something inside waitUntil: iOS revokes push for a worker that
// takes a push and shows nothing. A bad payload gets the generic title.
self.addEventListener("push", (event) => {
  let n = {};
  try {
    const data = event.data ? event.data.json() : {};
    n = (data && data.notification) || data || {};
  } catch { n = {}; }
  const title = typeof n.title === "string" && n.title ? n.title : "Daily";
  const body = typeof n.body === "string" && n.body ? n.body : "Your round is ready. About 6 minutes.";
  const url = typeof n.navigate === "string" && n.navigate ? n.navigate : LEARN_URL;
  const show = self.registration.showNotification(title, { body, tag: TAG, renotify: false, data: { url } });
  const badge = typeof n.app_badge === "number" && self.navigator && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(n.app_badge).catch(() => {}) : Promise.resolve();
  event.waitUntil(Promise.all([show, badge]));
});

// Tap → the open app jumps to Learn (an 'open-learn' message the shell listens
// for); no open app → a new window on the deep link.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || LEARN_URL;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.focused) || wins[0];
    if (win) {
      try { await win.focus(); } catch {}
      win.postMessage({ type: "open-learn" });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The push service rotated the endpoint: re-subscribe with the same key and
// tell any open app to re-save it (a worker holds no user token, so the app
// does the write — push.ts syncSubscription — on its next open).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "push-resubscribed", endpoint: sub.endpoint });
  })());
});
