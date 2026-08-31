import { NextResponse } from "next/server";
import { workerLoginMfa } from "@/lib/garmin-login-worker";
import { toResponse } from "@/lib/garmin-login-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/garmin-login-mfa
 * Body: { session_id, mfa_code }
 *
 * Step 2 of the Garmin sign-in, used only when /api/garmin-login returned
 * needs_mfa. Posts the verification code to the direct-login Cloudflare Worker,
 * which completes the SSO and returns the DI tokens. Success persists them and
 * responds { status: "connected" } exactly like step 1 (shared toResponse).
 */
export async function POST(request: Request) {
  let body: { session_id?: unknown; mfa_code?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ status: "error", error: "Invalid JSON body." }, { status: 400 });
  }

  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const code = typeof body.mfa_code === "string" ? body.mfa_code.trim() : "";
  if (!sessionId || !code) {
    return NextResponse.json(
      { status: "error", error: "A session and verification code are required." },
      { status: 400 },
    );
  }

  const result = await workerLoginMfa(sessionId, code);
  return toResponse(process.env.DATABASE_URL, result);
}
