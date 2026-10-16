import { describe, expect, it } from "vitest";
import { delivered, handle, undo, type Deps, type Event, type Out } from "../src/core/brain";
import { itemCb, T } from "../src/core/templates";
import { epochOf } from "../src/core/time";
import { initialState, type State } from "../src/core/types";
import { FakeDb, FakeLlm, reply, toolReply } from "./fakes";

const NY = "America/New_York";
const DAY = "2026-10-15";        // a Thursday (weekday 4)
const TOMORROW = "2026-10-16";
const at = (hhmm: string, day = DAY) => epochOf(day, hhmm, NY);
const tick: Event = { kind: "tick" };

function world() {
  const db = new FakeDb();
  const llm = new FakeLlm();
  let now = at("07:00");
  let n = 0;
  let upd = 0;
  db.blockMap.set(4, [
    { id: "b1", label: "Precalc HW", location: "", kind: "study", start_t: "11:30", end_t: "13:00" },
    { id: "b2", label: "Gym", location: "", kind: "gym", start_t: "18:00", end_t: "19:30" },
  ]);
  const deps: Deps = { db, llm, cal: null, now: () => now, ids: () => `p${++n}` };
  let st: State = initialState();
  let deliver = true;
  const step = async (t: string, e: Event = tick, day = DAY) => {
    now = at(t, day);
    const r = await handle(st, e, deps);
    st = r.state;
    // the agent marks a tagged message delivered once Telegram accepts it
    if (deliver) for (const o of r.out) if (o.tag) st = delivered(st, o.tag);
    return r.out;
  };
  const tap = (t: string, data: string) => step(t, { kind: "inbound", ev: { kind: "tap", update_id: ++upd, chat_id: 111, callback_id: `cb${upd}`, data } });
  const say = (t: string, text: string, chat = 111) => step(t, { kind: "inbound", ev: { kind: "text", update_id: ++upd, chat_id: chat, from_name: "x", text } });
  const item = (what: string, day = DAY) => db.items(day).find((i) => i.what === what);
  const texts = (out: Out[]) => out.map((o) => o.text).filter(Boolean);
  return {
    db, llm, deps, step, tap, say, item, texts,
    get st() { return st; },
    setNow: (t: number) => { now = t; },
    setDeliver: (v: boolean) => { deliver = v; },
  };
}

function withStakesReady(w: ReturnType<typeof world>) {
  w.db.lineRows = [{ id: "l1", text: "Ben owes you a coffee", used: 0 }];
  w.db.partnerRows = [{ id: "pt1", name: "Gavin", invite_code: "inv1", chat_id: 222, joined_at: "x", left_at: null, sent: 0 }];
}

describe("morning", () => {
  it("stays quiet before wake time", async () => {
    expect(await world().step("07:00")).toEqual([]);
  });
  it("seeds the timetable into the day list and sends one plan message", async () => {
    const w = world();
    const out = await w.step("07:31");
    expect(w.db.items(DAY).map((i) => i.what)).toEqual(["Precalc HW", "Gym"]);
    expect(w.db.nights.get(DAY)?.blocks_seeded).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Here's today.");
    expect(out[0].text).toContain("11:30-13:00 Precalc HW");
    expect(out[0].text).toContain("Stakes are off until you add a line and a partner in the app.");
    expect(out[0].buttons?.flat().map((b) => b.text)).toEqual(["Lock it in", "Change", "No stakes today"]);
    expect(await w.step("07:32")).toEqual([]);
  });
  it("uses the smart model's first steps and stakes picks when it answers", async () => {
    const w = world();
    withStakesReady(w);
    w.llm.replies.push(reply('{"steps":[{"n":1,"step":"Open the problem set"}],"stakes":[1],"note":"Solid day ahead."}'));
    const out = await w.step("07:31");
    expect(w.llm.calls[0].model).toBe("smart/model");
    expect(out[0].text).toContain("First step: Open the problem set");
    expect(out[0].text).toContain("Solid day ahead.");
    expect(out[0].text).toContain("Suggested stakes: Precalc HW");
    expect(w.db.spendRows.map((r) => r.purpose)).toEqual(["morning"]);
  });
});

