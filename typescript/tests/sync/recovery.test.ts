import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcilePending, retryPending, type PendingRecord } from "../../src/sync";
import { MemoryStore, mockGateway } from "./helpers";

/**
 * The "never double-upload" property: reconcile completes as matched; a retry
 * that finds an existing activity does NOT upload. Plus the happy retry path.
 */
let store: MemoryStore;
let gw: ReturnType<typeof mockGateway>;
let gatewayFactory: ReturnType<typeof vi.fn<() => Promise<typeof gw>>>;
const deps = () => ({ store, gateway: gatewayFactory });

const PENDING: PendingRecord = {
  hevy_id: "w1", phase: "processing", next_step: null, upload_id: null, garmin_activity_id: null,
  watch_activity_id: null, pre_upload_ids: [], resolution_source: null, attempt_count: 1,
  delete_attempt_count: 0, last_error: null, locked_until: null, created_at: null, updated_at: null,
  payload: {
    workout: { id: "w1", title: "Push Day", start_time: "2026-08-01T10:00:00Z", end_time: "2026-08-01T11:00:00Z",
               exercises: [{ title: "Bench Press", sets: [{ type: "normal", weight_kg: 80, reps: 5 }] }] },
    title: "Push Day", calories: 321, avg_hr: 110,
  },
};

beforeEach(() => {
  store = new MemoryStore();
  gw = mockGateway();
  gatewayFactory = vi.fn(async () => gw);
  store.pending.set("w1", PENDING);
});

describe("reconcilePending", () => {
  it("no pending row → not_found", async () => {
    store.pending.clear();
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("not_found");
    expect(gw.findExistingActivity).not.toHaveBeenCalled();
  });

  it("no usable payload → no_payload, no Garmin call", async () => {
    store.pending.set("w1", { ...PENDING, payload: {} });
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("no_payload");
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("Garmin already has it → completes as matched, no upload", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("reconciled_synced");
    expect(r.garminActivityId).toBe(4242);
    expect(store.completePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ garminActivityId: "4242", syncMethod: "match" }),
    );
    expect(gw.upload).not.toHaveBeenCalled();
  });

  it("Garmin has nothing → no_activity, pending left in place", async () => {
    const r = await reconcilePending(deps(), "w1");
    expect(r.status).toBe("no_activity");
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.updatePending).toHaveBeenCalledTimes(1);
  });
});

describe("retryPending", () => {
  it("Garmin already has it → matched, NEVER uploads", async () => {
    gw.findExistingActivity.mockResolvedValue(4242);
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("reconciled_synced");
    expect(gw.upload).not.toHaveBeenCalled();
  });

  it("fresh → regenerates FIT, uploads, finalizes, completes", async () => {
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("synced");
    expect(r.garminActivityId).toBe(555);
    expect(gw.upload).toHaveBeenCalledTimes(1);
    expect(gw.rename).toHaveBeenCalledWith(555, "Push Day");
    expect(gw.describe).toHaveBeenCalledTimes(1);
    expect(store.completePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ garminActivityId: "555", syncMethod: "upload" }),
    );
  });

  it("upload throws → parks pending with the error, no completion", async () => {
    gw.upload.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("error");
    expect(r.error).toContain("Garmin upload failed");
    expect(store.completePending).not.toHaveBeenCalled();
    expect(store.updatePending).toHaveBeenCalledWith(
      "w1", expect.objectContaining({ phase: "processing", last_error: expect.stringContaining("failed") }),
    );
  });

  it("no usable payload → no_payload", async () => {
    store.pending.set("w1", { ...PENDING, payload: { title: "x" } });
    const r = await retryPending(deps(), "w1");
    expect(r.status).toBe("no_payload");
    expect(gw.upload).not.toHaveBeenCalled();
  });
});
