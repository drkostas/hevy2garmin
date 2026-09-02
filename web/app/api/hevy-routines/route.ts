import { NextResponse } from "next/server";
import { fetchHevyRoutines } from "@/lib/hevy-routines";

// Reads live Hevy at request time — never at build. Read-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/hevy-routines — the user's Hevy routines (id, title, exercise count).
 * Read-only. Degrades to an empty list + note when Hevy is unreachable.
 */
export async function GET() {
  try {
    const routines = await fetchHevyRoutines();
    const items = routines.map((r) => ({
      id: String(r.id ?? ""),
      title: r.title ?? r.name ?? "Untitled routine",
      exercises: (r.exercises ?? []).length,
    }));
    return NextResponse.json({ routines: items });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error, routines: [] }, { status: 200 });
  }
}
