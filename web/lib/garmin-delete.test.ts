import { describe, it, expect, vi } from "vitest";
import { garminDelete } from "./garmin-delete";
import type { GarminClient } from "garmin-auth";

const client = {
  domain: "garmin.com",
  di_token: "tok",
  refreshDiToken: vi.fn(async () => {}),
} as unknown as GarminClient;

describe("garminDelete", () => {
  it("DELETEs the connectapi URL with the Bearer token + native headers", async () => {
    const fetchImpl = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 204 }));
    await garminDelete(client, "/workout-service/schedule/9", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("https://connectapi.garmin.com/workout-service/schedule/9");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("retries once after a 401 (token refresh)", async () => {
    const fetchImpl = vi
      .fn<(...a: unknown[]) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    (client.refreshDiToken as unknown as ReturnType<typeof vi.fn>).mockClear();
    await garminDelete(client, "/x", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(client.refreshDiToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 500 }));
    await expect(
      garminDelete(client, "/x", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/500/);
  });
});
