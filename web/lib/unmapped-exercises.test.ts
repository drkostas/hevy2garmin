import { describe, it, expect, vi } from "vitest";

// Deterministic lookup: names containing "UNK" are Unknown (65534), else mapped.
vi.mock("hevy2garmin", () => ({
  lookupExercise: (title: string) => ({
    category: title.includes("UNK") ? 65534 : 5,
    subcategory: 0,
  }),
}));

import { computeUnmapped, type WorkoutLike } from "./unmapped-exercises";

const wk = (exercises: Array<{ title?: string; name?: string }>): WorkoutLike => ({ exercises });

describe("computeUnmapped", () => {
  it("counts only Unknown-category exercises, most-frequent first", () => {
    const workouts = [
      wk([{ title: "Bench Press" }, { title: "UNK Machine A" }]),
      wk([{ title: "UNK Machine A" }, { title: "UNK Machine B" }]),
      wk([{ title: "Squat" }]),
    ];
    const res = computeUnmapped(workouts, new Set());
    expect(res).toEqual([
      { name: "UNK Machine A", count: 2 },
      { name: "UNK Machine B", count: 1 },
    ]);
  });

  it("excludes exercises that already have a custom mapping", () => {
    const workouts = [wk([{ title: "UNK Already Mapped" }, { title: "UNK New" }])];
    const custom = new Set(["unk already mapped"]); // lowercased
    const res = computeUnmapped(workouts, custom);
    expect(res).toEqual([{ name: "UNK New", count: 1 }]);
  });

  it("uses name when title is absent, skips blanks", () => {
    const workouts = [wk([{ name: "UNK ByName" }, { title: "" }, {}])];
    expect(computeUnmapped(workouts, new Set())).toEqual([{ name: "UNK ByName", count: 1 }]);
  });

  it("returns [] when everything maps", () => {
    expect(computeUnmapped([wk([{ title: "Bench Press" }])], new Set())).toEqual([]);
  });

  it("tolerates workouts with no exercises array", () => {
    expect(computeUnmapped([{ exercises: undefined }, {}], new Set())).toEqual([]);
  });
});
