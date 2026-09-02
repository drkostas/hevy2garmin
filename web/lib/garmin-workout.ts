/**
 * Build a Garmin Connect planned-workout payload from a Hevy routine — the body
 * for POST /workout-service/workout. A faithful port of routine.py
 * (routine_to_garmin_workout): one flat interval step per set, a timed rest step
 * between consecutive sets, warmup vs. working step types, per-set weights in kg
 * or lb, and the provenance marker in the description. The numeric enum ids were
 * reverse-engineered + validated against a real Garmin export in the Python.
 */
import { lookupExercise } from "hevy2garmin";
import { fitExerciseStrings } from "./garmin-exercise-strings";

const SPORT_TYPE_STRENGTH = { sportTypeId: 5, sportTypeKey: "strength_training" };
const STEP_TYPE_WARMUP = { stepTypeId: 1, stepTypeKey: "warmup" };
const STEP_TYPE_INTERVAL = { stepTypeId: 3, stepTypeKey: "interval" };
const STEP_TYPE_REST = { stepTypeId: 5, stepTypeKey: "rest" };
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
  const isWarmup = (set.type ?? "").toLowerCase() === "warmup";
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
  let order = 1;

  for (const exercise of exercises) {
    const title = exercise.title || exercise.name || "Exercise";
    const { category, subcategory } = lookupExercise(title, exercise.exercise_template_id ?? null);
    const [categoryStr, exerciseNameStr] = fitExerciseStrings(category, subcategory);

    const restSeconds = exercise.rest_seconds ?? defaultRestSeconds;
    const sets = exercise.sets ?? [];
    for (let i = 0; i < sets.length; i++) {
      steps.push(buildStep(order, sets[i], title, categoryStr, exerciseNameStr, weightUnit));
      order += 1;
      // Rest goes BETWEEN sets of the same exercise, not after the last one.
      if (restSeconds && i < sets.length - 1) {
        steps.push(restStep(order, restSeconds));
        order += 1;
      }
    }
  }

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
