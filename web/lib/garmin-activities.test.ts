import { describe, it, expect, vi } from "vitest";

vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));

import { detectDuplicates, getActivitiesByDate, type GarminActivity } from "./garmin-activities";
import type { GarminClient } from "garmin-auth";

const client = {} as GarminClient;
const window1 = {
  id: "w1",
  title: "Push",
  start_time: "2026-08-01T10:00:00Z",
  end_time: "2026-08-01T11:00:00Z",
};
const acts = (list: GarminActivity[]) => ({ getActivities: async () => list });

describe("detectDuplicates", () => {
  it("flags a tool (DEVELOPMENT) + watch pair overlapping the window", async () => {
    const dups = await detectDuplicates(client, [window1], acts([
      { activityId: 1, startTimeGMT: "2026-08-01 10:05:00", duration: 600, manufacturer: "DEVELOPMENT" },
      { activityId: 2, startTimeGMT: "2026-08-01 10:00:00", duration: 3600, manufacturer: "GARMIN" },
    ]));
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ workout_id: "w1", tool_activity_id: 1, watch_activity_id: 2 });
  });

  it("a tool activity alone is not a duplicate", async () => {
    const dups = await detectDuplicates(client, [window1], acts([
      { activityId: 1, startTimeGMT: "2026-08-01 10:05:00", duration: 600, manufacturer: "DEVELOPMENT" },
    ]));
    expect(dups).toHaveLength(0);
  });

  it("non-overlapping activities are ignored", async () => {
    const dups = await detectDuplicates(client, [window1], acts([
      { activityId: 1, startTimeGMT: "2026-08-01 13:00:00", duration: 600, manufacturer: "DEVELOPMENT" },
      { activityId: 2, startTimeGMT: "2026-08-01 13:00:00", duration: 600, manufacturer: "GARMIN" },
    ]));
    expect(dups).toHaveLength(0);
  });

  it("a workout without a start/end time is skipped", async () => {
    const getActivities = vi.fn(async () => [] as GarminActivity[]);
    const dups = await detectDuplicates(client, [{ id: "x", start_time: null, end_time: null }], { getActivities });
    expect(dups).toHaveLength(0);
    expect(getActivities).not.toHaveBeenCalled();
  });
});

describe("getActivitiesByDate", () => {
  it("calls the activitylist endpoint for the date and returns the array", async () => {
    const connectapi = vi.fn(async (..._a: unknown[]) => [{ activityId: 9 }]);
    const c = { connectapi } as unknown as GarminClient;
    const res = await getActivitiesByDate(c, "2026-08-01");
    expect(res).toEqual([{ activityId: 9 }]);
    expect(connectapi).toHaveBeenCalledTimes(1);
    expect(String(connectapi.mock.calls[0]?.[0])).toContain("/activitylist-service/activities/search/activities");
    expect(String(connectapi.mock.calls[0]?.[0])).toContain("startDate=2026-08-01");
  });

  it("a non-array response degrades to []", async () => {
    const c = { connectapi: async () => null } as unknown as GarminClient;
    expect(await getActivitiesByDate(c, "2026-08-01")).toEqual([]);
  });
});
