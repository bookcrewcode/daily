import { describe, expect, it } from "vitest";
import { addDays, epochOf, localOf, minutesBetween, secOfDayIn } from "../src/core/time";

const NY = "America/New_York";

describe("time", () => {
  it("converts New York wall time to epoch in summer (EDT, UTC-4)", () => {
    expect(epochOf("2026-10-15", "09:00", NY)).toBe(Date.UTC(2026, 9, 15, 13, 0));
  });
  it("converts New York wall time to epoch in winter (EST, UTC-5)", () => {
    expect(epochOf("2026-12-01", "09:00", NY)).toBe(Date.UTC(2026, 11, 1, 14, 0));
  });
  it("reads the local day, weekday and clock across midnight UTC", () => {
    expect(localOf(Date.UTC(2026, 9, 15, 3, 30), NY)).toEqual({ day: "2026-10-14", weekday: 3, hhmm: "23:30" });
  });
  it("handles the day the clocks change (Nov 1 2026)", () => {
    expect(epochOf("2026-11-01", "09:00", NY)).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(localOf(Date.UTC(2026, 10, 1, 14, 0), NY).hhmm).toBe("09:00");
  });
  it("adds days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("gives seconds of the local day", () => {
    expect(secOfDayIn(Date.UTC(2026, 9, 15, 13, 5, 7), NY)).toBe(9 * 3600 + 5 * 60 + 7);
  });
  it("measures minutes between two clock times", () => {
    expect(minutesBetween("09:00", "09:40")).toBe(40);
    expect(minutesBetween("09:40", "09:00")).toBe(0);
    expect(minutesBetween("", "09:00")).toBe(0);
  });
});
