import { describe, it, expect } from "vitest";
import { routineToGarminWorkout, ROUTINE_DESC_MARKER } from "./garmin-workout";

const routine = {
  id: "r1",
  title: "Push Day",
  notes: "chest + tris",
  exercises: [
    {
      title: "Bench Press (Barbell)",
      rest_seconds: 90,
      sets: [
        { type: "warmup", reps: 10, weight_kg: 40 },
        { type: "normal", reps: 5, weight_kg: 80 },
        { type: "normal", reps: 5, weight_kg: 80 },
      ],
    },
  ],
};

describe("routineToGarminWorkout", () => {
  it("builds a strength workout with one step per set + rest between sets", () => {
    const w = routineToGarminWorkout(routine);
    expect(w.workoutName).toBe("Push Day");
    expect((w.sportType as { sportTypeKey: string }).sportTypeKey).toBe("strength_training");
    const steps = (w.workoutSegments as Array<{ workoutSteps: Array<Record<string, unknown>> }>)[0]
      .workoutSteps;
    // 3 sets → a rest between each consecutive pair (2 rests), not after the last:
    // warmup, rest, interval, rest, interval = 5 steps.
    expect(steps.length).toBe(5);
    expect(steps[0].stepType).toMatchObject({ stepTypeKey: "warmup" });
    expect(steps[1].stepType).toMatchObject({ stepTypeKey: "rest" });
    expect(steps[2].stepType).toMatchObject({ stepTypeKey: "interval" });
    expect(steps[3].stepType).toMatchObject({ stepTypeKey: "rest" });
    expect(steps[4].stepType).toMatchObject({ stepTypeKey: "interval" });
    // working set: weight in kg, reps end-condition
    expect(steps[2]).toMatchObject({ weightValue: 80, endConditionValue: 5 });
    expect((steps[2].weightUnit as { unitKey: string }).unitKey).toBe("kilogram");
  });

  it("keeps the provenance marker in the description and converts to pounds when asked", () => {
    const w = routineToGarminWorkout(routine, { weightUnit: "pound" });
    expect(String(w.description)).toContain(ROUTINE_DESC_MARKER);
    const steps = (w.workoutSegments as Array<{ workoutSteps: Array<Record<string, unknown>> }>)[0]
      .workoutSteps;
    // 80 kg → ~176.37 lb (steps[2] is the first working interval)
    expect(steps[2].weightValue).toBeCloseTo(176.37, 1);
    expect((steps[2].weightUnit as { unitKey: string }).unitKey).toBe("pound");
  });

  it("no rest_seconds → no rest steps", () => {
    const noRest = { ...routine, exercises: [{ ...routine.exercises[0], rest_seconds: null }] };
    const w = routineToGarminWorkout(noRest);
    const steps = (w.workoutSegments as Array<{ workoutSteps: Array<Record<string, unknown>> }>)[0]
      .workoutSteps;
    expect(steps.length).toBe(3); // 3 sets, no rest
    expect(steps.every((s) => (s.stepType as { stepTypeKey: string }).stepTypeKey !== "rest")).toBe(true);
  });
});
