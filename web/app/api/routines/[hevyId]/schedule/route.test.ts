import { describe, it, expect, vi, beforeEach } from "vitest";

const scheduleRoutine = vi.fn();
vi.mock("@/lib/garmin-routine-sync", () => ({ scheduleRoutine: (...a: unknown[]) => scheduleRoutine(...a) }));

let syncedRow: Array<{ garmin_workout_id: string | null }> = [];
const sqlTag = vi.fn(async (..._a: unknown[]) => syncedRow);
vi.mock("@/lib/db", () => ({ getDb: () => sqlTag }));

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
function req(body: unknown): Request {
  return new Request("http://h/api/routines/r1/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(false);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  syncedRow = [{ garmin_workout_id: "555" }];
  scheduleRoutine.mockResolvedValue({ status: "scheduled", scheduleId: "9", error: null });
});

describe("POST /api/routines/[id]/schedule", () => {
  it("invalid date → 400, no schedule", async () => {
    const res = await POST(req({ date: "nope" }), params("r1"));
    expect(res.status).toBe(400);
    expect(scheduleRoutine).not.toHaveBeenCalled();
  });

  it("routine not synced yet (no garmin workout id) → 409", async () => {
    syncedRow = [];
    const res = await POST(req({ date: "2026-09-01" }), params("r1"));
    expect(res.status).toBe(409);
    expect(scheduleRoutine).not.toHaveBeenCalled();
  });

  it("valid → schedules", async () => {
    const res = await POST(req({ date: "2026-09-01" }), params("r1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(scheduleRoutine).toHaveBeenCalledWith("r1", "555", "2026-09-01", expect.anything());
  });

  it("password set + no session → 401", async () => {
    authEnabled.mockReturnValue(true);
    const res = await POST(req({ date: "2026-09-01" }), params("r1"));
    expect(res.status).toBe(401);
    expect(scheduleRoutine).not.toHaveBeenCalled();
  });
});