describe("drill blocks", () => {
  it("opens the block, follows the silence ladder, and moves the task when ignored", async () => {
    const w = world();
    await w.step("07:31");
    const start = await w.step("11:30");
    expect(w.texts(start)).toEqual(["Now: Precalc HW.\nFirst step: Open it and do the first two minutes."]);
    expect(start[0].buttons?.flat().map((b) => b.text)).toEqual(["On it", "Done", "Stuck", "Skip"]);
    expect([w.st.plan?.locked, w.st.plan?.stakes]).toEqual([true, []]);
    expect(await w.step("11:45")).toEqual([]);
    expect(w.texts(await w.step("11:50"))).toEqual(['Still on "Precalc HW"? One tap is enough.']);
    expect(w.texts(await w.step("12:00"))).toEqual(['Still on "Precalc HW"? One tap is enough.']);
    expect(w.texts(await w.step("12:10"))).toEqual(["Just this: Open it and do the first two minutes. Two minutes, then tap Done."]);
    expect(w.texts(await w.step("12:20"))).toEqual(['Moved "Precalc HW" to tomorrow.']);
    expect(w.db.items(DAY).map((i) => i.what)).toEqual(["Gym"]);
    expect(w.db.items(TOMORROW).map((i) => i.what)).toEqual(["Precalc HW"]);
    expect(w.db.game.get(DAY)).toEqual({ done: 0, total: 1 });
    expect(w.st.ladder.task).toBeNull();
  });
  it("Done marks the item in the app's list and stops the check-ins", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    const out = await w.tap("11:40", itemCb("done", w.item("Precalc HW")!.id));
    expect(out[0]).toEqual({ chat: "ben", text: "", answer: "cb1" });
    expect(w.texts(out)).toEqual(["Done: Precalc HW.", "Nothing left for this block. Good."]);
    expect(w.item("Precalc HW")?.done).toBe(true);
    expect(w.db.game.get(DAY)).toEqual({ done: 1, total: 2 });
    expect(await w.step("12:30")).toEqual([]);
  });
  it("10 more min brings the next check-in to ten minutes", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    expect(w.texts(await w.tap("11:35", itemCb("more", w.item("Precalc HW")!.id)))).toEqual(["OK. Back in 10."]);
    expect(await w.step("11:44")).toEqual([]);
    expect(w.texts(await w.step("11:45"))).toEqual(["Check-in: Precalc HW. Where are you at?"]);
  });
  it("Stuck asks the cheap model for a two-minute step", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    w.llm.replies.push(reply("Write the first problem number on paper"));
    expect(w.texts(await w.tap("11:35", itemCb("stuck", w.item("Precalc HW")!.id)))).toEqual(["Just this: Write the first problem number on paper. Two minutes, then tap Done."]);
    expect(w.llm.calls.at(-1)?.model).toBe("cheap/model");
  });
  it("Skip queues the task for a later block; it runs once that block's own task is done", async () => {
    const w = world();
    w.db.blockMap.set(4, [...w.db.blockMap.get(4)!, { id: "b3", label: "Essay draft", location: "", kind: "study", start_t: "15:00", end_t: "16:30" }]);
    await w.step("07:31");
    await w.step("11:30");
    expect(w.texts(await w.tap("11:35", itemCb("skip", w.item("Precalc HW")!.id)))).toEqual(['Moved "Precalc HW" to later today. It\'s queued for your 15:00 block.']);
    expect(w.item("Precalc HW")?.time).toBe("");
    expect(w.texts(await w.step("15:00"))[0]).toContain("Now: Essay draft.");
    expect(w.texts(await w.tap("15:20", itemCb("done", w.item("Essay draft")!.id)))).toEqual([
      "Done: Essay draft.",
      "Now: Precalc HW.\nFirst step: Open it and do the first two minutes.",
    ]);
  });
});

