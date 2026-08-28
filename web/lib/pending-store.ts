/**
 * Sync-bookkeeping DB helpers — the SAFE half of the sync engine.
 *
 * Every function here reads/writes ONLY the hevy2garmin app's own tables:
 *   - `synced_workouts`  (terminal state: uploaded | manual | skipped)
 *   - `pending_uploads`  (in-flight durable checkpoints)
 * These are local sync bookkeeping, not user-facing platform state. NOTHING in
 * this module calls Garmin, uploads a FIT, or mutates Hevy. `unsync` and
 * `resolveTerminal` only delete/insert the LOCAL ledger row — they never delete
 * the corresponding Garmin activity.
 *
 * The SQL mirrors PostgresDatabase in src/hevy2garmin/db_postgres.py so the
 * TS web app and the Python pipeline agree on the schema and semantics.
 */
import { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

/** Terminal statuses stored in synced_workouts.status. */
export type TerminalStatus = "success" | "manual" | "skipped";

/** A resolved (terminal) row from synced_workouts. */
export interface SyncedRow {
  hevy_id: string;
  garmin_activity_id: string | null;
  title: string | null;
  synced_at: string | null;
  status: string | null;
}

/** An in-flight row from pending_uploads. */
export interface PendingRow {
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

/** Terminal-state tallies, matching db_postgres.get_terminal_counts(). */
export interface TerminalCounts {
  uploaded: number;
  manual: number;
  skipped: number;
  terminal: number;
}

function jsonField<T>(value: unknown, empty: T): T {
  if (value == null) return empty;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return empty;
    }
  }
  return value as T;
}

