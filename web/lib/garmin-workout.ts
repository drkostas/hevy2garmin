/**
 * Build a Garmin Connect planned-workout payload from a Hevy routine — the body
 * for POST /workout-service/workout. Ported from routine.py
 * (routine_to_garmin_workout): a timed rest step after each set, warmup vs.
 * working step types, per-set weights in kg or lb, and the provenance marker in
 * the description. The numeric enum ids were reverse-engineered +
 * validated against a real Garmin export in the Python.
 *
 * An exercise whose working sets are all identical becomes one repeat block
 * ("3 sets" in Garmin, as its own editor builds them), so a uniform routine
 * reads cleanly (#727). An exercise with any varied working set, for example
 * 10/8/8, stays one flat step per set, so Garmin shows each set as the routine
 * has it (#800). Warmups are always their own step.
 *
 * Exercises grouped as a superset in Hevy (the same non-null superset_id) are
 * emitted interleaved, one set of each exercise in turn with the rest after the
 * whole group, so Garmin keeps the superset order rather than two independent
 * exercises (#801). routine.py still emits one flat step per set and is frozen
 * for the PyPI deprecation (#515).
 */
import { lookupExercise } from "hevy2garmin";
import { fitExerciseStrings } from "./garmin-exercise-strings";

const SPORT_TYPE_STRENGTH = { sportTypeId: 5, sportTypeKey: "strength_training" };
const STEP_TYPE_WARMUP = { stepTypeId: 1, stepTypeKey: "warmup" };
const STEP_TYPE_INTERVAL = { stepTypeId: 3, stepTypeKey: "interval" };
const STEP_TYPE_REST = { stepTypeId: 5, stepTypeKey: "rest" };
const STEP_TYPE_REPEAT = { stepTypeId: 6, stepTypeKey: "repeat" };
const END_ITERATIONS = { conditionTypeId: 7, conditionTypeKey: "iterations" };
const END_REPS = { conditionTypeId: 10, conditionTypeKey: "reps" };
const END_TIME = { conditionTypeId: 2, conditionTypeKey: "time" };
const END_LAP_BUTTON = { conditionTypeId: 1, conditionTypeKey: "lap.button" };
const WEIGHT_UNIT_KG = { unitId: 8, unitKey: "kilogram" };
const WEIGHT_UNIT_LB = { unitId: 7, unitKey: "pound" };
const KG_TO_LB = 2.2046226218;

export const ROUTINE_DESC_MARKER = "— synced from Hevy by hevy2garmin";

export interface HevySet {
  type?: string | null;
  reps?: number | null;
  duration_seconds?: number | null;
  weight_kg?: number | null;
}
export interface HevyExercise {
  title?: string | null;
  name?: string | null;
  exercise_template_id?: string | null;
  rest_seconds?: number | null;
  // The id of the superset this exercise belongs to, or null when it is not in
  // one (Hevy's routine/workout API; #801). Exercises that share a non-null
  // value are performed together.
  superset_id?: number | string | null;
  sets?: HevySet[];
}
export interface HevyRoutine {
  id?: string;
  title?: string | null;
  name?: string | null;
  notes?: string | null;
  exercises?: HevyExercise[];
}

type Step = Record<string, unknown>;
type Ctx = { order: number; groupId: number };

function weightFields(set: HevySet, weightUnit: string): Step {
  const kg = set.weight_kg;
  if (kg == null) return {};
  if (weightUnit === "pound") {
    return { weightValue: Math.round(kg * KG_TO_LB * 100) / 100, weightUnit: WEIGHT_UNIT_LB };
  }
  return { weightValue: kg, weightUnit: WEIGHT_UNIT_KG };
}

function buildStep(
  order: number,
  set: HevySet,
  title: string,
  categoryStr: string | null,
  exerciseNameStr: string | null,
  weightUnit: string,
): Step {
  const isWarmup = isWarmupSet(set);
  const step: Step = {
    type: "ExecutableStepDTO",
    stepOrder: order,
    stepType: isWarmup ? STEP_TYPE_WARMUP : STEP_TYPE_INTERVAL,
  };
  if (set.reps != null) {
    step.endCondition = END_REPS;
    step.endConditionValue = Number(set.reps);
  } else if (set.duration_seconds != null) {
    step.endCondition = END_TIME;
    step.endConditionValue = Number(set.duration_seconds);
  } else {
    step.endCondition = END_LAP_BUTTON;
  }
  if (categoryStr != null) step.category = categoryStr;
  if (exerciseNameStr != null) step.exerciseName = exerciseNameStr;
  if (exerciseNameStr == null) step.stepName = title;
  Object.assign(step, weightFields(set, weightUnit));
  return step;
}

