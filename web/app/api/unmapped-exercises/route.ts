import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getHevyClient } from "@/lib/hevy-sync";
import { computeUnmapped, type WorkoutLike } from "@/lib/unmapped-exercises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/unmapped-exercises → { unmapped: [{name, count}], total }
 *
 * READ-ONLY: fetches recent Hevy workouts and the custom_mappings table, then
 * reports exercises that don't map to a Garmin FIT category (Unknown/65534) and
 * have no custom mapping. No Garmin calls and no writes. Mirrors the Python
 * _get_unmapped_exercises() feeding the "Unmapped Exercises" card.
 */
export async function GET() {
  // Custom-mapped names are excluded (best-effort: no DB → no exclusions).
  let customNames = new Set<string>();
  try {
    const sql = getDb();
    const rows = (await sql`SELECT hevy_name FROM custom_mappings`) as Array<{ hevy_name: string }>;
    customNames = new Set(rows.map((r) => String(r.hevy_name).trim().toLowerCase()));
  } catch {
    /* no DB / table → treat everything as potentially unmapped */
  }

  let workouts: WorkoutLike[];
  try {
    const client = await getHevyClient();
    workouts = (await client.getAllWorkouts()) as WorkoutLike[];
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ unmapped: [], total: 0, error }, { status: 502 });
  }

  const unmapped = computeUnmapped(workouts, customNames);
  return NextResponse.json({ unmapped, total: unmapped.length });
}
