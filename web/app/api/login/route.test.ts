import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/login tests. Auth + the rate-limiter are mocked, so no real DB and
 * no real password are used.
 */
vi.mock("@/lib/auth", () => ({
  authEnabled: () => true,
  checkPassword: (p: string) => p === "correct-horse",
  signSession: async () => "v1.123.deadbeefdeadbeefdeadbeefdeadbeef",
  SESSION_COOKIE: "h2g_session",
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const lockoutRemaining = vi.fn();
const recordFailure = vi.fn();
const clearFailures = vi.fn();
vi.mock("@/lib/login-ratelimit", () => ({
  lockoutRemaining: (...a: unknown[]) => lockoutRemaining(...a),
  recordFailure: (...a: unknown[]) => recordFailure(...a),
  clearFailures: (...a: unknown[]) => clearFailures(...a),
  formatCooldown: (s: number) => `${s} sec`,
}));

import { POST } from "./route";

function req(password: unknown, next?: string): Request {
  const url = next ? `http://h/api/login?next=${encodeURIComponent(next)}` : "http://h/api/login";
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    body: JSON.stringify({ password }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lockoutRemaining.mockResolvedValue(0);
});

describe("POST /api/login", () => {
  it("correct password → sets cookie, clears failures, returns sanitized next", async () => {
    const res = await POST(req("correct-horse", "/settings"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.next).toBe("/settings");
    expect(res.headers.get("set-cookie")).toContain("h2g_session=");
    expect(clearFailures).toHaveBeenCalledWith(expect.anything(), "9.9.9.9");
  });

  it("an absolute (open-redirect) next is rejected → /dashboard", async () => {
    const res = await POST(req("correct-horse", "//evil.com"));
    expect((await res.json()).next).toBe("/dashboard");
  });

  it("wrong password → 401 and records a failure", async () => {
    const res = await POST(req("nope"));
    expect(res.status).toBe(401);
    expect(recordFailure).toHaveBeenCalledWith(expect.anything(), "9.9.9.9");
  });

  it("locked out → 429 before credentials are even checked", async () => {
    lockoutRemaining.mockResolvedValue(90);
    const res = await POST(req("correct-horse"));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Too many attempts/);
    expect(clearFailures).not.toHaveBeenCalled();
  });

  it("wrong password that trips the lockout → 429", async () => {
    lockoutRemaining.mockResolvedValueOnce(0).mockResolvedValueOnce(60);
    const res = await POST(req("nope"));
    expect(res.status).toBe(429);
    expect(recordFailure).toHaveBeenCalled();
  });
});
