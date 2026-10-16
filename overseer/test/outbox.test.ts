import { describe, expect, it } from "vitest";
import { afterSend, routeOf } from "../src/outbox";
import { DEFAULT_SETTINGS } from "../src/core/types";

const live = { ...DEFAULT_SETTINGS, chat_id: 111, dry_run: false, link_code: null };

describe("outbox", () => {
  it("holds everything while the settings can't be read", () => {
    expect(routeOf({ chat: "ben", text: "x" }, null)).toBeNull();
  });
  it("sends Ben's messages to his linked chat and partner messages to theirs", () => {
    expect(routeOf({ chat: "ben", text: "x" }, live)).toEqual({ chat: 111, dry: false });
    expect(routeOf({ chat: 222, text: "x" }, live)).toEqual({ chat: 222, dry: false });
    expect(routeOf({ chat: "ben", text: "x" }, { ...live, chat_id: null })).toEqual({ chat: null, dry: false });
  });
  it("only forced messages go out during dry run", () => {
    expect(routeOf({ chat: "ben", text: "x" }, { ...live, dry_run: true })).toEqual({ chat: 111, dry: true });
    expect(routeOf({ chat: 555, text: "x", force: true }, { ...live, dry_run: true })).toEqual({ chat: 555, dry: false });
  });
  it("drops a message Telegram rejects outright, retries one it may take later", () => {
    expect(afterSend("logged", 0)).toBe("delete");
    expect(afterSend({ ok: true, status: 200 }, 0)).toBe("delete");
    expect(afterSend({ ok: false, status: 400 }, 0)).toBe("drop");
    expect(afterSend({ ok: false, status: 403 }, 0)).toBe("drop");
    expect(afterSend({ ok: false, status: 429 }, 0)).toBe("retry");
    expect(afterSend({ ok: false, status: 502 }, 0)).toBe("retry");
    expect(afterSend({ ok: false, status: 502 }, 2)).toBe("drop");
  });
});
