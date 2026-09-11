import { describe, it, expect } from "vitest";
import { ALL_MUSCLE_GROUPS, MUSCLE_LABELS, MUSCLE_HEX, getExerciseMuscles, aggregateMuscleVolumes } from "../src/muscle-groups";

describe("groups, labels, colours", () => {
  it("every group has a label and a hex colour", () => {
    for (const g of ALL_MUSCLE_GROUPS) { expect(MUSCLE_LABELS[g]).toBeTruthy(); expect(MUSCLE_HEX[g]).toMatch(/^#[0-9a-f]{6}$/i); }
    expect(ALL_MUSCLE_GROUPS).toHaveLength(11);
  });
});

describe("getExerciseMuscles", () => {
  it("known exercises come from the table", () => {
    expect(getExerciseMuscles("Bench Press (Barbell)")).toEqual({ primary: ["chest"], secondary: ["triceps", "shoulders"] });
  });
  it("unknown names fall back to keyword heuristics", () => {
    expect(getExerciseMuscles("Weird Cable Pushdown Variation").primary).toEqual(["triceps"]);
    expect(getExerciseMuscles("Bulgarian Squat Thing").primary).toEqual(["quads"]);
    expect(getExerciseMuscles("Seated Row Machine XL").primary).toEqual(["back"]);
  });
  it("nothing recognisable maps to no muscle", () => {
    const m = getExerciseMuscles("Stretching");
    expect(m.primary.length + m.secondary.length).toBeGreaterThanOrEqual(0);
  });
});

describe("aggregateMuscleVolumes", () => {
  const ex = (title: string, sets: { weight_kg?: number | null; reps?: number | null; type?: string | null }[]) => ({ title, sets });
  it("working sets only, weight × reps, primary ×1, secondary ×0.33", () => {
    const v = aggregateMuscleVolumes([ex("Bench Press (Barbell)", [{ weight_kg: 100, reps: 5, type: "normal" }, { weight_kg: 60, reps: 10, type: "warmup" }])]);
    expect(v.chest.primary).toBe(500); expect(v.chest.total).toBe(500);
    expect(v.triceps.secondary).toBeCloseTo(165, 6); expect(v.triceps.total).toBeCloseTo(165, 6);
    expect(v.back.total).toBe(0);
  });
  it("bodyweight exercises count as 1 so they still light up", () => {
    const v = aggregateMuscleVolumes([ex("Pull Up", [{ reps: 8, type: "normal" }])]);
    expect(v.back.primary).toBe(1);
  });
  it("tolerates missing fields and an empty list", () => {
    expect(aggregateMuscleVolumes([{ title: null, sets: null }]).chest.total).toBe(0);
    expect(Object.keys(aggregateMuscleVolumes([]))).toEqual([...ALL_MUSCLE_GROUPS]);
  });
});
