// Google OAuth (offline access, calendar.events scope only) and a small
// Calendar API client. The refresh token lives in the agent's own storage.
import { addDays, epochOf } from "./core/time";
import type { CalEvent, CalPort } from "./core/types";

export type Tokens = { access_token: string; refresh_token: string; expires_at: number };
export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(t: Tokens): Promise<void>;
}

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

export function authUrl(clientId: string, redirect: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
  return `${AUTH}?${q}`;
}

export async function exchangeCode(code: string, clientId: string, secret: string, redirect: string, f: typeof fetch = fetch, now = Date.now()): Promise<Tokens | null> {
  try {
    const r = await f(TOKEN, { method: "POST", headers: FORM, body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!j.access_token || !j.refresh_token) return null;
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: now + (j.expires_in ?? 3600) * 1000 };
  } catch {
    return null;
  }
}

export class GoogleCal implements CalPort {
  constructor(private store: TokenStore, private clientId: string, private secret: string, private f: typeof fetch = fetch, private clock: () => number = Date.now) {}

  private async token(): Promise<string | null> {
    const t = await this.store.get();
    if (!t) return null;
    if (t.expires_at - 60_000 > this.clock()) return t.access_token;
    try {
      const r = await this.f(TOKEN, { method: "POST", headers: FORM, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }) });
      if (!r.ok) return null;
      const j = (await r.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) return null;
      await this.store.set({ ...t, access_token: j.access_token, expires_at: this.clock() + (j.expires_in ?? 3600) * 1000 });
      return j.access_token;
    } catch {
      return null;
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<any | null> {
    const tok = await this.token();
    if (!tok) return null;
    try {
      const r = await this.f(`${EVENTS}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) {
        console.error(`[gcal] ${method} ${r.status}`);
        return null;
      }
      return r.status === 204 ? {} : await r.json();
    } catch (e) {
      console.error("[gcal]", e instanceof Error ? e.message : e);
      return null;
    }
  }

  private ev(j: any): CalEvent {
    return { id: String(j.id), title: String(j.summary ?? "(no title)"), start: String(j.start?.dateTime ?? j.start?.date ?? ""), end: String(j.end?.dateTime ?? j.end?.date ?? "") };
  }

  async listDay(day: string, tz: string) {
    const q = new URLSearchParams({
      timeMin: new Date(epochOf(day, "00:00", tz)).toISOString(),
      timeMax: new Date(epochOf(addDays(day, 1), "00:00", tz)).toISOString(),
      singleEvents: "true", orderBy: "startTime", timeZone: tz, maxResults: "50",
    });
    const j = await this.call("GET", `?${q}`);
    return j ? (Array.isArray(j.items) ? j.items.map((x: any) => this.ev(x)) : []) : null;
  }
  async create(title: string, start: string, end: string, tz: string) {
    const j = await this.call("POST", "", { summary: title, start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } });
    return j ? this.ev(j) : null;
  }
  async move(id: string, start: string, end: string, tz: string) {
    const j = await this.call("PATCH", `/${encodeURIComponent(id)}`, { start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } });
    return j ? this.ev(j) : null;
  }
  async get(id: string) {
    const j = await this.call("GET", `/${encodeURIComponent(id)}`);
    return j ? this.ev(j) : null;
  }
  async remove(id: string) {
    return (await this.call("DELETE", `/${encodeURIComponent(id)}`)) !== null;
  }
}
