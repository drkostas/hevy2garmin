import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSessionEpoch } from "@/lib/session-epoch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/session-epoch → { n }
 *
 * The current "sign out everywhere" counter. PUBLIC (no session required — it
 * leaks nothing) so the edge proxy can read it to verify v2 cookies. The proxy
 * caches this for a few seconds, so it is not hit per request.
 */
export async function GET() {
  try {
    const n = await getSessionEpoch(getDb());
    return NextResponse.json({ n });
  } catch {
    return NextResponse.json({ n: 0 });
  }
}
