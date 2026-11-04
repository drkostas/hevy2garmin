import { NextResponse } from "next/server";
import { databaseNotAnswering } from "@/lib/db-down";
import { ifNoTable } from "@/lib/missing-table";
import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { demoStatus } from "@/lib/demo-data";
import { loadGarminConnection, loadHevyConnection } from "@/lib/connections";

// Reads the live hevy2garmin Postgres at request time — never at build.
export const dynamic = "force-dynamic";

/**
 * hevy2garmin sync status, read directly from the hevy2garmin Postgres schema
 * (synced_workouts / platform_credentials — see src/hevy2garmin/db_postgres.py).
 *
 * Shape matches `HevyStatus` in hevy2garmin/universal/src/lib/api.ts so the
 * existing Expo app can consume this route too.
 */

interface RecentWorkout {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number;
  status: string;
}

interface StatusResponse {
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  recent: RecentWorkout[];
}

const EMPTY: StatusResponse = {
  hevyConnected: false,
  garminConnected: false,
  totalSynced: 0,
  syncedThisWeek: 0,
  recent: [],
};

export async function GET() {
  if (demoMode()) return NextResponse.json(demoStatus());
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    // No DATABASE_URL configured — return sane defaults rather than a 500.
    return NextResponse.json(EMPTY);
  }

  try {
    // Connection status from platform_credentials. See lib/connections.ts for which row means
    // what; both helpers guard a missing table (fresh deploy that hasn't bootstrapped the schema).
    // This used to test status === 'connected', a value nothing writes, so both flags were always
    // false, and it read Garmin off the 'garmin' row a web login never creates (#495).
    const [hevyConn, garminConn] = await Promise.all([
      loadHevyConnection(sql),
      loadGarminConnection(sql),
    ]);
    const hevyConnected = hevyConn.connected;
    const garminConnected = garminConn.connected;

    // Aggregate counts over synced_workouts (success terminal state only).
    const counts = await sql`
      SELECT
        count(*) FILTER (WHERE COALESCE(status, 'success') = 'success')::int AS total,
        count(*) FILTER (
          WHERE COALESCE(status, 'success') = 'success'
            AND synced_at >= (now() - interval '7 days')
        )::int AS week
      FROM synced_workouts
    `.catch(ifNoTable([] as Array<{ total: number; week: number }>));

    const totalSynced = counts[0]?.total ?? 0;
    const syncedThisWeek = counts[0]?.week ?? 0;

    const recentRows = await sql`
      SELECT hevy_id, title, synced_at, calories, COALESCE(status, 'success') AS status
      FROM synced_workouts
      ORDER BY synced_at DESC
      LIMIT 8
    `.catch(ifNoTable([] as Array<{
          hevy_id: string;
          title: string | null;
          synced_at: string | null;
          calories: number | null;
          status: string;
        }>));

    const recent: RecentWorkout[] = recentRows.map((r) => ({
      hevy_id: r.hevy_id,
      title: r.title ?? "",
      synced_at: r.synced_at ?? null,
      calories: Number(r.calories) || 0,
      status: r.status,
    }));

    const body: StatusResponse = {
      // If we have synced rows, Hevy has been talking to us even absent an explicit
      // platform_credentials row.
      hevyConnected: hevyConnected || totalSynced > 0,
      // Any row with a garmin_activity_id proves the Garmin link worked.
      garminConnected,
      totalSynced,
      syncedThisWeek,
      recent,
    };

    return NextResponse.json(body);
  } catch (error) {
    return databaseNotAnswering("hevy/status", error);
  }
}
