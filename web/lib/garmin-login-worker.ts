/**
 * The Garmin direct-login Worker client lives in garmin-auth (sso-worker):
 * Garmin blocks the login and token exchange from cloud IPs, so the web sends
 * the user's credentials to the Worker on Cloudflare's edge and stores the DI
 * tokens it returns. This module only picks the Worker URL for this deploy
 * (GARMIN_LOGIN_WORKER_URL, else the ecosystem's shared deploy) and keeps the
 * names the two login routes call.
 */
import { createSsoWorkerClient, tokensFromResult, DEFAULT_SSO_WORKER_URL, type SsoFetch, type WorkerLoginResult } from "garmin-auth/sso-worker";

export { tokensFromResult };
export type { WorkerLoginResult, WorkerLoginStatus, GarminDiTokens } from "garmin-auth/sso-worker";
export type FetchImpl = SsoFetch;
export const DEFAULT_GARMIN_LOGIN_WORKER_URL = DEFAULT_SSO_WORKER_URL;

function client(fetchImpl?: FetchImpl) {
  return createSsoWorkerClient({ workerUrl: process.env.GARMIN_LOGIN_WORKER_URL, fetchImpl });
}

/** Step 1: submit email + password. */
export function workerLogin(email: string, password: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).login(email, password);
}

/** Step 2 (only when step 1 returned needs_mfa): submit the verification code. */
export function workerLoginMfa(sessionId: string, mfaCode: string, fetchImpl?: FetchImpl): Promise<WorkerLoginResult> {
  return client(fetchImpl).loginMfa(sessionId, mfaCode);
}
