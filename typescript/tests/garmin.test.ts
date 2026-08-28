import { describe, expect, it, vi } from "vitest";
import { findActivityByStartTime } from "../src/garmin";

describe("findActivityByStartTime", () => {
  it("searches broadly, ignores non-strength activities, and honors exclusions", async () => {
    const connectapi = vi.fn().mockResolvedValue([
      {
        activityId: 10,
        startTimeGMT: "2026-08-01T10:00:00Z",
        activityTypeKey: "running",
      },
      {
        activityId: 11,
        startTimeGMT: "2026-08-01T10:02:00Z",
        activityTypeKey: "strength_training",
      },
      {
        activityId: 12,
        startTimeGMT: "2026-08-01T10:01:00Z",
        activityTypeKey: "strength_training",
      },
    ]);
    const client = { connectapi } as any;

    await expect(
      findActivityByStartTime(client, "2026-08-01T10:00:00", {
        excludeActivityIds: [11],
      }),
    ).resolves.toBe(12);
    expect(connectapi).toHaveBeenCalledWith(
      "/activitylist-service/activities/search/activities?limit=100",
    );
  });

  it("returns null for an invalid target timestamp", async () => {
    const connectapi = vi.fn().mockResolvedValue([]);
    await expect(
      findActivityByStartTime({ connectapi } as any, "not-a-date"),
    ).resolves.toBeNull();
    expect(connectapi).not.toHaveBeenCalled();
  });
});
