/**
 * Sync a Hevy routine to Garmin as a planned workout, and schedule it on a date.
 * Ports the Garmin side of the Python routine sync:
 *   - create_workout:  POST /workout-service/workout
 *   - schedule_workout: POST /workout-service/schedule/{workoutId}
 * Both are POSTs, so they use the GarminClient's `post`. Unschedule/delete are
 * DELETE requests, which garmin-auth's client does not expose yet — those are
 * left for a package update.
 *
 * Injectable Garmin client factory for tests. The reverse-engineered Garmin
 * planned-workout payload is validated only against a real export (see
 * garmin-workout); a live smoke-test confirms Garmin accepts it.
 */
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { garminDelete } from "./garmin-delete";
import { routineToGarminWorkout, type HevyRoutine, type WorkoutBuildOptions } from "./garmin-workout";
import { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

interface Opts extends WorkoutBuildOptions {
  garminClientFactory?: () => Promise<GarminClient>;
}

export interface RoutineSyncResult {
  status: "synced" | "error";
  garminWorkoutId: number | null;
  error: string | null;
}

/** Create a Garmin planned workout from a Hevy routine and record it. */
export async function syncRoutine(
  routine: HevyRoutine,
  sql: Sql = getDb(),
  opts: Opts = {},
): Promise<RoutineSyncResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const payload = routineToGarminWorkout(routine, opts);
    const res = await client.post<{ workoutId?: number }>("/workout-service/workout", payload);
    const garminWorkoutId = res?.workoutId ?? null;
    await sql`
      INSERT INTO synced_routines (hevy_routine_id, garmin_workout_id, title, status, synced_at)
      VALUES (
        ${String(routine.id)},
        ${garminWorkoutId != null ? String(garminWorkoutId) : null},
        ${routine.title ?? routine.name ?? ""},
        'success', NOW()
      )
      ON CONFLICT (hevy_routine_id) DO UPDATE SET
        garmin_workout_id = EXCLUDED.garmin_workout_id,
        title = EXCLUDED.title,
        status = 'success',
        synced_at = NOW()
    `;
    return { status: "synced", garminWorkoutId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", garminWorkoutId: null, error };
  }
}

export interface RoutineScheduleResult {
  status: "scheduled" | "error";
  scheduleId: string | null;
  error: string | null;
}

/** Schedule a synced routine's Garmin workout onto a date and record it. */
export async function scheduleRoutine(
  hevyRoutineId: string,
  garminWorkoutId: number | string,
  date: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineScheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    const res = await client.post<{ workoutScheduleId?: number }>(
      `/workout-service/schedule/${garminWorkoutId}`,
      { date },
    );
    const scheduleId = res?.workoutScheduleId != null ? String(res.workoutScheduleId) : String(Date.now());
    await sql`
      INSERT INTO routine_schedules (hevy_routine_id, schedule_id, scheduled_date)
      VALUES (${hevyRoutineId}, ${scheduleId}, ${date})
      ON CONFLICT (hevy_routine_id, schedule_id) DO NOTHING
    `;
    return { status: "scheduled", scheduleId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", scheduleId: null, error };
  }
}

export interface RoutineUnscheduleResult {
  status: "unscheduled" | "error";
  error: string | null;
}

/** Remove a Garmin calendar entry (workoutScheduleId) and its local record. */
export async function unscheduleRoutine(
  hevyRoutineId: string,
  scheduleId: string,
  sql: Sql = getDb(),
  opts: { garminClientFactory?: () => Promise<GarminClient> } = {},
): Promise<RoutineUnscheduleResult> {
  try {
    const client = await (opts.garminClientFactory ?? (() => getGarminClient()))();
    await garminDelete(client, `/workout-service/schedule/${scheduleId}`);
    await sql`
      DELETE FROM routine_schedules
      WHERE hevy_routine_id = ${hevyRoutineId} AND schedule_id = ${scheduleId}
    `;
    return { status: "unscheduled", error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}