/** Normalize a raw pending_uploads row into a PendingRow (JSONB parsed). */
function toPending(row: Record<string, unknown>): PendingRow {
  return {
    hevy_id: String(row.hevy_id),
    phase: String(row.phase ?? ""),
    next_step: (row.next_step as string | null) ?? null,
    upload_id: (row.upload_id as string | null) ?? null,
    garmin_activity_id: (row.garmin_activity_id as string | null) ?? null,
    watch_activity_id: (row.watch_activity_id as string | null) ?? null,
    pre_upload_ids: jsonField<unknown[]>(row.pre_upload_ids, []),
    payload: jsonField<Record<string, unknown>>(row.payload, {}),
    resolution_source: (row.resolution_source as string | null) ?? null,
    attempt_count: Number(row.attempt_count ?? 0),
    delete_attempt_count: Number(row.delete_attempt_count ?? 0),
    last_error: (row.last_error as string | null) ?? null,
    locked_until: (row.locked_until as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

/** True when the workout already has a terminal row. Mirrors is_synced(). */
export async function isSynced(hevyId: string, sql: Sql = getDb()): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM synced_workouts WHERE hevy_id = ${hevyId} LIMIT 1`;
  return rows.length > 0;
}

/** COUNT(*) over synced_workouts. Mirrors get_synced_count(). */
export async function getSyncedCount(sql: Sql = getDb()): Promise<number> {
  const rows = await sql`SELECT COUNT(*)::int AS cnt FROM synced_workouts`;
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Terminal-state tallies grouped by status. Mirrors get_terminal_counts():
 * 'success' → uploaded, plus manual + skipped, and their sum as `terminal`.
 */
export async function getTerminalCounts(sql: Sql = getDb()): Promise<TerminalCounts> {
  const rows = await sql`
    SELECT COALESCE(status, 'success') AS status, COUNT(*)::int AS count
    FROM synced_workouts
    GROUP BY COALESCE(status, 'success')
  `;
  const raw: Record<string, number> = {};
  for (const r of rows) raw[String(r.status)] = Number(r.count);
  const uploaded = raw.success ?? 0;
  const manual = raw.manual ?? 0;
  const skipped = raw.skipped ?? 0;
  return { uploaded, manual, skipped, terminal: uploaded + manual + skipped };
}

/** All in-flight pending rows, newest first. Mirrors list_pending(). */
export async function listPending(sql: Sql = getDb()): Promise<PendingRow[]> {
  const rows = await sql`SELECT * FROM pending_uploads ORDER BY created_at DESC`;
  return rows.map((r) => toPending(r as Record<string, unknown>));
}

/** One pending row by id, or null. Mirrors get_pending(). */
export async function getPending(hevyId: string, sql: Sql = getDb()): Promise<PendingRow | null> {
  const rows = await sql`SELECT * FROM pending_uploads WHERE hevy_id = ${hevyId}`;
  const row = rows[0];
  return row ? toPending(row as Record<string, unknown>) : null;
}

/**
 * Atomically claim a workout by inserting a 'preparing' pending row. Returns
 * true when THIS caller inserted the row (won the race), false when a row
 * already existed. Mirrors claim_pending() (INSERT ... ON CONFLICT DO NOTHING).
 *
 * NOTE: claiming is pure bookkeeping — it does NOT begin a Garmin upload.
 */
export async function claimPending(
  hevyId: string,
  payload: Record<string, unknown>,
  sql: Sql = getDb(),
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO pending_uploads (hevy_id, phase, payload)
    VALUES (${hevyId}, 'preparing', ${sql.json(payload)})
    ON CONFLICT (hevy_id) DO NOTHING
    RETURNING hevy_id
  `;
  return rows.length === 1;
}

/**
 * Fields update_pending() is allowed to change (mirrors the Python allow-list).
 * pre_upload_ids/payload are JSONB; everything else is a scalar column.
 */
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

const PENDING_UPDATE_FIELDS: ReadonlyArray<keyof PendingUpdate> = [
  "phase",
  "next_step",
  "upload_id",
  "garmin_activity_id",
  "watch_activity_id",
  "pre_upload_ids",
  "payload",
  "resolution_source",
  "attempt_count",
  "delete_attempt_count",
  "last_error",
  "locked_until",
];

/**
 * Update a pending row's bookkeeping fields (filtered to the allow-list) and
 * bump updated_at. Mirrors update_pending(): only the keys the caller supplies
 * are changed, and a supplied key may set the column to NULL (e.g. clearing
 * last_error). No-op when nothing in the allow-list is provided.
 *
 * Every column is written with a `provided` guard so the statement is fully
 * parameterized (no dynamic identifier interpolation): each column keeps its
 * current value unless the caller passed that field. This never fires an
 * upload — it only records checkpoint state.
 */
export async function updatePending(
  hevyId: string,
  fields: PendingUpdate,
  sql: Sql = getDb(),
): Promise<void> {
  const has = (k: keyof PendingUpdate): boolean =>
    Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined;
  if (!PENDING_UPDATE_FIELDS.some(has)) return;

  // pre_upload_ids / payload are JSONB — wrap with sql.json so they are sent as
  // a JSONB payload (never a double-encoded string). See db.ts.
  const preUploadIds = has("pre_upload_ids") ? sql.json(fields.pre_upload_ids) : null;
  const payload = has("payload") ? sql.json(fields.payload) : null;

  await sql`
    UPDATE pending_uploads SET
      phase              = CASE WHEN ${has("phase")}              THEN ${fields.phase ?? null}              ELSE phase              END,
      next_step          = CASE WHEN ${has("next_step")}          THEN ${fields.next_step ?? null}          ELSE next_step          END,
      upload_id          = CASE WHEN ${has("upload_id")}          THEN ${fields.upload_id ?? null}          ELSE upload_id          END,
      garmin_activity_id = CASE WHEN ${has("garmin_activity_id")} THEN ${fields.garmin_activity_id ?? null} ELSE garmin_activity_id END,
      watch_activity_id  = CASE WHEN ${has("watch_activity_id")}  THEN ${fields.watch_activity_id ?? null}  ELSE watch_activity_id  END,
      pre_upload_ids     = CASE WHEN ${has("pre_upload_ids")}     THEN ${preUploadIds}                       ELSE pre_upload_ids     END,
      payload            = CASE WHEN ${has("payload")}            THEN ${payload}                           ELSE payload            END,
      resolution_source  = CASE WHEN ${has("resolution_source")}  THEN ${fields.resolution_source ?? null}  ELSE resolution_source  END,
      attempt_count      = CASE WHEN ${has("attempt_count")}      THEN ${fields.attempt_count ?? null}      ELSE attempt_count      END,
      delete_attempt_count = CASE WHEN ${has("delete_attempt_count")} THEN ${fields.delete_attempt_count ?? null} ELSE delete_attempt_count END,
      last_error         = CASE WHEN ${has("last_error")}         THEN ${fields.last_error ?? null}         ELSE last_error         END,
      locked_until       = CASE WHEN ${has("locked_until")}       THEN ${fields.locked_until ?? null}       ELSE locked_until       END,
      updated_at         = NOW()
    WHERE hevy_id = ${hevyId}
  `;
}

/** Delete a pending row. Returns whether a row was removed. Mirrors delete_pending(). */
export async function deletePending(hevyId: string, sql: Sql = getDb()): Promise<boolean> {
  const rows = await sql`
    DELETE FROM pending_uploads WHERE hevy_id = ${hevyId} RETURNING hevy_id
  `;
  return rows.length > 0;
}

/** Options for resolveTerminal (a manual / skipped resolution). */
export interface ResolveTerminalOpts {
  status: "manual" | "skipped";
  garminActivityId?: string | null;
  reason?: string | null;
  source?: string | null;
}

/**
 * Manually resolve a workout to a terminal state ('manual' or 'skipped') and
 * clear any pending row. Mirrors resolve_terminal(). This writes ONLY the local
 * ledger — 'manual' records that the user handled the upload themselves, it does
 * NOT upload anything to Garmin; 'skipped' records a deliberate skip.
 */
export async function resolveTerminal(
  hevyId: string,
  opts: ResolveTerminalOpts,
  sql: Sql = getDb(),
): Promise<void> {
  if (opts.status !== "manual" && opts.status !== "skipped") {
    throw new Error("manual resolution status must be 'manual' or 'skipped'");
  }
  const garminId = opts.garminActivityId ?? null;
  const reason = opts.reason ?? null;
  const source = opts.source ?? null;
  // Keep the terminal transition and claim removal in one database statement.
  // Two separate tagged-template calls can use different pooled connections;
  // if the second fails, the workout remains visibly pending forever.
  await sql`
    WITH terminal AS (
      INSERT INTO synced_workouts
        (hevy_id, garmin_activity_id, status, resolution_reason, resolved_at, resolution_source)
      VALUES (${hevyId}, ${garminId}, ${opts.status}, ${reason}, NOW(), ${source})
      ON CONFLICT (hevy_id) DO UPDATE SET
        garmin_activity_id = EXCLUDED.garmin_activity_id,
        status = EXCLUDED.status,
        resolution_reason = EXCLUDED.resolution_reason,
        resolved_at = NOW(),
        resolution_source = EXCLUDED.resolution_source,
        synced_at = NOW()
      RETURNING hevy_id
    )
    DELETE FROM pending_uploads WHERE hevy_id = ${hevyId}
  `;
}

/** Fields written when recording a successful upload. Mirrors mark_synced(). */
export interface MarkSyncedOpts {
  garminActivityId?: string | null;
  title?: string | null;
  calories?: number | null;
  avgHr?: number | null;
  hevyUpdatedAt?: string | null;
  syncMethod?: string;
}

/**
 * Record a workout as terminally synced (status='success') in synced_workouts.
 * Mirrors db_postgres.mark_synced(): UPSERT on hevy_id, always setting
 * status='success' and synced_at=NOW().
 *
 * This is a LOCAL ledger write only — it does NOT upload to Garmin. The caller
 * (sync-one) invokes it AFTER a real Garmin upload has already landed, to record
 * the terminal state so the workout is never re-uploaded (dedup layer 1).
 */
export async function markSynced(
  hevyId: string,
  opts: MarkSyncedOpts = {},
  sql: Sql = getDb(),
): Promise<void> {
  const garminId = opts.garminActivityId ?? null;
  const title = opts.title ?? "";
  const calories = opts.calories ?? null;
  const avgHr = opts.avgHr ?? null;
  const hevyUpdatedAt = opts.hevyUpdatedAt ?? null;
  const syncMethod = opts.syncMethod ?? "upload";
  await sql`
    INSERT INTO synced_workouts
      (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method, status)
    VALUES (${hevyId}, ${garminId}, ${title}, ${calories}, ${avgHr}, ${hevyUpdatedAt}, ${syncMethod}, 'success')
    ON CONFLICT (hevy_id) DO UPDATE SET
      garmin_activity_id = EXCLUDED.garmin_activity_id,
      title = EXCLUDED.title,
      calories = EXCLUDED.calories,
      avg_hr = EXCLUDED.avg_hr,
      hevy_updated_at = EXCLUDED.hevy_updated_at,
      sync_method = EXCLUDED.sync_method,
      status = 'success',
      synced_at = NOW()
  `;
}

/**
 * Complete a claimed upload: write the terminal success row AND clear the
 * in-flight pending row, atomically w.r.t. the two statements. Mirrors
 * db_postgres.complete_pending(). LOCAL ledger only — no Garmin write.
 */
export async function completePending(
  hevyId: string,
  opts: MarkSyncedOpts = {},
  sql: Sql = getDb(),
): Promise<void> {
  const garminId = opts.garminActivityId ?? null;
  const title = opts.title ?? "";
  const calories = opts.calories ?? null;
  const avgHr = opts.avgHr ?? null;
  const hevyUpdatedAt = opts.hevyUpdatedAt ?? null;
  const syncMethod = opts.syncMethod ?? "upload";
  // Same transaction boundary as Python complete_pending().
  await sql`
    WITH terminal AS (
      INSERT INTO synced_workouts
        (hevy_id, garmin_activity_id, title, calories, avg_hr, hevy_updated_at, sync_method, status)
      VALUES (${hevyId}, ${garminId}, ${title}, ${calories}, ${avgHr}, ${hevyUpdatedAt}, ${syncMethod}, 'success')
      ON CONFLICT (hevy_id) DO UPDATE SET
        garmin_activity_id = EXCLUDED.garmin_activity_id,
        title = EXCLUDED.title,
        calories = EXCLUDED.calories,
        avg_hr = EXCLUDED.avg_hr,
        hevy_updated_at = EXCLUDED.hevy_updated_at,
        sync_method = EXCLUDED.sync_method,
        status = 'success',
        synced_at = NOW()
      RETURNING hevy_id
    )
    DELETE FROM pending_uploads WHERE hevy_id = ${hevyId}
  `;
}

/**
 * Delete a workout's terminal row so it becomes eligible for sync again.
 * Mirrors unsync(). DB-ONLY: this does NOT delete the Garmin activity — that
 * would be a destructive Garmin write and is out of scope for the safe half.
 * Returns whether a row was removed.
 */
export async function unsync(hevyId: string, sql: Sql = getDb()): Promise<boolean> {
  const rows = await sql`
    DELETE FROM synced_workouts WHERE hevy_id = ${hevyId} RETURNING hevy_id
  `;
  return rows.length > 0;
}

/**
 * Delete EVERY terminal row so all workouts become sync candidates again.
 * Mirrors the Python /api/unsync-all. DB-ONLY: like unsync(), it does NOT delete
 * any Garmin activity — only the local ledger is cleared. Returns how many rows
 * were removed.
 */
export async function unsyncAll(sql: Sql = getDb()): Promise<number> {
  const rows = await sql`DELETE FROM synced_workouts RETURNING hevy_id`;
  return rows.length;
}

/** Set of hevy_ids with a terminal (synced_workouts) row. Batch read for dedup. */
export async function loadSyncedIds(sql: Sql = getDb()): Promise<Set<string>> {
  const rows = await sql`SELECT hevy_id FROM synced_workouts`;
  return new Set(rows.map((r) => String(r.hevy_id)));
}

/** Set of hevy_ids with an in-flight (pending_uploads) row. Batch read for dedup. */
export async function loadPendingIds(sql: Sql = getDb()): Promise<Set<string>> {
  const rows = await sql`SELECT hevy_id FROM pending_uploads`;
  return new Set(rows.map((r) => String(r.hevy_id)));
}
