import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the LIVE Hevy→Garmin upload engine (lib/sync-one).
 *
 * The central safety property under test: in dryRun (the DEFAULT) NO Garmin
 * write and NO DB mutation are reachable. We mock every DB helper and the FIT
 * generator, and inject the Hevy fetch + Garmin client so no network is
 * touched. The Garmin write wrappers (upload/rename/describe) and the mutating
 * ledger helpers (claimPending/completePending/markSynced/updatePending) are
 * spies, and we assert they are NEVER called on the dry-run path.
 */

// --- Mock the package: generateFit is deterministic; the Garmin ops are spies. ---
const uploadFit = vi.fn();
const findActivityByStartTime = vi.fn();
const renameActivity = vi.fn();
const setDescription = vi.fn();
vi.mock("hevy2garmin", () => ({
  generateFit: vi.fn(() => ({
    fit: new Uint8Array([1, 2, 3]),
    exercises: 2,
    total_sets: 6,
    hr_samples: 0,
    calories: 321,
    avg_hr: null,
    duration_s: 3600,
  })),
  uploadFit: (...a: unknown[]) => uploadFit(...a),
  findActivityByStartTime: (...a: unknown[]) => findActivityByStartTime(...a),
  renameActivity: (...a: unknown[]) => renameActivity(...a),
  setDescription: (...a: unknown[]) => setDescription(...a),
}));

// --- Mock garmin-auth so importing garmin-upload never builds a real client. ---
vi.mock("garmin-auth", () => ({
  GarminAuth: class {
    async client() {
      return { domain: "garmin.com", di_token: "x" };
    }
  },
  DBTokenStore: class {
    constructor(..._a: unknown[]) {}
  },
}));

// --- Mock the DB ledger helpers. Reads return controllable sets; writes are spies. ---
const isSynced = vi.fn();
const claimPending = vi.fn();
const updatePending = vi.fn();
const deletePending = vi.fn();
const completePending = vi.fn();
const markSynced = vi.fn();
const loadSyncedIds = vi.fn();
const loadPendingIds = vi.fn();
vi.mock("./pending-store", () => ({
  isSynced: (...a: unknown[]) => isSynced(...a),
  claimPending: (...a: unknown[]) => claimPending(...a),
  updatePending: (...a: unknown[]) => updatePending(...a),
  deletePending: (...a: unknown[]) => deletePending(...a),
  completePending: (...a: unknown[]) => completePending(...a),
  markSynced: (...a: unknown[]) => markSynced(...a),
  loadSyncedIds: (...a: unknown[]) => loadSyncedIds(...a),
  loadPendingIds: (...a: unknown[]) => loadPendingIds(...a),
}));

// getDb is imported for the Sql type; give it a harmless stub.
vi.mock("./db", () => ({ getDb: () => ({}) }));

import { syncOneWorkout, listCandidates } from "./sync-one";
import type { GarminClient } from "garmin-auth";

const sql = {} as ReturnType<typeof import("./db").getDb>;

// A fake Garmin client — findExistingActivity/upload/etc. are the mocked
// package fns above, so this object only needs to exist.
const fakeClient = { domain: "garmin.com", di_token: "x" } as unknown as GarminClient;
const garminClientFactory = vi.fn(async () => fakeClient);

const WORKOUT = {
  id: "hevy-1",
  title: "Push Day",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
  updated_at: "2026-08-01T11:05:00Z",
  exercises: [
    { title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] },
  ],
};

function fetchOne() {
  return async () => [WORKOUT];
}

/** Assert that NOTHING wrote to Garmin or mutated the DB ledger. */
function expectNoWrites() {
  expect(uploadFit).not.toHaveBeenCalled();
  expect(renameActivity).not.toHaveBeenCalled();
  expect(setDescription).not.toHaveBeenCalled();
  expect(claimPending).not.toHaveBeenCalled();
  expect(completePending).not.toHaveBeenCalled();
  expect(markSynced).not.toHaveBeenCalled();
  expect(updatePending).not.toHaveBeenCalled();
  expect(deletePending).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty ledgers (fresh workout), Garmin has nothing at the timestamp.
  loadSyncedIds.mockResolvedValue(new Set<string>());
  loadPendingIds.mockResolvedValue(new Set<string>());
  isSynced.mockResolvedValue(false);
  findActivityByStartTime.mockResolvedValue(null);
  claimPending.mockResolvedValue(true);
  uploadFit.mockResolvedValue({ uploadId: 99, activityId: 555 });
});