describe("stakes", () => {
  async function countdownStarted(blockEnd = "13:00", deliverWarning = true) {
    const w = world();
    w.db.blockMap.set(4, [{ id: "b1", label: "Precalc HW", location: "", kind: "study", start_t: "11:30", end_t: blockEnd }]);
    withStakesReady(w);
    w.llm.replies.push(reply('{"steps":[],"stakes":[1],"note":""}'));
    await w.step("07:31");
    expect(w.texts(await w.tap("07:40", `L|${DAY}`))).toEqual(["Locked. Stakes on: Precalc HW."]);
    for (const t of ["11:30", "11:50", "12:00", "12:10"]) await w.step(t);
    w.setDeliver(deliverWarning);
    expect(w.texts(await w.step("12:20"))).toEqual(["15 minutes, then Gavin gets line #1. Tap Done on the two-minute step to stop it."]);
    return w;
  }
  it("Done during the countdown stops it and nothing is sent", async () => {
    const w = await countdownStarted();
    const out = await w.tap("12:25", itemCb("done", w.item("Precalc HW")!.id));
    expect(w.texts(out)).toEqual(["Stopped. That counts.", "Done: Precalc HW.", "Nothing left for this block. Good."]);
    expect(out.some((o) => o.chat === 222)).toBe(false);
    expect(w.db.stakeRows.map((r) => r.status)).toEqual(["started", "cancelled"]);
    expect(await w.step("12:35")).toEqual([]);
  });
  it("silence through the countdown sends one line to the partner, then moves the task", async () => {
    const w = await countdownStarted();
    const out = await w.step("12:35");
    expect(out.find((o) => o.chat === 222)?.text).toBe("From Ben's accountability bot: Ben owes you a coffee");
    expect(w.texts(out.filter((o) => o.chat === "ben"))).toEqual(["Sent to Gavin. Moving on.", 'Moved "Precalc HW" to tomorrow.']);
    expect(w.st.stakes_sent_day).toBe(DAY);
    expect([w.db.lineRows[0].used, w.db.partnerRows[0].sent]).toEqual([1, 1]);
    expect(w.db.stakeRows.map((r) => r.status)).toEqual(["started", "sent"]);
  });
  it("a countdown that already started still fires while paused", async () => {
    const w = await countdownStarted();
    expect(w.texts(await w.say("12:22", "/pause"))).toEqual(["Paused. Send /resume to start again."]);
    expect((await w.step("12:35")).find((o) => o.chat === 222)).toBeTruthy();
    expect(await w.step("13:30")).toEqual([]);
  });
  it("the block ending cancels a countdown", async () => {
    const w = await countdownStarted("12:30");
    expect(w.texts(await w.step("12:30"))).toEqual(["Block's over, so stakes on this one are off."]);
    expect(w.db.stakeRows.map((r) => r.status)).toEqual(["started", "cancelled"]);
  });
  it("Ben ticking the task in the app stops the countdown; the partner gets nothing", async () => {
    const w = await countdownStarted();
    await w.db.saveItems(DAY, w.db.items(DAY).map((i) => (i.what === "Precalc HW" ? { ...i, done: true } : i)));
    expect(w.texts(await w.step("12:21"))[0]).toBe("Done, so the stakes are off.");
    expect((await w.step("12:35")).some((o) => o.chat === 222)).toBe(false);
    expect(w.db.stakeRows.map((r) => r.status)).toEqual(["started", "cancelled"]);
  });
  it("marking the task done in chat stops the countdown right away", async () => {
    const w = await countdownStarted();
    w.llm.replies.push(toolReply("check_item", { item_id: w.item("Precalc HW")!.id, done: true }), reply("Marked done."));
    expect(w.texts(await w.say("12:22", "finished precalc"))).toEqual(["Marked done.", "Stopped. That counts."]);
    expect((await w.step("12:35")).some((o) => o.chat === 222)).toBe(false);
  });
  it("never messages the partner if the countdown warning didn't reach Ben", async () => {
    const w = await countdownStarted("13:00", false);
    const out = await w.step("12:35");
    expect(out.some((o) => o.chat === 222)).toBe(false);
    expect(w.texts(out)[0]).toBe("Stakes didn't go out: my warning never reached you.");
    expect(w.db.stakeRows.map((r) => r.status)).toEqual(["started", "voided"]);
  });
  it("sends nothing when the list can't be checked at fire time", async () => {
    const w = await countdownStarted();
    w.db.failDay = true;
    const out = await w.step("12:35");
    expect(out.some((o) => o.chat === 222)).toBe(false);
    expect(w.texts(out)[0]).toBe("Couldn't check your list, so nothing was sent.");
  });
  it("a Done tap stops the countdown even when saving the list fails", async () => {
    const w = await countdownStarted();
    const id = w.item("Precalc HW")!.id;
    w.db.failDay = true;
    expect(w.texts(await w.tap("12:25", itemCb("done", id)))).toEqual(["Stopped. That counts.", "Couldn't read the list right now. Nothing changed."]);
    expect(w.st.countdown).toBeNull();
  });
  it("No stakes today works before the first block and is refused after", async () => {
    const late = world();
    await late.step("07:31");
    expect(late.texts(await late.tap("11:31", `N|${DAY}`))).toEqual(["Too late to turn stakes off today. They stay as set."]);
    const early = world();
    await early.step("07:31");
    expect(early.texts(await early.tap("08:00", `N|${DAY}`))).toEqual(["Locked. No stakes today."]);
    expect(early.st.plan?.stakes_off).toBe(true);
  });
});

