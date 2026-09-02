import { getDb } from "@/lib/db";
import { WorkoutRow } from "@/components/workout-row";
import { CandidatesList } from "@/components/candidates-list";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface WorkoutItem {
  hevy_id: string;
  title: string;
  when: string | null;
  // Normalised state for the pill: terminal statuses from synced_workouts
  // (success/manual/skipped) or a pending phase from pending_uploads.
  state: string;
  detail: string | null;
  garmin_activity_id: string | null;
  kind: "terminal" | "pending";
}

interface WorkoutsData {
  dbConfigured: boolean;
  items: WorkoutItem[];
}

const EMPTY: WorkoutsData = { dbConfigured: false, items: [] };

async function loadWorkouts(): Promise<WorkoutsData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }

  const [terminal, pending] = await Promise.all([
    sql`
      SELECT hevy_id, title, synced_at, garmin_activity_id,
             COALESCE(status, 'success') AS status
      FROM synced_workouts
      ORDER BY synced_at DESC
      LIMIT 100
    `.catch(
      () =>
        [] as Array<{
          hevy_id: string;
          title: string | null;
          synced_at: string | null;
          garmin_activity_id: string | null;
          status: string;
        }>,
    ),
    sql`
      SELECT hevy_id, phase, next_step, last_error, garmin_activity_id,
             created_at,
             (payload ->> 'title') AS payload_title
      FROM pending_uploads
      ORDER BY created_at DESC
      LIMIT 100
    `.catch(
      () =>
        [] as Array<{
          hevy_id: string;
          phase: string | null;
          next_step: string | null;
          last_error: string | null;
          garmin_activity_id: string | null;
          created_at: string | null;
          payload_title: string | null;
        }>,
    ),
  ]);

  const pendingItems: WorkoutItem[] = pending.map((p) => ({
    hevy_id: p.hevy_id,
    title: p.payload_title ?? "",
    when: p.created_at ?? null,
    state: p.phase ?? "pending",
    detail: p.last_error ?? p.next_step ?? null,
    garmin_activity_id: p.garmin_activity_id ?? null,
    kind: "pending",
  }));

  const pendingIds = new Set(pendingItems.map((p) => p.hevy_id));

  const terminalItems: WorkoutItem[] = terminal
    // A hevy_id in pending_uploads is mid-flight; prefer its pending row.
    .filter((t) => !pendingIds.has(t.hevy_id))
    .map((t) => ({
      hevy_id: t.hevy_id,
      title: t.title ?? "",
      when: t.synced_at ?? null,
      state: t.status,
      detail: null,
      garmin_activity_id: t.garmin_activity_id ?? null,
      kind: "terminal",
    }));

  // Pending first (they need attention), then terminal, each newest-first.
  return { dbConfigured: true, items: [...pendingItems, ...terminalItems] };
}

export default async function WorkoutsPage() {
  const data = await loadWorkouts();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-text">Workouts</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Terminal and in-flight workouts recorded in the database.
        </p>
      </header>

      <div className="mb-6 rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
        Sync an unsynced workout from the To sync list, resolve an in-flight one
        with Mark as synced / Skip / Abandon, and expand a Garmin-matched workout
        to see its cached heart-rate.
      </div>

      {data.dbConfigured && <CandidatesList />}

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Showing empty state.
        </div>
      )}

      {data.items.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-sm font-medium text-text-secondary">
            No workouts recorded yet.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Synced and pending workouts will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
          {data.items.map((w) => (
            <WorkoutRow key={w.hevy_id} item={w} />
          ))}
        </ul>
      )}
    </main>
  );
}
