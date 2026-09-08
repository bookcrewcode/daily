// Nudge edge function — one push a day: tomorrow's first question, at the
// time he picked, only if he hasn't done a round yet.
//
// TWO CALLERS: pg_cron every 15 minutes with {cronSecret} (matched against the
// vault), and the app with a user JWT + {mode:'test'}, which sends one real
// notification to that user's phones right now. The payload is iOS 18.4+
// "declarative web push": the JSON itself is the notification, so the phone
// shows it even when the service worker never gets to run.
//
// NEVER a day count, never "you missed": the body is a question or "your
// round is ready". nudge_sent_day is written BEFORE the send so a slow push
// service can't double-send, and a dead endpoint (404/410) is deleted.
//
// verify_jwt=false at the gateway; the JWT / cron secret is checked here.
import { ApplicationServer, importVapidKeys, PushMessageError } from "jsr:@negrel/webpush@0.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const NAVIGATE = "https://bookcrewcode.github.io/daily/?go=learn";
const READY = "Your round is ready. About 6 minutes.";

type C = Record<string, unknown>;
type Sub = { endpoint: string; user_id: string; keys: { auth: string; p256dh: string }; fails: number | null };
const S = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// vault secrets via the service-role-only get_secret RPC; missing = "" and can never match
async function secretOf(name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: name }) });
    return r.ok ? ((await r.json()) as string | null) ?? "" : "";
  } catch { return ""; }
}

async function getUser(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// REST as the service role. A failed read is null — never an empty list that
// would read as "nobody wants a reminder".
async function get<T>(q: string): Promise<T[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: SVC });
    if (!r.ok) { console.error(`[nudge] read ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return (await r.json()) as T[];
  } catch (e) { console.error(`[nudge] read ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return null; }
}
async function write(method: "PATCH" | "DELETE", q: string, body?: C): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method, headers: { ...SVC, Prefer: "return=minimal" }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) console.error(`[nudge] ${method} ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.error(`[nudge] ${method} ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return false; }
}

