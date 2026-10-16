"use client";

// The Overseer's control room. The agent runs on Cloudflare and talks to Ben
// on Telegram; this page shows what it did today (each action with Undo),
// what it said, and the rules it runs by. Rows come straight from Supabase;
// the few things only the agent can do (connect links, undo, test message,
// Google sign-in) go through src/lib/overseer.ts.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { overseer } from "@/lib/overseer";

type Settings = {
  wake: string; wrap: string; ping_kinds: string[]; ping_every_min: number; cap_usd: number;
  cheap_model: string; smart_model: string; paused: boolean; dry_run: boolean; chat_id: number | null;
};
type Action = { id: string; summary: string; undone_at: string | null; created_at: string };
type Message = { id: number; direction: "in" | "out"; peer: "ben" | "partner"; text: string; dry_run: boolean; created_at: string };
type Line = { id: string; text: string; used: number };
type Partner = { id: string; name: string; joined_at: string | null; left_at: string | null; sent: number };

const KINDS = ["study", "work", "read", "drill", "class", "gym", "drive", "reset"];
const CARD = "mt-4 rounded-2xl p-4 border bg-[var(--raised)] border-[var(--border-1)]";
const HEAD = "mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]";
const HINT = "text-xs text-[var(--text-3)] leading-snug";
const BTN = "px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--neon)]/12 text-[var(--neon)] disabled:opacity-40";
const FIELD = "mt-1 w-full rounded-lg px-3 py-2 text-sm bg-black/20 border border-[var(--border-1)]";
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function firstNote(): string {
  if (typeof window === "undefined") return "";
  const g = new URLSearchParams(window.location.search).get("google");
  return g === "ok" ? "Google Calendar connected." : g === "fail" ? "Google sign-in didn't finish. Try again." : "";
}