function restStep(order: number, restSeconds: number): Step {
  return {
    type: "ExecutableStepDTO",
    stepOrder: order,
    stepType: STEP_TYPE_REST,
    endCondition: END_TIME,
    endConditionValue: Number(restSeconds),
  };
}

function isWarmupSet(set: HevySet): boolean {
  return (set.type ?? "").toLowerCase() === "warmup";
}

/**
 * Two sets are one repeatable step when Garmin would show them the same: the
 * same warmup/working type, the same end condition (reps, or else duration) and
 * the same weight. Mirrors what buildStep reads from a set.
 */
function setKey(set: HevySet): string {
  const reps = set.reps ?? null;
  const duration = reps == null ? (set.duration_seconds ?? null) : null;
  return JSON.stringify([isWarmupSet(set), reps, duration, set.weight_kg ?? null]);
}

/** The Garmin category and exercise-name strings for one Hevy exercise. */
function exerciseStrings(exercise: HevyExercise): {
  title: string;
  categoryStr: string | null;
  exerciseNameStr: string | null;
} {
  const title = exercise.title || exercise.name || "Exercise";
  const { category, subcategory } = lookupExercise(title, exercise.exercise_template_id ?? null);
  const [categoryStr, exerciseNameStr] = fitExerciseStrings(category, subcategory);
  return { title, categoryStr, exerciseNameStr };
}

/**
 * Emit one ordinary (non-superset) exercise. Identical consecutive working sets
 * collapse into one repeat block (#727/#800); every other set is one flat step.
 * A timed rest follows each set unless it is the workout's last (#730).
 */
function emitExercise(
  exercise: HevyExercise,
  isLastInWorkout: boolean,
  steps: Step[],
  ctx: Ctx,
  weightUnit: string,
  defaultRestSeconds: number | null,
): void {
  const { title, categoryStr, exerciseNameStr } = exerciseStrings(exercise);
  const restSeconds = exercise.rest_seconds ?? defaultRestSeconds;
  const sets = exercise.sets ?? [];
  // A repeat block is used only when every working set of the exercise is
  // identical, so a uniform exercise like 3x8 reads as one clean block. An
  // exercise with any varied working set (10/8/8) stays one flat step per set
  // (#800). Warmups are always their own step and never start or join a run.
  const working = sets.filter((s) => !isWarmupSet(s));
  const uniformWorking =
    working.length >= 2 && working.every((s) => setKey(s) === setKey(working[0]));
  let i = 0;
  while (i < sets.length) {
    // A run of identical consecutive working sets, only for a uniform exercise.
    let n = 1;
    if (uniformWorking && !isWarmupSet(sets[i])) {
      while (
        i + n < sets.length &&
        !isWarmupSet(sets[i + n]) &&
        setKey(sets[i + n]) === setKey(sets[i])
      ) {
        n += 1;
      }
    }
    const endsWorkout = isLastInWorkout && i + n === sets.length;

    if (n >= 2) {
      // One repeat block of n rounds, each the set and its rest. Garmin numbers
      // the block first and its children after it, and marks the children with
      // the block's childStepId (read back from a stored workout).
      ctx.groupId += 1;
      const groupOrder = ctx.order;
      ctx.order += 1;
      const children: Step[] = [
        { ...buildStep(ctx.order, sets[i], title, categoryStr, exerciseNameStr, weightUnit), childStepId: ctx.groupId },
      ];
      ctx.order += 1;
      if (restSeconds) {
        children.push({ ...restStep(ctx.order, restSeconds), childStepId: ctx.groupId });
        ctx.order += 1;
      }
      steps.push({
        type: "RepeatGroupDTO",
        stepOrder: groupOrder,
        stepType: STEP_TYPE_REPEAT,
        childStepId: ctx.groupId,
        numberOfIterations: n,
        endCondition: END_ITERATIONS,
        endConditionValue: n,
        // The rest after the last round is the rest before whatever comes next;
        // only the block that ends the workout skips it.
        skipLastRestStep: Boolean(restSeconds) && endsWorkout,
        smartRepeat: false,
        workoutSteps: children,
      });
    } else {
      steps.push(buildStep(ctx.order, sets[i], title, categoryStr, exerciseNameStr, weightUnit));
      ctx.order += 1;
      // Rest after the set, unless it is the last set of the workout.
      if (restSeconds && !endsWorkout) {
        steps.push(restStep(ctx.order, restSeconds));
        ctx.order += 1;
      }
    }
    i += n;
  }
}

