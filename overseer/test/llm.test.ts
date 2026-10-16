import { describe, expect, it } from "vitest";
import { openRouter, parseJson, runAgentLoop } from "../src/core/llm";
import { morningPlan, shrinkStep } from "../src/core/llmflows";
import { FakeDb, FakeLlm, mockFetch, reply, toolReply } from "./fakes";

describe("openRouter", () => {
  it("asks for a reasoning budget below max_tokens and reads the cost", async () => {
    const { f, calls } = mockFetch(() => ({ status: 200, body: { choices: [{ message: { content: "hi" } }], usage: { cost: 0.0012, prompt_tokens: 50, completion_tokens: 5 } } }));
    const r = await openRouter("KEY", f).chat("m/x", [{ role: "user", content: "x" }], undefined, 300);
    expect(r).toEqual({ text: "hi", tool_calls: [], cost: 0.0012, tin: 50, tout: 5, error: null });
    const body = JSON.parse(String(calls[0].init?.body));
    expect([body.max_tokens, body.reasoning, body.usage, body.tools]).toEqual([1324, { max_tokens: 1024, exclude: true }, { include: true }, undefined]);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
  });
  it("reports an empty account as out_of_credit", async () => {
    const { f } = mockFetch(() => ({ status: 402, body: {} }));
    expect((await openRouter("K", f).chat("m", [])).error).toBe("out_of_credit");
  });
});

describe("runAgentLoop", () => {
  it("runs tool calls, feeds results back and sums the cost", async () => {
    const llm = new FakeLlm();
    llm.replies.push(toolReply("add_item", { what: "Call dentist" }, 0.002), reply("Added it.", 0.001));
    const seen: unknown[] = [];
    const r = await runAgentLoop({ llm, model: "m", messages: [{ role: "user", content: "add dentist" }], tools: [], exec: async (name, args) => { seen.push([name, args]); return "Added (id i1)."; } });
    expect(seen).toEqual([["add_item", { what: "Call dentist" }]]);
    expect(r).toMatchObject({ text: "Added it.", error: null });
    expect(r.cost).toBeCloseTo(0.003);
    expect(llm.calls[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "t1", content: "Added (id i1)." });
  });
  it("runs a tool with no arguments when the model sends broken JSON", async () => {
    const llm = new FakeLlm();
    llm.replies.push({ ...toolReply("list_day", {}), tool_calls: [{ id: "t1", type: "function", function: { name: "list_day", arguments: "{oops" } }] }, reply("ok"));
    const seen: unknown[] = [];
    await runAgentLoop({ llm, model: "m", messages: [], tools: [], exec: async (_n, a) => { seen.push(a); return "x"; } });
    expect(seen).toEqual([{}]);
  });
  it("stops on an error", async () => {
    const r = await runAgentLoop({ llm: new FakeLlm(), model: "m", messages: [], tools: [], exec: async () => "x" });
    expect(r.error).toBe("no reply queued");
  });
  it("pulls JSON out of a chatty reply", () => {
    expect(parseJson('Sure! {"a":1} done')).toEqual({ a: 1 });
    expect(parseJson("nope")).toBeNull();
  });
});

describe("llmflows", () => {
  it("keeps only valid task numbers from the morning plan and records the spend", async () => {
    const db = new FakeDb();
    const llm = new FakeLlm();
    llm.replies.push(reply('{"steps":[{"n":1,"step":"Open the set"},{"n":9,"step":"x"}],"stakes":[1,7],"note":"Good day."}', 0.004));
    const r = await morningPlan({ db, llm, day: "2026-10-15", cap: 1 }, "smart/model", [{ n: 1, what: "Precalc HW", time: "11:30" }], [], []);
    expect(r).toEqual({ steps: [{ n: 1, step: "Open the set" }], stakes: [1], note: "Good day." });
    expect(db.spendRows).toEqual([{ day: "2026-10-15", cost_usd: 0.004, purpose: "morning" }]);
  });
  it("records a failed call so the app can warn about it", async () => {
    const db = new FakeDb();
    const llm = new FakeLlm();
    llm.replies.push({ ...reply(""), cost: 0, tin: 0, error: "out_of_credit" });
    expect(await shrinkStep({ db, llm, day: "2026-10-15", cap: 1 }, "cheap/model", "Essay")).toBeNull();
    expect(db.spendRows).toEqual([{ day: "2026-10-15", cost_usd: 0, purpose: "stuck:error:out_of_credit" }]);
  });
  it("skips the model entirely once the cap is reached", async () => {
    const db = new FakeDb();
    db.spendRows.push({ day: "2026-10-15", cost_usd: 1, purpose: "x" });
    const llm = new FakeLlm();
    expect(await shrinkStep({ db, llm, day: "2026-10-15", cap: 1 }, "cheap/model", "Essay")).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });
});
