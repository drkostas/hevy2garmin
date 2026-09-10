/**
 * syncOneWorkout — the Hevy→Garmin upload engine, host-agnostic.
 *
 * DRY-RUN BY DEFAULT. Because a bad upload creates a duplicate Garmin/Strava
 * activity — a hard user constraint — the default is dryRun=true and NO Garmin
 * write and NO store mutation happen unless the caller passes { dryRun: false }.
 *
 * The three-layer never-duplicate contract:
 *
 *   Layer 1 — already resolved: a terminal `synced_workouts` row exists for
 *     the workout → SKIPPED. The pure dedup excludes these when picking the
 *     next candidate; this module re-checks the picked workout against the live
 *     ledger so a concurrent sync can't slip a just-synced id through.
 *
 *   Layer 2 — Garmin already has it: BEFORE uploading, the gateway asks Garmin
 *     whether an activity already exists at the workout's start time. If one
 *     does, we DO NOT upload (409 prevention) — we match it and rename/describe
 *     the existing activity instead.
 *
 *   Layer 3 — in-flight ledger: claimPending atomically inserts a
 *     pending_uploads row. If another process already claimed the workout, our
 *     claim loses and we defer, so two workers never double-upload.
 *
 * ALL THREE gate the upload. In dryRun mode layers 1 and 2 run (reads only) to
 * compute the decision, but NO claim, NO upload, NO finalize, NO ledger write.
 *
 * All IO goes through `SyncDeps`: the store, a lazily built Garmin gateway, and
 * the Hevy fetch. The engine itself is pure orchestration.
 */
import { generateFit, type FitResult, type HevyWorkout as FitWorkout } from "../fit";
import { filterUnsynced } from "./dedup";
import { generateDescription } from "./description";
import type { SyncDeps } from "./gateway";
import type {
  CandidateWorkout,
  DedupDecision,
  DedupWorkout,
  FitStats,
  SyncOneOptions,
  SyncOneResult,
} from "./types";

function fitStatsOf(r: FitResult): FitStats {
  return {
    exercises: r.exercises,
    totalSets: r.total_sets,
    calories: r.calories,
    avgHr: r.avg_hr,
    durationS: r.duration_s,
  };
}

function workoutView(w: DedupWorkout): SyncOneResult["workout"] {
  return {
    hevy_id: w.id,
    title: (w.title as string | null) ?? null,
    start_time: (w.start_time as string | null) ?? null,
  };
}

/** Build the "nothing to do" result. */
function emptyResult(dryRun: boolean, decision: DedupDecision, remaining: number): SyncOneResult {
  return {
    status: "none",
    dryRun,
    wouldUpload: false,
    dedupDecision: decision,
    workout: null,
    fitStats: null,
    existingGarminActivityId: null,
    garminActivityId: null,
    remaining,
    syncMethod: null,
    error: null,
  };
}

/**
 * The unsynced Hevy workouts (dedup layer 1) — everything that would be a sync
 * candidate. READ-ONLY: no Garmin call, no store write.
 */
