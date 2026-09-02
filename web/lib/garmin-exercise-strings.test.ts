import { describe, it, expect } from "vitest";
import { fitExerciseStrings, exerciseCategoryId } from "./garmin-exercise-strings";

describe("fitExerciseStrings", () => {
  it("maps a real (bench press, barbell) pair to the Garmin enum strings", () => {
    const benchId = exerciseCategoryId("benchPress");
    expect(benchId).not.toBeNull();
    // subcategory 1 is barbellBenchPress in the FIT profile.
    const [cat, name] = fitExerciseStrings(benchId as number, 1);
    expect(cat).toBe("BENCH_PRESS");
    expect(name).toBe("BARBELL_BENCH_PRESS");
  });

  it("returns UPPER_SNAKE for the category even when the subcategory is unknown", () => {
    const squatId = exerciseCategoryId("squat");
    expect(squatId).not.toBeNull();
    const [cat, name] = fitExerciseStrings(squatId as number, 999999);
    expect(cat).toBe("SQUAT");
    expect(name).toBeNull();
  });

  it("an unknown category → [null, null]", () => {
    expect(fitExerciseStrings(999999, 0)).toEqual([null, null]);
  });
});
