import { describe, it, expect, vi, beforeEach } from "vitest";

const getAllWorkouts = vi.fn();
vi.mock("@/lib/hevy-sync", () => ({
  getHevyClient: async () => ({ getAllWorkouts: (...a: unknown[]) => getAllWorkouts(...a) }),
}));

const detectDuplicates = vi.fn();
vi.mock("@/lib/garmin-activities", () => ({
  detectDuplicates: (...a: unknown[]) => detectDuplicates(...a),
  garminClient: async () => ({}),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  getAllWorkouts.mockResolvedValue([
    { id: "w1", title: "Push", start_time: "2026-08-01T10:00:00Z", end_time: "2026-08-01T11:00:00Z" },
  ]);
});

describe("POST /api/scan-duplicates", () => {
  it("returns the duplicate count", async () => {
    detectDuplicates.mockResolvedValue([
      { workout_id: "w1", workout_title: "Push", tool_activity_id: 1, watch_activity_id: 2 },
    ]);
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(detectDuplicates).toHaveBeenCalledTimes(1);
  });

  it("no duplicates → count 0", async () => {
    detectDuplicates.mockResolvedValue([]);
    const res = await POST();
    const json = await res.json();
    expect(json.count).toBe(0);
  });

  it("a failure → 502", async () => {
    detectDuplicates.mockRejectedValue(new Error("Garmin unreachable"));
    const res = await POST();
    expect(res.status).toBe(502);
  });
});
