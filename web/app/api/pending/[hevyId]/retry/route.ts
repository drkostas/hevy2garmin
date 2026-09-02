import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { retryPending } from "@/lib/pending-recovery";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads/writes Garmin + the local ledger at request time — never at build.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pending/[hevyId]/retry
 * Body: { confirm: "<hevyId>" }
 *
 * Re-attempts a stuck upload: reconciles first (so it never double-uploads),
 * then re-generates the FIT from the stored payload and re-uploads. Mirrors the
 * Python /api/pending/{id}/retry. Because it WRITES to Garmin it requires BOTH:
 *   1. an explicit confirmation: body { confirm } equal to the hevyId; AND
 *   2. authorization: a valid h2g session cookie OR Bearer CRON_SECRET (or auth
 *      being disabled entirely on a local/self-hosted deploy).
 */

async function isAuthorized(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1] === cronSecret) return true;
  }
  if (!authEnabled()) return true;
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value ?? null;
  return verifySession(cookie);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ ok: false, error: "hevyId is required." }, { status: 400 });
  }

  let body: { confirm?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.confirm !== hevyId) {
    return NextResponse.json(
      { ok: false, error: "Explicit confirmation required." },
      { status: 400 },
    );
  }

  if (!(await isAuthorized(request))) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized: a retry upload requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const result = await retryPending(hevyId, {}, sql);
    if (result.status === "not_found") {
      return NextResponse.json({ ok: false, error: "No pending operation." }, { status: 404 });
    }
    if (result.status === "no_payload") {
      return NextResponse.json(
        { ok: false, error: "Stored workout payload is unavailable." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
