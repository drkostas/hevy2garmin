/**
 * Route-facing recovery for a stuck pending upload. The logic (reconcile →
 * match, never double-upload; retry → reconcile first, then re-upload) lives in
 * the `hevy2garmin` package; this binds it to the app's store and Garmin client
 * and keeps the `(hevyId, opts, sql)` signature the routes call.
 */
import {
  reconcilePending as engineReconcilePending,
  retryPending as engineRetryPending,
  type RecoveryOptions,
} from "hevy2garmin";
import { getDb } from "./db";
import type { Sql } from "./pending-store";
import { buildSyncDeps } from "./sync-one";

export type { RecoveryOptions, RecoveryResult } from "hevy2garmin";

export function reconcilePending(hevyId: string, _opts: RecoveryOptions = {}, sql: Sql = getDb()) {
  return engineReconcilePending(buildSyncDeps(sql), hevyId);
}

export function retryPending(hevyId: string, opts: RecoveryOptions = {}, sql: Sql = getDb()) {
  return engineRetryPending(buildSyncDeps(sql), hevyId, opts);
}