export default function OverseerSpace({ uid }: { uid: string }) {
  const [s, setS] = useState<Settings | null>(null);
  const [google, setGoogle] = useState(false);
  const [actions, setActions] = useState<Action[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [spent, setSpent] = useState(0);
  const [aiError, setAiError] = useState("");
  const [note, setNote] = useState(firstNote);
  const [link, setLink] = useState("");
  const [newLine, setNewLine] = useState("");
  const [friend, setFriend] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const [st, ac, ms, ln, pt, sp] = await Promise.all([
      supabase.from("overseer_settings").select("wake,wrap,ping_kinds,ping_every_min,cap_usd,cheap_model,smart_model,paused,dry_run,chat_id").eq("user_id", uid).maybeSingle(),
      supabase.from("overseer_actions").select("id,summary,undone_at,created_at").eq("user_id", uid).gte("created_at", midnight.toISOString()).order("created_at", { ascending: false }).limit(50),
      supabase.from("overseer_messages").select("id,direction,peer,text,dry_run,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(30),
      supabase.from("overseer_stakes_lines").select("id,text,used").eq("user_id", uid).eq("archived", false).order("created_at"),
      supabase.from("overseer_partners").select("id,name,joined_at,left_at,sent").eq("user_id", uid).order("created_at"),
      supabase.from("overseer_spend").select("cost_usd,purpose").eq("user_id", uid).eq("day", todayStr()).order("created_at"),
    ]);
    if ([st, ac, ms, ln, pt, sp].some((r) => r.error)) setNote("Some of this page couldn't load. Try again in a minute.");
    if (st.data) setS(st.data as Settings);
    setActions((ac.data ?? []) as Action[]);
    setMsgs(((ms.data ?? []) as Message[]).slice().reverse());
    setLines((ln.data ?? []) as Line[]);
    setPartners((pt.data ?? []) as Partner[]);
    const spendRows = (sp.data ?? []) as { cost_usd: number | string; purpose: string }[];
    setSpent(spendRows.reduce((t, r) => t + Number(r.cost_usd), 0));
    // failed model calls are logged as "<purpose>:error:<reason>"; the newest one wins
    const failed = spendRows.filter((r) => r.purpose.includes(":error:")).at(-1);
    setAiError(failed ? failed.purpose.split(":error:")[1] : "");
    const status = await overseer("status");
    if (status.ok) setGoogle(status.google === true);
  }, [uid]);

  useEffect(() => {
    // first load runs as a callback, so its state updates land after this effect
    void Promise.resolve().then(load);
    // coming back from Telegram (after tapping Start) should show "Connected"
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  async function save(patch: Partial<Settings>) {
    if (!s) return;
    const next = { ...s, ...patch };
    setBusy("save");
    const { error } = await supabase.from("overseer_settings").update({
      wake: next.wake, wrap: next.wrap, ping_kinds: next.ping_kinds, ping_every_min: next.ping_every_min,
      cap_usd: next.cap_usd, cheap_model: next.cheap_model, smart_model: next.smart_model,
      paused: next.paused, dry_run: next.dry_run, updated_at: new Date().toISOString(),
    }).eq("user_id", uid);
    setBusy("");
    if (error) { setNote("Couldn't save. Nothing changed."); return; }
    setS(next);
    setNote("Saved.");
  }

  async function call(op: string, body: Record<string, unknown> = {}) {
    setBusy(op);
    const r = await overseer(op, body);
    setBusy("");
    return r;
  }

  async function connect() {
    const r = await call("link");
    if (r.ok && r.url) { setLink(r.url); window.open(r.url, "_blank"); }
    else setNote(r.error ?? "Couldn't make a link.");
  }
  async function undo(id: string) {
    const r = await call("undo", { action_id: id });
    setNote(r.text ?? r.error ?? "");
    await load();
  }
  async function test() {
    const r = await call("test");
    setNote(r.ok ? "Test sent. Check Telegram." : r.error ?? "Couldn't send.");
    await load();
  }
  async function connectGoogle() {
    const r = await call("google_start");
    if (r.ok && r.url) window.location.href = r.url;
    else setNote(r.error ?? "Google sign-in isn't set up yet.");
  }
  async function invite() {
    const name = friend.trim();
    if (!name) { setNote("Add your friend's name first."); return; }
    const r = await call("invite", { name });
    if (r.ok && r.url) { setLink(r.url); setFriend(""); await load(); }
    else setNote(r.error ?? "Couldn't make the invite.");
  }
  async function addLine() {
    const text = newLine.trim();
    if (text.length < 3) { setNote("A line needs at least 3 characters."); return; }
    const { error } = await supabase.from("overseer_stakes_lines").insert({ user_id: uid, text });
    if (error) { setNote("Couldn't save the line."); return; }
    setNewLine("");
    await load();
  }
  async function archiveLine(id: string) {
    const { error } = await supabase.from("overseer_stakes_lines").update({ archived: true }).eq("id", id).eq("user_id", uid);
    if (error) setNote("Couldn't remove the line.");
    await load();
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNote("Link copied."); }
    catch { setNote("Copy didn't work. Press and hold the link to copy it."); }
  }

  const kinds = s?.ping_kinds ?? [];

  return (
    <div className="pt-6 pb-24">
      <h1 className="text-xl font-bold">Overseer</h1>
      <p className={HINT}>Your day manager on Telegram. It checks in during your study, work and reading blocks, moves what you skip, and tells you every change it makes.</p>
      {note && <p className="mt-3 text-sm text-[var(--text-2)]">{note}</p>}

      <section className={CARD}>
        <p className={HEAD}>Status</p>
        {!s ? <p className="mt-2 text-sm">Loading…</p> : (
          <>
            <p className="mt-2 text-sm">{s.chat_id ? "Connected to your Telegram." : "Not connected to Telegram yet."}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={BTN} disabled={!!busy} onClick={connect}>{s.chat_id ? "Reconnect Telegram" : "Connect Telegram"}</button>
              <button className={BTN} disabled={!!busy} onClick={test}>Send a test message</button>
              <button className={BTN} disabled={!!busy} onClick={() => save({ paused: !s.paused })}>{s.paused ? "Resume" : "Pause"}</button>
              <button className={BTN} disabled={!!busy} onClick={() => save({ dry_run: !s.dry_run })}>{s.dry_run ? "Turn dry run off" : "Turn dry run on"}</button>
            </div>
            {link && (
              <p className="mt-3 text-sm break-all">
                <a className="underline" href={link} target="_blank" rel="noreferrer">{link}</a>
                <button className="ml-2 text-xs underline" onClick={() => copy(link)}>Copy</button>
              </p>
            )}
            <p className={`mt-3 ${HINT}`}>Connect: opens Telegram; tap Start there and this page will say Connected. Pause: no check-ins until you resume (a stakes countdown that already started still runs). Dry run is {s.dry_run ? "on" : "off"}: when on, messages are written in the conversation below instead of sent to your phone.</p>
            <p className="mt-3 text-sm">AI spend today: ${spent.toFixed(2)} of ${Number(s.cap_usd).toFixed(2)}</p>
            <p className={HINT}>Daily AI cap: the most it spends on AI in a day. Check-ins and buttons keep working past it; only free-text chat waits until tomorrow.</p>
            {aiError && (
              <p className="mt-3 text-sm text-orange-300">
                The AI couldn&apos;t be reached today ({aiError === "out_of_credit" ? "OpenRouter is out of credit" : aiError}). Check-ins still go out from templates. Top up OpenRouter or check the key.
              </p>
            )}
          </>
        )}
      </section>

      <section className={CARD}>
        <p className={HEAD}>What it did today</p>
        {actions.length === 0 && <p className="mt-2 text-sm text-[var(--text-3)]">Nothing yet.</p>}
        <ul className="mt-2 space-y-2">
          {actions.map((a) => (
            <li key={a.id} className="flex items-start gap-3 text-sm">
              <span className="mono text-[11px] text-[var(--text-3)] pt-0.5">{clock(a.created_at)}</span>
              <span className={`flex-1 ${a.undone_at ? "line-through opacity-50" : ""}`}>{a.summary}</span>
              {!a.undone_at && <button className="text-xs underline" disabled={!!busy} onClick={() => undo(a.id)}>Undo</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className={CARD}>
        <p className={HEAD}>Conversation</p>
        <p className={HINT}>The last 30 messages. &quot;Not sent&quot; means dry run was on, or Telegram wasn&apos;t connected yet.</p>
        <ul className="mt-2 space-y-2">
          {msgs.map((m) => (
            <li key={m.id} className={`text-sm rounded-lg px-3 py-2 whitespace-pre-line ${m.direction === "out" ? "bg-[var(--neon)]/[0.06]" : "bg-white/[0.04]"}`}>
              <span className="mono text-[10px] text-[var(--text-3)] block">
                {clock(m.created_at)} · {m.direction === "out" ? (m.peer === "partner" ? "to a partner" : "Overseer") : m.peer === "partner" ? "partner" : "you"}{m.dry_run ? " · not sent" : ""}
              </span>
              {m.text}
            </li>
          ))}
        </ul>
      </section>

      {s && (
        <section className={CARD}>
          <p className={HEAD}>Rules</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-sm">Morning plan at<input className={FIELD} type="time" value={s.wake} onChange={(e) => setS({ ...s, wake: e.target.value })} /></label>
            <label className="text-sm">Evening wrap at<input className={FIELD} type="time" value={s.wrap} onChange={(e) => setS({ ...s, wrap: e.target.value })} /></label>
            <label className="text-sm">Check in every (minutes)<input className={FIELD} type="number" min={10} max={120} value={s.ping_every_min} onChange={(e) => setS({ ...s, ping_every_min: Number(e.target.value) })} /></label>
            <label className="text-sm">Daily AI cap ($)<input className={FIELD} type="number" min={0} max={5} step={0.25} value={s.cap_usd} onChange={(e) => setS({ ...s, cap_usd: Number(e.target.value) })} /></label>
          </div>
          <p className={`mt-3 ${HINT}`}>Check in every: minutes between check-ins while you&apos;re in a drill block. If you don&apos;t answer, it follows up after 20 and 10 minutes, then cuts the task to a two-minute step, then moves it.</p>
          <p className="mt-4 text-sm">Drill block kinds</p>
          <p className={HINT}>Drill block kinds: timetable blocks of these kinds get check-ins. All other blocks stay quiet. With none picked, it never checks in.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button key={k}
                onClick={() => setS({ ...s, ping_kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] })}
                className={`px-3 py-1.5 rounded-full text-xs border ${kinds.includes(k) ? "border-[var(--neon)] text-[var(--neon)]" : "border-[var(--border-1)] text-[var(--text-3)]"}`}>
                {k}
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-3">
            <label className="text-sm">Cheap model<input className={FIELD} value={s.cheap_model} onChange={(e) => setS({ ...s, cheap_model: e.target.value })} /></label>
            <label className="text-sm">Smart model<input className={FIELD} value={s.smart_model} onChange={(e) => setS({ ...s, smart_model: e.target.value })} /></label>
          </div>
          <p className={`mt-2 ${HINT}`}>Cheap model: answers your messages and writes two-minute steps. Smart model: writes the morning plan and the evening wrap. Both are OpenRouter model ids.</p>
          <button className={`mt-4 ${BTN}`} disabled={!!busy} onClick={() => save({})}>Save rules</button>
        </section>
      )}

      <section className={CARD}>
        <p className={HEAD}>Stakes</p>
        <p className={HINT}>Stakes: on a task you confirm in the morning, if you stay quiet through every follow-up, one of these lines goes to a partner after a 15-minute countdown. Tapping Done on the two-minute step stops it. At most one a day. You write the lines; the Overseer never makes one up.</p>
        <ul className="mt-3 space-y-2">
          {lines.map((l, i) => (
            <li key={l.id} className="flex items-start gap-3 text-sm">
              <span className="mono text-[11px] text-[var(--text-3)] pt-0.5">#{i + 1}</span>
              <span className="flex-1">{l.text}</span>
              <span className="mono text-[11px] text-[var(--text-3)]">sent {l.used}x</span>
              <button className="text-xs underline" onClick={() => archiveLine(l.id)}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input className={FIELD} placeholder="Ben owes you a coffee." value={newLine} maxLength={280} onChange={(e) => setNewLine(e.target.value)} />
          <button className={BTN} onClick={addLine}>Add</button>
        </div>
        <p className="mt-5 text-sm">Partners</p>
        <p className={HINT}>Partners: friends who agreed to get a stakes line. They join by tapping your invite link in Telegram and can leave anytime by sending /stop.</p>
        <ul className="mt-2 space-y-1">
          {partners.map((p) => (
            <li key={p.id} className="text-sm">{p.name} <span className="text-[var(--text-3)]">· {p.left_at ? "left" : p.joined_at ? `joined, sent ${p.sent}x` : "invite not used yet"}</span></li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input className={FIELD} placeholder="Friend's name" value={friend} maxLength={40} onChange={(e) => setFriend(e.target.value)} />
          <button className={BTN} disabled={!!busy} onClick={invite}>Make invite link</button>
        </div>
      </section>

      <section className={CARD}>
        <p className={HEAD}>Google Calendar</p>
        <p className="mt-2 text-sm">{google ? "Connected. It can read and move your events." : "Not connected."}</p>
        <p className={HINT}>Lets the Overseer add and move events while the app is closed. Deleting an event always asks you first.</p>
        <button className={`mt-3 ${BTN}`} disabled={!!busy} onClick={connectGoogle}>{google ? "Reconnect Google" : "Connect Google Calendar"}</button>
      </section>
    </div>
  );
}
