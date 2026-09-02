/**
 * Detect Hevy exercises that don't map to a Garmin FIT category — ports the
 * Python _get_unmapped_exercises(). An exercise is "unmapped" when
 * lookupExercise() returns the Unknown category (65534) AND there is no custom
 * mapping for its exact name. Pure + testable; the route feeds it real workouts.
 */
import { lookupExercise } from "hevy2garmin";

const UNKNOWN_CATEGORY = 65534;

export interface UnmappedExercise {
  name: string;
  count: number;
}

/** A minimal view of a Hevy workout's exercises (payloads carry more fields). */
export interface WorkoutLike {
  exercises?: Array<{ title?: string | null; name?: string | null; exercise_template_id?: string | null }> | unknown;
  [key: string]: unknown;
}

/**
 * Count occurrences of unmapped exercises across the given workouts.
 * `customNames` is the set of lowercased Hevy names that already have a custom
 * mapping (those are excluded even if the built-in map doesn't know them).
 */
export function computeUnmapped(workouts: WorkoutLike[], customNames: Set<string>): UnmappedExercise[] {
  const counts = new Map<string, number>();
  for (const w of workouts) {
    const exs = Array.isArray(w.exercises) ? (w.exercises as Array<Record<string, unknown>>) : [];
    for (const e of exs) {
      const title = String((e.title as string) || (e.name as string) || "").trim();
      if (!title) continue;
      if (customNames.has(title.toLowerCase())) continue; // already custom-mapped
      let category: number;
      try {
        category = lookupExercise(title, (e.exercise_template_id as string) ?? null).category;
      } catch {
        continue;
      }
      if (category === UNKNOWN_CATEGORY) {
        counts.set(title, (counts.get(title) ?? 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
