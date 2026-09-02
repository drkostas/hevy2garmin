import { NextResponse } from "next/server";
import { getHevyClient } from "@/lib/hevy-sync";
import { detectDuplicates, garminClient, type WorkoutWindow } from "@/lib/garmin-activities";

// Reads live Hevy + Garmin at request time — never at build. Read-only: it
// reports duplicate activity pairs, it never deletes anything.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/scan-duplicates
 *
 * Scans the most recent Hevy workouts for windows where Garmin holds BOTH a
 * tool-uploaded activity and the watch's own — the tell of a past sync race.
 * Returns the count (and the descriptors). Log/report only — no deletion.
 * Mirrors the Python /api/scan-duplicates.
 */
export async function POST() {
  try {
    const hevy = await getHevyClient();
    const raw = (await hevy.getAllWorkouts()) as Array<Record<string, unknown>>;
    const workouts: WorkoutWindow[] = raw.slice(0, 50).map((w) => ({
      id: String(w.id),
      title: (w.title as string | null) ?? null,
      start_time: (w.start_time as string | null) ?? null,
      end_time: (w.end_time as string | null) ?? null,
    }));
    const client = await garminClient();
    const duplicates = await detectDuplicates(client, workouts);
    return NextResponse.json({ ok: true, count: duplicates.length, duplicates });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
}
