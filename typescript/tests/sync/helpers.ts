import { vi } from "vitest";
import type { GarminGateway, MarkSyncedOpts, PendingRecord, PendingUpdate, SyncStore } from "../../src/sync";

/**
 * An in-memory SyncStore whose every method is a vi.fn, so tests assert on
 * calls exactly as the web tests asserted on the mocked Postgres helpers.
 * Reads are controllable (`syncedIds`, `pendingIds`, `pending`); writes record.
 */
export class MemoryStore implements SyncStore {
  syncedIds = new Set<string>();
  pendingIds = new Set<string>();
  pending = new Map<string, PendingRecord>();
  /** Force the live layer-1 re-check independently of the id-set snapshot. */
  isSyncedOverride: boolean | null = null;
  /** Force the claim outcome (dedup layer 3). Default: win. */
  claimResult = true;

  isSynced = vi.fn(async (hevyId: string) =>
    this.isSyncedOverride ?? this.syncedIds.has(hevyId),
  );
  loadSyncedIds = vi.fn(async () => new Set(this.syncedIds));
  loadPendingIds = vi.fn(async () => new Set(this.pendingIds));
  getPending = vi.fn(async (hevyId: string) => this.pending.get(hevyId) ?? null);
  claimPending = vi.fn(async (_hevyId: string, _payload: Record<string, unknown>) => this.claimResult);
  updatePending = vi.fn(async (_hevyId: string, _fields: PendingUpdate) => {});
  deletePending = vi.fn(async (_hevyId: string) => true);
  completePending = vi.fn(async (_hevyId: string, _opts: MarkSyncedOpts) => {});
  markSynced = vi.fn(async (_hevyId: string, _opts: MarkSyncedOpts) => {});
}

/** A GarminGateway of spies. Defaults: nothing at the timestamp; upload → 555. */
export function mockGateway() {
  return {
    findExistingActivity: vi.fn(async (_startTime: string) => null as number | null),
    upload: vi.fn(async (_fit: Uint8Array, _start?: string) => ({ uploadId: 99, activityId: 555 as number | null })),
    rename: vi.fn(async (_id: number, _name: string) => {}),
    describe: vi.fn(async (_id: number, _text: string) => {}),
  } satisfies GarminGateway;
}

export const WORKOUT = {
  id: "hevy-1",
  title: "Push Day",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  updated_at: "2026-08-01T11:05:00Z",
  exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }],
};
