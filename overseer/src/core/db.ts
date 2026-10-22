// Everything the Overseer reads or writes in Supabase goes through this port.
// SupabaseDb talks PostgREST with the service role and scopes every query to
// Ben's user id. A failed read is null, never an empty list: "couldn't read"
// must not look like "nothing to do".
import type { DayItem } from "../../../src/lib/theGame";
import { addDays, isHhmm } from "./time";
import { plainFetch } from "./http";
import { DEFAULT_SETTINGS, type ActionRow, type Block, type Line, type Partner, type Settings } from "./types";

export type SettingsRow = Settings & { link_code: string | null };
export type DayRow = { items: unknown; blocks_seeded: boolean; top3: string[] };
export type GoalRow = { id: string; title: string; due: string | null; steps: { id: string; title: string; done: boolean }[] };
export type MessageIn = { direction: "in" | "out"; peer: "ben" | "partner"; text: string; buttons: unknown; dry_run: boolean };
export type StakesEvent = { day: string; item_id: string; what: string; status: "started" | "cancelled" | "sent" | "voided"; line_id: string; partner_id: string };
export type SpendRow = { day: string; model: string; purpose: string; cost_usd: number; tokens_in: number; tokens_out: number };
export type LearnInfo = { on: boolean; at: string; done: boolean };

export interface Db {
  settings(): Promise<SettingsRow | null>;
  patchSettings(p: Partial<SettingsRow>): Promise<boolean>;
  day(day: string): Promise<DayRow | "none" | null>;
  saveItems(day: string, items: DayItem[], extra?: { blocks_seeded?: boolean }): Promise<boolean>;
  mirrorCounts(day: string, done: number, total: number): Promise<boolean>;
  setTop3(day: string, top3: string[]): Promise<boolean>;
  blocks(weekday: number): Promise<Block[] | null>;
  goalsDue(day: string): Promise<{ id: string; title: string }[] | null>;
  setGoalDone(goalId: string, done: boolean): Promise<boolean>;
  goals(): Promise<GoalRow[] | null>;
  setStepDone(stepId: string, done: boolean): Promise<boolean>;
  addStep(goalId: string, title: string): Promise<string | null>;
  deleteStep(stepId: string): Promise<boolean>;
  addCapture(text: string): Promise<string | null>;
  deleteCapture(id: string): Promise<boolean>;
  captures(): Promise<{ id: string; text: string }[] | null>;
  setCaptureDone(id: string, done: boolean): Promise<boolean>;
  habits(day: string): Promise<Record<string, boolean> | null>;
  setHabit(day: string, key: string, val: boolean): Promise<boolean>;
  learn(day: string): Promise<LearnInfo | null>;
  logMessage(m: MessageIn): Promise<void>;
  logAction(a: { tool: string; summary: string; before: unknown; after: unknown }): Promise<string | null>;
  action(id: string): Promise<ActionRow | null>;
  markUndone(id: string): Promise<boolean>;
  addSpend(r: SpendRow): Promise<void>;
  spent(day: string): Promise<number | null>;
  lines(): Promise<Line[] | null>;
  bumpLine(id: string, used: number): Promise<void>;
  partners(): Promise<Partner[] | null>;
  createInvite(name: string, code: string): Promise<boolean>;
  joinPartner(code: string, chatId: number): Promise<Partner | null>;
  leavePartner(chatId: number): Promise<string | null>;
  bumpPartner(id: string, sent: number): Promise<void>;
  logStakes(e: StakesEvent): Promise<void>;
}

const nowIso = () => new Date().toISOString();

export class SupabaseDb implements Db {
  constructor(private url: string, private key: string, private uid: string, private f: typeof fetch = plainFetch) {}

