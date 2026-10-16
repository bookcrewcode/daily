// The Overseer agent: one Durable Object for Ben. It owns the brain's state,
// a durable inbox (Telegram updates) and outbox (messages still to send),
// and the every-minute tick. Every decision lives in core/brain.ts; this
// file only wires storage, Telegram, Supabase and OpenRouter around it.
import { Agent } from "agents";
import { handle, undo as undoInBrain, type Deps, type Event, type Out } from "./core/brain";
import { SupabaseDb } from "./core/db";
import { openRouter } from "./core/llm";
import { parseUpdate, TgClient } from "./core/telegram";
import { initialState as freshState, type CalPort, type State } from "./core/types";
import type { OverseerEnv } from "./env";

export function randomCode(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Overseer extends Agent<OverseerEnv, State> {
  initialState: State = freshState();
  private chain: Promise<unknown> = Promise.resolve();

  async onStart() {
    this.sql`create table if not exists inbox (id integer primary key autoincrement, body text not null)`;
    this.sql`create table if not exists outbox (id integer primary key autoincrement, body text not null, tries integer not null default 0)`;
    this.sql`create table if not exists kv (k text primary key, v text not null)`;
    await this.schedule("* * * * *", "tick");
  }

  // One state change at a time: alarms and RPC calls interleave at every await.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private kvGet(k: string): string | null {
    return this.sql<{ v: string }>`select v from kv where k = ${k}`[0]?.v ?? null;
  }
  private kvSet(k: string, v: string | null) {
    if (v === null) this.sql`delete from kv where k = ${k}`;
    else this.sql`insert into kv (k, v) values (${k}, ${v}) on conflict(k) do update set v = excluded.v`;
  }

  private db() {
    return new SupabaseDb(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY, this.env.BEN_USER_ID);
  }
  private cal(): CalPort | null {
    return null;
  }
  private deps(): Deps {
    return { db: this.db(), llm: openRouter(this.env.OPENROUTER_API_KEY), cal: this.cal(), now: () => Date.now(), ids: () => crypto.randomUUID() };
  }

  private async step(e: Event) {
    try {
      const { state, out } = await handle(this.state, e, this.deps());
      this.setState(state);
      for (const o of out) this.sql`insert into outbox (body) values (${JSON.stringify(o)})`;
    } catch (err) {
      console.error("[overseer] step failed", e.kind, err instanceof Error ? err.message : err);
    }
    await this.flush();
  }

  async tick() {
    await this.serial(() => this.step({ kind: "tick" }));
  }

  // The webhook returns as soon as the update is stored; drain() does the work.
  async inbound(update: unknown) {
    this.sql`insert into inbox (body) values (${JSON.stringify(update)})`;
    await this.schedule(1, "drain");
  }

  async drain() {
    await this.serial(async () => {
      const rows = this.sql<{ id: number; body: string }>`select id, body from inbox order by id limit 20`;
      for (const r of rows) {
        this.sql`delete from inbox where id = ${r.id}`;
        await this.step({ kind: "inbound", ev: parseUpdate(JSON.parse(r.body)) });
      }
    });
  }

  // Send what's queued. Dry run (or no linked chat) logs instead of sending;
  // a failed send stays queued for the next tick, up to three tries.
  private async flush() {
    const rows = this.sql<{ id: number; body: string; tries: number }>`select id, body, tries from outbox order by id limit 30`;
    if (!rows.length) return;
    const db = this.db();
    const s = await db.settings();
    const tg = new TgClient(this.env.TELEGRAM_BOT_TOKEN);
    for (const r of rows) {
      const o = JSON.parse(r.body) as Out;
      const chat = o.chat === "ben" ? (s?.chat_id ?? null) : o.chat;
      const dry = !o.force && (s?.dry_run ?? true);
      let ok = true;
      if (o.answer) await tg.answer(o.answer);
      if (o.text) {
        if (!dry && chat !== null) ok = (await tg.send(chat, o.text, o.buttons)) !== null;
        if (ok) await db.logMessage({ direction: "out", peer: o.chat === "ben" ? "ben" : "partner", text: o.text, buttons: o.buttons ?? null, dry_run: dry || chat === null });
      }
      if (ok || r.tries >= 2) this.sql`delete from outbox where id = ${r.id}`;
      else this.sql`update outbox set tries = tries + 1 where id = ${r.id}`;
    }
  }

  async api(op: string, body: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
    const db = this.db();
    const tg = new TgClient(this.env.TELEGRAM_BOT_TOKEN);
    switch (op) {
      case "status": {
        const s = await db.settings();
        return { ok: !!s, linked: !!s?.chat_id, paused: s?.paused ?? false, dry_run: s?.dry_run ?? true, google: false };
      }
      case "link": {
        if (!(await tg.setWebhook(`${origin}/telegram`, this.env.TELEGRAM_WEBHOOK_SECRET))) return { ok: false, error: "Telegram didn't accept the webhook. Check the bot token." };
        const code = randomCode();
        const me = await tg.getMe();
        if (!me || !(await db.patchSettings({ link_code: code }))) return { ok: false, error: "Couldn't make a link." };
        return { ok: true, url: `https://t.me/${me}?start=link_${code}` };
      }
      case "invite": {
        const name = String(body.name ?? "").trim().slice(0, 40);
        if (!name) return { ok: false, error: "Add your friend's name first." };
        const code = randomCode();
        const me = await tg.getMe();
        if (!me || !(await db.createInvite(name, code))) return { ok: false, error: "Couldn't make the invite." };
        return { ok: true, url: `https://t.me/${me}?start=p_${code}` };
      }
      case "undo":
        return this.serial(async () => {
          const r = await undoInBrain(this.state, String(body.action_id ?? ""), this.deps());
          this.setState(r.state);
          return { ok: r.ok, text: r.text };
        });
      case "test":
        await this.serial(() => this.step({ kind: "test" }));
        return { ok: true };
      default:
        return { ok: false, error: `Unknown request ${op}.` };
    }
  }
}
