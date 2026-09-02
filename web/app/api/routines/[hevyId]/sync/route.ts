import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { fetchHevyRoutines } from "@/lib/hevy-routines";
import { syncRoutine } from "@/lib/garmin-routine-sync";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Fetches Hevy + writes a Garmin planned workout at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/routines/[hevyId]/sync
 *
 * Fetches the named Hevy routine and creates (or refreshes) a Garmin planned
 * workout from it. Because it WRITES to Garmin, it requires authorization when a
 * dashboard password is configured (session or Bearer CRON_SECRET); on a
 * self-hosted deploy without a password it runs directly.
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
  return verifySession(store.get(SESSION_COOKIE)?.value ?? null);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }
  if (!(await isAuthorized(request))) {
    return NextResponse.json(
      { error: "Unauthorized: syncing a routine requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const routines = await fetchHevyRoutines();
    const routine = routines.find((r) => String(r.id) === hevyId);
    if (!routine) {
      return NextResponse.json({ error: "Routine not found on Hevy." }, { status: 404 });
    }
    const result = await syncRoutine(routine, sql);
    const code = result.status === "error" ? 502 : 200;
    return NextResponse.json({ ok: result.status === "synced", ...result }, { status: code });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 502 });
  }
}
