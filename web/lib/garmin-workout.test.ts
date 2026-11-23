import { describe, it, expect } from "vitest";
import { routineToGarminWorkout, ROUTINE_DESC_MARKER, type HevyRoutine } from "./garmin-workout";

type Step = Record<string, unknown>;

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

function topSteps(r: HevyRoutine, opts = {}): Step[] {
  const w = routineToGarminWorkout(r, opts);
  return (w.workoutSegments as Array<{ workoutSteps: Step[] }>)[0].workoutSteps;
}

const key = (s: Step) => (s.stepType as { stepTypeKey: string }).stepTypeKey;

/** Every step's stepOrder in document order, children included. */
function allOrders(steps: Step[]): number[] {
  return steps.flatMap((s) => [s.stepOrder as number, ...allOrders((s.workoutSteps as Step[]) ?? [])]);
}

describe("routineToGarminWorkout", () => {
  it("builds a strength workout; the warmup stays its own step and identical working sets become a repeat block", () => {
    const w = routineToGarminWorkout(routine);
    expect(w.workoutName).toBe("Push Day");
    expect((w.sportType as { sportTypeKey: string }).sportTypeKey).toBe("strength_training");
    const steps = topSteps(routine);
    // warmup, rest, repeat(2 × [interval, rest]).
    expect(steps.map(key)).toEqual(["warmup", "rest", "repeat"]);
    const group = steps[2];
    expect(group).toMatchObject({
      type: "RepeatGroupDTO",
      numberOfIterations: 2,
      endConditionValue: 2,
      endCondition: { conditionTypeKey: "iterations" },
      // the last set of the exercise has no rest after it, as before
      skipLastRestStep: true,
      smartRepeat: false,
    });
    const children = group.workoutSteps as Step[];
    expect(children.map(key)).toEqual(["interval", "rest"]);
    expect(children.every((c) => c.childStepId === group.childStepId)).toBe(true);
    // working set: weight in kg, reps end-condition
    expect(children[0]).toMatchObject({ weightValue: 80, endConditionValue: 5 });
    expect((children[0].weightUnit as { unitKey: string }).unitKey).toBe("kilogram");
    expect(children[1]).toMatchObject({ endConditionValue: 90 });
  });

  it("keeps the provenance marker in the description and converts to pounds when asked", () => {
    const w = routineToGarminWorkout(routine, { weightUnit: "pound" });
    expect(String(w.description)).toContain(ROUTINE_DESC_MARKER);
    const set = (topSteps(routine, { weightUnit: "pound" })[2].workoutSteps as Step[])[0];
    // 80 kg → ~176.37 lb
    expect(set.weightValue).toBeCloseTo(176.37, 1);
    expect((set.weightUnit as { unitKey: string }).unitKey).toBe("pound");
  });

  it("no rest_seconds → no rest steps, inside or outside the block", () => {
    const noRest = { ...routine, exercises: [{ ...routine.exercises[0], rest_seconds: null }] };
    const steps = topSteps(noRest);
    expect(steps.map(key)).toEqual(["warmup", "repeat"]);
    expect((steps[1].workoutSteps as Step[]).map(key)).toEqual(["interval"]);
    expect(steps[1].skipLastRestStep).toBe(false);
  });

  it("three identical sets are one block of three, as in the routine from #727", () => {
    const r: HevyRoutine = {
      title: "Fortalecimento",
      exercises: [{ title: "Bulgarian Split Squat (Dumbbell)", rest_seconds: 90, sets: [1, 2, 3].map(() => ({ type: "normal", reps: 8, weight_kg: 16 })) }],
    };
    const steps = topSteps(r);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "RepeatGroupDTO", numberOfIterations: 3, skipLastRestStep: true });
    expect((steps[0].workoutSteps as Step[])[0]).toMatchObject({ endConditionValue: 8, weightValue: 16 });
  });

  it("sets that differ stay separate steps with a rest between each", () => {
    const r: HevyRoutine = {
      exercises: [{ title: "Squat (Barbell)", rest_seconds: 120, sets: [
        { type: "normal", reps: 5, weight_kg: 100 },
        { type: "normal", reps: 5, weight_kg: 105 },
        { type: "normal", reps: 3, weight_kg: 105 },
      ] }],
    };
    expect(topSteps(r).map(key)).toEqual(["interval", "rest", "interval", "rest", "interval"]);
  });

  it("an exercise with variable reps keeps each set, not a repeat block (#800)", () => {
    const r: HevyRoutine = {
      exercises: [{ title: "Lat Pulldown (Cable)", rest_seconds: 90, sets: [
        { type: "normal", reps: 10, weight_kg: 50 },
        { type: "normal", reps: 8, weight_kg: 50 },
        { type: "normal", reps: 8, weight_kg: 50 },
      ] }],
    };
    const steps = topSteps(r);
    // 10, 8, 8 is not a uniform exercise, so the trailing 8s must not collapse
    // into a repeat block. Three flat sets, a rest between each.
    expect(steps.map(key)).toEqual(["interval", "rest", "interval", "rest", "interval"]);
    expect(steps.some((s) => s.type === "RepeatGroupDTO")).toBe(false);
    expect(steps.filter((s) => key(s) === "interval").map((s) => s.endConditionValue)).toEqual([10, 8, 8]);
  });

  it("an exercise with varied working sets stays flat, even where some sets repeat (#800)", () => {
    const r: HevyRoutine = {
      exercises: [{ title: "Deadlift (Barbell)", rest_seconds: 60, sets: [
        { type: "normal", reps: 5, weight_kg: 100 },
        { type: "normal", reps: 5, weight_kg: 100 },
        { type: "normal", reps: 3, weight_kg: 120 },
        { type: "normal", reps: 3, weight_kg: 120 },
      ] }],
    };
    const steps = topSteps(r);
    // The working sets are not all identical, so each is its own step with a rest
    // between, and the last set of the workout has none after it (#800).
    expect(steps.map(key)).toEqual(["interval", "rest", "interval", "rest", "interval", "rest", "interval"]);
    expect(steps.some((s) => s.type === "RepeatGroupDTO")).toBe(false);
    expect(steps.filter((s) => key(s) === "interval").map((s) => s.endConditionValue)).toEqual([5, 5, 3, 3]);
  });

  it("numbers every step once, in order, across exercises, and gives each block its own childStepId", () => {
    const r: HevyRoutine = {
      exercises: [
        routine.exercises[0],
        { title: "Plank", rest_seconds: 30, sets: [{ type: "normal", duration_seconds: 60 }, { type: "normal", duration_seconds: 60 }] },
      ],
    };
    const steps = topSteps(r);
    const orders = allOrders(steps);
    expect(orders).toEqual(orders.map((_, i) => i + 1));
    const groups = steps.filter((s) => s.type === "RepeatGroupDTO");
    expect(groups.map((g) => g.childStepId)).toEqual([1, 2]);
    // only the block that ends the workout skips its last rest (#730)
    expect(groups.map((g) => g.skipLastRestStep)).toEqual([false, true]);
    // timed sets group too, and end on time
    expect((groups[1].workoutSteps as Step[])[0]).toMatchObject({ endCondition: { conditionTypeKey: "time" }, endConditionValue: 60 });
  });

  it("keeps the rest after an exercise's last set when another exercise follows (#730)", () => {
    const r: HevyRoutine = {
      exercises: [
        { title: "Pull Up", rest_seconds: 90, sets: [{ type: "normal", reps: 10 }] },
        { title: "Lat Pulldown (Cable)", rest_seconds: 60, sets: [1, 2].map(() => ({ type: "normal", reps: 10, weight_kg: 50 })) },
        { title: "Hip Abduction (Machine)", rest_seconds: 45, sets: [1, 2].map(() => ({ type: "normal", reps: 12, weight_kg: 40 })) },
        { title: "Cable Core Press", rest_seconds: 45, sets: [1, 2, 3].map(() => ({ type: "normal", reps: 10, weight_kg: 5 })) },
      ],
    };
    const steps = topSteps(r);
    expect(steps.map(key)).toEqual(["interval", "rest", "repeat", "repeat", "repeat"]);
    expect(steps[1]).toMatchObject({ endConditionValue: 90 });
    expect(steps.filter((s) => s.type === "RepeatGroupDTO").map((g) => g.skipLastRestStep)).toEqual([false, false, true]);
  });

  it("an exercise with no sets does not count as the last one", () => {
    const r: HevyRoutine = {
      exercises: [
        { title: "Squat (Barbell)", rest_seconds: 120, sets: [1, 2].map(() => ({ type: "normal", reps: 5, weight_kg: 100 })) },
        { title: "Stretching", rest_seconds: 30, sets: [] },
      ],
    };
    expect(topSteps(r)[0]).toMatchObject({ type: "RepeatGroupDTO", skipLastRestStep: true });
  });

  it("a single set is a plain step with no rest after it", () => {
    const r: HevyRoutine = { exercises: [{ title: "Pull Up", rest_seconds: 90, sets: [{ type: "normal", reps: 10 }] }] };
    expect(topSteps(r).map(key)).toEqual(["interval"]);
  });
});
