import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupabaseDb } from "../src/core/db";
import { TgClient } from "../src/core/telegram";
import { GoogleCal } from "../src/google";

// Cloudflare Workers throw "Illegal invocation" when the global fetch is called
// as a method of some other object (this.f(...)). Node doesn't, so mimic it.
const real = globalThis.fetch;
let body: unknown = [];

beforeEach(() => {
  globalThis.fetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  } as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = real;
});

describe("default fetch works the way Workers require", () => {
  it("SupabaseDb reads with the default fetch", async () => {
    body = [{ cost_usd: 0.5 }];
    expect(await new SupabaseDb("https://sb.test", "KEY", "u1").spent("2026-10-22")).toBe(0.5);
  });
  it("TgClient calls Telegram with the default fetch", async () => {
    body = { ok: true, result: { username: "dailyappalert_bot" } };
    expect(await new TgClient("T").getMe()).toBe("dailyappalert_bot");
  });
  it("GoogleCal calls Google with the default fetch", async () => {
    body = { items: [] };
    const store = { get: async () => ({ access_token: "A", refresh_token: "R", expires_at: 9e15 }), set: async () => {} };
    expect(await new GoogleCal(store, "cid", "sec").listDay("2026-10-22", "America/New_York")).toEqual([]);
  });
});
