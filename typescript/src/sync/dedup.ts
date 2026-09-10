/**
 * Pure dedup decision logic — the SAFE half of the sync engine.
 *
 * These functions decide WHICH Hevy workouts still need syncing. They take
 * plain data (a workout list + the sets of already-synced and pending hevy_ids)
 * and return candidates / the next pick. They perform NO IO: no store, no Hevy,
 * and crucially no Garmin upload.
 *
 * The three-layer never-duplicate concept maps onto the ledger as:
 *   Layer 1 (already resolved): a terminal `synced_workouts` row exists
 *            (status success/manual/skipped) → excluded via `syncedIds`.
 *   Layer 2 (in flight): a `pending_uploads` row exists (an upload was claimed
 *            or is mid-flight) → excluded via `pendingIds`, so we never
 *            double-claim / double-upload the same workout.
 *   Layer 3 (Garmin 409 on duplicate FIT) lives in the engine's upload path and
 *            is out of scope here; the pure layer only encodes layers 1 and 2.
 *
 * "Skip if synced OR pending" is the single rule these functions enforce.
 */
import type { DedupWorkout } from "./types";

export type { DedupWorkout };

/** True when a workout is NOT yet resolved and NOT in flight. Pure predicate. */
export function isUnsynced(
  workout: DedupWorkout,
  syncedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): boolean {
  const id = workout.id;
  if (!id) return false;
  return !syncedIds.has(id) && !pendingIds.has(id);
}

/** Filter to the workouts still needing a sync. Input order preserved. Pure. */
export function filterUnsynced(
  workouts: readonly DedupWorkout[],
  syncedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): DedupWorkout[] {
  return workouts.filter((w) => isUnsynced(w, syncedIds, pendingIds));
}

/** The first unsynced workout in list order, or null. Pure. */
export function pickNextUnsynced(
  workouts: readonly DedupWorkout[],
  syncedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): DedupWorkout | null {
  for (const w of workouts) {
    if (isUnsynced(w, syncedIds, pendingIds)) return w;
  }
  return null;
}

/** A full preview of the dedup decision over a workout list. Pure. */
export interface DedupSummary {
  totalHevy: number;
  syncedCount: number;
  pendingCount: number;
  remaining: number;
  candidates: DedupWorkout[];
  nextUnsynced: DedupWorkout | null;
}

/**
 * Compute the full dedup decision in one pass. `syncedCount`/`pendingCount`
 * reflect how many of THESE workouts are already resolved / in flight, so the
 * numbers add up against `totalHevy`. Pure — feeds a preview route.
 */
export function summarizeDedup(
  workouts: readonly DedupWorkout[],
  syncedIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
): DedupSummary {
  const candidates = filterUnsynced(workouts, syncedIds, pendingIds);
  let syncedCount = 0;
  let pendingCount = 0;
  for (const w of workouts) {
    if (!w.id) continue;
    if (syncedIds.has(w.id)) syncedCount++;
    else if (pendingIds.has(w.id)) pendingCount++;
  }
  return {
    totalHevy: workouts.length,
    syncedCount,
    pendingCount,
    remaining: candidates.length,
    candidates,
    nextUnsynced: candidates[0] ?? null,
  };
}
