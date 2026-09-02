import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  workerLogin,
  workerLoginMfa,
  tokensFromResult,
  DEFAULT_GARMIN_LOGIN_WORKER_URL,
  type FetchImpl,
  type WorkerLoginResult,
} from "./garmin-login-worker";

/** A FetchImpl stub that records the call and returns a canned JSON payload. */
function stub(status: number, payload: unknown) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => payload };
  };
  return { impl, calls };
}

beforeEach(() => {
  delete process.env.GARMIN_LOGIN_WORKER_URL;
});
afterEach(() => vi.unstubAllGlobals());

describe("workerLogin", () => {
  it("POSTs {email,password} to <worker>/login and returns the JSON verbatim", async () => {
    const payload: WorkerLoginResult = {
      status: "success",
      di_token: "a",
      di_refresh_token: "b",
      di_client_id: "c",
    };
    const { impl, calls } = stub(200, payload);
    const r = await workerLogin("me@x.com", "pw", impl);
    expect(r).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_GARMIN_LOGIN_WORKER_URL}/login`);
    const init = calls[0].init as { method: string; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "me@x.com", password: "pw" });
  });

  it("passes needs_mfa (with session_id) straight through", async () => {
    const { impl } = stub(200, { status: "needs_mfa", session_id: "s1", mfa_method: "TOTP" });
    const r = await workerLogin("me@x.com", "pw", impl);
    expect(r.status).toBe("needs_mfa");
    expect(r.session_id).toBe("s1");
  });

  it("honours GARMIN_LOGIN_WORKER_URL (trailing slash trimmed)", async () => {
    process.env.GARMIN_LOGIN_WORKER_URL = "https://custom.example.dev/";
    const { impl, calls } = stub(200, { status: "invalid_credentials" });
    await workerLogin("me@x.com", "pw", impl);
    expect(calls[0].url).toBe("https://custom.example.dev/login");
  });

  it("returns status:error when the network call throws", async () => {
    const impl: FetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await workerLogin("me@x.com", "pw", impl);
    expect(r.status).toBe("error");
    expect(r.message).toContain("ECONNREFUSED");
  });

  it("returns status:error when the body is not the expected shape", async () => {
    const { impl } = stub(500, { oops: true });
    const r = await workerLogin("me@x.com", "pw", impl);
    expect(r.status).toBe("error");
  });
});

describe("workerLoginMfa", () => {
  it("POSTs {session_id,mfa_code} to <worker>/login-mfa", async () => {
    const { impl, calls } = stub(200, { status: "success", di_token: "a", di_refresh_token: "b", di_client_id: "c" });
    const r = await workerLoginMfa("s1", "123456", impl);
    expect(r.status).toBe("success");
    expect(calls[0].url).toBe(`${DEFAULT_GARMIN_LOGIN_WORKER_URL}/login-mfa`);
    expect(JSON.parse((calls[0].init as { body: string }).body)).toEqual({
      session_id: "s1",
      mfa_code: "123456",
    });
  });
});

describe("tokensFromResult", () => {
  it("extracts the three DI tokens from a success result", () => {
    expect(
      tokensFromResult({ status: "success", di_token: "a", di_refresh_token: "b", di_client_id: "c" }),
    ).toEqual({ di_token: "a", di_refresh_token: "b", di_client_id: "c" });
  });
  it("returns null for a non-success result", () => {
    expect(tokensFromResult({ status: "needs_mfa", session_id: "s" })).toBeNull();
  });
  it("returns null when a token field is missing", () => {
    expect(tokensFromResult({ status: "success", di_token: "a" })).toBeNull();
  });
});
