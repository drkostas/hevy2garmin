import { describe, it, expect, vi, beforeEach } from "vitest";

const unscheduleRoutine = vi.fn();
vi.mock("@/lib/garmin-routine-sync", () => ({
  unscheduleRoutine: (...a: unknown[]) => unscheduleRoutine(...a),
}));
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
function req(body: unknown): Request {
  return new Request("http://h/api/routines/r1/unschedule", {
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
  unscheduleRoutine.mockResolvedValue({ status: "unscheduled", error: null });
});

describe("POST /api/routines/[id]/unschedule", () => {
  it("missing scheduleId → 400", async () => {
    const res = await POST(req({}), params("r1"));
    expect(res.status).toBe(400);
    expect(unscheduleRoutine).not.toHaveBeenCalled();
  });

  it("authorized (no password) → unschedules", async () => {
    const res = await POST(req({ scheduleId: "9" }), params("r1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(unscheduleRoutine).toHaveBeenCalledWith("r1", "9", expect.anything());
  });

  it("password set + no session → 401", async () => {
    authEnabled.mockReturnValue(true);
    const res = await POST(req({ scheduleId: "9" }), params("r1"));
    expect(res.status).toBe(401);
    expect(unscheduleRoutine).not.toHaveBeenCalled();
  });

  it("engine error → 502", async () => {
    unscheduleRoutine.mockResolvedValue({ status: "error", error: "Garmin DELETE → 500" });
    const res = await POST(req({ scheduleId: "9" }), params("r1"));
    expect(res.status).toBe(502);
  });
});
