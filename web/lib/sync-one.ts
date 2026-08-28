/**
 * syncOneWorkout — the LIVE Hevy→Garmin upload engine for the web app.
 *
 * DRY-RUN BY DEFAULT. This is the piece that makes the modern web capable of
 * actually syncing (the rest of the web app only reads). Because a bad upload
 * creates a duplicate Garmin/Strava activity — a hard user constraint — the
 * default is dryRun=true and NO Garmin write and NO DB mutation happen unless
 * the caller explicitly passes { dryRun: false }.
 *
 * The three-layer never-duplicate contract (ported from sync.py):
 *
 *   Layer 1 — already resolved: if a terminal `synced_workouts` row exists for
 *     the workout (isSynced / the dedup id-set), it is SKIPPED. The pure dedup
 *     in lib/dedup already excludes these when picking the next candidate; this
 *     module re-checks the picked workout so a concurrent sync can't slip a
 *     just-synced id through.
 *
 *   Layer 2 — Garmin already has it: BEFORE uploading, findActivityByStartTime
 *     asks Garmin whether an activity already exists at the workout's start
 *     time. If one does, we DO NOT upload (409 prevention) — we match it and
 *     rename/describe the existing activity instead.
 *
 *   Layer 3 — in-flight ledger: claimPending atomically inserts a
 *     pending_uploads row (INSERT ... ON CONFLICT DO NOTHING). If another
 *     process already claimed the workout, our claim loses and we defer, so two
 *     workers never double-upload the same workout.
 *
 * ALL THREE gate the upload. In dryRun mode we run layers 1 and 2 (reads only)
 * to compute the decision, but perform NO claim, NO upload, NO finalize, and NO
 * ledger write.
 */
import {
  isSynced,
  claimPending,
  updatePending,
  deletePending,
  completePending,
  markSynced,
} from "./pending-store";
import { getHevyClient, type HevyWorkout } from "./hevy-sync";
import { filterUnsynced, type DedupWorkout } from "./dedup";
import { loadSyncedIds, loadPendingIds } from "./pending-store";
import {
  getGarminClient,
  findExistingActivity,
  listActivityIds,
  upload,
  rename,
  describe,
} from "./garmin-upload";
import { generateFit, type HevyWorkout as FitWorkout, type FitResult } from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

/** What the dedup gate decided for this workout. */
export type DedupDecision =
  | "would_upload" // fresh: no terminal row, no existing Garmin activity — a real upload
  | "already_synced" // layer 1: terminal synced_workouts row exists — skip
  | "existing_garmin_activity" // layer 2: Garmin already has an activity at this start time — match, do NOT upload
  | "claim_lost" // layer 3: another worker holds the pending claim — deferred
  | "no_candidates" // nothing left to sync
  | "no_start_time"; // workout has no start_time; can't run the layer-2 lookup safely

/** Compact FIT stats surfaced to the caller (no bytes). */
export interface FitStats {
  exercises: number;
  totalSets: number;
  calories: number;
  avgHr: number | null;
  durationS: number;
}

/** Result shape, aligned with the Python sync-one status vocabulary. */
export interface SyncOneResult {
  /** synced | skipped | deferred | dry_run | none | processing | error */
  status: "synced" | "skipped" | "deferred" | "dry_run" | "none" | "processing" | "error";
  dryRun: boolean;
  /** In dry-run: true when a live run WOULD upload a fresh FIT. */
  wouldUpload: boolean;
  dedupDecision: DedupDecision;
  workout: { hevy_id: string; title: string | null; start_time: string | null } | null;
  fitStats: FitStats | null;
  /** The matched/created Garmin activity id, when known. */
  existingGarminActivityId: number | null;
  garminActivityId: number | null;
  /** How many candidates remained after dedup (context for the caller). */
  remaining: number;
  syncMethod: "upload" | "match" | null;
  error: string | null;
}