describe("talking to it", () => {
  it("acts with tools and replies in plain words", async () => {
    const w = world();
    await w.step("07:31");
    w.llm.replies.push(toolReply("add_item", { what: "Call dentist", time: "16:00" }, 0.002), reply("Added. Dentist call at 16:00."));
    expect(w.texts(await w.say("09:00", "add call dentist at 4"))).toEqual(["Added. Dentist call at 16:00."]);
    expect(w.item("Call dentist")?.time).toBe("16:00");
    expect(w.llm.calls.at(-1)?.model).toBe("cheap/model");
    expect(String(w.llm.calls.at(-2)?.messages[0].content)).toContain("Today's list");
    expect(w.db.spendRows.filter((r) => r.purpose === "talk").reduce((t, r) => t + r.cost_usd, 0)).toBeCloseTo(0.003);
    expect(w.st.convo).toHaveLength(2);
  });
  it("asks before removing anything, and only removes on Yes", async () => {
    const w = world();
    await w.step("07:31");
    w.llm.replies.push(toolReply("remove_item", { item_id: w.item("Gym")!.id }), reply("I asked you to confirm."));
    const out = await w.say("09:00", "drop gym today");
    expect(w.texts(out)).toEqual(["I asked you to confirm.", `Remove "Gym" from ${DAY}?`]);
    expect(out[1].buttons?.flat().map((b) => b.data)).toEqual(["y|p1", "n|p1"]);
    expect(w.item("Gym")).toBeTruthy();
    expect(w.texts(await w.tap("09:01", "y|p1"))).toEqual(['Removed "Gym".']);
    expect(w.item("Gym")).toBeUndefined();
    expect(w.texts(await w.tap("09:02", "y|p1"))).toEqual(["That request expired."]);
  });
  it("OpenRouter out of credit: one notice, then quiet with no more paid attempts", async () => {
    const w = world();
    await w.step("07:31");
    w.llm.replies.push({ ...reply(""), cost: 0, tin: 0, error: "out_of_credit" });
    expect(w.texts(await w.say("09:00", "move gym to 6"))).toEqual([T.capNotice()]);
    const calls = w.llm.calls.length;
    expect(await w.say("09:05", "hello?")).toEqual([]);
    expect(w.llm.calls.length).toBe(calls);
    expect(w.texts(await w.say("09:06", "/today"))[0]).toContain("[ ] Precalc HW");
  });
  it("over the daily cap: says so once, then stays quiet; commands still work", async () => {
    const w = world();
    await w.step("07:31");
    w.db.spendRows.push({ day: DAY, cost_usd: 1, purpose: "x" });
    expect(w.texts(await w.say("09:00", "move gym to 6"))).toEqual(["Today's AI budget is used up. Buttons still work; I'll read your messages in the morning."]);
    expect(await w.say("09:01", "hello?")).toEqual([]);
    expect(w.texts(await w.say("09:02", "/today"))[0]).toContain("[ ] Precalc HW");
    expect(w.llm.calls).toHaveLength(1);
  });
});

