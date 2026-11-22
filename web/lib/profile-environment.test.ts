import { afterEach, describe, expect, it, vi } from "vitest";
import { withProfile } from "./profile-context";
import type { getDb } from "./db";

const h = vi.hoisted(() => ({ cleanup: vi.fn() }));
vi.mock("hevy2garmin", async (original) => ({
  ...await original<Record<string, unknown>>(), intervalsCleanupHook: () => h.cleanup,
}));
vi.mock("./db", () => ({ getDb: () => async () => [] }));

import { resolveHevyKey } from "./hevy-sync";
import { loadHevyConnection } from "./connections";
import { getGithubPat } from "./github";
import { buildSyncDeps } from "./sync-one";

const sql = (async () => []) as unknown as ReturnType<typeof getDb>;
afterEach(() => { vi.unstubAllEnvs(); h.cleanup.mockClear(); });

describe("legacy integration credentials stay with the original account", () => {
  it("does not connect a new profile with the original account's Hevy key or GitHub token", async () => {
    vi.stubEnv("HEVY_API_KEY", "legacy-key");
    vi.stubEnv("GITHUB_PAT", "legacy-pat");
    await withProfile("new-person", async () => {
      expect(await resolveHevyKey()).toBeNull();
      expect((await loadHevyConnection(sql)).connected).toBe(false);
      expect(await getGithubPat(sql)).toBeNull();
    });
    await withProfile("default", async () => {
      expect(await resolveHevyKey()).toBe("legacy-key");
      expect((await loadHevyConnection(sql)).connected).toBe(true);
      expect(await getGithubPat(sql)).toBe("legacy-pat");
    });
  });

  it("never deletes a new profile's activity from the original account's Intervals integration", async () => {
    const hook = buildSyncDeps(sql).onWatchActivityDeleted!;
    const args: Parameters<typeof hook> = ["test-activity", "2026-11-17T10:00:00Z"];
    await withProfile("new-person", () => hook(...args));
    expect(h.cleanup).not.toHaveBeenCalled();
    await withProfile("default", () => hook(...args));
    expect(h.cleanup).toHaveBeenCalledOnce();
  });
});
