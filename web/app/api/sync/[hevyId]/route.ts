import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { syncOneWorkout } from "@/lib/sync-one";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";

// Reads live Hevy + Postgres (and, on the live path, Garmin) at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/sync/[hevyId]  —  sync ONE specific workout. DRY-RUN BY DEFAULT.
 *
 * Same engine and the same three-layer never-duplicate contract as
 * /api/sync-one, but targets the given Hevy workout instead of the next
 * candidate. A live upload fires only when the request both asks for it
 * (?live=1 / body {live}) AND is authorized (h2g session cookie OR Bearer
 * CRON_SECRET). Anything short of both runs a dry-run.
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

function wantsLive(request: Request, body: Record<string, unknown>): boolean {
  const q = new URL(request.url).searchParams.get("live");
  if (q === "1" || q === "true") return true;
  const b = body.live;
  return b === 1 || b === true || b === "1" || b === "true";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedLive = wantsLive(request, body);
  const authorized = requestedLive ? await isAuthorized(request) : false;
  const dryRun = !(requestedLive && authorized);

  if (requestedLive && !authorized) {
    return NextResponse.json(
      { error: "Unauthorized: a live upload requires a session or CRON_SECRET." },
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
    const result = await syncOneWorkout(sql, { dryRun, targetHevyId: hevyId });
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  }
}
