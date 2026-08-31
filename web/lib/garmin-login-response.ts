import { NextResponse } from "next/server";
import { DBTokenStore } from "garmin-auth";
import { GARMIN_TOKEN_PLATFORM, resetGarminClient } from "@/lib/garmin-upload";
import { tokensFromResult, type WorkerLoginResult } from "@/lib/garmin-login-worker";

/** Persist the DI tokens (nested {garmin_tokens:{...}}) for the sync engine. */
async function persist(url: string, result: WorkerLoginResult): Promise<void> {
  const tokens = tokensFromResult(result);
  if (!tokens) throw new Error("Login succeeded but no DI tokens were returned.");
  const store = new DBTokenStore(url, GARMIN_TOKEN_PLATFORM);
  await store.save(tokens);
  resetGarminClient();
}

/** Map a Worker result to the HTTP response both Garmin login steps consume. */
export function toResponse(
  url: string | undefined,
  result: WorkerLoginResult,
): Promise<NextResponse> | NextResponse {
  switch (result.status) {
    case "success": {
      if (!url) {
        return NextResponse.json(
          { status: "error", error: "DATABASE_URL is not configured; cannot store the session." },
          { status: 503 },
        );
      }
      return persist(url, result)
        .then(() => NextResponse.json({ status: "connected" }))
        .catch((err) =>
          NextResponse.json(
            { status: "error", error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          ),
        );
    }
    case "needs_mfa":
      return NextResponse.json({
        status: "needs_mfa",
        session_id: result.session_id ?? "",
        mfa_method: result.mfa_method ?? "",
      });
    case "needs_captcha":
      return NextResponse.json(
        {
          status: "needs_captcha",
          error:
            "Garmin asked for a captcha. Automated sign-in can't clear it — sign in on Garmin's site and use the manual token flow.",
        },
        { status: 409 },
      );
    case "invalid_credentials":
      return NextResponse.json(
        { status: "invalid_credentials", error: "Incorrect Garmin email or password." },
        { status: 401 },
      );
    case "rate_limited":
      return NextResponse.json(
        {
          status: "rate_limited",
          retry_after_seconds: result.retry_after_seconds ?? null,
          error: result.retry_after_seconds
            ? `Garmin is rate-limiting sign-ins. Try again in about ${Math.ceil(result.retry_after_seconds / 60)} min.`
            : "Garmin is rate-limiting sign-ins. Try again later.",
        },
        { status: 429 },
      );
    default:
      return NextResponse.json(
        { status: "error", error: result.message ?? "Garmin login failed." },
        { status: 502 },
      );
  }
}
