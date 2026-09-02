import { NextResponse } from "next/server";
import { reconcilePending } from "@/lib/pending-recovery";
import { getDb } from "@/lib/db";

// Reads Garmin + the local ledger at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pending/[hevyId]/reconcile
 *
 * Checks whether Garmin already has an activity at the pending workout's start
 * time. If so, the earlier attempt landed and the pending is completed as a
 * matched success (no upload). Otherwise the pending is left in place. Mirrors
 * the Python /api/pending/{id}/reconcile. It performs a Garmin READ but never
 * uploads.
 *
 * NOTE: auth-gating is added in the login phase; intentionally open for now.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ ok: false, error: "hevyId is required." }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const result = await reconcilePending(hevyId, {}, sql);
    if (result.status === "not_found") {
      return NextResponse.json({ ok: false, error: "No pending operation." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
