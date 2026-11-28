/**
 * Route-facing sync entry points. The engine itself — dedup layers, dry-run
 * default, merge, HR fusion, claim → upload → finalize — lives in the
 * `hevy2garmin` package and is shared with soma. This module only binds it to
 * this app's IO:
 *
 *   store        → Postgres, via ./pending-store (postgresSyncStore)
 *   gateway      → the app's healed Garmin client (getGarminClient), lazily
 *   fetchWorkouts→ the app's Hevy key resolution (fetchAllWorkouts)
 *   hr           → ./hr-store (the hr_cache table and the durable backup)
 *   settings     → ./sync-settings (what the user saved on the Settings page)
 *   photos       → ./workout-photos, after the engine call (#237)
 *
 * The settings are the point of this module now. The engine can merge and fuse
 * heart rate, and it only does either when told to, so without this the Settings
 * page would go on saving values that changed nothing (#565).
 *
 * Signatures keep the `(sql, options)` shape every route already calls.
 * dryRun still defaults to TRUE inside the engine; nothing here overrides it.
 */
import {
  garminGateway,
  intervalsCleanupHook,
  listCandidates as engineListCandidates,
  syncOneWorkout as engineSyncOneWorkout,
  type GarminGateway,
  type SyncDeps,
  type SyncOneOptions as EngineSyncOneOptions,
} from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { fetchAllWorkouts, type HevyWorkout } from "./hevy-sync";
import { hrDepsFor, type HrWorkout } from "./hr-store";
import { postgresSyncStore } from "./sync-store";
import { loadSyncSettings, loadSyncStartDate } from "./sync-settings";
import { parseStartDate, withinSyncWindow } from "./sync-window";
import type { Sql } from "./pending-store";
import { withGarminLocalDates } from "./garmin-local-dates";
import { photoActivityId, syncWorkoutPhotos } from "./workout-photos";

export type {
  CandidateWorkout,
  DedupDecision,
  FitStats,
  SyncOneResult,
} from "hevy2garmin";
export { generateDescription } from "hevy2garmin";

export interface SyncOneOptions extends EngineSyncOneOptions {
  /** Test seam: replace the Hevy fetch. Default: fetchAllWorkouts(). */
  fetchWorkouts?: () => Promise<HevyWorkout[]>;
  /** Test seam: replace the Garmin client. Default: getGarminClient(). */
  garminClientFactory?: () => Promise<GarminClient>;
}

/** Bind the engine to this app's store, Garmin client, Hevy fetch and HR storage. */
export function buildSyncDeps(sql: Sql, options: SyncOneOptions = {}): SyncDeps {
  return bindSync(sql, options).deps;
}

/**
 * The engine's deps, and what the photo step needs from the same run: the
 * workouts as fetched, by id, and the Garmin client the gateway was built on.
 */
function bindSync(sql: Sql, options: SyncOneOptions) {
  const clientFactory = options.garminClientFactory ?? (() => getGarminClient());
  let client: Promise<GarminClient> | null = null;
  const garminClient = () => (client ??= clientFactory());
  let gateway: Promise<GarminGateway> | null = null;
  const fetchWorkouts = options.fetchWorkouts ?? (() => fetchAllWorkouts());

  // The engine asks for a backup by workout id, and rebasing one needs the
  // workout's start and end. The fetch is the only place both are in hand, so
  // the list is kept as it goes past.
  const seen = new Map<string, HrWorkout>();

  const deps: SyncDeps = {
    store: postgresSyncStore(sql),
    // Built once, lazily: the dry-run/no-candidate paths never log in to Garmin.
    gateway: () => (gateway ??= garminClient().then(garminGateway).then(withGarminLocalDates)),
    fetchWorkouts: async () => {
      const all = await fetchWorkouts();
      // Applied HERE, before the engine sees the list, so listCandidates and
      // syncOneWorkout both honour it without being told and without the engine
      // needing a release (#647).
      //
      // Not for a resync. The date chooses which workouts are sync candidates,
      // and a resync's workout is already synced, possibly before the date was
      // set. Hiding it would leave the engine nothing to resync from.
      const startDate =
        options.targetActivityId != null
          ? null
          : parseStartDate(await loadSyncStartDate(sql).catch(() => null));
      const workouts = withinSyncWindow(all, startDate);
      // The HR backup is looked up by id against the FULL list on purpose: a
      // workout outside the window is not a candidate, but one that was synced
      // before the window was set still has heart rate worth finding.
      for (const w of all) {
        const id = String((w as { id?: unknown }).id ?? "");
        if (id) seen.set(id, w as HrWorkout);
      }
      return workouts;
    },
    hr: hrDepsFor(sql, () => seen),
    // A replace deletes the watch's own copy from Garmin, and that copy has
    // usually already reached intervals.icu, where our named upload then
    // arrives as a second one. The hook removes the stale copy. It is null
    // unless both credentials are set, and undefined rather than a no-op
    // function makes the engine skip the step outright for everyone else.
    onWatchActivityDeleted:
      intervalsCleanupHook({
        apiKey: process.env.INTERVALS_API_KEY,
        athleteId: process.env.INTERVALS_ATHLETE_ID,
      }) ?? undefined,
  };
  return { deps, seen, garminClient };
}

/** READ-only: the unsynced Hevy workouts. */
export function listCandidates(sql: Sql, options: SyncOneOptions = {}) {
  return engineListCandidates(buildSyncDeps(sql, options));
}

/**
 * Sync the next unsynced workout (or `options.targetHevyId`). dryRun defaults
 * to true in the engine; pass `{ dryRun: false }` for a real upload.
 *
 * The user's merge and HR settings are read here unless the caller passes its
 * own, so every route gets them without having to remember to.
 */
export async function syncOneWorkout(sql: Sql, options: SyncOneOptions = {}) {
  const { fetchWorkouts: _f, garminClientFactory: _g, ...engineOptions } = options;
  const saved = await loadSyncSettings(sql);
  const { deps, seen, garminClient } = bindSync(sql, options);
  const result = await engineSyncOneWorkout(deps, {
    merge: saved.merge,
    hrFusion: saved.hrFusion,
    descriptionEnabled: saved.descriptionEnabled,
    profile: saved.profile,
    ...engineOptions, // an explicit option still wins, which is what tests rely on
  });

  // The workout's photos, onto the activity it now lives on. After the engine,
  // so its Garmin calls and the photo uploads never interleave, and never able
  // to fail the sync: the step itself does not throw, and this is the backstop.
  const activityId = photoActivityId(result);
  const hevyId = result.workout?.hevy_id;
  const workout = hevyId ? seen.get(hevyId) : undefined;
  if (saved.photos && activityId != null && hevyId && workout) {
    await syncWorkoutPhotos({ sql, hevyId, activityId, workout, client: garminClient }).catch((err) =>
      console.warn(`[photos] workout ${hevyId}: photos skipped: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return result;
}
