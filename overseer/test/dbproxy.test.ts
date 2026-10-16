import { describe, expect, it } from "vitest";
import { refusal } from "../../supabase/functions/overseer-db/guard";

const BEN = "ben-id";
const mine = `user_id=eq.${BEN}`;

describe("overseer-db guard", () => {
  it("forwards Ben's own reads", () => {
    expect(refusal("GET", "/rest/v1/nights", `?${mine}&day=eq.2026-10-16`, null, BEN)).toBeNull();
  });
  it("refuses reads that aren't scoped to Ben", () => {
    expect(refusal("GET", "/rest/v1/nights", "?day=eq.2026-10-16", null, BEN)).toBe("owner");
    expect(refusal("GET", "/rest/v1/nights", "?user_id=eq.someone", null, BEN)).toBe("owner");
  });
  it("refuses tables it doesn't list, and RPC calls", () => {
    expect(refusal("GET", "/rest/v1/push_subscriptions", `?${mine}`, null, BEN)).toBe("table");
    expect(refusal("POST", "/rest/v1/rpc/get_secret", "", { secret_name: "x" }, BEN)).toBe("path");
  });
  it("forwards inserts and upserts only when every row is Ben's", () => {
    expect(refusal("POST", "/rest/v1/nights", "?on_conflict=user_id,day", { user_id: BEN, day: "d" }, BEN)).toBeNull();
    expect(refusal("POST", "/rest/v1/overseer_spend", "", [{ user_id: BEN }, { user_id: BEN }], BEN)).toBeNull();
    expect(refusal("POST", "/rest/v1/nights", "", { user_id: "someone" }, BEN)).toBe("owner");
    expect(refusal("POST", "/rest/v1/nights", "", [{ user_id: BEN }, { day: "d" }], BEN)).toBe("owner");
  });
  it("never lets an update move a row to someone else", () => {
    expect(refusal("PATCH", "/rest/v1/goals", `?id=eq.g1&${mine}`, { status: "done" }, BEN)).toBeNull();
    expect(refusal("PATCH", "/rest/v1/goals", `?id=eq.g1&${mine}`, { user_id: "someone" }, BEN)).toBe("owner");
  });
  it("keeps the app's own settings and timetable read-only", () => {
    expect(refusal("GET", "/rest/v1/user_settings", `?${mine}&select=learn`, null, BEN)).toBeNull();
    expect(refusal("PATCH", "/rest/v1/user_settings", `?${mine}`, { learn: {} }, BEN)).toBe("read-only");
    expect(refusal("DELETE", "/rest/v1/class_blocks", `?${mine}`, null, BEN)).toBe("read-only");
  });
  it("refuses other methods", () => {
    expect(refusal("PUT", "/rest/v1/nights", `?${mine}`, { user_id: BEN }, BEN)).toBe("method");
  });
});
