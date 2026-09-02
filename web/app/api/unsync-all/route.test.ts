import { describe, it, expect, vi, beforeEach } from "vitest";

const unsyncAll = vi.fn();
vi.mock("@/lib/pending-store", () => ({ unsyncAll: () => unsyncAll() }));

const cacheWrites: string[] = [];
vi.mock("@/lib/db", () => {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("INSERT INTO app_cache")) cacheWrites.push(values[0] as string);
    return [];
  }) as unknown as { (): unknown; json: <T>(v: T) => T };
  tag.json = (v) => v;
  return { getDb: () => tag };
});

let demo = false;
vi.mock("@/lib/demo", () => ({ demoMode: () => demo }));

import { POST } from "./route";

function req(body?: unknown): Request {
  return new Request("http://h/api/unsync-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheWrites.length = 0;
  demo = false;
  unsyncAll.mockResolvedValue(7);
});

describe("POST /api/unsync-all", () => {
  it("confirm=RESET → unsyncs, clears 10 cached pages, returns count", async () => {
    const res = await POST(req({ confirm: "RESET" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, count: 7 });
    expect(unsyncAll).toHaveBeenCalled();
    expect(cacheWrites).toHaveLength(10);
    expect(cacheWrites).toContain("hevy_workouts_page_1");
    expect(cacheWrites).toContain("hevy_workouts_page_10");
  });

  it("missing confirm → 400, no unsync", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(unsyncAll).not.toHaveBeenCalled();
  });

  it("wrong confirm → 400", async () => {
    const res = await POST(req({ confirm: "reset" }));
    expect(res.status).toBe(400);
  });

  it("demo mode → 403 before anything runs", async () => {
    demo = true;
    const res = await POST(req({ confirm: "RESET" }));
    expect(res.status).toBe(403);
    expect(unsyncAll).not.toHaveBeenCalled();
  });
});
