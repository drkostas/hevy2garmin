import { describe, it, expect, vi, beforeEach } from "vitest";

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
  return new Request("http://h/api/garmin-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgres://ci:ci@localhost:5432/ci";
});

describe("POST /api/garmin-ticket", () => {
  it("persists the three DI tokens (nested via DBTokenStore) and returns ok", async () => {
    const res = await POST(req({ tokens: { di_token: "a", di_refresh_token: "b", di_client_id: "c" } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(save).toHaveBeenCalledWith({ di_token: "a", di_refresh_token: "b", di_client_id: "c" });
    expect(resetGarminClient).toHaveBeenCalled();
  });

  it("400 when a token field is missing", async () => {
    const res = await POST(req({ tokens: { di_token: "a" } }));
    expect(res.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("503 when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const res = await POST(req({ tokens: { di_token: "a", di_refresh_token: "b", di_client_id: "c" } }));
    expect(res.status).toBe(503);
    expect(save).not.toHaveBeenCalled();
  });
});
