import { describe, expect, it } from "vitest";
import { SupabaseDb } from "../src/core/db";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { mockFetch } from "./fakes";

const mk = (h: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(h);
  return { db: new SupabaseDb("https://sb.test", "SERVICE", "u1", m.f), calls: m.calls };
};

describe("SupabaseDb", () => {
  it("reads a failed day as null and a missing day as none", async () => {
    expect(await mk(() => ({ status: 500, body: {} })).db.day("2026-10-15")).toBeNull();
    expect(await mk(() => ({ status: 200, body: [] })).db.day("2026-10-15")).toBe("none");
    const r = await mk(() => ({ status: 200, body: [{ items: [{ id: "a" }], blocks_seeded: true, top3: ["x", "", 3] }] })).db.day("2026-10-15");
    expect(r).toEqual({ items: [{ id: "a" }], blocks_seeded: true, top3: ["x"] });
  });
  it("writes the list as a partial upsert scoped to Ben", async () => {
    const { db, calls } = mk(() => ({ status: 201, body: null }));
    expect(await db.saveItems("2026-10-15", [], { blocks_seeded: true })).toBe(true);
    expect(calls[0].url).toBe("https://sb.test/rest/v1/nights?on_conflict=user_id,day");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Prefer).toBe("resolution=merge-duplicates,return=minimal");
    expect(headers.Authorization).toBe("Bearer SERVICE");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ user_id: "u1", day: "2026-10-15", items: [], blocks_seeded: true });
  });
  it("fills settings defaults when there is no row yet", async () => {
    expect(await mk(() => ({ status: 200, body: [] })).db.settings()).toEqual({ ...DEFAULT_SETTINGS, link_code: null });
  });
  it("sums today's spend, and an unreadable spend is null", async () => {
    expect(await mk(() => ({ status: 200, body: [{ cost_usd: 0.25 }, { cost_usd: "0.5" }] })).db.spent("2026-10-15")).toBeCloseTo(0.75);
    expect(await mk(() => { throw new Error("offline"); }).db.spent("2026-10-15")).toBeNull();
  });
  it("joins a partner only through an unused invite", async () => {
    const { db, calls } = mk(() => ({ status: 200, body: [{ id: "p1", name: "Gavin", chat_id: 222, joined_at: "t", left_at: null, sent: 0 }] }));
    expect((await db.joinPartner("inv123", 222))?.name).toBe("Gavin");
    expect(calls[0].url).toContain("invite_code=eq.inv123");
    expect(calls[0].url).toContain("joined_at=is.null");
  });
  it("reads the Learn reminder setting and whether today's round is done", async () => {
    const { db } = mk((url) => (url.includes("user_settings")
      ? { status: 200, body: [{ learn: { nudge_on: true, nudge_at: "09:15" } }] }
      : { status: 200, body: [{ id: "s1" }] }));
    expect(await db.learn("2026-10-15")).toEqual({ on: true, at: "09:15", done: true });
  });
});
