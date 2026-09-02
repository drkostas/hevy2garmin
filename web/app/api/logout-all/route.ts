import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bumpSessionEpoch } from "@/lib/session-epoch";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/logout-all — sign out everywhere.
 *
 * Bumps the server-side epoch so every outstanding session cookie (on all
 * devices, including v1) stops validating, then clears this device's cookie.
 * If the bump fails we do NOT pretend success — the epoch never advanced, so
 * other devices are still signed in; we surface the error so the admin can
 * retry (mirrors Python /logout-all). Session-gating is handled by the proxy.
 */
export async function POST() {
  let epoch: number;
  try {
    epoch = await bumpSessionEpoch(getDb());
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Could not sign out everywhere: ${error}` },
      { status: 500 },
    );
  }
  const res = NextResponse.json({ ok: true, epoch });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
