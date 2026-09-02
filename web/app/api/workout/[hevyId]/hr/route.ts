import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Reads the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/workout/[hevyId]/hr
 *
 * Returns the cached heart-rate timeline for a workout's matched Garmin
 * activity from the `hr_cache` table (data.samples) — mirroring
 * db.get_cached_hr. Read-only: it never calls Garmin. The sync/cron job is what
 * populates the cache, so this returns `{ samples: null }` for workouts that
 * haven't been fetched yet.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json({ error: "DATABASE_URL not configured." }, { status: 503 });
  }

  try {
    const rows = (await sql`
      SELECT data, cached_at FROM hr_cache WHERE hevy_id = ${hevyId} LIMIT 1
    `) as { data: unknown; cached_at: string | null }[];

    if (rows.length === 0) {
      return NextResponse.json({ samples: null, cached_at: null });
    }

    const data = rows[0].data;
    const raw = data && typeof data === "object" ? (data as Record<string, unknown>).samples : null;
    const samples = Array.isArray(raw)
      ? raw.map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : null;

    return NextResponse.json({
      samples: samples && samples.length > 0 ? samples : null,
      cached_at: rows[0].cached_at ?? null,
    });
  } catch (err) {
    console.error("hr read failed:", err);
    return NextResponse.json({ error: "Failed to read HR." }, { status: 500 });
  }
}