/** Options controlling syncOneWorkout. dryRun defaults to TRUE (safe). */
export interface SyncOneOptions {
  /** DEFAULT true. When true: NO Garmin write and NO DB mutation happen. */
  dryRun?: boolean;
  /** Injectable Hevy fetch (tests). Defaults to the live Hevy read. */
  fetchWorkouts?: () => Promise<HevyWorkout[]>;
  /** Injectable Garmin client factory (tests). Defaults to getGarminClient. */
  garminClientFactory?: () => Promise<GarminClient>;
  /** Whether to attach a text description on the activity. Default true. */
  descriptionEnabled?: boolean;
  /**
   * Sync a SPECIFIC workout by its Hevy id instead of the next candidate. When
   * set, the workout must still be an unsynced candidate (all three dedup layers
   * still gate the upload); if it is not among the candidates the result is
   * `no_candidates`.
   */
  targetHevyId?: string;
}

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

/** The live Hevy workout fetch used by default (all workouts). */
async function defaultFetchWorkouts(): Promise<HevyWorkout[]> {
  const client = await getHevyClient();
  return (await client.getAllWorkouts()) as HevyWorkout[];
}

/** A candidate workout surfaced to the /api/candidates route. */
export interface CandidateWorkout {
  hevy_id: string;
  title: string | null;
  start_time: string | null;
}

/**
 * The unsynced Hevy workouts (dedup layer 1) — everything that would be a sync
 * candidate. READ-ONLY: no Garmin call, no DB write. Injectable Hevy fetch for
 * tests.
 */
