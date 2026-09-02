import { NextResponse } from "next/server";
import { DBTokenStore } from "garmin-auth";
import { GARMIN_TOKEN_PLATFORM, resetGarminClient } from "@/lib/garmin-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/garmin-ticket
 * Body: { tokens: { di_token, di_refresh_token, di_client_id } }
 *
 * The manual Garmin sign-in fallback used when Garmin forces the browser embed
 * flow (captcha, or an MFA account hitting the 427 path) — the case the direct
 * /api/garmin-login can't clear. The browser signs in on Garmin's own widget,
 * pastes the resulting `ST-...` ticket, and the client exchanges it for DI
 * tokens at the CF Worker `/exchange` (which returns DI tokens directly). This
 * route just persists those tokens via DBTokenStore.save() — the same nested
 * `{garmin_tokens:{…}}` shape the sync engine reads. Mirrors Python
 * POST /api/garmin-ticket.
 */
export async function POST(request: Request) {
  let body: { tokens?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const t = body.tokens as Record<string, unknown> | undefined;
  const di_token = typeof t?.di_token === "string" ? t.di_token : "";
  const di_refresh_token = typeof t?.di_refresh_token === "string" ? t.di_refresh_token : "";
  const di_client_id = typeof t?.di_client_id === "string" ? t.di_client_id : "";
  if (!di_token || !di_refresh_token || !di_client_id) {
    return NextResponse.json(
      { ok: false, error: "tokens must include di_token, di_refresh_token, and di_client_id." },
      { status: 400 },
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL is not configured; cannot store the session." },
      { status: 503 },
    );
  }

  try {
    const store = new DBTokenStore(url, GARMIN_TOKEN_PLATFORM);
    await store.save({ di_token, di_refresh_token, di_client_id });
    resetGarminClient();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
