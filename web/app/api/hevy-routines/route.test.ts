import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchHevyRoutines = vi.fn();
vi.mock("@/lib/hevy-routines", () => ({
  fetchHevyRoutines: (...a: unknown[]) => fetchHevyRoutines(...a),
}));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/hevy-routines", () => {
  it("returns id/title/exercise-count", async () => {
    fetchHevyRoutines.mockResolvedValue([
      { id: "r1", title: "Push", exercises: [{}, {}] },
      { id: "r2", name: "Pull", exercises: [] },
    ]);
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.routines).toEqual([
      { id: "r1", title: "Push", exercises: 2 },
      { id: "r2", title: "Pull", exercises: 0 },
    ]);
  });

  it("a Hevy error → empty list + note (200)", async () => {
    fetchHevyRoutines.mockRejectedValue(new Error("No Hevy API key available"));
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.routines).toEqual([]);
    expect(json.error).toContain("Hevy");
  });
});
