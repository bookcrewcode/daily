// HTTP edge of the Worker. Telegram must carry the webhook secret; the app
// must carry Ben's Supabase session. Anything else is a 404.
import { webhookOk } from "./core/telegram";

export type Stub = {
  inbound(update: unknown): Promise<void>;
  api(op: string, body: Record<string, unknown>, origin: string): Promise<Record<string, unknown>>;
};
export type RouterEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string; BEN_USER_ID: string; APP_ORIGIN: string; TELEGRAM_WEBHOOK_SECRET: string };

export async function userIdOf(auth: string | null, env: RouterEnv, f: typeof fetch): Promise<string | null> {
  const token = auth?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token) return null;
  try {
    const r = await f(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return ((await r.json()) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

export async function route(req: Request, env: RouterEnv, stub: () => Promise<Stub>, f: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const cors = { "Access-Control-Allow-Origin": env.APP_ORIGIN, "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...cors } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (url.pathname === "/telegram" && req.method === "POST") {
    if (!webhookOk(req.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TELEGRAM_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
    let update: unknown;
    try {
      update = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    await (await stub()).inbound(update);
    return new Response("ok");
  }

  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    if ((await userIdOf(req.headers.get("Authorization"), env, f)) !== env.BEN_USER_ID) return json({ ok: false, error: "forbidden" }, 403);
    let body: Record<string, unknown> = {};
    try {
      const b = await req.json();
      if (b && typeof b === "object") body = b as Record<string, unknown>;
    } catch {
      // no body
    }
    return json(await (await stub()).api(url.pathname.slice(5), body, url.origin));
  }

  return new Response("not found", { status: 404 });
}
