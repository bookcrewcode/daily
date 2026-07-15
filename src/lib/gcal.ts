"use client";

// TWO-WAY Google Calendar: create/edit/delete events straight from the app
// via the Calendar REST API + Google Identity Services token flow.
//
// - The OAuth Client ID is public config (it ships in the JS of every web app
//   that uses Google sign-in); Ben creates it once in Google Cloud Console.
// - Access tokens live in MEMORY only (~1h), silently re-requested when the
//   browser session still has a grant; a one-tap reconnect otherwise.
// - Scope is calendar.events only — least privilege, no calendar settings.

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type GEvent = {
  id: string;
  summary?: string;
  status?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
};

export class NeedsAuth extends Error {
  constructor() { super("needs-auth"); this.name = "NeedsAuth"; }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { google?: any } }

let gisReady: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisReady = null; reject(new Error("Couldn't load Google sign-in.")); };
    document.head.appendChild(s);
  });
  return gisReady;
}

let token: { value: string; exp: number } | null = null;

export function everGranted(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem("daily.gcal.granted") === "1";
}

// interactive=true must be called from a click handler (popup rules).
export async function acquireToken(clientId: string, interactive: boolean): Promise<string | null> {
  if (token && Date.now() < token.exp - 60_000) return token.value;
  try { await loadGis(); } catch { return null; }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const tc = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: (resp: any) => {
          if (resp?.access_token) {
            token = { value: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
            localStorage.setItem("daily.gcal.granted", "1");
            done(resp.access_token);
          } else done(null);
        },
        error_callback: () => done(null),
      });
      tc.requestAccessToken({ prompt: interactive ? "" : "none" });
      // silent attempts can hang if Google never answers — don't wedge the UI
      if (!interactive) setTimeout(() => done(null), 8000);
    } catch {
      done(null);
    }
  });
}

async function authedFetch(clientId: string, url: string, init?: RequestInit): Promise<Response> {
  const t = await acquireToken(clientId, false);
  if (!t) throw new NeedsAuth();
  const r = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
  });
  if (r.status === 401) { token = null; throw new NeedsAuth(); }
  if (r.status === 403) {
    // 403 is usually quota/rate-limit, not bad credentials — reconnecting
    // wouldn't help and would loop. Keep the token, surface a real message.
    throw new Error("Google said no (403) — likely rate-limited. Wait a minute and try again.");
  }
  return r;
}

export async function listDay(clientId: string, day: Date): Promise<GEvent[]> {
  const from = new Date(day); from.setHours(0, 0, 0, 0);
  const to = new Date(day); to.setHours(23, 59, 59, 999);
  const p = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    fields: "items(id,summary,status,start,end)",
  });
  const r = await authedFetch(clientId, `${API}?${p}`);
  if (!r.ok) throw new Error(`Calendar list failed (HTTP ${r.status})`);
  const json = await r.json();
  return ((json.items ?? []) as GEvent[]).filter((e) => e.status !== "cancelled");
}

export async function createEvent(clientId: string, summary: string, start: Date, end: Date): Promise<GEvent> {
  const r = await authedFetch(clientId, API, {
    method: "POST",
    body: JSON.stringify({ summary, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }),
  });
  if (!r.ok) throw new Error(`Couldn't create the event (HTTP ${r.status})`);
  return await r.json();
}

export async function patchEvent(clientId: string, id: string, patch: { summary?: string; start?: Date; end?: Date }): Promise<GEvent> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.start) body.start = { dateTime: patch.start.toISOString() };
  if (patch.end) body.end = { dateTime: patch.end.toISOString() };
  const r = await authedFetch(clientId, `${API}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Couldn't update the event (HTTP ${r.status})`);
  return await r.json();
}

export async function deleteEvent(clientId: string, id: string): Promise<void> {
  const r = await authedFetch(clientId, `${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok && r.status !== 410) throw new Error(`Couldn't delete the event (HTTP ${r.status})`);
}
