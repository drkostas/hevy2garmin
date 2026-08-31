import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadFit = vi.fn();
vi.mock("hevy2garmin", () => ({
  uploadFit: (...args: unknown[]) => uploadFit(...args),
  findActivityByStartTime: vi.fn(),
  renameActivity: vi.fn(),
  setDescription: vi.fn(),
}));

vi.mock("garmin-auth", () => ({
  GarminAuth: class {},
  DBTokenStore: class {},
}));

import { findExistingActivity, listActivityIds, upload } from "./garmin-upload";

describe("web Garmin upload safety wrapper", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns a pre-existing resolved ID into a pending reconciliation", async () => {
    uploadFit.mockResolvedValue({ uploadId: 7, activityId: 42 });
    const result = await upload({} as any, new Uint8Array([1]), "2026-08-01T10:00:00Z", {
      excludeActivityIds: [42],
    });
    expect(result).toEqual({ uploadId: 7, activityId: null });
  });

  it("normalizes the pre-upload activity snapshot to positive numeric IDs", async () => {
    const connectapi = vi.fn().mockResolvedValue([
      { activityId: 10 },
      { activityId: "11" },
      { activityId: 0 },
      { activityId: "not-an-id" },
    ]);
    await expect(listActivityIds({ connectapi } as any)).resolves.toEqual([10, 11]);
  });

  it("does not match an unrelated activity type at the same timestamp", async () => {
    const connectapi = vi.fn().mockResolvedValue([
      { activityId: 20, startTimeGMT: "2026-08-01T10:00:00Z", activityTypeKey: "running" },
      { activityId: 21, startTimeGMT: "2026-08-01T10:09:00Z", activityTypeKey: "strength_training" },
    ]);
    await expect(
      findExistingActivity({ connectapi } as any, "2026-08-01T10:00:00Z"),
    ).resolves.toBe(21);
  });
});
