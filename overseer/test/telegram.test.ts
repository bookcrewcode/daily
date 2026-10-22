import { describe, expect, it } from "vitest";
import { classify, parseUpdate, TgClient, webhookOk, type Inbound } from "../src/core/telegram";
import { mockFetch } from "./fakes";

const text = (chat: number, t: string): Inbound => ({ kind: "text", update_id: 1, chat_id: chat, from_name: "", text: t });

describe("parseUpdate", () => {
  it("reads a text message", () => {
    expect(parseUpdate({ update_id: 7, message: { chat: { id: 111 }, from: { first_name: "Ben" }, text: "hi" } }))
      .toEqual({ kind: "text", update_id: 7, chat_id: 111, from_name: "Ben", text: "hi" });
  });
  it("reads a button tap", () => {
    expect(parseUpdate({ update_id: 8, callback_query: { id: "cq", data: "d|a", message: { chat: { id: 111 } }, from: { id: 111 } } }))
      .toEqual({ kind: "tap", update_id: 8, chat_id: 111, callback_id: "cq", data: "d|a" });
  });
  it("treats anything else as other", () => {
    expect(parseUpdate({ update_id: 9, edited_message: {} })).toEqual({ kind: "other", update_id: 9 });
    expect(parseUpdate(null)).toEqual({ kind: "other", update_id: 0 });
  });
});

describe("webhookOk", () => {
  it("accepts only the exact secret", () => {
    expect(webhookOk("s3cret", "s3cret")).toBe(true);
    expect(webhookOk("s3creX", "s3cret")).toBe(false);
    expect(webhookOk(null, "s3cret")).toBe(false);
    expect(webhookOk("", "")).toBe(false);
  });
});

describe("classify", () => {
  it("Ben's chat is Ben", () => expect(classify(text(111, "hello"), 111, [])).toEqual({ role: "ben" }));
  it("a link code from any chat links", () => expect(classify(text(555, "/start link_abc123"), null, [])).toEqual({ role: "link", code: "abc123" }));
  it("an invite code joins", () => expect(classify(text(222, "/start p_inv123"), 111, [])).toEqual({ role: "join", code: "inv123" }));
  it("a partner can leave", () => expect(classify(text(222, "/stop"), 111, [222])).toEqual({ role: "leave" }));
  it("everyone else is ignored", () => {
    expect(classify(text(999, "hi"), 111, [222])).toEqual({ role: "ignore" });
    expect(classify(text(222, "hi"), 111, [222])).toEqual({ role: "ignore" });
    expect(classify({ kind: "tap", update_id: 1, chat_id: 999, callback_id: "x", data: "d|a" }, 111, [])).toEqual({ role: "ignore" });
  });
});

describe("TgClient", () => {
  it("sends buttons as an inline keyboard and links as url buttons", async () => {
    const { f, calls } = mockFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 1 } } }));
    const tg = new TgClient("TOKEN", f);
    expect(await tg.send(111, "hi", [[{ text: "Done", data: "d|a" }, { text: "Open", url: "https://x.test" }]])).toEqual({ message_id: 1 });
    expect(calls[0].url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      chat_id: 111, text: "hi",
      reply_markup: { inline_keyboard: [[{ text: "Done", callback_data: "d|a" }, { text: "Open", url: "https://x.test" }]] },
    });
  });
  it("returns null when Telegram says no", async () => {
    const { f } = mockFetch(() => ({ status: 400, body: { ok: false, description: "chat not found" } }));
    const tg = new TgClient("T", f);
    expect(await tg.send(1, "x")).toBeNull();
    expect(tg.lastStatus).toBe(400);
  });
  it("reads the bot's username", async () => {
    const { f } = mockFetch(() => ({ status: 200, body: { ok: true, result: { username: "ben_overseer_bot" } } }));
    expect(await new TgClient("T", f).getMe()).toBe("ben_overseer_bot");
  });
});