describe("evening wrap", () => {
  it("leads with wins, then takes tomorrow's top 3 from the reply", async () => {
    const w = world();
    await w.step("07:31");
    await w.tap("19:00", itemCb("done", w.item("Gym")!.id));
    const out = await w.step("21:30");
    expect(out[0].text.startsWith("Day wrap.")).toBe(true);
    expect(out[0].text).toContain("Done (1): Gym");
    expect(out[0].text).toContain("Still open: Precalc HW");
    expect(out[0].text.endsWith("Reply with tomorrow's top 3, one per line.")).toBe(true);
    expect(w.texts(await w.say("21:40", "1. Essay\n2. Gym\n3. Call mom"))).toEqual(["Tomorrow's top 3 is set."]);
    expect(w.db.nights.get(TOMORROW)?.top3).toEqual(["Essay", "Gym", "Call mom"]);
  });
});

describe("learn round", () => {
  it("sends one reminder at the Learn time when no round is done", async () => {
    const w = world();
    w.db.learnInfo = { on: true, at: "08:30", done: false };
    await w.step("07:31");
    expect(await w.step("08:29")).toEqual([]);
    const out = await w.step("08:30");
    expect(w.texts(out)).toEqual(["Your Learn round is ready. About 6 minutes."]);
    expect(out[0].buttons?.[0][0].url).toBe("https://bookcrewcode.github.io/daily/?go=learn");
    expect(await w.step("08:45")).toEqual([]);
  });
  it("stays quiet when the round is already done", async () => {
    const w = world();
    w.db.learnInfo = { on: true, at: "08:30", done: true };
    await w.step("07:31");
    expect(await w.step("08:30")).toEqual([]);
  });
});

describe("who can talk to it", () => {
  it("links Ben's chat with the one-time code from the app", async () => {
    const w = world();
    w.db.set = { ...w.db.set, chat_id: null, link_code: "abc123" };
    expect(await w.say("09:00", "/start link_abc123", 555)).toEqual([{ chat: 555, text: "Connected. This is where I'll reach you.", force: true }]);
    expect([w.db.set.chat_id, w.db.set.link_code]).toEqual([555, null]);
  });
  it("lets an invited friend join and leave, and ignores strangers", async () => {
    const w = world();
    w.db.partnerRows = [{ id: "pt1", name: "Gavin", invite_code: "inv123", chat_id: null, joined_at: null, left_at: null, sent: 0 }];
    const join = await w.say("09:00", "/start p_inv123", 222);
    expect(join.map((o) => o.chat)).toEqual([222, "ben"]);
    expect(w.texts(join)[1]).toBe("Gavin joined as a stakes partner.");
    expect(await w.say("09:01", "hi bot", 999)).toEqual([]);
    expect(w.db.messages.some((m) => m.text === "hi bot")).toBe(false);
    expect(w.texts(await w.say("09:02", "/stop", 222))).toEqual(["Done. You won't get any more messages.", "Gavin left the stakes list."]);
    expect(w.db.partnerRows[0].left_at).not.toBeNull();
  });
});

describe("review focus", () => {
  it("never pings about a task already ticked in the app", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    await w.db.saveItems(DAY, w.db.items(DAY).map((i) => (i.what === "Precalc HW" ? { ...i, done: true } : i)));
    expect(w.texts(await w.step("11:50")).some((t) => t.includes("Still on"))).toBe(false);
  });
  it("handles a Telegram update delivered twice only once", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    const ev: Event = { kind: "inbound", ev: { kind: "tap", update_id: 50, chat_id: 111, callback_id: "c50", data: itemCb("done", w.item("Precalc HW")!.id) } };
    await w.step("11:40", ev);
    const actions = w.db.actions.size;
    expect(await w.step("11:41", ev)).toEqual([]);
    expect(w.db.actions.size).toBe(actions);
  });
  it("keeps pinging from the last known task when the list can't be read, and never writes the list", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    const before = JSON.stringify(w.db.nights.get(DAY));
    w.db.failDay = true;
    expect(w.texts(await w.step("11:50"))).toEqual(['Still on "Precalc HW"? One tap is enough.']);
    expect(JSON.stringify(w.db.nights.get(DAY))).toBe(before);
  });
  it("starts clean after midnight: nothing carried over", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    w.setNow(at("00:01", TOMORROW));
    const r = await handle(w.st, tick, w.deps);
    expect(r.out).toEqual([]);
    expect([r.state.plan?.day, r.state.ladder.task, r.state.countdown]).toEqual([TOMORROW, null, null]);
  });
  it("sends the test message, marked to go out even in dry run", async () => {
    expect(await world().step("09:00", { kind: "test" })).toEqual([{ chat: "ben", text: "Test from the Overseer. If you can read this, pings will reach you.", force: true }]);
  });
});

