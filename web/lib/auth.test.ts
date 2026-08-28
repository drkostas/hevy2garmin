import { beforeEach, describe, expect, it, vi } from "vitest";
import { authEnabled, checkPassword, signSession, verifySession } from "./auth";

describe("dashboard auth contract", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("H2G_PASSWORD", "correct horse battery staple");
    vi.stubEnv("H2G_PASSWORD_HASH", "");
    vi.stubEnv("H2G_SECRET", "");
  });

  it("uses the same v2 session shape and rejects tampering", async () => {
    const cookie = await signSession();
    expect(cookie).toMatch(/^v2\.\d+\.0\.[0-9a-f]{32}$/);
    await expect(verifySession(cookie)).resolves.toBe(true);
    await expect(verifySession(`${cookie.slice(0, -1)}0`)).resolves.toBe(false);
  });

  it("binds sessions to the current epoch", async () => {
    const cookie = await signSession(undefined, 4);
    await expect(verifySession(cookie, 4)).resolves.toBe(true);
    await expect(verifySession(cookie, 3)).resolves.toBe(false);
  });

  it("does not treat H2G_SECRET alone as a login credential", () => {
    vi.stubEnv("H2G_PASSWORD", "");
    vi.stubEnv("H2G_PASSWORD_HASH", "");
    vi.stubEnv("H2G_SECRET", "a-long-signing-secret-that-is-not-a-password");
    expect(authEnabled()).toBe(false);
  });

  it("checks plaintext credentials asynchronously", async () => {
    await expect(checkPassword("correct horse battery staple")).resolves.toBe(true);
    await expect(checkPassword("wrong")).resolves.toBe(false);
  });
});
