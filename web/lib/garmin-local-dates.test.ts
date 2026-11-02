import { describe, expect, it, vi } from "vitest";
import { findMergeMatch, mergeSearchRange, type CandidateActivity, type GarminGateway } from "hevy2garmin";
import { withGarminLocalDates } from "./garmin-local-dates";

function localCalendarListing(activities: CandidateActivity[]) {
  const list = vi.fn(async (start: string, end: string) => activities.filter((a) => {
    const day = a.startTimeLocal!.slice(0, 10);
    return day >= start && day <= end;
  }));
  return { list, gateway: { activitiesByDate: list } as unknown as GarminGateway };
}
const now = new Date("2026-06-20T00:00:00Z");

describe("Garmin local-date activity listing", () => {
  it.each([
    { name: "an evening west of UTC", local: "2026-06-14 23:50:11", start: "04:50", end: "06:10" },
    { name: "a morning east of UTC", local: "2026-06-16 01:50:11", start: "12:50", end: "14:10" },
  ])("finds the same watch session on $name", async ({ local, start, end }) => {
    const workout = { start_time: `2026-06-15T${start}:00Z`, end_time: `2026-06-15T${end}:00Z` };
    const activity = { activityId: 42, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" }, startTimeGMT: `2026-06-15 ${start}:11`, startTimeLocal: local, duration: 4800 };
    const { list, gateway } = localCalendarListing([activity]);
    const range = mergeSearchRange(workout)!;
    const before = await gateway.activitiesByDate(range.start, range.end);
    expect(findMergeMatch(workout, before, { now })).toBeNull();

    const padded = withGarminLocalDates(gateway);
    const after = await padded.activitiesByDate(range.start, range.end);
    expect(list).toHaveBeenLastCalledWith("2026-06-14", "2026-06-16");
    const match = findMergeMatch(workout, after, { now });
    expect(match?.activity.activityId).toBe(42);
    expect(match?.driftMinutes).toBeCloseTo(11 / 60);
    expect(match?.overlapPct).toBeGreaterThan(0.99);
    // Repeated lookups start from the same dates, without accumulating padding.
    await padded.activitiesByDate(range.start, range.end);
    expect(list).toHaveBeenLastCalledWith("2026-06-14", "2026-06-16");
  });

  it("keeps overlap, drift and activity-type checks after widening the listing", async () => {
    const workout = { start_time: "2026-06-15T04:50:00Z", end_time: "2026-06-15T06:10:00Z" };
    const base = { manufacturer: "GARMIN", duration: 4800, activityType: { typeKey: "strength_training" }, startTimeLocal: "2026-06-14 23:50:00" };
    const { gateway } = localCalendarListing([
      { ...base, activityId: 1, startTimeGMT: "2026-06-14 04:50:00" },
      { ...base, activityId: 2, startTimeGMT: "2026-06-15 04:50:00", activityType: { typeKey: "running" } },
      { ...base, activityId: 3, startTimeGMT: "2026-06-15 04:20:00" },
    ]);
    const activities = await withGarminLocalDates(gateway).activitiesByDate("2026-06-15", "2026-06-15");
    expect(activities).toHaveLength(3);
    expect(findMergeMatch(workout, activities, { now })).toBeNull();
  });

  it("handles year boundaries and propagates Garmin failures", async () => {
    const list = vi.fn().mockRejectedValue(new Error("Garmin unavailable"));
    const gateway = withGarminLocalDates({ activitiesByDate: list } as unknown as GarminGateway);
    await expect(gateway.activitiesByDate("2026-12-31", "2027-01-01")).rejects.toThrow("Garmin unavailable");
    expect(list).toHaveBeenCalledWith("2026-12-30", "2027-01-02");
  });
});