describe("fix pass", () => {
  it("a Plan-chat item with a long id gets valid buttons, and Done works", async () => {
    const w = world();
    w.db.blockMap.set(4, []);
    w.db.nights.set(DAY, { items: [{ time: "11:30", what: "LOCK-IN: Modern America Test #2 review, chapters 4-6 and the map quiz 1.5h" }], blocks_seeded: true, top3: [] });
    await w.step("07:31");
    const start = await w.step("11:30");
    expect(start[0].text).toContain("Now: LOCK-IN");
    for (const b of start[0].buttons!.flat()) expect(new TextEncoder().encode(b.data!).length).toBeLessThanOrEqual(64);
    const done = start[0].buttons!.flat().find((b) => b.text === "Done")!;
    expect(w.texts(await w.tap("11:40", done.data!))[0]).toContain("Done: LOCK-IN");
    expect(w.db.items(DAY)[0].done).toBe(true);
  });
  it("holds a Telegram update while the settings can't be read, then handles it", async () => {
    const w = world();
    await w.step("07:31");
    w.db.failReads = true;
    const ev: Event = { kind: "inbound", ev: { kind: "text", update_id: 9, chat_id: 111, from_name: "x", text: "/today" } };
    w.setNow(at("09:00"));
    const r = await handle(w.st, ev, w.deps);
    expect(r.deferred).toBe(true);
    w.db.failReads = false;
    expect((await handle(r.state, ev, w.deps)).out[0].text).toContain("Precalc HW");
  });
  it("an unanswered wrap doesn't capture the next day's first message", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("21:30");
    expect(w.st.awaiting_top3_for).toBe(TOMORROW);
    await w.step("07:31", tick, TOMORROW);
    expect(w.st.awaiting_top3_for).toBeNull();
  });
  it("retries the morning when the list can't be read", async () => {
    const w = world();
    w.db.failDay = true;
    expect(await w.step("07:31")).toEqual([]);
    expect(w.st.plan?.morning_sent).toBe(false);
    w.db.failDay = false;
    expect((await w.step("07:32"))[0].text).toContain("11:30-13:00 Precalc HW");
  });
  it("keeps listening after Telegram restarts its update numbering", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("09:00", { kind: "inbound", ev: { kind: "text", update_id: 900000, chat_id: 111, from_name: "x", text: "/help" } });
    const out = await w.step("09:01", { kind: "inbound", ev: { kind: "text", update_id: 5, chat_id: 111, from_name: "x", text: "/today" } });
    expect(w.texts(out)[0]).toContain("Precalc HW");
  });
  it("pausing from the app is recorded and resets the ladder", async () => {
    const w = world();
    await w.step("07:31");
    await w.step("11:30");
    expect(w.texts(await w.step("11:35", { kind: "app", command: "/pause" }))).toEqual(["Paused. Send /resume to start again."]);
    expect([w.db.set.paused, w.st.pauses.length, w.st.ladder.task]).toEqual([true, 1, null]);
    await w.step("11:40", { kind: "app", command: "/resume" });
    expect(w.db.set.paused).toBe(false);
  });
});

describe("undo", () => {
  it("reverses a Done from the app's log, once", async () => {
    const w = world();
    await w.step("07:31");
    await w.tap("19:00", itemCb("done", w.item("Gym")!.id));
    const id = [...w.db.actions.keys()].at(-1)!;
    const r = await undo(w.st, id, w.deps);
    expect(r.ok).toBe(true);
    expect(w.item("Gym")?.done).toBe(false);
    expect(w.db.game.get(DAY)).toEqual({ done: 0, total: 2 });
    expect((await undo(r.state, id, w.deps)).text).toBe("Already undone.");
  });
});
