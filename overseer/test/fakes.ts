// Test doubles shared by the Overseer's tests.
import { normalizeItems } from "../../src/lib/theGame";
import type { Db, DayRow, GoalRow, LearnInfo, MessageIn, SettingsRow, SpendRow, StakesEvent } from "../src/core/db";
import { DEFAULT_SETTINGS, type ActionRow, type Block, type DayItem, type Line, type Partner } from "../src/core/types";

export function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === null || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

type Night = { items: unknown; blocks_seeded: boolean; top3: string[] };

export class FakeDb implements Db {
  failReads = false;        // every read fails
  failDay = false;          // only the day-list read fails
  set: SettingsRow = { ...DEFAULT_SETTINGS, chat_id: 111, dry_run: false, cheap_model: "cheap/model", smart_model: "smart/model", link_code: null };
  nights = new Map<string, Night>();
  game = new Map<string, { done: number; total: number }>();
  blockMap = new Map<number, Block[]>();
  due: { id: string; title: string }[] = [];
  goalList: (GoalRow & { status: string })[] = [];
  captureRows = new Map<string, { text: string; done: boolean }>();
  habitRows = new Map<string, Record<string, boolean>>();
  messages: MessageIn[] = [];
  actions = new Map<string, ActionRow>();
  spendRows: { day: string; cost_usd: number; purpose: string }[] = [];
  lineRows: Line[] = [];
  partnerRows: (Partner & { invite_code: string })[] = [];
  stakeRows: { day: string; item_id: string; status: string }[] = [];
  learnInfo: LearnInfo = { on: false, at: "08:30", done: false };
  private n = 0;

  private id(prefix: string) {
    this.n += 1;
    return `${prefix}${this.n}`;
  }
  private read<T>(v: T): T | null {
    return this.failReads ? null : v;
  }
  items(day: string): DayItem[] {
    return normalizeItems(this.nights.get(day)?.items);
  }
  private night(day: string): Night {
    return this.nights.get(day) ?? { items: [], blocks_seeded: false, top3: [] };
  }

  async settings() { return this.read({ ...this.set }); }
  async patchSettings(p: Partial<SettingsRow>) { this.set = { ...this.set, ...p }; return true; }
  async day(day: string): Promise<DayRow | "none" | null> {
    if (this.failReads || this.failDay) return null;
    const x = this.nights.get(day);
    return x ? structuredClone(x) : "none";
  }
  async saveItems(day: string, items: DayItem[], extra: { blocks_seeded?: boolean } = {}) {
    const x = this.night(day);
    this.nights.set(day, { ...x, items: structuredClone(items), blocks_seeded: extra.blocks_seeded ?? x.blocks_seeded });
    return true;
  }
  async mirrorCounts(day: string, done: number, total: number) { this.game.set(day, { done, total }); return true; }
  async setTop3(day: string, top3: string[]) { this.nights.set(day, { ...this.night(day), top3: [...top3] }); return true; }
  async blocks(weekday: number) { return this.read(this.blockMap.get(weekday) ?? []); }
  async goalsDue(_day: string) { return this.read([...this.due]); }
  async setGoalDone(goalId: string, done: boolean) {
    const g = this.goalList.find((x) => x.id === goalId);
    if (g) g.status = done ? "done" : "active";
    return true;
  }
  async goals() {
    return this.read(this.goalList.filter((g) => g.status === "active").map(({ id, title, due, steps }) => ({ id, title, due, steps: steps.map((s) => ({ ...s })) })));
  }
  async setStepDone(stepId: string, done: boolean) {
    for (const g of this.goalList) for (const s of g.steps) if (s.id === stepId) { s.done = done; return true; }
    return false;
  }
  async addStep(goalId: string, title: string) {
    const g = this.goalList.find((x) => x.id === goalId);
    if (!g) return null;
    const id = this.id("st");
    g.steps.push({ id, title, done: false });
    return id;
  }
  async deleteStep(stepId: string) { for (const g of this.goalList) g.steps = g.steps.filter((s) => s.id !== stepId); return true; }
  async addCapture(text: string) { const id = this.id("c"); this.captureRows.set(id, { text, done: false }); return id; }
  async deleteCapture(id: string) { return this.captureRows.delete(id); }
  async captures() { return this.read([...this.captureRows].filter(([, c]) => !c.done).map(([id, c]) => ({ id, text: c.text }))); }
  async setCaptureDone(id: string, done: boolean) { const c = this.captureRows.get(id); if (!c) return false; c.done = done; return true; }
  async habits(day: string) { return this.read({ ...(this.habitRows.get(day) ?? {}) }); }
  async setHabit(day: string, key: string, val: boolean) { this.habitRows.set(day, { ...(this.habitRows.get(day) ?? {}), [key]: val }); return true; }
  async learn(_day: string) { return this.read({ ...this.learnInfo }); }
  async logMessage(m: MessageIn) { this.messages.push(m); }
  async logAction(a: { tool: string; summary: string; before: unknown; after: unknown }) {
    const id = this.id("a");
    this.actions.set(id, { id, ...a, undone_at: null });
    return id;
  }
  async action(id: string) { return this.actions.get(id) ?? null; }
  async markUndone(id: string) { const a = this.actions.get(id); if (!a) return false; a.undone_at = "now"; return true; }
  async addSpend(r: SpendRow) { this.spendRows.push({ day: r.day, cost_usd: r.cost_usd, purpose: r.purpose }); }
  async spent(day: string) { return this.read(this.spendRows.filter((x) => x.day === day).reduce((t, x) => t + x.cost_usd, 0)); }
  async lines() { return this.read(this.lineRows.map((l) => ({ ...l }))); }
  async bumpLine(id: string, used: number) { const l = this.lineRows.find((x) => x.id === id); if (l) l.used = used; }
  async partners() { return this.read(this.partnerRows.map(({ invite_code: _code, ...p }) => ({ ...p }))); }
  async createInvite(name: string, code: string) {
    this.partnerRows.push({ id: this.id("pt"), name, invite_code: code, chat_id: null, joined_at: null, left_at: null, sent: 0 });
    return true;
  }
  async joinPartner(code: string, chatId: number) {
    const p = this.partnerRows.find((x) => x.invite_code === code && !x.left_at && !x.joined_at);
    if (!p) return null;
    p.chat_id = chatId;
    p.joined_at = "now";
    const { invite_code: _code, ...rest } = p;
    return { ...rest };
  }
  async leavePartner(chatId: number) {
    const p = this.partnerRows.find((x) => x.chat_id === chatId && !x.left_at);
    if (!p) return null;
    p.left_at = "now";
    return p.name;
  }
  async bumpPartner(id: string, sent: number) { const p = this.partnerRows.find((x) => x.id === id); if (p) p.sent = sent; }
  async logStakes(e: StakesEvent) { this.stakeRows.push({ day: e.day, item_id: e.item_id, status: e.status }); }
}
