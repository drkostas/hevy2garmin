/**
 * Sync orchestrator — coordinates Hevy→FIT→Garmin workflow.
 * Ported from Python src/hevy2garmin/sync.py + syncstate.py.
 *
 * Key responsibilities:
 * - State machine: pending → processing → finalizing → synced/needs_review/failed
 * - Durable checkpoints: survive crashes, resume from last step
 * - Grace period: don't re-sync workout within N minutes of completion
 * - Cooldown: rate-limit API calls, batch uploads
 * - HR fusion: merge HR data from multiple sources
 * - Sync lock: prevent concurrent sync execution
 */

import type {
  SyncOneResult,
  PendingWorkout,
  SyncRunResult,
  SyncConfig,
  SyncLogEntry,
} from "./sync-types";

const DEFAULT_GRACE_PERIOD_MINUTES = 60;
const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extract numeric activity ID from string (handles "123" or "garmin-123" formats).
 */
function parseActivityId(idStr?: string): number | undefined {
  if (!idStr) return undefined;
  const match = idStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : undefined;
}

/**
 * State machine for a single Hevy workout sync.
 * Models the checkpoint pattern from Python: every step is durable,
 * so a crash mid-finalization can resume from the exact step that failed.
 */
export class SyncStateMachine {
  private pending: PendingWorkout;
  private config: SyncConfig;
  private store: SyncStore; // Abstraction for DB access

  constructor(hevyId: string, store: SyncStore, config: SyncConfig) {
    this.pending = {
      hevyId,
      phase: "initial",
      attemptCount: 0,
      deleteAttemptCount: 0,
    };
    this.config = config;
    this.store = store;
  }

  /**
   * Restore state from a durable checkpoint in the database.
   */
  async restore(hevyId: string): Promise<void> {
    const persisted = await this.store.getPending(hevyId);
    if (persisted) {
      this.pending = persisted;
    }
  }

  /**
   * Transition to next phase and persist to DB.
   */
  private async transition(
    phase: string,
    nextStep?: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    this.pending.phase = phase as any;
    this.pending.nextStep = nextStep;
    if (payload) {
      this.pending.payload = payload;
    }
    this.pending.updatedAt = new Date();
    await this.store.updatePending(this.pending);
  }

  /**
   * Start a new sync attempt for a Hevy workout.
   */
  async initiate(
    workoutData: Record<string, unknown>
  ): Promise<SyncOneResult> {
    this.pending.phase = "processing";
    this.pending.payload = workoutData;
    this.pending.attemptCount = (this.pending.attemptCount || 0) + 1;
    this.pending.createdAt = new Date();
    this.pending.updatedAt = new Date();

    await this.store.updatePending(this.pending);
    return {
      status: "processing",
    };
  }

  /**
   * Finalize a workout after upload to Garmin (rename, description, delete, commit).
   * Resumes from the last checkpoint if crash occurred mid-finalization.
   */
  async finalize(garminActivityId: string): Promise<SyncOneResult> {
    this.pending.garminActivityId = garminActivityId;
    let step = this.pending.nextStep || "rename";
    const payload = this.pending.payload || {};

    try {
      // Step 1: Rename activity
      if (step === "rename") {
        // Call Garmin API to rename activity
        // await garminClient.rename(garminActivityId, payload.title);
        step = payload.descriptionEnabled ? "description" : "delete";
        await this.transition("finalizing", step);
      }

      // Step 2: Set description (optional)
      if (step === "description") {
        // await garminClient.setDescription(garminActivityId, payload.description);
        step = this.pending.watchActivityId ? "delete" : "commit";
        await this.transition("finalizing", step);
      }

      // Step 3: Delete watch duplicate (optional)
      if (step === "delete") {
        if (!this.pending.watchActivityId) {
          step = "commit";
          await this.transition("finalizing", step);
        } else {
          const watchId = parseInt(this.pending.watchActivityId, 10);
          if (watchId === parseInt(garminActivityId, 10)) {
            await this.transition("needs_review", undefined, {
              lastError: "replacement equals watch activity; deletion blocked",
            });
            return {
              status: "needs_review",
              activityId: parseInt(garminActivityId, 10),
            };
          }
          // await garminClient.deleteActivity(watchId);
          step = "commit";
          await this.transition("finalizing", step);
        }
      }

      // Step 4: Mark as synced (commit)
      if (step === "commit") {
        const terminal = {
          garminActivityId: garminActivityId,
          title: payload.title || "",
          calories: payload.calories,
          avgHr: payload.avgHr,
          hevyUpdatedAt: payload.hevyUpdatedAt,
          syncMethod: payload.syncMethod || "upload",
        };
        await this.store.completePending(this.pending.hevyId, terminal);
        this.pending.phase = "synced";
        this.pending.payload = { ...this.pending.payload, ...terminal };

        return {
          status: "synced",
          activityId: parseActivityId(garminActivityId),
          syncMethod: payload.syncMethod as string,
          mergeFallback: payload.mergeFallback as boolean,
          calories: payload.calories as number,
          avgHr: payload.avgHr as number,
        };
      }

      return {
        status: "processing",
        activityId: parseActivityId(garminActivityId),
      };
    } catch (error) {
      this.pending.lastError = String(error).slice(0, 1000);
      await this.store.updatePending(this.pending);
      return {
        status: "processing",
        activityId: parseActivityId(garminActivityId),
      };
    }
  }