// his local calendar day and HH:MM; an unknown zone falls back to New York
function localNow(tz: string): { day: string; hm: string } {
  const parts = (z: string) => new Intl.DateTimeFormat("en-CA", { timeZone: z, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  let ps: Intl.DateTimeFormatPart[];
  try { ps = parts(tz); } catch { ps = parts("America/New_York"); }
  const p = Object.fromEntries(ps.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
// "7:00" → "07:00" so a plain string compare works
const hhmm = (v: unknown, dflt: string) => { const m = String(v ?? "").match(/^(\d{1,2}):(\d{2})$/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : dflt; };

// VAPID keys from the vault: the usual base64url pair (65-byte public point,
// 32-byte private scalar) or a JWK JSON — either way the library wants JWKs
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
async function appServer(): Promise<ApplicationServer | null> {
  const [pub, priv] = await Promise.all([secretOf("vapid_public_key"), secretOf("vapid_private_key")]);
  if (!pub || !priv) { console.error("[nudge] VAPID keys missing from the vault"); return null; }
  try {
    let publicKey: JsonWebKey, privateKey: JsonWebKey;
    if (priv.trim().startsWith("{")) {
      const j = JSON.parse(priv);
      privateKey = j.privateKey ?? j;
      publicKey = j.publicKey ?? { kty: "EC", crv: "P-256", x: privateKey.x, y: privateKey.y };
    } else {
      const p = unb64u(pub.trim());
      if (p.length !== 65) throw new Error(`public key is ${p.length} bytes, not a 65-byte P-256 point`);
      publicKey = { kty: "EC", crv: "P-256", x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)) };
      privateKey = { ...publicKey, d: b64u(unb64u(priv.trim())) };
    }
    const vapidKeys = await importVapidKeys({ publicKey, privateKey });
    return await ApplicationServer.new({ contactInformation: "mailto:getbookcrew@gmail.com", vapidKeys });
  } catch (e) { console.error("[nudge] VAPID import", e instanceof Error ? e.message : e); return null; }
}

// What the notification says: the question queued for today, else the oldest
// due card, else the plain invitation. Never a day count.
async function compose(uid: string, learn: C, day: string): Promise<{ title: string; body: string }> {
  const n = (learn.nudge ?? {}) as C;
  let nb = "", body = "";
  if (n.day === day && S(n.text, 140)) { body = S(n.text, 140); nb = S(n.nb, 120); }
  else {
    const c = (await get<{ front: string; notebook_id: string }>(`notebook_cards?select=front,notebook_id&user_id=eq.${uid}&suspended=eq.false&due=lte.${new Date().toISOString()}&order=due.asc&limit=1`))?.[0];
    if (c?.front) { body = `Quick one: ${S(c.front, 120)}`; nb = c.notebook_id; }
  }
  // nudge.nb may be the notebook's id rather than its name
  if (isUuid(nb)) nb = S((await get<{ title: string }>(`notebooks?select=title&id=eq.${nb}`))?.[0]?.title, 120);
  return { title: `${nb || "Daily"} · ~6 min`, body: body || READY };
}
const payload = (m: { title: string; body: string }) => JSON.stringify({ web_push: 8030, notification: { title: m.title, body: m.body, navigate: NAVIGATE, tag: "daily-round", app_badge: 1 } });

// One push per subscription. A dead endpoint (404/410) is deleted; any other
// failure counts against the row and is logged with the service's reply.
async function push(as: ApplicationServer, sub: Sub, text: string): Promise<boolean> {
  const q = `push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`;
  try {
    // a nudge older than a few hours is stale — better dropped than late
    await as.subscribe({ endpoint: sub.endpoint, keys: sub.keys }).pushTextMessage(text, { ttl: 4 * 3600 });
    await write("PATCH", q, { last_sent_at: new Date().toISOString() });
    return true;
  } catch (e) {
    const st = e instanceof PushMessageError ? e.response.status : 0;
    if (st === 404 || st === 410) { console.error(`[nudge] gone ${st} — dropping the subscription`); await write("DELETE", q); }
    else {
      const reply = e instanceof PushMessageError ? (await e.response.text().catch(() => "")).slice(0, 200) : e instanceof Error ? e.message : String(e);
      console.error(`[nudge] push ${st || "failed"} ${reply}`);
      await write("PATCH", q, { fails: (sub.fails ?? 0) + 1 });
    }
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const body = await req.json().catch(() => ({}));
    const cron = typeof body.cronSecret === "string" && body.cronSecret && body.cronSecret === await secretOf("nudge_cron_secret");
    let testUid = "";
    if (!cron) {
      const user = await getUser((req.headers.get("Authorization") ?? "").replace("Bearer ", ""));
      if (!user?.id) return json({ error: "unauthorized" }, 401);
      if (body.mode !== "test") return json({ error: "From the app only {mode:'test'} works — the daily reminder sends on its own." });
      testUid = user.id;
    }
    const as = await appServer();
    if (!as) return json({ error: "Push isn't set up on the server yet — nothing was sent." });

    const rows = await get<{ user_id: string; learn: C | null }>(testUid ? `user_settings?select=user_id,learn&user_id=eq.${testUid}` : `user_settings?select=user_id,learn&learn->>nudge_on=eq.true`);
    if (!rows) return json({ error: "Couldn't read who wants a reminder — nothing was sent." });
    // a test sends even before the settings row exists
    const settings = testUid && !rows.length ? [{ user_id: testUid, learn: {} }] : rows;
    const uids = settings.map((s) => s.user_id);
    const subs = uids.length ? await get<Sub>(`push_subscriptions?select=endpoint,user_id,keys,fails&user_id=in.(${uids.join(",")})`) : [];
    if (!subs) return json({ error: "Couldn't read the phone subscriptions — nothing was sent." });

    let checked = 0, sent = 0, skipped = 0;
    for (const s of settings) {
      const learn = (s.learn ?? {}) as C;
      const mine = subs.filter((x) => x.user_id === s.user_id);
      if (!mine.length) {
        if (testUid) return json({ error: "No phone is signed up for reminders yet — tap Turn on first." });
        skipped++; continue;
      }
      const { day, hm } = localNow(S(learn.tz, 60) || "America/New_York");
      if (!testUid) {
        checked++;
        if (hm < hhmm(learn.nudge_at, "08:30") || learn.nudge_sent_day === day) { skipped++; continue; }
        // a failed read skips too: silence beats a nag after a finished round
        const done = await get<{ id: string }>(`study_sessions?select=id&user_id=eq.${s.user_id}&status=eq.done&day=eq.${day}&scope=in.(today,chapter)&limit=1`);
        if (!done || done.length) { skipped++; continue; }
        // marked BEFORE sending so a slow push service can never double-send
        if (!(await write("PATCH", `user_settings?user_id=eq.${s.user_id}`, { learn: { ...learn, nudge_sent_day: day } }))) { skipped++; continue; }
      }
      const msg = await compose(s.user_id, learn, day);
      const text = payload(msg);
      let n = 0;
      for (const sub of mine) if (await push(as, sub, text)) n++;
      sent += n;
      console.error(`[nudge] sent uid=${s.user_id} subs=${n}/${mine.length} body="${msg.body}"`);
      if (testUid) return json({ sent: n, subs: mine.length, title: msg.title, body: msg.body, ...(n ? {} : { error: "The push service refused every phone — turn reminders off and on again on the phone." }) });
    }
    return json({ checked, sent, skipped });
  } catch (e) {
    console.error("[nudge] fatal", e instanceof Error ? e.message : e);
    return json({ error: "Something broke on the way — nothing was sent." });
  }
});
