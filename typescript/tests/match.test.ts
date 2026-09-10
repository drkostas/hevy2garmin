import { describe, it, expect } from "vitest";
import { matchHevyToGarmin, toUtcDate, type HevyDt, type GarminAct } from "../src/match";

const D = (s: string) => new Date(s);

describe("matchHevyToGarmin — two-pass timestamp match (dedup)", () => {
  const garmin: GarminAct[] = [
    { gmt: "2026-07-13 10:00:00", aid: 111 },
    { gmt: "2026-07-13 18:30:00", aid: 222 }, // ~6h off a 12:30 workout (local-time offset)
  ];

  it("exact GMT match", () => {
    const hevy: HevyDt[] = [{ hevyId: "w1", date: D("2026-07-13T10:00:00Z") }];
    expect(matchHevyToGarmin(hevy, garmin)).toEqual([{ hevyId: "w1", aid: 111 }]);
  });

  it("matches within ±60s", () => {
    const hevy: HevyDt[] = [{ hevyId: "w1", date: D("2026-07-13T10:00:45Z") }];
    expect(matchHevyToGarmin(hevy, garmin)).toEqual([{ hevyId: "w1", aid: 111 }]);
  });

  it("fuzzy-matches the closest activity within ±6h", () => {
    // workout at 12:30 UTC → 111 is 2.5h away, 222 is 6h away → picks 111 (closest)
    const hevy: HevyDt[] = [{ hevyId: "w1", date: D("2026-07-13T12:30:00Z") }];
    expect(matchHevyToGarmin(hevy, garmin)).toEqual([{ hevyId: "w1", aid: 111 }]);
  });

  it("no match when beyond ±6h", () => {
    const hevy: HevyDt[] = [{ hevyId: "w1", date: D("2026-07-14T02:00:00Z") }];
    expect(matchHevyToGarmin(hevy, garmin)).toEqual([]);
  });

  it("matches multiple workouts independently", () => {
    const hevy: HevyDt[] = [
      { hevyId: "a", date: D("2026-07-13T10:00:00Z") },
      { hevyId: "b", date: D("2026-07-13T18:30:20Z") }, // within 60s of 222
    ];
    expect(matchHevyToGarmin(hevy, garmin)).toEqual([
      { hevyId: "a", aid: 111 },
      { hevyId: "b", aid: 222 },
    ]);
  });
});

describe("toUtcDate", () => {
  it("treats naive strings as UTC, respects explicit zones", () => {
    expect(toUtcDate("2026-07-13 10:00:00")!.toISOString()).toBe("2026-07-13T10:00:00.000Z");
    expect(toUtcDate("2026-07-13T10:00:00Z")!.toISOString()).toBe("2026-07-13T10:00:00.000Z");
    expect(toUtcDate("2026-07-13T12:00:00+02:00")!.toISOString()).toBe("2026-07-13T10:00:00.000Z");
  });
  it("returns null on empty/garbage", () => {
    expect(toUtcDate("")).toBeNull();
    expect(toUtcDate("nonsense")).toBeNull();
  });
});
