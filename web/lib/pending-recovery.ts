/**
 * Recovery for stuck in-flight uploads — the counterpart to lib/sync-one for a
 * SPECIFIC pending workout rather than the next candidate.
 *
 *   reconcile — a Garmin READ: check whether Garmin already has an activity at
 *     the workout's start time. If it does, the earlier attempt actually landed,
 *     so complete the pending as a matched success (no re-upload). Otherwise
 *     leave the pending in place and record that nothing was found.
 *
 *   retry — reconcile first (never double-upload), and only if Garmin still has
 *     nothing, regenerate the FIT from the stored payload and re-upload, then
 *     finalize. A Garmin WRITE — the route gates it behind auth + confirmation.
 *
 * Both reuse the same helpers as sync-one and take an injectable Garmin client
 * factory so they can be unit-tested with no network.
 */
import { generateFit, type HevyWorkout as FitWorkout } from "hevy2garmin";
import {
  getGarminClient,
  findExistingActivity,
  upload,
  rename,
  describe,
} from "./garmin-upload";
import { getPending, completePending, updatePending, type PendingRow } from "./pending-store";
import { generateDescription } from "./sync-one";
import type { GarminClient } from "garmin-auth";
import { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

export interface RecoveryOptions {
  /** Injectable Garmin client factory (tests). Defaults to the live client. */
  garminClientFactory?: () => Promise<GarminClient>;
  /** Attach a text description on a retried upload. Default true. */
  descriptionEnabled?: boolean;
}

export interface RecoveryResult {
  /**
   * reconciled_synced — Garmin already had it, completed as matched.
   * no_activity — reconcile found nothing on Garmin, pending left in place.
   * synced — retry re-uploaded successfully.
   * not_found — no pending row for this id.
   * no_payload — the pending row has no usable stored workout.
   * error — the retry upload failed (pending parked with the error).
   */
  status: "reconciled_synced" | "no_activity" | "synced" | "not_found" | "no_payload" | "error";
  garminActivityId: number | null;
  error: string | null;
}

interface StoredPayload {
  workout?: Record<string, unknown>;
  title?: string;
  calories?: number;
  avg_hr?: number | null;
}

function payloadOf(pending: PendingRow): StoredPayload {
  const p = pending.payload;
  return p && typeof p === "object" ? (p as StoredPayload) : {};
}

function startTimeOf(workout: Record<string, unknown> | undefined): string | null {
  const s = workout?.start_time;
  return typeof s === "string" && s ? s : null;
}

/** Complete a pending as a matched Garmin activity (no upload). */
async function completeMatched(
  hevyId: string,
  pl: StoredPayload,
  activityId: number,
  sql: Sql,
): Promise<void> {
  await completePending(
    hevyId,
    {
      garminActivityId: String(activityId),
      title: pl.title ?? "",
      calories: pl.calories ?? null,
      avgHr: pl.avg_hr ?? null,
      syncMethod: "match",
    },
    sql,
  );
}

export async function reconcilePending(
  hevyId: string,
  opts: RecoveryOptions = {},
  sql: Sql = getDb(),
): Promise<RecoveryResult> {
  const pending = await getPending(hevyId, sql);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const startTime = startTimeOf(pl.workout);
  if (!startTime) return { status: "no_payload", garminActivityId: null, error: null };

  const factory = opts.garminClientFactory ?? (() => getGarminClient());
  const client = await factory();
  const existing = await findExistingActivity(client, startTime);
  if (existing != null) {
    await completeMatched(hevyId, pl, existing, sql);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }
  await updatePending(hevyId, { last_error: "reconcile: no matching Garmin activity" }, sql);
  return { status: "no_activity", garminActivityId: null, error: null };
}

export async function retryPending(
  hevyId: string,
  opts: RecoveryOptions = {},
  sql: Sql = getDb(),
): Promise<RecoveryResult> {
  const pending = await getPending(hevyId, sql);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const workout = pl.workout;
  const startTime = startTimeOf(workout);
  if (!workout || !startTime) return { status: "no_payload", garminActivityId: null, error: null };

  const factory = opts.garminClientFactory ?? (() => getGarminClient());
  const client = await factory();

  // Never double-upload: if Garmin already has it, complete as matched.
  const existing = await findExistingActivity(client, startTime);
  if (existing != null) {
    await completeMatched(hevyId, pl, existing, sql);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }

  try {
    const fit = generateFit(workout as unknown as FitWorkout, null);
    await updatePending(
      hevyId,
      { phase: "processing", attempt_count: (pending.attempt_count ?? 0) + 1, last_error: null },
      sql,
    );
    const up = await upload(client, fit.fit, startTime);
    const activityId = up.activityId;
    if (activityId != null) {
      await rename(client, activityId, pl.title ?? "");
      if (opts.descriptionEnabled !== false) {
        await describe(
          client,
          activityId,
          generateDescription(workout, fit.calories, fit.avg_hr),
        );
      }
    }
    await completePending(
      hevyId,
      {
        garminActivityId: activityId != null ? String(activityId) : null,
        title: pl.title ?? "",
        calories: fit.calories,
        avgHr: fit.avg_hr,
        syncMethod: "upload",
      },
      sql,
    );
    return { status: "synced", garminActivityId: activityId ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updatePending(hevyId, { phase: "processing", last_error: message }, sql);
    return { status: "error", garminActivityId: null, error: message };
  }
}
