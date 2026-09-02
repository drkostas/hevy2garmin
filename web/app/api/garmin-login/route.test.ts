import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for POST /api/garmin-login. The login Worker and the token store are
 * mocked, so NO real Garmin SSO runs and no real credentials are ever used.
 */

const workerLogin = vi.fn();
vi.mock("@/lib/garmin-login-worker", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, workerLogin: (...a: unknown[]) => workerLogin(...a) };
});

const save = vi.fn();
vi.mock("garmin-auth", () => ({
  DBTokenStore: class {
    constructor(..._a: unknown[]) {}
    save(...a: unknown[]) {
      return save(...a);
    }
  },
}));
const resetGarminClient = vi.fn();
vi.mock("@/lib/garmin-upload", () => ({
  GARMIN_TOKEN_PLATFORM: "garmin_tokens",
  resetGarminClient: () => resetGarminClient(),
}));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://h/api/garmin-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgres://ci:ci@localhost:5432/ci";
});

describe("POST /api/garmin-login", () => {
  it("400 when email/password missing", async () => {
    const res = await POST(req({ email: "" }));
    expect(res.status).toBe(400);
    expect(workerLogin).not.toHaveBeenCalled();
  });

  it("success → persists nested DI tokens and returns connected", async () => {
    workerLogin.mockResolvedValue({
      status: "success",
      di_token: "a",
      di_refresh_token: "b",
      di_client_id: "c",
    });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("connected");
    expect(save).toHaveBeenCalledWith({ di_token: "a", di_refresh_token: "b", di_client_id: "c" });
    expect(resetGarminClient).toHaveBeenCalled();
  });

  it("success but DATABASE_URL unset → 503, no store call", async () => {
    delete process.env.DATABASE_URL;
    workerLogin.mockResolvedValue({ status: "success", di_token: "a", di_refresh_token: "b", di_client_id: "c" });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    expect(res.status).toBe(503);
    expect(save).not.toHaveBeenCalled();
  });

  it("needs_mfa → passes session_id through, no persistence", async () => {
    workerLogin.mockResolvedValue({ status: "needs_mfa", session_id: "s1", mfa_method: "TOTP" });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("needs_mfa");
    expect(json.session_id).toBe("s1");
    expect(save).not.toHaveBeenCalled();
  });

  it("invalid_credentials → 401", async () => {
    workerLogin.mockResolvedValue({ status: "invalid_credentials" });
    const res = await POST(req({ email: "me@x.com", password: "bad" }));
    expect(res.status).toBe(401);
    expect((await res.json()).status).toBe("invalid_credentials");
  });

  it("rate_limited → 429 with a human retry hint", async () => {
    workerLogin.mockResolvedValue({ status: "rate_limited", retry_after_seconds: 120 });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    const json = await res.json();
    expect(res.status).toBe(429);
    expect(json.error).toMatch(/2 min/);
  });

  it("needs_captcha → 409", async () => {
    workerLogin.mockResolvedValue({ status: "needs_captcha" });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    expect(res.status).toBe(409);
  });

  it("error → 502 carrying the worker message", async () => {
    workerLogin.mockResolvedValue({ status: "error", message: "boom" });
    const res = await POST(req({ email: "me@x.com", password: "pw" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("boom");
  });
});
