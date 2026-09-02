import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchHevyRoutines = vi.fn();
vi.mock("@/lib/hevy-routines", () => ({ fetchHevyRoutines: (...a: unknown[]) => fetchHevyRoutines(...a) }));
const syncRoutine = vi.fn();
vi.mock("@/lib/garmin-routine-sync", () => ({ syncRoutine: (...a: unknown[]) => syncRoutine(...a) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const authEnabled = vi.fn();
const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({
  authEnabled: (...a: unknown[]) => authEnabled(...a),
  verifySession: (...a: unknown[]) => verifySession(...a),
  SESSION_COOKIE: "h2g_session",
}));
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }) }));

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ hevyId: id }) });
const req = () => new Request("http://h/api/routines/r1/sync", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(false); // authorized on a passwordless deploy
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  fetchHevyRoutines.mockResolvedValue([{ id: "r1", title: "Push", exercises: [] }]);
  syncRoutine.mockResolvedValue({ status: "synced", garminWorkoutId: 555, error: null });
});

describe("POST /api/routines/[id]/sync", () => {
  it("authorized (no password) → syncs the routine", async () => {
    const res = await POST(req(), params("r1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.garminWorkoutId).toBe(555);
    expect(syncRoutine).toHaveBeenCalledTimes(1);
  });

  it("password set + no session → 401, no sync", async () => {
    authEnabled.mockReturnValue(true);
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(401);
    expect(syncRoutine).not.toHaveBeenCalled();
  });

  it("routine not on Hevy → 404", async () => {
    fetchHevyRoutines.mockResolvedValue([{ id: "other" }]);
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(404);
    expect(syncRoutine).not.toHaveBeenCalled();
  });

  it("syncRoutine error → 502", async () => {
    syncRoutine.mockResolvedValue({ status: "error", garminWorkoutId: null, error: "Garmin rejected" });
    const res = await POST(req(), params("r1"));
    expect(res.status).toBe(502);
  });
});
