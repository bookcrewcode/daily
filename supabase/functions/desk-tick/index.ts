// desk-tick — the Desk's five-minute heartbeat. It runs the ledger sync
// (fills, exits, funding, marks), runs the leagues' cycle (marks, deaths,
// candidates to every team), and every fifteen minutes launches the news feed
// and the technical scan as their own invocations so no call runs long (the
// gateway cuts any invocation at 150s). Cron: `1-59/5 * * * *` — one minute past each
// five-minute mark, after the exchanges have opened the new candle.
//
// verify_jwt=false; callers checked here: the cron's vault secret or the
// service role. It only calls sibling functions with the service role.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
type J = Record<string, unknown>;

async function secret(name: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: svcH, body: JSON.stringify({ secret_name: name }) });
  const j = await r.json().catch(() => null);
  return r.ok && typeof j === "string" ? j : "";
}
async function call(fn: string, body: J, ms: number): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    try { return JSON.parse(text) as J; } catch { return { error: `${fn}: HTTP ${r.status} ${text.slice(0, 120)}` }; }
  } catch (e) { return { error: `${fn}: ${e instanceof Error ? e.message : String(e)}` }; }
  finally { clearTimeout(t); }
}
// Fire and keep the isolate alive until the child answers, without waiting for it.
function launch(fn: string, body: J): void {
  const p = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body) }).then((r) => r.text()).catch((e) => console.error("[desk-tick] launch", fn, e instanceof Error ? e.message : e));
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const t0 = Date.now();
    const out: J = { at: new Date(t0).toISOString() };
    out.sync = await call("desk-sync", { mode: "sync", userId: uid }, 90_000);
    // The leagues: marks and deaths, then every fresh setup to every team (one child per team); the cycle
    // itself launches the sessions at their minutes and the daily cut after 16:06 ET.
    if (body.league !== false) out.league = await call("desk-league", { mode: "cycle", userId: uid }, 50_000);
    // The quarter-hour: the feed and the scan run in their own invocations.
    const minute = new Date().getUTCMinutes();
    const quarter = minute % 15 === 1 || body.force === true;
    if (quarter && body.feed !== false) { launch("desk-feed", { mode: "ingest", userId: uid }); out.feed = "launched"; }
    if (quarter && body.scan !== false) { launch("desk-scan", { mode: "scan", userId: uid }); out.scan = "launched"; }
    out.ms = Date.now() - t0;
    return ok(out);
  } catch (e) {
    console.error("[desk-tick] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
