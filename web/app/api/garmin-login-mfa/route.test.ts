import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for POST /api/garmin-login-mfa. The login Worker and the token store are
 * mocked, so NO real Garmin SSO runs and no real credentials are ever used.
 */

const workerLoginMfa = vi.fn();
vi.mock("@/lib/garmin-login-worker", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, workerLoginMfa: (...a: unknown[]) => workerLoginMfa(...a) };
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
  return new Request("http://h/api/garmin-login-mfa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgres://ci:ci@localhost:5432/ci";
});

describe("POST /api/garmin-login-mfa", () => {
  it("400 when session_id or mfa_code missing", async () => {
    const res = await POST(req({ session_id: "s1" }));
    expect(res.status).toBe(400);
    expect(workerLoginMfa).not.toHaveBeenCalled();
  });

  it("success → persists tokens and returns connected", async () => {
    workerLoginMfa.mockResolvedValue({
      status: "success",
      di_token: "a",
      di_refresh_token: "b",
      di_client_id: "c",
    });
    const res = await POST(req({ session_id: "s1", mfa_code: "123456" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.status).toBe("connected");
    expect(workerLoginMfa).toHaveBeenCalledWith("s1", "123456");
    expect(save).toHaveBeenCalledWith({ di_token: "a", di_refresh_token: "b", di_client_id: "c" });
    expect(resetGarminClient).toHaveBeenCalled();
  });

  it("wrong code → error surfaces (502), no persistence", async () => {
    workerLoginMfa.mockResolvedValue({ status: "error", message: "bad code" });
    const res = await POST(req({ session_id: "s1", mfa_code: "000000" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("bad code");
    expect(save).not.toHaveBeenCalled();
  });
});
