import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncOneWorkout, listCandidates } from "../../src/sync";
import { MemoryStore, mockGateway, WORKOUT } from "./helpers";

/**
 * The central safety property: in dryRun (the DEFAULT) NO Garmin write and NO
 * store mutation are reachable. The gateway and the store are spies; we assert
 * they are NEVER called on the dry-run path. FIT generation is real (pure).
 */
let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;
let gatewayFactory: ReturnType<typeof vi.fn<() => Promise<typeof gw>>>;

const deps = () => ({ store, gateway: gatewayFactory, fetchWorkouts: async () => [WORKOUT] });

function expectNoWrites() {
  expect(gw.upload).not.toHaveBeenCalled();
  expect(gw.rename).not.toHaveBeenCalled();
  expect(gw.describe).not.toHaveBeenCalled();
  expect(store.claimPending).not.toHaveBeenCalled();
  expect(store.completePending).not.toHaveBeenCalled();
  expect(store.markSynced).not.toHaveBeenCalled();
  expect(store.updatePending).not.toHaveBeenCalled();
  expect(store.deletePending).not.toHaveBeenCalled();
}

beforeEach(() => {
  store = new MemoryStore();
  gw = mockGateway();
  gatewayFactory = vi.fn(async () => gw);
});

describe("syncOneWorkout — dry-run is the DEFAULT and never writes", () => {
  it("defaults to dryRun when no option is passed (fresh → wouldUpload, no writes)", async () => {
    const res = await syncOneWorkout(deps());
    expect(res.dryRun).toBe(true);
    expect(res.status).toBe("dry_run");
    expect(res.wouldUpload).toBe(true);
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.fitStats?.exercises).toBe(1);
    expect(res.fitStats?.totalSets).toBe(1);
    // The layer-2 read IS allowed (it's a read), but NO write happens.
    expect(gw.findExistingActivity).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it("explicit dryRun:true also performs zero writes", async () => {
    const res = await syncOneWorkout(deps(), { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.wouldUpload).toBe(true);
    expectNoWrites();
  });
});

describe("dedup layer 1 — already-synced is skipped, never uploaded", () => {
  it("id-set marks it synced → filtered out → no_candidates", async () => {
    store.syncedIds.add("hevy-1");
    const res = await syncOneWorkout(deps());
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(res.wouldUpload).toBe(false);
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("live re-check: isSynced true for the picked id → skipped, no upload", async () => {
    store.isSyncedOverride = true; // passes the snapshot, fails the live ledger check
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.dedupDecision).toBe("already_synced");
    expectNoWrites();
  });
});

describe("dedup layer 2 — existing Garmin activity → match, NOT upload", () => {
  it("dry-run: reports the match, no writes", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const res = await syncOneWorkout(deps());
    expect(res.dryRun).toBe(true);
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.wouldUpload).toBe(false);
    expect(res.existingGarminActivityId).toBe(4242);
    expect(res.syncMethod).toBe("match");
    expectNoWrites();
  });

  it("live: matches + renames the existing activity, NEVER uploads a FIT", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("existing_garmin_activity");
    expect(res.garminActivityId).toBe(4242);
    expect(gw.upload).not.toHaveBeenCalled();
    expect(gw.rename).toHaveBeenCalledWith(4242, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.markSynced).toHaveBeenCalledTimes(1);
    expect(store.claimPending).not.toHaveBeenCalled();
  });
});

describe("dedup layer 3 + live upload — fresh workout on the live path", () => {
  it("claims, uploads, finalizes, and completes the pending row", async () => {
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("synced");
    expect(res.dedupDecision).toBe("would_upload");
    expect(res.garminActivityId).toBe(555);
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(gw.upload).toHaveBeenCalledTimes(1);
    expect(gw.rename).toHaveBeenCalledWith(555, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.completePending).toHaveBeenCalledTimes(1);
  });

  it("claim lost (another worker holds it) → deferred, NO upload", async () => {
    store.claimResult = false;
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("deferred");
    expect(res.dedupDecision).toBe("claim_lost");
    expect(gw.upload).not.toHaveBeenCalled();
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.markSynced).not.toHaveBeenCalled();
  });

  it("upload throws → parks pending as processing with the error, no completion", async () => {
    gw.upload.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const res = await syncOneWorkout(deps(), { dryRun: false });
    expect(res.status).toBe("error");
    expect(res.error).toContain("Garmin upload failed");
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(store.updatePending).toHaveBeenCalledWith("hevy-1", expect.objectContaining({ phase: "processing" }));
    expect(store.completePending).not.toHaveBeenCalled();
  });
});

describe("empty + edge inputs", () => {
  it("no workouts at all → none / no_candidates, no writes", async () => {
    const res = await syncOneWorkout({ ...deps(), fetchWorkouts: async () => [] });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expect(gatewayFactory).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("workout without a start_time → refuses to upload (dry_run), no writes", async () => {
    const res = await syncOneWorkout(
      { ...deps(), fetchWorkouts: async () => [{ ...WORKOUT, start_time: null }] },
      { dryRun: true },
    );
    expect(res.dedupDecision).toBe("no_start_time");
    expect(res.wouldUpload).toBe(false);
    expect(gatewayFactory).not.toHaveBeenCalled(); // never consulted Garmin
    expectNoWrites();
  });
});

describe("targetHevyId — sync a specific workout", () => {
  it("targets the matching candidate (dry-run), not the first", async () => {
    const res = await syncOneWorkout(deps(), { targetHevyId: "hevy-1" });
    expect(res.dryRun).toBe(true);
    expect(res.workout?.hevy_id).toBe("hevy-1");
    expect(res.dedupDecision).toBe("would_upload");
    expectNoWrites();
  });

  it("a target that is not a candidate → no_candidates", async () => {
    const res = await syncOneWorkout(deps(), { targetHevyId: "does-not-exist" });
    expect(res.status).toBe("none");
    expect(res.dedupDecision).toBe("no_candidates");
    expectNoWrites();
  });
});

describe("listCandidates — the unsynced list", () => {
  it("returns the unsynced workouts (dedup layer 1)", async () => {
    const cands = await listCandidates(deps());
    expect(cands).toHaveLength(1);
    expect(cands[0].hevy_id).toBe("hevy-1");
    expect(cands[0].title).toBe("Push Day");
    expectNoWrites();
  });

  it("excludes already-synced ids", async () => {
    store.syncedIds.add("hevy-1");
    expect(await listCandidates(deps())).toHaveLength(0);
  });
});