export async function listCandidates(deps: Pick<SyncDeps, "store" | "fetchWorkouts">): Promise<CandidateWorkout[]> {
  const workouts = await deps.fetchWorkouts();
  const [syncedIds, pendingIds] = await Promise.all([deps.store.loadSyncedIds(), deps.store.loadPendingIds()]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  return candidates.map((c) => ({
    hevy_id: String(c.id),
    title: (c.title as string | null) ?? null,
    start_time: (c.start_time as string | null) ?? null,
  }));
}

/**
 * Sync the single next unsynced Hevy workout to Garmin.
 *
 * DEFAULT dryRun=true → computes the decision (next unsynced, FIT, layers 1 & 2)
 * and returns it WITHOUT any Garmin write or store mutation. Only when
 * dryRun=false does it claim → upload → finalize → mark synced.
 */
export async function syncOneWorkout(deps: SyncDeps, options: SyncOneOptions = {}): Promise<SyncOneResult> {
  const dryRun = options.dryRun ?? true; // SAFE DEFAULT
  const descriptionEnabled = options.descriptionEnabled ?? true;
  const targetHevyId = options.targetHevyId;
  const { store } = deps;

  // 1) Fetch the Hevy list + the dedup id-sets, then pick the next unsynced
  //    candidate (dedup layer 1, pure). Reads only.
  const workouts = await deps.fetchWorkouts();
  const [syncedIds, pendingIds] = await Promise.all([store.loadSyncedIds(), store.loadPendingIds()]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  const remaining = candidates.length;
  const workout = targetHevyId
    ? candidates.find((c) => String(c.id) === targetHevyId) ?? null
    : candidates[0] ?? null;

  if (!workout) {
    return emptyResult(dryRun, "no_candidates", 0);
  }

  const wid = workout.id;
  const title = (workout.title as string | null) ?? "Workout";
  const startTime = (workout.start_time as string | null) ?? null;

  // Re-confirm layer 1 against the live ledger for the picked id (guards a
  // concurrent sync that resolved this id after the id-set snapshot).
  if (await store.isSynced(wid)) {
    return {
      ...emptyResult(dryRun, "already_synced", remaining),
      status: "skipped",
      workout: workoutView(workout),
    };
  }

  // Without a start_time we cannot run the layer-2 lookup, so we refuse to
  // upload rather than risk a duplicate. Checked BEFORE generating the FIT:
  // the encoder needs the same timestamps, and there is nothing to preview.
  if (!startTime) {
    return {
      ...emptyResult(dryRun, "no_start_time", remaining),
      status: dryRun ? "dry_run" : "deferred",
      wouldUpload: false,
      workout: workoutView(workout),
    };
  }

  // 2) Generate the FIT (pure/in-memory). Runs in dry-run too, so a preview
  //    shows real stats. No IO, no upload.
  const fitResult = generateFit(workout as unknown as FitWorkout, null);
  const fitStats = fitStatsOf(fitResult);

  // 3) Layer 2 — ask Garmin whether an activity already exists at this start
  //    time (409 prevention). A READ; runs in dry-run too so the preview
  //    reflects the real decision. The gateway is built lazily, here.
  const gateway = await deps.gateway();
  const existingId = await gateway.findExistingActivity(startTime);

  if (existingId) {
    // Garmin already has this workout. NEVER upload — match it.
    if (dryRun) {
      return {
        status: "dry_run",
        dryRun: true,
        wouldUpload: false,
        dedupDecision: "existing_garmin_activity",
        workout: workoutView(workout),
        fitStats,
        existingGarminActivityId: existingId,
        garminActivityId: existingId,
        remaining,
        syncMethod: "match",
        error: null,
      };
    }
    await gateway.rename(existingId, title);
    if (descriptionEnabled) {
      await gateway.describe(existingId, generateDescription(workout, fitStats.calories, fitStats.avgHr));
    }
    await store.markSynced(wid, {
      garminActivityId: String(existingId),
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload_fallback",
    });
    return {
      status: "synced",
      dryRun: false,
      wouldUpload: false,
      dedupDecision: "existing_garmin_activity",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: existingId,
      garminActivityId: existingId,
      remaining,
      syncMethod: "match",
      error: null,
    };
  }

  // 4) Fresh workout — a real upload WOULD happen. In dry-run STOP HERE.
  if (dryRun) {
    return {
      status: "dry_run",
      dryRun: true,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: null,
      remaining,
      syncMethod: "upload",
      error: null,
    };
  }

  // ---- LIVE PATH (dryRun === false only) ----

  // Layer 3 — atomically claim the workout. If we lose the race, another
  // worker owns it; defer.
  const payload = {
    workout,
    title,
    calories: fitStats.calories,
    avg_hr: fitStats.avgHr,
    hevy_updated_at: (workout.updated_at as string | null) ?? null,
    sync_method: "upload",
  };
  const claimed = await store.claimPending(wid, payload);
  if (!claimed) {
    return {
      ...emptyResult(false, "claim_lost", remaining),
      status: "deferred",
      workout: workoutView(workout),
      fitStats,
    };
  }

  try {
    await store.updatePending(wid, { phase: "processing", attempt_count: 1 });

    const uploadResult = await gateway.upload(fitResult.fit, startTime);
    const activityId = uploadResult.activityId;

    // Finalize: rename + describe, then write the terminal row and clear the claim.
    if (activityId) {
      await gateway.rename(activityId, title);
      if (descriptionEnabled) {
        await gateway.describe(activityId, generateDescription(workout, fitStats.calories, fitStats.avgHr));
      }
    }
    await store.completePending(wid, {
      garminActivityId: activityId != null ? String(activityId) : null,
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload",
    });

    return {
      status: "synced",
      dryRun: false,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: activityId,
      remaining,
      syncMethod: "upload",
      error: null,
    };
  } catch (err) {
    // The upload may or may not have reached Garmin. Park the pending row in
    // 'processing' with the error rather than deleting it, so it is never
    // blindly re-uploaded — reconciliation resolves it later.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await store.updatePending(wid, { phase: "processing", last_error: message.slice(0, 1000) });
    } catch {
      // If even the checkpoint write fails, drop the claim so the workout can
      // be re-evaluated rather than being wedged in a bad state.
      await store.deletePending(wid).catch(() => {});
    }
    return {
      status: "error",
      dryRun: false,
      wouldUpload: true,
      dedupDecision: "would_upload",
      workout: workoutView(workout),
      fitStats,
      existingGarminActivityId: null,
      garminActivityId: null,
      remaining,
      syncMethod: "upload",
      error: message,
    };
  }
}
