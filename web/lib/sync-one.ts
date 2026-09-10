/**
 * Route-facing sync entry points. The engine itself — dedup layers, dry-run
 * default, claim → upload → finalize — lives in the `hevy2garmin` package and
 * is shared with soma. This module only binds it to this app's IO:
 *
 *   store        → Postgres, via ./pending-store (postgresSyncStore)
 *   gateway      → the app's healed Garmin client (getGarminClient), lazily
 *   fetchWorkouts→ the app's Hevy key resolution (fetchAllWorkouts)
 *
 * Signatures keep the `(sql, options)` shape every route already calls.
 * dryRun still defaults to TRUE inside the engine; nothing here overrides it.
 */
import {
  garminGateway,
  listCandidates as engineListCandidates,
  syncOneWorkout as engineSyncOneWorkout,
  type GarminGateway,
  type SyncDeps,
  type SyncOneOptions as EngineSyncOneOptions,
} from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { getGarminClient } from "./garmin-upload";
import { fetchAllWorkouts, type HevyWorkout } from "./hevy-sync";
import { postgresSyncStore } from "./sync-store";
import type { Sql } from "./pending-store";

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

/** Bind the engine to this app's store, Garmin client and Hevy fetch. */
export function buildSyncDeps(sql: Sql, options: SyncOneOptions = {}): SyncDeps {
  const clientFactory = options.garminClientFactory ?? (() => getGarminClient());
  let gateway: Promise<GarminGateway> | null = null;
  return {
    store: postgresSyncStore(sql),
    // Built once, lazily: the dry-run/no-candidate paths never log in to Garmin.
    gateway: () => (gateway ??= clientFactory().then(garminGateway)),
    fetchWorkouts: options.fetchWorkouts ?? (() => fetchAllWorkouts()),
  };
}

/** READ-only: the unsynced Hevy workouts. */
export function listCandidates(sql: Sql, options: SyncOneOptions = {}) {
  return engineListCandidates(buildSyncDeps(sql, options));
}

/**
 * Sync the next unsynced workout (or `options.targetHevyId`). dryRun defaults
 * to true in the engine; pass `{ dryRun: false }` for a real upload.
 */
export function syncOneWorkout(sql: Sql, options: SyncOneOptions = {}) {
  const { fetchWorkouts: _f, garminClientFactory: _g, ...engineOptions } = options;
  return engineSyncOneWorkout(buildSyncDeps(sql, options), engineOptions);
}
