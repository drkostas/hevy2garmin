import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ authEnabled: () => false, verifySession: async () => true, SESSION_COOKIE: "h2g_session" }));
const state: { pat: string | null } = { pat: null };
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray) => {
    const q = strings.join("?");
    if (q.includes("FROM platform_credentials WHERE platform = 'github'")) return state.pat ? [{ credentials: { pat: state.pat } }] : [];
    throw new Error("unexpected query: " + q);
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});
const { setup } = vi.hoisted(() => ({ setup: vi.fn(async () => ({ ok: true, message: "Auto-sync enabled! Workouts will sync every 2 hours." })) }));
vi.mock("@/lib/github", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/github")>()), setupGithubActions: setup }));

import { POST } from "./route";
import { withProfile } from "@/lib/profile-context";
const req = (body: unknown) => new Request("http://h/api/setup-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/setup-actions", () => {
  beforeEach(() => { state.pat = null; delete process.env.GITHUB_PAT; delete process.env.GITHUB_REPO; delete process.env.VERCEL_GIT_REPO_OWNER; delete process.env.VERCEL_GIT_REPO_SLUG; process.env.DATABASE_URL = "postgres://x"; setup.mockClear(); });
  it("refuses without a token (same message as the Python route)", async () => {
    const res = await POST(req({ interval: 120 })); expect(res.status).toBe(400); expect(await res.json()).toEqual({ ok: false, message: "GitHub token not set" });
  });
  it("refuses without a repo", async () => {
    state.pat = "ghp_x"; const res = await POST(req({})); expect(res.status).toBe(400); expect((await res.json()).message).toBe("Not deployed via Vercel (missing repo info)");
  });
  it("uses the Settings token + Vercel repo metadata and a valid interval", async () => {
    state.pat = "ghp_x"; process.env.VERCEL_GIT_REPO_OWNER = "o"; process.env.VERCEL_GIT_REPO_SLUG = "r";
    const res = await POST(req({ interval: 240 })); expect(res.status).toBe(200);
    expect(setup).toHaveBeenCalledWith({ pat: "ghp_x", repo: "o/r", databaseUrl: "postgres://x", intervalMinutes: 240 });
  });
  it("leaves the default profile's workflow alone when an added profile asks", async () => {
    state.pat = "ghp_x"; process.env.VERCEL_GIT_REPO_OWNER = "o"; process.env.VERCEL_GIT_REPO_SLUG = "r";
    const res = await withProfile("9b1b9af0-ddc8-4e4b-8209-4d436f93bb0e", () => POST(req({ interval: 240 })));
    expect(res.status).toBe(400); expect((await res.json()).message).toMatch(/default profile/); expect(setup).not.toHaveBeenCalled();
  });
});
