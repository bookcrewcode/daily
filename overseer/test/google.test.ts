import { describe, expect, it } from "vitest";
import { authUrl, exchangeCode, GoogleCal, type TokenStore, type Tokens } from "../src/google";
import { mockFetch } from "./fakes";

function memStore(t: Tokens | null): TokenStore {
  let v = t;
  return { get: async () => v, set: async (n) => { v = n; } };
}

describe("google", () => {
  it("builds an offline consent URL for calendar events only", () => {
    const u = new URL(authUrl("cid", "https://w.test/google/callback", "st8"));
    expect([u.searchParams.get("access_type"), u.searchParams.get("prompt"), u.searchParams.get("scope"), u.searchParams.get("state")])
      .toEqual(["offline", "consent", "https://www.googleapis.com/auth/calendar.events", "st8"]);
  });
  it("exchanges a code for tokens", async () => {
    const { f } = mockFetch(() => ({ status: 200, body: { access_token: "A", refresh_token: "R", expires_in: 3600 } }));
    expect(await exchangeCode("code", "cid", "sec", "https://w.test/google/callback", f, 1000)).toEqual({ access_token: "A", refresh_token: "R", expires_at: 1000 + 3_600_000 });
  });
  it("refreshes an expired access token before calling the calendar", async () => {
    const store = memStore({ access_token: "OLD", refresh_token: "R", expires_at: 0 });
    const { f, calls } = mockFetch((url) => (url.startsWith("https://oauth2")
      ? { status: 200, body: { access_token: "NEW", expires_in: 3600 } }
      : { status: 200, body: { items: [{ id: "e1", summary: "Dentist", start: { dateTime: "2026-10-15T15:00:00-04:00" }, end: { dateTime: "2026-10-15T16:00:00-04:00" } }] } }));
    const cal = new GoogleCal(store, "cid", "sec", f, () => 10_000);
    expect(await cal.listDay("2026-10-15", "America/New_York")).toEqual([{ id: "e1", title: "Dentist", start: "2026-10-15T15:00:00-04:00", end: "2026-10-15T16:00:00-04:00" }]);
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer NEW");
    expect((await store.get())?.access_token).toBe("NEW");
  });
  it("returns null when Google refuses", async () => {
    const { f } = mockFetch(() => ({ status: 401, body: {} }));
    expect(await new GoogleCal(memStore({ access_token: "A", refresh_token: "R", expires_at: 9e15 }), "cid", "sec", f).listDay("2026-10-15", "America/New_York")).toBeNull();
  });
});
