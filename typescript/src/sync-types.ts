/**
 * Sync orchestration types — state machine, results, durable checkpoints.
 * Ported from Python src/hevy2garmin/sync.py + syncstate.py + merge.py.
 */

/**
 * Outcome of syncing a single Hevy workout.
 * Maps to Python SyncOneResult.
 */
export interface SyncOneResult {
  status:
    | "synced"
    | "dry_run"
    | "deferred"
    | "merge_pending"
    | "processing"
    | "needs_review"
    | "failed";
  activityId?: number | null;
  syncMethod?: string;
  merged?: boolean;
  mergeFallback?: boolean;
  calories?: number | null;
  avgHr?: number | null;
  noHr?: boolean;
}

/**
 * Durable sync checkpoint for a Hevy workout.
 * Persisted to DB; survives crashes and retries.
 * Mirrors Python pending workout record.
 */
export interface PendingWorkout {
  hevyId: string;
  phase: "initial" | "processing" | "finalizing" | "needs_review" | "failed" | "synced";
  nextStep?: string; // "rename" | "description" | "delete" | "commit"
  garminActivityId?: string;
  watchActivityId?: string;
  uploadId?: string;
  preUploadIds?: number[];
  payload?: Record<string, unknown>;
  lastError?: string;
  attemptCount?: number;
  deleteAttemptCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
  resolutionSource?: "upload_id" | "snapshot" | null;
}

/**
 * Result of a full sync run (multiple workouts).
 */
export interface SyncRunResult {
  synced: number;
  deferred: number;
  mergedPending: number;
  processing: number;
  needsReview: number;
  failed: number;
  errors?: string[];
}

/**
 * Grace period configuration — prevents re-syncing within N minutes of workout end.
 */
export interface GracePeriodConfig {
  minutes: number;
}

/**
 * Cooldown configuration — batches uploads, rate-limits APIs.
 */
export interface CooldownConfig {
  minIntervalSeconds: number;
  maxBatchSize?: number;
}

/**
 * HR fusion configuration — merge HR from Hevy + Garmin + watch.
 */
export interface HRFusionConfig {
  enableFusion: boolean;
  sources: ("hevy" | "garmin" | "watch")[];
  fallbackOrder: ("hevy" | "garmin" | "watch")[];
}

/**
 * Merge mode — how to reconcile conflicting workout versions.
 */
export type MergeMode = "replace" | "merge" | "describe" | "prompt";

/**
 * Sync orchestration configuration.
 */
export interface SyncConfig {
  gracePeriod: GracePeriodConfig;
  cooldown: CooldownConfig;
  hrFusion: HRFusionConfig;
  mergeMode: MergeMode;
  dryRun?: boolean;
}

/**
 * Sync log entry (diagnostic record).
 */
export interface SyncLogEntry {
  timestamp: Date;
  trigger: "manual" | "cron" | "auto-sync" | "routine";
  synced: number;
  deferred: number;
  failed: number;
  errors?: string[];
}
