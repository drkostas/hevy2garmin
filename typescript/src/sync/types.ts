/**
 * Sync orchestration types — shared by every consumer of the engine (the web
 * dashboard, soma, any fork). Field names are snake_case where they mirror a
 * database row or a Hevy/Garmin payload, so the Postgres store and the Python
 * pipeline read the same shapes without a mapping layer.
 */

/** Minimal shape a Hevy workout needs for dedup + upload. `id` is the Hevy id (PK). */
export interface DedupWorkout {
  id: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

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

/** Result of syncing one workout, aligned with the Python status vocabulary. */
export interface SyncOneResult {
  status: "synced" | "skipped" | "deferred" | "dry_run" | "none" | "error";
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

/** A candidate workout surfaced to a candidates listing. */
export interface CandidateWorkout {
  hevy_id: string;
  title: string | null;
  start_time: string | null;
}

/** Terminal statuses stored in synced_workouts.status. */
export type TerminalStatus = "success" | "manual" | "skipped";

/** An in-flight durable checkpoint (a pending_uploads row). */
export interface PendingRecord {
  hevy_id: string;
  phase: string;
  next_step: string | null;
  upload_id: string | null;
  garmin_activity_id: string | null;
  watch_activity_id: string | null;
  pre_upload_ids: unknown[];
  payload: Record<string, unknown>;
  resolution_source: string | null;
  attempt_count: number;
  delete_attempt_count: number;
  last_error: string | null;
  locked_until: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Fields a checkpoint update may change (mirrors the Python allow-list). */
export interface PendingUpdate {
  phase?: string;
  next_step?: string | null;
  upload_id?: string | null;
  garmin_activity_id?: string | null;
  watch_activity_id?: string | null;
  pre_upload_ids?: unknown[];
  payload?: Record<string, unknown>;
  resolution_source?: string | null;
  attempt_count?: number;
  delete_attempt_count?: number;
  last_error?: string | null;
  locked_until?: string | null;
}

/** Fields written when recording a successful upload or match. */
export interface MarkSyncedOpts {
  garminActivityId?: string | null;
  title?: string | null;
  calories?: number | null;
  avgHr?: number | null;
  hevyUpdatedAt?: string | null;
  syncMethod?: string;
}

/** Options controlling syncOneWorkout. dryRun defaults to TRUE (safe). */
export interface SyncOneOptions {
  /** DEFAULT true. When true: NO Garmin write and NO store mutation happen. */
  dryRun?: boolean;
  /** Whether to attach a text description on the activity. Default true. */
  descriptionEnabled?: boolean;
  /**
   * Sync a SPECIFIC workout by its Hevy id instead of the next candidate. It
   * must still be an unsynced candidate (all three dedup layers still gate the
   * upload); if it is not among the candidates the result is `no_candidates`.
   */
  targetHevyId?: string;
}

/** Options for reconcile/retry. */
export interface RecoveryOptions {
  /** Attach a text description on a retried upload. Default true. */
  descriptionEnabled?: boolean;
}

/** Result of reconcile/retry on a specific pending workout. */
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
