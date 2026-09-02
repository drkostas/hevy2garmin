/**
 * Authenticated Garmin connectapi DELETE.
 *
 * garmin-auth's GarminClient exposes GET (connectapi), POST and PUT but no
 * DELETE, so this replicates the client's request — the connectapi base URL, the
 * di_token Bearer, the native headers, and one 401 token-refresh retry — using
 * only the client's PUBLIC members (di_token, domain, refreshDiToken). Replace
 * with client.delete() once garmin-auth ships one. Injectable fetch for tests.
 */
import type { GarminClient } from "garmin-auth";
import { NATIVE_API_USER_AGENT, NATIVE_X_GARMIN_USER_AGENT } from "garmin-auth";

interface DeletableClient {
  domain: string;
  di_token: string | null;
  refreshDiToken(): Promise<void>;
}

/** Mirrors garmin-auth's private nativeHeaders() + the connectapi auth header. */
function headers(client: DeletableClient): Record<string, string> {
  return {
    Authorization: `Bearer ${client.di_token ?? ""}`,
    Accept: "application/json",
    "User-Agent": NATIVE_API_USER_AGENT,
    "X-Garmin-User-Agent": NATIVE_X_GARMIN_USER_AGENT,
    "X-Garmin-Paired-App-Version": "10861",
    "X-Garmin-Client-Platform": "Android",
    "X-App-Ver": "10861",
    "X-Lang": "en",
    "X-GCExperience": "GC5",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

export async function garminDelete(
  client: GarminClient,
  path: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const c = client as unknown as DeletableClient;
  const url = `https://connectapi.${c.domain}${path}`;
  const f = opts.fetchImpl ?? fetch;
  let res = await f(url, { method: "DELETE", headers: headers(c) });
  if (res.status === 401 && typeof c.refreshDiToken === "function") {
    await c.refreshDiToken();
    res = await f(url, { method: "DELETE", headers: headers(c) });
  }
  if (!res.ok) {
    throw new Error(`Garmin DELETE ${path} → ${res.status}`);
  }
}
