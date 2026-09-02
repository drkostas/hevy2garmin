import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gating tests for POST /api/pending/[hevyId]/retry — it WRITES to Garmin, so it
 * must require BOTH an explicit confirm token (== hevyId) AND authorization.
 */

const retryPending = vi.fn();
vi.mock("@/lib/pending-recovery", () => ({
  retryPending: (...a: unknown[]) => retryPending(...a),
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
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (...a: unknown[]) => cookieGet(...a) }),
}));

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ hevyId: id }) });
function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://h/api/pending/w1/retry", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  authEnabled.mockReturnValue(true);
  verifySession.mockReturnValue(false);
  cookieGet.mockReturnValue(undefined);
  retryPending.mockResolvedValue({ status: "synced", garminActivityId: 555, error: null });
});

describe("POST /api/pending/[id]/retry — gating", () => {
  it("missing/wrong confirm → 400, engine not called", async () => {
    const res = await POST(req({ confirm: "not-w1" }), params("w1"));
    expect(res.status).toBe(400);
    expect(retryPending).not.toHaveBeenCalled();
  });

  it("correct confirm but unauthorized → 401", async () => {
    const res = await POST(req({ confirm: "w1" }), params("w1"));
    expect(res.status).toBe(401);
    expect(retryPending).not.toHaveBeenCalled();
  });

  it("confirm + session → runs retry", async () => {
    cookieGet.mockReturnValue({ value: "c" });
    verifySession.mockReturnValue(true);
    const res = await POST(req({ confirm: "w1" }), params("w1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("synced");
    expect(retryPending).toHaveBeenCalledTimes(1);
  });

  it("confirm + auth disabled → runs retry", async () => {
    authEnabled.mockReturnValue(false);
    const res = await POST(req({ confirm: "w1" }), params("w1"));
    expect(res.status).toBe(200);
    expect(retryPending).toHaveBeenCalledTimes(1);
  });

  it("no_payload result → 409", async () => {
    authEnabled.mockReturnValue(false);
    retryPending.mockResolvedValue({ status: "no_payload", garminActivityId: null, error: null });
    const res = await POST(req({ confirm: "w1" }), params("w1"));
    expect(res.status).toBe(409);
  });
});
