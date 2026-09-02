/**
 * Translate FIT numeric (category, subcategory) exercise ids into the Garmin
 * workout-service enum STRINGS, e.g. (benchPress, 1) → ["BENCH_PRESS",
 * "BARBELL_BENCH_PRESS"]. Ported from mapper.fit_exercise_strings, backed by
 * @garmin/fitsdk's Profile enums (which ship camelCase names, converted here to
 * the UPPER_SNAKE member names Garmin expects).
 *
 * Either element is null when the pair doesn't resolve (unknown category, a
 * subcategory the SDK doesn't have), so callers fall back to a generic named
 * step instead of sending an invalid enum.
 */
import { Profile } from "@garmin/fitsdk";

type EnumMap = Record<number, string>;

const types = (Profile as unknown as { types?: Record<string, unknown> }).types ?? {};

/** camelCase → UPPER_SNAKE_CASE (the FIT enum member name). */
function upperSnake(camel: string): string {
  return camel
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

export function fitExerciseStrings(
  category: number,
  subcategory: number,
): [string | null, string | null] {
  const catMap = types.exerciseCategory as EnumMap | undefined;
  const catName = catMap?.[category];
  if (!catName || catName === "unknown") return [null, null];
  const categoryStr = upperSnake(catName);

  const nameMap = types[`${catName}ExerciseName`] as EnumMap | undefined;
  const subName = nameMap?.[subcategory];
  const exerciseNameStr = subName && subName !== "unknown" ? upperSnake(subName) : null;

  return [categoryStr, exerciseNameStr];
}

/** The numeric id for a named category (e.g. "benchPress" → its FIT value), or null. */
export function exerciseCategoryId(name: string): number | null {
  const catMap = types.exerciseCategory as EnumMap | undefined;
  if (!catMap) return null;
  for (const [k, v] of Object.entries(catMap)) {
    if (v === name) return Number(k);
  }
  return null;
}
