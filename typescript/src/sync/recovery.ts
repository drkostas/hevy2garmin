/**
 * Recovery for stuck in-flight uploads — the counterpart to syncOneWorkout for
 * a SPECIFIC pending workout rather than the next candidate.
 *
 *   reconcile — a Garmin READ: check whether Garmin already has an activity at
 *     the workout's start time. If it does, the earlier attempt actually
 *     landed, so complete the pending as a matched success (no re-upload).
 *     Otherwise leave the pending in place and record that nothing was found.
 *
 *   retry — reconcile first (never double-upload), and only if Garmin still has
 *     nothing, regenerate the FIT from the stored payload and re-upload, then
 *     finalize. A Garmin WRITE — the host gates it behind auth + confirmation.
 */
import { generateFit, type HevyWorkout as FitWorkout } from "../fit";
import { generateDescription } from "./description";
import type { SyncDeps } from "./gateway";
import type { PendingRecord, RecoveryOptions, RecoveryResult } from "./types";

interface StoredPayload {
  workout?: Record<string, unknown>;
  title?: string;
  calories?: number;
  avg_hr?: number | null;
}

function payloadOf(pending: PendingRecord): StoredPayload {
  const p = pending.payload;
  return p && typeof p === "object" ? (p as StoredPayload) : {};
}

function startTimeOf(workout: Record<string, unknown> | undefined): string | null {
  const s = workout?.start_time;
  return typeof s === "string" && s ? s : null;
}

type RecoveryDeps = Pick<SyncDeps, "store" | "gateway">;

/** Complete a pending as a matched Garmin activity (no upload). */
async function completeMatched(deps: RecoveryDeps, hevyId: string, pl: StoredPayload, activityId: number): Promise<void> {
  await deps.store.completePending(hevyId, {
    garminActivityId: String(activityId),
    title: pl.title ?? "",
    calories: pl.calories ?? null,
    avgHr: pl.avg_hr ?? null,
    syncMethod: "match",
  });
}

export async function reconcilePending(deps: RecoveryDeps, hevyId: string): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const startTime = startTimeOf(pl.workout);
  if (!startTime) return { status: "no_payload", garminActivityId: null, error: null };

  const gateway = await deps.gateway();
  const existing = await gateway.findExistingActivity(startTime);
  if (existing != null) {
    await completeMatched(deps, hevyId, pl, existing);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }
  await deps.store.updatePending(hevyId, { last_error: "reconcile: no matching Garmin activity" });
  return { status: "no_activity", garminActivityId: null, error: null };
}

export async function retryPending(
  deps: RecoveryDeps,
  hevyId: string,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const pending = await deps.store.getPending(hevyId);
  if (!pending) return { status: "not_found", garminActivityId: null, error: null };
  const pl = payloadOf(pending);
  const workout = pl.workout;
  const startTime = startTimeOf(workout);
  if (!workout || !startTime) return { status: "no_payload", garminActivityId: null, error: null };

  const gateway = await deps.gateway();

  // Never double-upload: if Garmin already has it, complete as matched.
  const existing = await gateway.findExistingActivity(startTime);
  if (existing != null) {
    await completeMatched(deps, hevyId, pl, existing);
    return { status: "reconciled_synced", garminActivityId: existing, error: null };
  }

  try {
    const fit = generateFit(workout as unknown as FitWorkout, null);
    await deps.store.updatePending(hevyId, {
      phase: "processing",
      attempt_count: (pending.attempt_count ?? 0) + 1,
      last_error: null,
    });
    const up = await gateway.upload(fit.fit, startTime);
    const activityId = up.activityId;
    if (activityId != null) {
      await gateway.rename(activityId, pl.title ?? "");
      if (opts.descriptionEnabled !== false) {
        await gateway.describe(activityId, generateDescription(workout, fit.calories, fit.avg_hr));
      }
    }
    await deps.store.completePending(hevyId, {
      garminActivityId: activityId != null ? String(activityId) : null,
      title: pl.title ?? "",
      calories: fit.calories,
      avgHr: fit.avg_hr,
      syncMethod: "upload",
    });
    return { status: "synced", garminActivityId: activityId ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.updatePending(hevyId, { phase: "processing", last_error: message });
    return { status: "error", garminActivityId: null, error: message };
  }
}
