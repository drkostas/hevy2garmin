import { getDb } from "@/lib/db";
import { HevyRoutinesList } from "@/components/hevy-routines-list";
import { RoutineSchedules } from "@/components/routine-schedules";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface RoutineRow {
  hevy_routine_id: string;
  title: string;
  status: string;
  garmin_workout_id: string | null;
  scheduled_date: string | null;
  synced_at: string | null;
  schedules: Array<{ scheduleId: string; date: string }>;
  schedule_count: number;
}

interface RoutinesData {
  dbConfigured: boolean;
  total: number;
  scheduled: number;
  rows: RoutineRow[];
}

const EMPTY: RoutinesData = { dbConfigured: false, total: 0, scheduled: 0, rows: [] };
const LIMIT = 100;

async function loadRoutines(): Promise<RoutinesData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }

  const [rows, scheduleEntries] = await Promise.all([
    sql`
      SELECT hevy_routine_id, title, COALESCE(status, 'success') AS status,
             garmin_workout_id, scheduled_date, synced_at
      FROM synced_routines
      ORDER BY synced_at DESC NULLS LAST
      LIMIT ${LIMIT}
    `.catch(
      () =>
        [] as Array<{
          hevy_routine_id: string;
          title: string | null;
          status: string;
          garmin_workout_id: string | null;
          scheduled_date: string | null;
          synced_at: string | null;
        }>,
    ),
    sql`
      SELECT hevy_routine_id, schedule_id, scheduled_date
      FROM routine_schedules
      ORDER BY scheduled_date ASC
    `.catch(
      () => [] as Array<{ hevy_routine_id: string; schedule_id: string; scheduled_date: string | null }>,
    ),
  ]);

  const schedules = new Map<string, Array<{ scheduleId: string; date: string }>>();
  for (const e of scheduleEntries) {
    const list = schedules.get(e.hevy_routine_id) ?? [];
    list.push({ scheduleId: String(e.schedule_id), date: e.scheduled_date ?? "" });
    schedules.set(e.hevy_routine_id, list);
  }

  const mapped: RoutineRow[] = rows.map((r) => ({
    hevy_routine_id: r.hevy_routine_id,
    title: r.title ?? "",
    status: r.status,
    garmin_workout_id: r.garmin_workout_id ?? null,
    scheduled_date: r.scheduled_date ?? null,
    synced_at: r.synced_at ?? null,
    schedules: schedules.get(r.hevy_routine_id) ?? [],
    schedule_count: (schedules.get(r.hevy_routine_id) ?? []).length,
  }));

  return {
    dbConfigured: true,
    total: mapped.length,
    scheduled: mapped.filter((r) => r.schedule_count > 0).length,
    rows: mapped,
  };
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(value: string | null): string {
  if (!value) return "—";
  // scheduled_date is a plain YYYY-MM-DD string from Hevy; show it verbatim
  // rather than risk a timezone shift by parsing it as a Date.
  return value;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    success: { cls: "bg-success/15 text-success", label: "Synced" },
    failed: { cls: "bg-danger/15 text-danger", label: "Failed" },
    skipped: { cls: "bg-surface-active text-text-muted", label: "Skipped" },
  };
  const s = map[status] ?? { cls: "bg-surface-active text-text-secondary", label: status };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4">
      <div className="text-2xl font-bold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-text-muted">{label}</div>
    </div>
  );
}

export default async function RoutinesPage() {
  const data = await loadRoutines();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-text">Routines</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Hevy routines synced to Garmin as planned workouts.
        </p>
      </header>

      <div className="mb-6 rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
        Sync a Hevy routine to Garmin as a planned workout and add it to a
        calendar date. Synced routines are listed below.
      </div>

      {data.dbConfigured && <HevyRoutinesList />}

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Showing empty state.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4">
        <StatCard label="Synced routines" value={data.total} />
        <StatCard label="With a schedule" value={data.scheduled} />
      </div>

      {data.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-sm font-medium text-text-secondary">
            No routines synced yet.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Routine → Garmin planned-workout sync runs from the pipeline; synced
            routines will appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2 font-medium">Routine</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Garmin workout</th>
                <th className="px-4 py-2 font-medium">Scheduled</th>
                <th className="px-4 py-2 font-medium">Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((r) => (
                <tr key={r.hevy_routine_id}>
                  <td className="px-4 py-2 font-medium text-text">
                    {r.title || "Untitled routine"}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-2 tabular-nums text-text-secondary">
                    {r.garmin_workout_id || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <RoutineSchedules hevyRoutineId={r.hevy_routine_id} entries={r.schedules} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                    {fmtDate(r.synced_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