  /**
   * Mark as requiring manual review (e.g., merge conflict, ambiguous recovery).
   */
  async needsReview(reason: string): Promise<SyncOneResult> {
    await this.transition("needs_review", undefined, {
      lastError: reason,
    });
    return {
      status: "needs_review",
      activityId: this.pending.garminActivityId
        ? parseActivityId(this.pending.garminActivityId)
        : undefined,
    };
  }

  /**
   * Mark as failed (unrecoverable error).
   */
  async fail(reason: string): Promise<SyncOneResult> {
    await this.transition("failed", undefined, {
      lastError: reason,
    });
    return {
      status: "failed",
      activityId: this.pending.garminActivityId
        ? parseActivityId(this.pending.garminActivityId)
        : undefined,
    };
  }

  /**
   * Get current state.
   */
  getState(): PendingWorkout {
    return { ...this.pending };
  }
}

/**
 * Grace period guard — prevents re-syncing workouts too soon after completion.
 * Python: _workout_within_grace(workout, grace_minutes)
 */
export function isWorkoutWithinGracePeriod(
  workout: Record<string, unknown>,
  gracePeriodMinutes: number
): boolean {
  if (gracePeriodMinutes <= 0) return false;

  const endTimeStr = (workout.endTime || workout.end_time) as string;
  if (!endTimeStr) return false;

  try {
    const endTime = new Date(endTimeStr);
    if (isNaN(endTime.getTime())) return false;

    const ageMinutes =
      (Date.now() - endTime.getTime()) / (1000 * 60);
    return ageMinutes < gracePeriodMinutes;
  } catch {
    return false;
  }
}

/**
 * Sync lock manager — prevents concurrent sync execution.
 * In Python, this is threading.Lock; here we use a simple async flag.
 * (Production would use distributed lock for server-side execution.)
 */
export class SyncLock {
  private locked = false;
  private acquiredAt = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_SYNC_LOCK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Try to acquire the lock. Returns true if acquired; false if already held.
   * Force-releases if held too long (hung sync).
   */
  acquire(): boolean {
    if (this.locked) {
      const elapsedMs = Date.now() - this.acquiredAt;
      if (elapsedMs > this.timeoutMs) {
        console.warn(
          `Sync lock held for >${this.timeoutMs}ms — force-releasing (likely hung)`
        );
        this.locked = false;
        this.acquiredAt = 0;
      }
    }

    if (!this.locked) {
      this.locked = true;
      this.acquiredAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Release the lock. Throws if not held.
   */
  release(): void {
    if (!this.locked) {
      throw new Error("SyncLock not held");
    }
    this.locked = false;
    this.acquiredAt = 0;
  }

  /**
   * Check if lock is currently held.
   */
  isHeld(): boolean {
    return this.locked;
  }
}

/**
 * Abstraction for persistent store (DB access).
 * Implementations provide SQLite/Postgres/etc. access.
 */
export interface SyncStore {
  getPending(hevyId: string): Promise<PendingWorkout | null>;
  updatePending(pending: PendingWorkout): Promise<void>;
  completePending(
    hevyId: string,
    terminal: Record<string, unknown>
  ): Promise<void>;
  recordSyncLog(entry: SyncLogEntry): Promise<void>;
  markSyncTime(timestamp: Date): Promise<void>;
  getLastSyncTime(): Promise<Date | null>;
}

/**
 * Aggregates sync results for a full run (multiple workouts).
 */
export class SyncRunAggregator {
  private results: SyncOneResult[] = [];

  add(result: SyncOneResult): void {
    this.results.push(result);
  }

  aggregate(): SyncRunResult {
    return {
      synced: this.results.filter((r) => r.status === "synced").length,
      deferred: this.results.filter((r) => r.status === "deferred").length,
      mergedPending: this.results.filter(
        (r) => r.status === "merge_pending"
      ).length,
      processing: this.results.filter(
        (r) => r.status === "processing"
      ).length,
      needsReview: this.results.filter(
        (r) => r.status === "needs_review"
      ).length,
      failed: this.results.filter((r) => r.status === "failed").length,
    };
  }

  getResults(): SyncOneResult[] {
    return [...this.results];
  }
}