/**
 * Emit a superset: two or more exercises done back to back, with rest only after
 * the whole group (#801). One flat step per set, interleaved by round across the
 * members, so Garmin shows set 1 of each exercise, a rest, set 2 of each, and so
 * on. The rest after a round is the last member's rest, and the workout's final
 * round has none (#730). A repeat block is not used, because its rounds would
 * have to be identical and a superset's members are different exercises.
 */
function emitSuperset(
  members: HevyExercise[],
  isLastInWorkout: boolean,
  steps: Step[],
  ctx: Ctx,
  weightUnit: string,
  defaultRestSeconds: number | null,
): void {
  const strings = members.map(exerciseStrings);
  const setLists = members.map((m) => m.sets ?? []);
  const rounds = Math.max(0, ...setLists.map((s) => s.length));
  const last = members[members.length - 1];
  const restSeconds = last.rest_seconds ?? defaultRestSeconds;
  for (let r = 0; r < rounds; r += 1) {
    for (let m = 0; m < members.length; m += 1) {
      const set = setLists[m][r];
      if (set === undefined) continue;
      steps.push(
        buildStep(ctx.order, set, strings[m].title, strings[m].categoryStr, strings[m].exerciseNameStr, weightUnit),
      );
      ctx.order += 1;
    }
    // Rest after the round, unless this round ends the workout.
    const endsWorkout = isLastInWorkout && r === rounds - 1;
    if (restSeconds && !endsWorkout) {
      steps.push(restStep(ctx.order, restSeconds));
      ctx.order += 1;
    }
  }
}

export interface WorkoutBuildOptions {
  weightUnit?: "kilogram" | "pound";
  defaultRestSeconds?: number | null;
}

/** Convert a Hevy routine into a Garmin /workout-service/workout body. */
export function routineToGarminWorkout(
  routine: HevyRoutine,
  opts: WorkoutBuildOptions = {},
): Record<string, unknown> {
  const weightUnit = opts.weightUnit ?? "kilogram";
  const defaultRestSeconds = opts.defaultRestSeconds ?? null;
  const exercises = routine.exercises ?? [];
  const steps: Step[] = [];
  const ctx: Ctx = { order: 1, groupId: 0 };

  // Consecutive exercises that share a non-null superset_id are one superset
  // unit; every other exercise is its own unit (#801). A lone exercise that
  // carries a superset_id (a one-member group) is treated as ordinary.
  const units: HevyExercise[][] = [];
  for (const ex of exercises) {
    const sid = ex.superset_id ?? null;
    const lastUnit = units[units.length - 1];
    const lastSid = lastUnit ? (lastUnit[0].superset_id ?? null) : null;
    if (sid != null && lastUnit != null && lastSid === sid) lastUnit.push(ex);
    else units.push([ex]);
  }

  // Hevy's rest timer runs after every set, the last set of an exercise included,
  // so the rest before the next exercise is a real step. Only the very last set of
  // the workout has none after it (#730). Find the last unit that has any sets.
  let lastUnitIdx = -1;
  units.forEach((u, idx) => {
    if (u.some((e) => (e.sets ?? []).length > 0)) lastUnitIdx = idx;
  });

  units.forEach((unit, idx) => {
    const isLast = idx === lastUnitIdx;
    if (unit.length >= 2) {
      emitSuperset(unit, isLast, steps, ctx, weightUnit, defaultRestSeconds);
    } else {
      emitExercise(unit[0], isLast, steps, ctx, weightUnit, defaultRestSeconds);
    }
  });

  const name = routine.title || routine.name || "Hevy Routine";
  const marker = `\n${ROUTINE_DESC_MARKER}`;
  const notes = (routine.notes || "Synced from Hevy").trim().slice(0, 1024 - marker.length);

  return {
    workoutName: name,
    description: `${notes}${marker}`,
    sportType: SPORT_TYPE_STRENGTH,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: SPORT_TYPE_STRENGTH,
        workoutSteps: steps,
      },
    ],
  };
}
