import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for reconcile/retry (lib/pending-recovery). Every Garmin op, the
 * FIT generator, and the DB helpers are mocked, so no network/DB is touched. We
 * assert the "never double-upload" property (reconcile completes as matched; a
 * retry that finds an existing activity does NOT upload) and the happy retry
 * path.
 */

const generateFit = vi.fn((..._a: unknown[]) => ({
  fit: new Uint8Array([1, 2, 3]),
  exercises: 2,
  total_sets: 6,
  calories: 321,
  avg_hr: 110,
  duration_s: 3600,
}));
vi.mock("hevy2garmin", () => ({ generateFit: (...a: unknown[]) => generateFit(...a) }));

const getGarminClient = vi.fn(async (..._a: unknown[]) => ({ domain: "garmin.com" }));
const findExistingActivity = vi.fn();
const upload = vi.fn();
const rename = vi.fn();
const describe_ = vi.fn();
vi.mock("./garmin-upload", () => ({
  getGarminClient: (...a: unknown[]) => getGarminClient(...a),
  findExistingActivity: (...a: unknown[]) => findExistingActivity(...a),
  upload: (...a: unknown[]) => upload(...a),
  rename: (...a: unknown[]) => rename(...a),
  describe: (...a: unknown[]) => describe_(...a),
}));

const getPending = vi.fn();
const completePending = vi.fn();
const updatePending = vi.fn();
vi.mock("./pending-store", () => ({
  getPending: (...a: unknown[]) => getPending(...a),
  completePending: (...a: unknown[]) => completePending(...a),
  updatePending: (...a: unknown[]) => updatePending(...a),
}));

vi.mock("./sync-one", () => ({ generateDescription: () => "desc" }));
vi.mock("./db", () => ({ getDb: () => ({}) }));

import { reconcilePending, retryPending } from "./pending-recovery";

const sql = {} as ReturnType<typeof import("./db").getDb>;
const client = { domain: "garmin.com" };
const garminClientFactory = vi.fn(async () => client as never);

const PENDING = {
  hevy_id: "w1",
  phase: "processing",
  attempt_count: 1,
  payload: {
    workout: { id: "w1", title: "Push Day", start_time: "2026-08-01T10:00:00Z" },
    title: "Push Day",
    calories: 321,
    avg_hr: 110,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getPending.mockResolvedValue(PENDING);
  findExistingActivity.mockResolvedValue(null);
  upload.mockResolvedValue({ uploadId: 9, activityId: 555 });
});

describe("reconcilePending", () => {
  it("no pending row → not_found", async () => {
    getPending.mockResolvedValue(null);
    const r = await reconcilePending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("not_found");
    expect(findExistingActivity).not.toHaveBeenCalled();
  });

  it("no usable payload → no_payload, no Garmin call", async () => {
    getPending.mockResolvedValue({ ...PENDING, payload: {} });
    const r = await reconcilePending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("no_payload");
    expect(garminClientFactory).not.toHaveBeenCalled();
  });

  it("Garmin already has it → completes as matched, no upload", async () => {
    findExistingActivity.mockResolvedValue(4242);
    const r = await reconcilePending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("reconciled_synced");
    expect(r.garminActivityId).toBe(4242);
    expect(completePending).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ garminActivityId: "4242", syncMethod: "match" }),
      sql,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("Garmin has nothing → no_activity, pending left in place", async () => {
    const r = await reconcilePending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("no_activity");
    expect(completePending).not.toHaveBeenCalled();
    expect(updatePending).toHaveBeenCalledTimes(1);
  });
});

describe("retryPending", () => {
  it("Garmin already has it → matched, NEVER uploads", async () => {
    findExistingActivity.mockResolvedValue(4242);
    const r = await retryPending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("reconciled_synced");
    expect(upload).not.toHaveBeenCalled();
    expect(generateFit).not.toHaveBeenCalled();
  });

  it("fresh → regenerates FIT, uploads, finalizes, completes", async () => {
    const r = await retryPending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("synced");
    expect(r.garminActivityId).toBe(555);
    expect(generateFit).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(client, 555, "Push Day");
    expect(describe_).toHaveBeenCalledTimes(1);
    expect(completePending).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ garminActivityId: "555", syncMethod: "upload" }),
      sql,
    );
  });

  it("upload throws → parks pending with the error, no completion", async () => {
    upload.mockRejectedValue(new Error("Garmin upload failed (500)"));
    const r = await retryPending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("error");
    expect(r.error).toContain("Garmin upload failed");
    expect(completePending).not.toHaveBeenCalled();
    expect(updatePending).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ phase: "processing", last_error: expect.stringContaining("failed") }),
      sql,
    );
  });

  it("no usable payload → no_payload", async () => {
    getPending.mockResolvedValue({ ...PENDING, payload: { title: "x" } });
    const r = await retryPending("w1", { garminClientFactory }, sql);
    expect(r.status).toBe("no_payload");
    expect(upload).not.toHaveBeenCalled();
  });
});
