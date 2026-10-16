import { describe, expect, it } from "vitest";
import { route, type RouterEnv, type Stub } from "../src/router";
import { mockFetch } from "./fakes";

const env: RouterEnv = {
  SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "ANON", BEN_USER_ID: "ben-id",
  APP_ORIGIN: "https://bookcrewcode.github.io", TELEGRAM_WEBHOOK_SECRET: "hook-secret",
};

function spy() {
  const seen = { inbound: [] as unknown[], api: [] as unknown[] };
  const stub: Stub = {
    inbound: async (u) => { seen.inbound.push(u); },
    api: async (op, body) => { seen.api.push([op, body]); return { ok: true }; },
    googleCallback: async (code, state) => code === "c1" && state === "s1",
  };
  return { seen, get: async () => stub };
}
const auth = (id: string) => mockFetch(() => ({ status: 200, body: { id } }));

describe("router", () => {
  it("rejects a webhook call without the secret", async () => {
    const s = spy();
    const r = await route(new Request("https://w.test/telegram", { method: "POST", body: "{}" }), env, s.get);
    expect(r.status).toBe(401);
    expect(s.seen.inbound).toEqual([]);
  });
  it("hands a signed webhook update to the agent", async () => {
    const s = spy();
    const r = await route(new Request("https://w.test/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" }, body: '{"update_id":1}' }), env, s.get);
    expect(r.status).toBe(200);
    expect(s.seen.inbound).toEqual([{ update_id: 1 }]);
  });
  it("answers the browser's preflight with CORS for the app's origin", async () => {
    const r = await route(new Request("https://w.test/api/status", { method: "OPTIONS" }), env, spy().get);
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(env.APP_ORIGIN);
  });
  it("refuses the app API without Ben's sign-in", async () => {
    const s = spy();
    expect((await route(new Request("https://w.test/api/status", { method: "POST" }), env, s.get, auth("ben-id").f)).status).toBe(403);
    expect((await route(new Request("https://w.test/api/status", { method: "POST", headers: { Authorization: "Bearer tok" } }), env, s.get, auth("someone-else").f)).status).toBe(403);
    expect(s.seen.api).toEqual([]);
  });
  it("passes Ben's API calls to the agent", async () => {
    const s = spy();
    const a = auth("ben-id");
    const r = await route(new Request("https://w.test/api/undo", { method: "POST", headers: { Authorization: "Bearer tok" }, body: '{"action_id":"a1"}' }), env, s.get, a.f);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(s.seen.api).toEqual([["undo", { action_id: "a1" }]]);
    expect(a.calls[0].url).toBe("https://sb.test/auth/v1/user");
    expect((a.calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    // the sign-in check uses the public app key, never a service key
    expect((a.calls[0].init?.headers as Record<string, string>).apikey).toBe("ANON");
  });
  it("404s anything else", async () => {
    expect((await route(new Request("https://w.test/"), env, spy().get)).status).toBe(404);
  });
  it("sends Google's sign-in back to the app's Overseer page", async () => {
    const s = spy();
    const r = await route(new Request("https://w.test/google/callback?code=c1&state=s1"), env, s.get);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("https://bookcrewcode.github.io/daily/?go=overseer&google=ok");
  });
});