  private headers(prefer?: string): Record<string, string> {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) };
  }
  private get u() {
    return `user_id=eq.${this.uid}`;
  }
  private async get<T>(q: string): Promise<T[] | null> {
    try {
      const r = await this.f(`${this.url}/rest/v1/${q}`, { headers: this.headers() });
      if (!r.ok) {
        console.error(`[db] read ${q.split("?")[0]} ${r.status}`);
        return null;
      }
      return (await r.json()) as T[];
    } catch (e) {
      console.error(`[db] read ${q.split("?")[0]}`, e instanceof Error ? e.message : e);
      return null;
    }
  }
  private async send(method: "POST" | "PATCH" | "DELETE", q: string, body?: unknown, prefer = "return=minimal"): Promise<unknown[] | null> {
    try {
      const r = await this.f(`${this.url}/rest/v1/${q}`, { method, headers: this.headers(prefer), body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) {
        console.error(`[db] ${method} ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
        return null;
      }
      return prefer.includes("representation") ? ((await r.json()) as unknown[]) : [];
    } catch (e) {
      console.error(`[db] ${method} ${q.split("?")[0]}`, e instanceof Error ? e.message : e);
      return null;
    }
  }
  // Partial upsert: PostgREST only writes the columns in the payload.
  private async upsert(table: string, row: Record<string, unknown>, conflict = "user_id,day"): Promise<boolean> {
    return (await this.send("POST", `${table}?on_conflict=${conflict}`, { user_id: this.uid, ...row }, "resolution=merge-duplicates,return=minimal")) !== null;
  }
  private idOf(rows: unknown[] | null): string | null {
    return (rows?.[0] as { id?: string } | undefined)?.id ?? null;
  }

  async settings(): Promise<SettingsRow | null> {
    const rows = await this.get<Record<string, unknown>>(`overseer_settings?${this.u}&select=*`);
    if (!rows) return null;
    const r = rows[0] ?? {};
    const d = DEFAULT_SETTINGS;
    const num = (v: unknown, def: number) => (v === undefined || v === null || Number.isNaN(Number(v)) ? def : Number(v));
    const str = (v: unknown, def: string) => (typeof v === "string" && v ? v : def);
    return {
      tz: str(r.tz, d.tz),
      wake: str(r.wake, d.wake),
      wrap: str(r.wrap, d.wrap),
      ping_kinds: Array.isArray(r.ping_kinds) ? (r.ping_kinds as string[]) : d.ping_kinds,
      ping_every_min: num(r.ping_every_min, d.ping_every_min),
      cap_usd: num(r.cap_usd, d.cap_usd),
      cheap_model: str(r.cheap_model, d.cheap_model),
      smart_model: str(r.smart_model, d.smart_model),
      paused: r.paused === true,
      dry_run: r.dry_run === undefined ? d.dry_run : r.dry_run === true,
      chat_id: r.chat_id === null || r.chat_id === undefined ? null : Number(r.chat_id),
      link_code: typeof r.link_code === "string" ? r.link_code : null,
    };
  }
  patchSettings(p: Partial<SettingsRow>) {
    return this.upsert("overseer_settings", { ...p, updated_at: nowIso() }, "user_id");
  }
  async day(day: string): Promise<DayRow | "none" | null> {
    const rows = await this.get<{ items: unknown; blocks_seeded: boolean; top3: unknown }>(`nights?${this.u}&day=eq.${day}&select=items,blocks_seeded,top3`);
    if (!rows) return null;
    if (!rows.length) return "none";
    const r = rows[0];
    const top3 = Array.isArray(r.top3) ? r.top3.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
    return { items: r.items, blocks_seeded: r.blocks_seeded === true, top3 };
  }
  saveItems(day: string, items: DayItem[], extra: { blocks_seeded?: boolean } = {}) {
    return this.upsert("nights", { day, items, ...extra });
  }
  mirrorCounts(day: string, done: number, total: number) {
    return this.upsert("game_days", { day, items_done: done, items_total: total });
  }
  setTop3(day: string, top3: string[]) {
    return this.upsert("nights", { day, top3 });
  }
  blocks(weekday: number) {
    return this.get<Block>(`class_blocks?${this.u}&weekday=eq.${weekday}&select=id,label,location,kind,start_t,end_t&order=start_t`);
  }
  goalsDue(day: string) {
    return this.get<{ id: string; title: string }>(`goals?${this.u}&status=eq.active&due=gte.${addDays(day, -7)}&due=lte.${day}&select=id,title&order=due.asc&limit=3`);
  }
  async setGoalDone(goalId: string, done: boolean) {
    const a = await this.send("PATCH", `goals?id=eq.${goalId}&${this.u}`, { status: done ? "done" : "active", updated_at: nowIso() });
    const b = await this.send("PATCH", `deadlines?goal_id=eq.${goalId}&${this.u}`, { done });
    return a !== null && b !== null;
  }
  async goals(): Promise<GoalRow[] | null> {
    const gs = await this.get<{ id: string; title: string; due: string | null }>(`goals?${this.u}&status=eq.active&select=id,title,due&order=due.asc.nullslast&limit=20`);
    if (!gs) return null;
    if (!gs.length) return [];
    const steps = await this.get<{ id: string; goal_id: string; title: string; done: boolean }>(
      `goal_steps?${this.u}&goal_id=in.(${gs.map((g) => g.id).join(",")})&select=id,goal_id,title,done&order=sort.asc`,
    );
    if (!steps) return null;
    return gs.map((g) => ({ ...g, steps: steps.filter((s) => s.goal_id === g.id).map(({ id, title, done }) => ({ id, title, done })) }));
  }
  async setStepDone(stepId: string, done: boolean) {
    return (await this.send("PATCH", `goal_steps?id=eq.${stepId}&${this.u}`, { done })) !== null;
  }
  async addStep(goalId: string, title: string) {
    return this.idOf(await this.send("POST", "goal_steps", { user_id: this.uid, goal_id: goalId, title }, "return=representation"));
  }
  async deleteStep(stepId: string) {
    return (await this.send("DELETE", `goal_steps?id=eq.${stepId}&${this.u}`)) !== null;
  }
  async addCapture(text: string) {
    return this.idOf(await this.send("POST", "captures", { user_id: this.uid, text }, "return=representation"));
  }
  async deleteCapture(id: string) {
    return (await this.send("DELETE", `captures?id=eq.${id}&${this.u}`)) !== null;
  }
  captures() {
    return this.get<{ id: string; text: string }>(`captures?${this.u}&done=eq.false&select=id,text&order=created_at&limit=30`);
  }
  async setCaptureDone(id: string, done: boolean) {
    return (await this.send("PATCH", `captures?id=eq.${id}&${this.u}`, { done })) !== null;
  }
  async habits(day: string) {
    const rows = await this.get<Record<string, unknown>>(`days?${this.u}&day=eq.${day}&select=*`);
    if (!rows) return null;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(rows[0] ?? {})) if (k.startsWith("ws_")) out[k] = v === true;
    return out;
  }
  setHabit(day: string, key: string, val: boolean) {
    return this.upsert("days", { day, [key]: val });
  }
  async learn(day: string): Promise<LearnInfo | null> {
    const [s, done] = await Promise.all([
      this.get<{ learn: Record<string, unknown> | null }>(`user_settings?${this.u}&select=learn`),
      this.get<{ id: string }>(`study_sessions?${this.u}&status=eq.done&day=eq.${day}&scope=in.(today,chapter)&select=id&limit=1`),
    ]);
    if (!s || !done) return null;
    const l = s[0]?.learn ?? {};
    const at = typeof l.nudge_at === "string" && isHhmm(l.nudge_at) ? l.nudge_at : "08:30";
    return { on: l.nudge_on === true, at, done: done.length > 0 };
  }
  async logMessage(m: MessageIn) {
    await this.send("POST", "overseer_messages", { user_id: this.uid, ...m });
  }
  async logAction(a: { tool: string; summary: string; before: unknown; after: unknown }) {
    return this.idOf(await this.send("POST", "overseer_actions", { user_id: this.uid, ...a }, "return=representation"));
  }
  async action(id: string) {
    const rows = await this.get<ActionRow>(`overseer_actions?id=eq.${id}&${this.u}&select=id,tool,summary,before,after,undone_at`);
    return rows?.[0] ?? null;
  }
  async markUndone(id: string) {
    return (await this.send("PATCH", `overseer_actions?id=eq.${id}&${this.u}`, { undone_at: nowIso() })) !== null;
  }
  async addSpend(r: SpendRow) {
    await this.send("POST", "overseer_spend", { user_id: this.uid, ...r });
  }
  async spent(day: string) {
    const rows = await this.get<{ cost_usd: unknown }>(`overseer_spend?${this.u}&day=eq.${day}&select=cost_usd`);
    return rows ? rows.reduce((t, r) => t + (Number(r.cost_usd) || 0), 0) : null;
  }
  lines() {
    return this.get<Line>(`overseer_stakes_lines?${this.u}&archived=eq.false&select=id,text,used&order=created_at`);
  }
  async bumpLine(id: string, used: number) {
    await this.send("PATCH", `overseer_stakes_lines?id=eq.${id}&${this.u}`, { used });
  }
  partners() {
    return this.get<Partner>(`overseer_partners?${this.u}&select=id,name,chat_id,joined_at,left_at,sent&order=created_at`);
  }
  async createInvite(name: string, code: string) {
    return (await this.send("POST", "overseer_partners", { user_id: this.uid, name, invite_code: code })) !== null;
  }
  async joinPartner(code: string, chatId: number) {
    const r = await this.send(
      "PATCH",
      `overseer_partners?invite_code=eq.${encodeURIComponent(code)}&${this.u}&left_at=is.null&joined_at=is.null`,
      { chat_id: chatId, joined_at: nowIso() },
      "return=representation",
    );
    const p = r?.[0] as Partner | undefined;
    return p ? { id: p.id, name: p.name, chat_id: p.chat_id, joined_at: p.joined_at, left_at: p.left_at, sent: p.sent } : null;
  }
  async leavePartner(chatId: number) {
    const r = await this.send("PATCH", `overseer_partners?chat_id=eq.${chatId}&${this.u}&left_at=is.null`, { left_at: nowIso() }, "return=representation");
    return (r?.[0] as { name?: string } | undefined)?.name ?? null;
  }
  async bumpPartner(id: string, sent: number) {
    await this.send("PATCH", `overseer_partners?id=eq.${id}&${this.u}`, { sent });
  }
  async logStakes(e: StakesEvent) {
    await this.send("POST", "overseer_stakes_events", { user_id: this.uid, ...e });
  }
}
