import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { unscheduleRoutine } from "@/lib/garmin-routine-sync";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Removes a Garmin calendar entry at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/routines/[hevyId]/unschedule
 * Body: { scheduleId: "<workoutScheduleId>" }
 *
 * Removes the Garmin calendar entry and the local routine_schedules row. Same
 * authorization gate as sync/schedule.
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

  let body: { scheduleId?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const scheduleId = typeof body.scheduleId === "string" ? body.scheduleId.trim() : "";
  if (!scheduleId) {
    return NextResponse.json({ error: "A scheduleId is required." }, { status: 400 });
  }

  if (!(await isAuthorized(request))) {
    return NextResponse.json(
      { error: "Unauthorized: unscheduling requires a session or CRON_SECRET." },
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
    const result = await unscheduleRoutine(hevyId, scheduleId, sql);
    const code = result.status === "error" ? 502 : 200;
    return NextResponse.json({ ok: result.status === "unscheduled", ...result }, { status: code });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 502 });
  }
}