describe("syncOneWorkout — dry-run is the DEFAULT and never writes", () => {
  it("defaults to dryRun when no option is passed (fresh → wouldUpload, no writes)", async () => {
    const res = await syncOneWorkout(sql, {
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.dryRun).toBe(true);
    expect(res.status).toBe("dry_run");
    expect(res.wouldUpload).toBe(true);
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.fitStats?.calories).toBe(321);
    // The layer-2 read IS allowed (it's a read), but NO write happens.
    expect(findActivityByStartTime).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it("explicit dryRun:true also performs zero writes", async () => {
    const res = await syncOneWorkout(sql, {
      dryRun: true,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.dryRun).toBe(true);
    expect(res.wouldUpload).toBe(true);
    expectNoWrites();
  });
});

describe("dedup layer 1 — already-synced is skipped, never uploaded", () => {
  it("id-set marks it synced → filtered out → no_candidates", async () => {
    loadSyncedIds.mockResolvedValue(new Set(["hevy-1"]));
    const res = await syncOneWorkout(sql, {
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(res.wouldUpload).toBe(false);
    // Garmin was never even consulted.
    expect(findActivityByStartTime).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("live re-check: isSynced true for the picked id → skipped, no upload", async () => {
    // Passes the id-set filter but the live ledger says it's already synced
    // (a concurrent sync resolved it). Must skip, not upload.
    isSynced.mockResolvedValue(true);
    const res = await syncOneWorkout(sql, {
      dryRun: false,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("skipped");
    expect(res.dedupDecision).toBe("already_synced");
    expectNoWrites();
  });
});

describe("dedup layer 2 — existing Garmin activity → match, NOT upload", () => {
  it("dry-run: reports the match, no writes", async () => {
    findActivityByStartTime.mockResolvedValue(4242);
    const res = await syncOneWorkout(sql, {
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.dryRun).toBe(true);
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.wouldUpload).toBe(false);
    expect(res.existingGarminActivityId).toBe(4242);
    expect(res.syncMethod).toBe("match");
    expect(uploadFit).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("live: matches + renames the existing activity, NEVER uploads a FIT", async () => {
    findActivityByStartTime.mockResolvedValue(4242);
    const res = await syncOneWorkout(sql, {
      dryRun: false,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.garminActivityId).toBe(4242);
    // The upload path is unreachable — the whole point of layer 2.
    expect(uploadFit).not.toHaveBeenCalled();
    // It DID rename/describe the existing activity and record a terminal row.
    expect(renameActivity).toHaveBeenCalledWith(fakeClient, 4242, "Push Day");
    expect(setDescription).toHaveBeenCalledTimes(1);
    expect(markSynced).toHaveBeenCalledTimes(1);
    // No fresh claim/upload was made.
    expect(claimPending).not.toHaveBeenCalled();
  });
});

describe("dedup layer 3 + live upload — fresh workout on the live path", () => {
  it("claims, uploads, finalizes, and completes the pending row", async () => {
    const res = await syncOneWorkout(sql, {
      dryRun: false,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.garminActivityId).toBe(555);
    // Layer 3 claim happened before the upload.
    expect(claimPending).toHaveBeenCalledTimes(1);
    expect(uploadFit).toHaveBeenCalledTimes(1);
    expect(renameActivity).toHaveBeenCalledWith(fakeClient, 555, "Push Day");
    expect(setDescription).toHaveBeenCalledTimes(1);
    expect(completePending).toHaveBeenCalledTimes(1);
  });

  it("claim lost (another worker holds it) → deferred, NO upload", async () => {
    claimPending.mockResolvedValue(false);
    const res = await syncOneWorkout(sql, {
      dryRun: false,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("deferred");
    expect(res.dedupDecision).toBe("claim_lost");
    expect(uploadFit).not.toHaveBeenCalled();
    expect(completePending).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
  });

  it("upload throws → parks pending as processing with the error, no completion", async () => {
    uploadFit.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const res = await syncOneWorkout(sql, {
      dryRun: false,
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("error");
    expect(res.error).toContain("Garmin upload failed");
    expect(claimPending).toHaveBeenCalledTimes(1);
    // Parked, not completed — never blindly re-uploaded.
    expect(updatePending).toHaveBeenCalledWith(
      "hevy-1",
      expect.objectContaining({ phase: "processing" }),
      sql,
    );
    expect(completePending).not.toHaveBeenCalled();
  });
});

describe("empty + edge inputs", () => {
  it("no workouts at all → none / no_candidates, no writes", async () => {
    const res = await syncOneWorkout(sql, {
      fetchWorkouts: async () => [],
      garminClientFactory,
    });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(garminClientFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("workout without a start_time → refuses to upload (dry_run), no writes", async () => {
    const noStart = { ...WORKOUT, start_time: null };
    const res = await syncOneWorkout(sql, {
      dryRun: true,
      fetchWorkouts: async () => [noStart],
      garminClientFactory,
    });
    expect(res.dedupDecision).toBe("no_start_time");
    expect(res.wouldUpload).toBe(false);
    // Never consulted Garmin (no start time to look up).
    expect(garminClientFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

describe("targetHevyId — sync a specific workout", () => {
  it("targets the matching candidate (dry-run), not the first", async () => {
    const res = await syncOneWorkout(sql, {
      targetHevyId: "hevy-1",
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.dryRun).toBe(true);
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.dedupDecision).toBe("would_upload");
    expectNoWrites();
  });

  it("a target that is not a candidate → no_candidates", async () => {
    const res = await syncOneWorkout(sql, {
      targetHevyId: "does-not-exist",
      fetchWorkouts: fetchOne(),
      garminClientFactory,
    });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expectNoWrites();
  });
});

describe("listCandidates — the unsynced list", () => {
  it("returns the unsynced workouts (dedup layer 1)", async () => {
    const cands = await listCandidates(sql, { fetchWorkouts: fetchOne() });
    expect(cands).toHaveLength(1);
    expect(cands[0].hevy_id).toBe("hevy-1");
    expect(cands[0].title).toBe("Push Day");
    expectNoWrites();
  });

  it("excludes already-synced ids", async () => {
    loadSyncedIds.mockResolvedValue(new Set(["hevy-1"]));
    const cands = await listCandidates(sql, { fetchWorkouts: fetchOne() });
    expect(cands).toHaveLength(0);
  });
});
