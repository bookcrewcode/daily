// Telegram at the edges: turn an update into one of three shapes, check the
// webhook secret, decide who is talking, and a tiny Bot API client. The
// client never logs request URLs because they carry the bot token.
import type { Btn } from "./types";

export type Inbound =
  | { kind: "text"; update_id: number; chat_id: number; from_name: string; text: string }
  | { kind: "tap"; update_id: number; chat_id: number; callback_id: string; data: string }
  | { kind: "other"; update_id: number };

export function parseUpdate(u: unknown): Inbound {
  const x = (u ?? {}) as Record<string, any>;
  const update_id = Number(x.update_id) || 0;
  const m = x.message;
  if (m && typeof m.text === "string" && m.chat) {
    return { kind: "text", update_id, chat_id: Number(m.chat.id), from_name: String(m.from?.first_name ?? ""), text: m.text.slice(0, 4000) };
  }
  const q = x.callback_query;
  if (q && typeof q.data === "string") {
    return { kind: "tap", update_id, chat_id: Number(q.message?.chat?.id ?? q.from?.id), callback_id: String(q.id), data: q.data };
  }
  return { kind: "other", update_id };
}

export function webhookOk(header: string | null, secret: string): boolean {
  if (!secret || !header || header.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export type Who = { role: "ben" } | { role: "link"; code: string } | { role: "join"; code: string } | { role: "leave" } | { role: "ignore" };

export function classify(ev: Inbound, benChat: number | null, partnerChats: number[]): Who {
  if (ev.kind === "other") return { role: "ignore" };
  const text = ev.kind === "text" ? ev.text.trim() : "";
  const start = text.match(/^\/start\s+(link_|p_)([A-Za-z0-9]{6,40})$/);
  if (start && start[1] === "link_") return { role: "link", code: start[2] };
  if (benChat !== null && ev.chat_id === benChat) return { role: "ben" };
  if (start && start[1] === "p_") return { role: "join", code: start[2] };
  if (text === "/stop" && partnerChats.includes(ev.chat_id)) return { role: "leave" };
  return { role: "ignore" };
}

export class TgClient {
  lastStatus = 0;     // HTTP status of the last failed call (0 = network)
  constructor(private token: string, private f: typeof fetch = fetch) {}

  async call(method: string, body: Record<string, unknown>): Promise<any | null> {
    try {
      const r = await this.f(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
      if (!r.ok || !j?.ok) {
        this.lastStatus = r.status;
        console.error(`[tg] ${method} ${r.status} ${j?.description ?? ""}`);
        return null;
      }
      return j.result ?? true;
    } catch (e) {
      this.lastStatus = 0;
      console.error(`[tg] ${method}`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  send(chat: number, text: string, buttons?: Btn[][]) {
    const keyboard = buttons?.length
      ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } }
      : {};
    return this.call("sendMessage", { chat_id: chat, text: text.slice(0, 4000), ...keyboard });
  }

  answer(id: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id });
  }

  async getMe(): Promise<string | null> {
    const r = await this.call("getMe", {});
    return r && typeof r.username === "string" ? r.username : null;
  }

  async setWebhook(url: string, secret: string): Promise<boolean> {
    return (await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] })) !== null;
  }
}
