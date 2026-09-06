import { describe, it, expect } from "vitest";
import { recurringDates } from "./recurring-dates";

const day = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const DAY_MS = 7 * 24 * 3600 * 1000;

describe("recurringDates", () => {
  it("generates N weekly dates on the chosen weekday, 7 days apart", () => {
    const dates = recurringDates("2026-01-05", 1, 3); // Mondays
    expect(dates).toHaveLength(3);
    for (const d of dates) expect(day(d)).toBe(1);
    expect(dates.every((d) => d >= "2026-01-05")).toBe(true);
    for (let i = 1; i < dates.length; i++) {
      const gap = new Date(`${dates[i]}T00:00:00Z`).getTime() - new Date(`${dates[i - 1]}T00:00:00Z`).getTime();
      expect(gap).toBe(DAY_MS);
    }
  });

  it("advances to the first matching weekday on/after the start", () => {
    // 2026-01-05 is a Monday; asking for Wednesday (3) → first is 2026-01-07.
    const dates = recurringDates("2026-01-05", 3, 2);
    expect(dates[0]).toBe("2026-01-07");
    expect(day(dates[0])).toBe(3);
  });

  it("clamps weeks to [1,52]", () => {
    expect(recurringDates("2026-01-05", 1, 0)).toHaveLength(1);
    expect(recurringDates("2026-01-05", 1, 999)).toHaveLength(52);
  });

  it("normalizes an out-of-range weekday", () => {
    expect(day(recurringDates("2026-01-05", 8, 1)[0])).toBe(1); // 8 % 7 = 1 (Mon)
  });

  it("returns [] for an invalid start date", () => {
    expect(recurringDates("not-a-date", 1, 3)).toEqual([]);
  });
});
