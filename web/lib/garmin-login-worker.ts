/**
 * Client for the Garmin direct-login Cloudflare Worker (worker-di, deployed at
 * hevy2garmin-exchange-di.gkos.workers.dev).
 *
 * Garmin blocks SSO + token exchange from cloud IP ranges (Vercel, GitHub
 * Actions), so the web can't log in to Garmin directly. The Worker runs on
 * Cloudflare's edge, which is not blocked, and does the whole credential flow
 * (including two-factor) there. The web sends the user's credentials to the
 * Worker and stores the DI tokens it returns.
 *
 *   POST /login      { email, password }
 *     → { status: "success", di_token, di_refresh_token, di_client_id }
 *     → { status: "needs_mfa", session_id, mfa_method }
 *     → { status: "needs_captcha" }          (fall back to manual sign-in)
 *     → { status: "invalid_credentials" }
 *     → { status: "rate_limited", retry_after_seconds }
 *     → { status: "error", message }
 *
 *   POST /login-mfa  { session_id, mfa_code }
 *     → { status: "success", di_token, di_refresh_token, di_client_id }
 *     → (error variants above)
 */

export const DEFAULT_GARMIN_LOGIN_WORKER_URL =
  "https://hevy2garmin-exchange-di.gkos.workers.dev";

export type WorkerLoginStatus =
  | "success"
  | "needs_mfa"
  | "needs_captcha"
  | "invalid_credentials"
  | "rate_limited"
  | "error";

export interface WorkerLoginResult {
  status: WorkerLoginStatus;
  di_token?: string;
  di_refresh_token?: string;
  di_client_id?: string;
  session_id?: string;
  mfa_method?: string;
  retry_after_seconds?: number;
  message?: string;
}

/**
 * DI tokens as garmin-auth's DBTokenStore.save() expects them. A `type` alias
 * (not an interface) so it's assignable to the store's `Record<string,unknown>`
 * parameter — interfaces lack the implicit index signature that grants that.
 */
export type GarminDiTokens = {
  di_token: string;
  di_refresh_token: string;
  di_client_id: string;
};

export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

function workerBase(): string {
  const raw = process.env.GARMIN_LOGIN_WORKER_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_GARMIN_LOGIN_WORKER_URL).replace(/\/$/, "");
}

async function callWorker(
  path: string,
  body: Record<string, string>,
  fetchImpl: FetchImpl,
): Promise<WorkerLoginResult> {
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(`${workerBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `Could not reach the Garmin login service: ${message}` };
  }

  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    return { status: "error", message: `Garmin login service returned a non-JSON response (${res.status}).` };
  }

  const status = (data as { status?: unknown } | null)?.status;
  if (typeof status === "string") {
    return data as WorkerLoginResult;
  }
  return {
    status: "error",
    message: `Garmin login service returned an unexpected response (${res.status}).`,
  };
}

/** Extract the three DI tokens from a success result, or null if incomplete. */
export function tokensFromResult(r: WorkerLoginResult): GarminDiTokens | null {
  if (r.status !== "success") return null;
  if (!r.di_token || !r.di_refresh_token || !r.di_client_id) return null;
  return {
    di_token: r.di_token,
    di_refresh_token: r.di_refresh_token,
    di_client_id: r.di_client_id,
  };
}

/** Step 1: submit email + password. */
export function workerLogin(
  email: string,
  password: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<WorkerLoginResult> {
  return callWorker("/login", { email, password }, fetchImpl);
}

/** Step 2 (only when step 1 returned needs_mfa): submit the verification code. */
export function workerLoginMfa(
  sessionId: string,
  mfaCode: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
): Promise<WorkerLoginResult> {
  return callWorker("/login-mfa", { session_id: sessionId, mfa_code: mfaCode }, fetchImpl);
}
