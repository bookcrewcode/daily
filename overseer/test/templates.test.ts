import { describe, expect, it } from "vitest";
import { overCap } from "../src/core/budget";
import {
  cb, confirmButtons, drillButtons, learnButtons, morningButtons, morningText, parseCb, shrinkButtons, startButtons, T, todayText, wrapText,
} from "../src/core/templates";

const EMOJI = /\p{Extended_Pictographic}/u;

describe("templates", () => {
  it("never uses emojis", () => {
    const samples = [
      T.start("Precalc HW", "Open it"), T.ping("x"), T.still("x"), T.shrink("y"), T.countdown("Gavin", 2), T.countdownStopped(),
      T.countdownOver(), T.stakesSent("Gavin"), T.partner("line"), T.moved("x", "to tomorrow"), T.nothingLeft(), T.capNotice(),
      T.paused(), T.resumed(), T.tooLateStakes(), T.locked(["x"]), T.locked([]), T.change(), T.top3Ask(), T.top3Set(3), T.help(),
      T.linked(), T.partnerWelcome(), T.partnerJoined("Gavin"), T.partnerBye(), T.partnerLeft("Gavin"), T.defaultStep(), T.confirm("Remove x"), T.learn(),
      morningText({ wins: [{ start: "11:30", end: "13:00", what: "HW", step: "Open it" }], floating: ["a"], top3: ["b"], calendar: ["15:00 Dentist"], stakes: ["HW"], note: "n", stakesMissing: false, learnAt: "08:30" }),
      morningText({ wins: [], floating: [], top3: [], calendar: [], stakes: [], note: "", stakesMissing: true, learnAt: null }),
      wrapText({ done: ["a"], open: ["b"], moved: ["c (tomorrow)"], pauses: ["14:05"], note: "n", learn: "done" }),
      todayText([{ id: "a", time: "09:00", what: "x", done: true }, { id: "b", time: "", what: "y" }]),
      ...[startButtons("a"), drillButtons("a"), shrinkButtons("a"), morningButtons("2026-10-15"), confirmButtons("p1"), learnButtons()].flat(2).map((b) => b.text),
    ];
    for (const s of samples) expect(EMOJI.test(s)).toBe(false);
  });
  it("encodes button data within Telegram's 64-byte limit and reads it back", () => {
    const id = "imabc1234567";
    for (const act of ["done", "more", "onit", "stuck", "skip", "lock", "change", "nostakes", "yes", "no"] as const) {
      const data = cb(act, id);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseCb(data)).toEqual({ act, arg: id });
    }
    expect(parseCb(cb("yes", "0f8a2b6c-1d2e-4f3a-9b8c-7d6e5f4a3b2c"))?.arg).toBe("0f8a2b6c-1d2e-4f3a-9b8c-7d6e5f4a3b2c");
    expect(parseCb("zz|1")).toBeNull();
    expect(parseCb("nonsense")).toBeNull();
  });
  it("lays out the buttons the spec names", () => {
    expect(startButtons("a").flat().map((b) => b.text)).toEqual(["On it", "Done", "Stuck", "Skip"]);
    expect(drillButtons("a").flat().map((b) => b.text)).toEqual(["Done", "10 more min", "Stuck", "Skip"]);
    expect(shrinkButtons("a").flat().map((b) => b.text)).toEqual(["Done", "Stuck"]);
    expect(morningButtons("d").flat().map((b) => b.text)).toEqual(["Lock it in", "Change", "No stakes today"]);
    expect(learnButtons()[0][0].url).toBe("https://bookcrewcode.github.io/daily/?go=learn");
  });
  it("writes whole sentences around steps with or without a period", () => {
    expect(T.shrink("Open it")).toBe("Just this: Open it. Two minutes, then tap Done.");
    expect(T.shrink("Open it.")).toBe("Just this: Open it. Two minutes, then tap Done.");
    expect(T.start("Precalc HW", "Open it")).toBe("Now: Precalc HW.\nFirst step: Open it.");
  });
  it("clips long item text", () => {
    expect(T.ping("x".repeat(300)).length).toBeLessThan(160);
  });
  it("treats an unknown spend as over the cap", () => {
    expect(overCap(null, 1)).toBe(true);
    expect(overCap(0.99, 1)).toBe(false);
    expect(overCap(1, 1)).toBe(true);
  });
});