export async function listCandidates(
  sql: Sql,
  opts: { fetchWorkouts?: () => Promise<HevyWorkout[]> } = {},
): Promise<CandidateWorkout[]> {
  const fetchWorkouts = opts.fetchWorkouts ?? defaultFetchWorkouts;
  const workouts = (await fetchWorkouts()) as DedupWorkout[];
  const [syncedIds, pendingIds] = await Promise.all([loadSyncedIds(sql), loadPendingIds(sql)]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  return candidates.map((c) => ({
    hevy_id: String(c.id),
    title: (c.title as string | null) ?? null,
    start_time: (c.start_time as string | null) ?? null,
  }));
}

/**
 * Text description for a synced gym workout. Ported from garmin.py
 * generate_description so the web upload and the Python pipeline produce the
 * same body. Pure/local — builds a string, no network.
 */
export function generateDescription(
  workout: Record<string, unknown>,
  calories: number | null,
  avgHr: number | null,
): string {
  const lines: string[] = [];
  const title = (workout.title as string) || "Workout";
  const start = (workout.start_time as string) || (workout.startTime as string) || "";
  const end = (workout.end_time as string) || (workout.endTime as string) || "";
  let durationS = 0;
  if (start && end) {
    const t0 = Date.parse(start.replace(" ", "T"));
    const t1 = Date.parse(end.replace(" ", "T"));
    if (!Number.isNaN(t0) && !Number.isNaN(t1)) durationS = Math.floor((t1 - t0) / 1000);
  }

  lines.push(`🏋️ ${title}`);
  if (durationS > 0) lines.push(`⏱️ ${Math.floor(durationS / 60)} min`);
  if (calories) lines.push(`🔥 ${calories} kcal`);
  if (avgHr) lines.push(`❤️ avg ${avgHr} bpm`);

  const exercises = (workout.exercises as Array<Record<string, unknown>>) || [];
  if (exercises.length) {
    lines.push("");
    for (const ex of exercises) {
      const name = (ex.title as string) || (ex.name as string) || "Unknown";
      const allSets = (ex.sets as Array<Record<string, unknown>>) || [];
      const normal = allSets.filter((s) => s.type === "normal");
      const warmup = allSets.filter((s) => s.type === "warmup");
      if (normal.length) {
        const nLabel = normal.length === 1 ? "set" : "sets";
        const hasDistance = normal.some((s) => s.distance_meters);
        const hasDuration = normal.some((s) => s.duration_seconds);
        const hasWeight = normal.some((s) => s.weight_kg || s.weight);
        if (hasDistance || (hasDuration && !hasWeight)) {
          const totalDist = normal.reduce((a, s) => a + (Number(s.distance_meters) || 0), 0);
          const totalDur = normal.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
          const parts = [`${normal.length} ${nLabel}`];
          if (totalDist > 0) parts.push(`${(totalDist / 1000).toFixed(1)}km`);
          if (totalDur > 0) parts.push(`${Math.floor(totalDur / 60)}min`);
          lines.push(`• ${name}: ${parts.join(" · ")}`);
        } else {
          const weights = normal
            .map((s) => (s.weight_kg ?? s.weight) as number | undefined)
            .filter((w): w is number => w != null);
          const reps = normal
            .map((s) => s.reps as number | undefined)
            .filter((r): r is number => r != null);
          const topWeight = weights.length ? Math.max(...weights) : 0;
          const topReps = reps.length ? Math.max(...reps) : 0;
          lines.push(`• ${name}: ${normal.length} ${nLabel} · ${topWeight.toFixed(1)}kg × ${topReps}`);
        }
      } else if (warmup.length) {
        const sLabel = warmup.length === 1 ? "set" : "sets";
        lines.push(`• ${name}: ${warmup.length} warmup ${sLabel}`);
      }
    }
  }

  lines.push("\n— synced by hevy2garmin");
  return lines.join("\n");
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
 * Sync the single next unsynced Hevy workout to Garmin.
 *
 * DEFAULT dryRun=true → computes the decision (fetch next unsynced, generate the
 * FIT, run layers 1 & 2) and returns { wouldUpload, workout, fitStats,
 * dedupDecision, existingGarminActivityId } WITHOUT any Garmin write or DB
 * mutation. Only when dryRun=false does it claim → upload → finalize → mark
 * synced.
 */
export async function syncOneWorkout(
  sql: Sql,
  options: SyncOneOptions = {},
): Promise<SyncOneResult> {
  const dryRun = options.dryRun ?? true; // SAFE DEFAULT
  const descriptionEnabled = options.descriptionEnabled ?? true;
  const targetHevyId = options.targetHevyId;

  // 1) Fetch the Hevy workout list + the dedup id-sets, then pick the next
  //    unsynced candidate (dedup layer 1, pure). Reads only.
  const fetchWorkouts = options.fetchWorkouts ?? defaultFetchWorkouts;

  const workouts = (await fetchWorkouts()) as DedupWorkout[];
  const [syncedIds, pendingIds] = await Promise.all([
    loadSyncedIds(sql),
    loadPendingIds(sql),
  ]);
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  const remaining = candidates.length;
  // Target a specific workout when asked; otherwise take the next candidate.
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
  if (await isSynced(wid, sql)) {
    return {
      ...emptyResult(dryRun, "already_synced", remaining),
      status: "skipped",
      workout: workoutView(workout),
    };
  }

  // 2) Generate the FIT (pure/in-memory; the package returns bytes + stats).
  //    No IO, no upload. Runs in dry-run too, so the preview shows real stats.
  const fitResult = generateFit(workout as unknown as FitWorkout, null);
  const fitStats = fitStatsOf(fitResult);

  // Without a start_time we cannot run the layer-2 lookup, so we refuse to
  // upload rather than risk a duplicate. (The Python path also keys dedup on
  // start_time.)
  if (!startTime) {
    return {
      ...emptyResult(dryRun, "no_start_time", remaining),
      status: dryRun ? "dry_run" : "deferred",
      wouldUpload: false,
      workout: workoutView(workout),
      fitStats,
    };
  }

  // 3) Layer 2 — ask Garmin whether an activity already exists at this start
  //    time (409 prevention). This is a READ; it runs in dry-run too so the
  //    preview reflects the real decision.
  const garminClientFactory = options.garminClientFactory ?? (() => getGarminClient());
  const client = await garminClientFactory();
  const existingId = await findExistingActivity(client, startTime);

  if (existingId) {
    // Garmin already has this workout. NEVER upload — match it. In a live run
    // we rename/describe the existing activity and record a terminal row; in
    // dry-run we report the match and touch nothing.
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
    await rename(client, existingId, title);
    if (descriptionEnabled) {
      await describe(
        client,
        existingId,
        generateDescription(workout, fitStats.calories, fitStats.avgHr),
      );
    }
    await markSynced(wid, {
      garminActivityId: String(existingId),
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload_fallback",
    }, sql);
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

  // 4) Fresh workout — a real upload WOULD happen. In dry-run STOP HERE: no
  //    claim, no upload, no finalize, no ledger write.
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

  // Layer 3 — atomically claim the workout in pending_uploads. If we lose the
  // race, another worker owns it; defer.
  const payload = {
    workout,
    title,
    calories: fitStats.calories,
    avg_hr: fitStats.avgHr,
    hevy_updated_at: (workout.updated_at as string | null) ?? null,
    sync_method: "upload",
  };
  const claimed = await claimPending(wid, payload, sql);
  if (!claimed) {
    return {
      ...emptyResult(false, "claim_lost", remaining),
      status: "deferred",
      workout: workoutView(workout),
      fitStats,
    };
  }

  try {
    const preUploadIds = await listActivityIds(client);
    await updatePending(
      wid,
      { phase: "processing", attempt_count: 1, pre_upload_ids: preUploadIds },
      sql,
    );

    const uploadResult = await upload(client, fitResult.fit, startTime, {
      excludeActivityIds: preUploadIds,
    });
    const activityId = uploadResult.activityId;
    const uploadId = uploadResult.uploadId;

    // Persist Garmin's upload identifier before any follow-up mutation. If the
    // response was accepted but the activity is not discoverable yet, keep the
    // claim in-flight rather than marking the workout complete with a null ID.
    await updatePending(
      wid,
      {
        phase: activityId != null ? "finalizing" : "processing",
        next_step: activityId != null ? "rename" : "resolve_activity",
        upload_id: uploadId != null ? String(uploadId) : null,
        garmin_activity_id: activityId != null ? String(activityId) : null,
        last_error:
          activityId != null
            ? null
            : "Upload accepted but Garmin activity ID is not resolved yet",
      },
      sql,
    );

    if (activityId == null) {
      return {
        status: "processing",
        dryRun: false,
        wouldUpload: true,
        dedupDecision: "would_upload",
        workout: workoutView(workout),
        fitStats,
        existingGarminActivityId: null,
        garminActivityId: null,
        remaining,
        syncMethod: "upload",
        error: "Upload accepted but Garmin activity ID is not resolved yet; pending state retained.",
      };
    }

    // Finalize: rename + describe, then write the terminal success row and
    // clear the pending claim.
    await rename(client, activityId, title);
    if (descriptionEnabled) {
      await describe(
        client,
        activityId,
        generateDescription(workout, fitStats.calories, fitStats.avgHr),
      );
    }
    await completePending(wid, {
      garminActivityId: activityId != null ? String(activityId) : null,
      title,
      calories: fitStats.calories,
      avgHr: fitStats.avgHr,
      hevyUpdatedAt: (workout.updated_at as string | null) ?? null,
      syncMethod: "upload",
    }, sql);

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
    // 'processing' with the error (mirrors sync.py) rather than deleting it, so
    // it is never blindly re-uploaded — reconciliation resolves it later.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await updatePending(wid, { phase: "processing", last_error: message.slice(0, 1000) }, sql);
    } catch {
      // If even the checkpoint write fails, drop the claim so the workout can
      // be re-evaluated rather than being wedged in a bad state.
      await deletePending(wid, sql).catch(() => {});
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
