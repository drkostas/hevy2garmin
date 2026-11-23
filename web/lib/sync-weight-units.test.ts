import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateDescription } from "hevy2garmin";
import type { Sql } from "./pending-store";

const h = vi.hoisted(() => ({
  describe: vi.fn(async (_id: number, _description: string) => {}),
  rename: vi.fn(async () => {}),
  markSynced: vi.fn(async () => {}),
  activitiesByDate: vi.fn(async (_start: string, _end: string) => []),
  pending: null as null | { payload: { workout: Record<string, unknown> } },
}));
vi.mock("./garmin-upload", () => ({ getGarminClient: async () => ({}) }));
vi.mock("./sync-store", () => ({ postgresSyncStore: () => ({
  loadSyncedIds: async () => new Set(), loadPendingIds: async () => new Set(),
  isSynced: async () => false, getPending: async () => h.pending,
  markSynced: h.markSynced,
}) }));
vi.mock("hevy2garmin", async (original) => ({
  ...(await original<object>()),
  garminGateway: () => ({ findExistingActivity: async () => 42, rename: h.rename, describe: h.describe, activitiesByDate: h.activitiesByDate }),
}));
import { buildSyncDeps, syncOneWorkout } from "./sync-one";

function sqlWithUnit(unit: unknown): Sql {
  return (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values[0] === "display_units") return [{ value: { weight: unit } }];
    if (values[0] === "merge_settings") return [{ value: { merge_mode: false } }];
    if (values[0] === "hr_fusion") return [{ value: { enabled: false } }];
    return [];
  }) as unknown as Sql;
}
const workout = {
  id: "first", title: "Strength", start_time: "2026-06-15T10:00:00Z", end_time: "2026-06-15T11:00:00Z",
  exercises: [{ title: "Press", sets: [{ type: "normal", weight_kg: 50.0, reps: 5 }] }],
};
beforeEach(() => { vi.clearAllMocks(); h.pending = null; });

describe("saved weight unit through the real sync engine", () => {
  it("keeps local-date listing and pound formatting on the same gateway", async () => {
    h.pending = { payload: { workout } };
    const deps = buildSyncDeps(sqlWithUnit("lb"));
    await deps.store.getPending(workout.id);
    const gateway = await deps.gateway();
    await gateway.activitiesByDate("2026-06-15", "2026-06-15");
    await gateway.describe(42, generateDescription(workout, null, null));
    expect(h.activitiesByDate).toHaveBeenCalledWith("2026-06-14", "2026-06-16");
    expect(h.describe).toHaveBeenCalledWith(42, expect.stringContaining("110.2 lbs × 5"));
  });
  it("formats the selected workout rather than another session with the same rounded kg summary", async () => {
    const other = { ...workout, id: "second", start_time: "2026-06-16T10:00:00Z", end_time: "2026-06-16T11:00:00Z",
      exercises: [{ title: "Press", sets: [{ type: "normal", weight_kg: 50.04, reps: 5 }] }] };
    const original = structuredClone([workout, other]);
    const result = await syncOneWorkout(sqlWithUnit("lb"), { dryRun: false, fetchWorkouts: async () => [workout, other] });
    expect(result.status).toBe("synced");
    expect(h.describe).toHaveBeenCalledWith(42, expect.stringContaining("110.2 lbs × 5"));
    expect(h.describe.mock.calls[0][1]).not.toContain("110.3 lbs");
    expect([workout, other]).toEqual(original);
  });
  it("formats recovery from its saved payload without another Hevy fetch", async () => {
    h.pending = { payload: { workout } };
    const fetchWorkouts = vi.fn(async () => { throw new Error("No Hevy read should be needed"); });
    const deps = buildSyncDeps(sqlWithUnit("lb"), { fetchWorkouts });
    await deps.store.getPending(workout.id);
    const gateway = await deps.gateway();
    await gateway.describe(42, generateDescription(workout, 321, 123));
    expect(h.describe).toHaveBeenCalledWith(42, expect.stringContaining("110.2 lbs × 5"));
    expect(h.describe.mock.calls[0][1]).toContain("321 kcal");
    expect(h.describe.mock.calls[0][1]).toContain("avg 123 bpm");
    expect(fetchWorkouts).not.toHaveBeenCalled();
  });
  it.each(["kg", undefined, "invalid"])("keeps the existing note untouched for %s", async (unit) => {
    const fetchWorkouts = vi.fn(async () => []);
    const gateway = await buildSyncDeps(sqlWithUnit(unit), { fetchWorkouts }).gateway();
    await gateway.describe(42, "An existing metric description");
    expect(h.describe).toHaveBeenCalledWith(42, "An existing metric description");
    expect(fetchWorkouts).not.toHaveBeenCalled();
  });
});
