// overseer-db: the Overseer agent (a Cloudflare Worker) reaches the database
// only through this function, so the service-role key never leaves Supabase.
// The caller proves itself with a shared secret whose SHA-256 sits in the
// vault (overseer_db_secret_sha256); guard.ts limits it to the listed tables
// and Ben's own rows. Until the hash exists, every call is refused.
//
// verify_jwt=false at the gateway; the secret is checked here.
import { refusal } from "./guard.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BEN = "f0e1e204-aa54-4a45-bbb5-99c83114fecb";
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

// the expected hash, re-read at most once a minute; a failed read refuses
let cached: { hash: string; at: number } | null = null;
async function expectedHash(): Promise<string> {
  if (cached && Date.now() - cached.at < 60_000) return cached.hash;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: "overseer_db_secret_sha256" }) });
    const hash = r.ok ? ((await r.json()) as string | null) ?? "" : "";
    cached = { hash, at: Date.now() };
    return hash;
  } catch {
    return "";
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const want = await expectedHash();
  if (!token || !want || (await sha256Hex(token)) !== want) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/overseer-db/, "");
  const raw = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("bad json", { status: 400 });
    }
  }
  const why = refusal(req.method, path, url.search, body, BEN);
  if (why) {
    console.error(`[overseer-db] refused ${req.method} ${path}: ${why}`);
    return new Response(`refused: ${why}`, { status: 403 });
  }

  const prefer = req.headers.get("Prefer");
  try {
    const r = await fetch(`${SUPABASE_URL}${path}${url.search}`, {
      method: req.method,
      headers: { ...SVC, ...(prefer ? { Prefer: prefer } : {}) },
      body: raw || undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(r.status === 204 ? null : await r.text(), {
      status: r.status,
      headers: { "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    console.error("[overseer-db] upstream", e instanceof Error ? e.message : e);
    return new Response("upstream failed", { status: 502 });
  }
});
