import Link from "next/link";
import { getDb } from "@/lib/db";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface HistoryRow {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number | null;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  status: string;
}

interface HistoryData {
  dbConfigured: boolean;
  total: number;
  rows: HistoryRow[];
}

const EMPTY: HistoryData = { dbConfigured: false, total: 0, rows: [] };
const LIMIT = 100;

async function loadHistory(): Promise<HistoryData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }

  const [counts, rows] = await Promise.all([
    sql`SELECT count(*)::int AS total FROM synced_workouts`.catch(
      () => [] as Array<{ total: number }>,
    ),
    sql`
      SELECT hevy_id, title, synced_at, calories, avg_hr,
             garmin_activity_id, COALESCE(status, 'success') AS status
      FROM synced_workouts
      ORDER BY synced_at DESC
      LIMIT ${LIMIT}
    `.catch(() => [] as HistoryRow[]),
  ]);

  return {
    dbConfigured: true,
    total: counts[0]?.total ?? 0,
    rows: rows.map((r) => ({
      hevy_id: r.hevy_id,
      title: r.title ?? "",
      synced_at: r.synced_at ?? null,
      calories: r.calories != null ? Number(r.calories) : null,
      avg_hr: r.avg_hr != null ? Number(r.avg_hr) : null,
      garmin_activity_id: r.garmin_activity_id ?? null,
      status: r.status,
    })),
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

function statusLabel(status: string): string {
  if (status === "manual") return "Marked as synced";
  if (status === "skipped") return "Skipped";
  return "Uploaded";
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "bg-success/15 text-success",
    manual: "bg-warm/15 text-warm",
    skipped: "bg-surface-active text-text-muted",
    failed: "bg-danger/15 text-danger",
  };
  const cls = styles[status] ?? "bg-surface-active text-text-secondary";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      {statusLabel(status)}
    </span>
  );
}

export default async function HistoryPage() {
  const data = await loadHistory();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">Sync history</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {data.total} {data.total === 1 ? "workout" : "workouts"} resolved
          {data.total > LIMIT && <span> · showing the {LIMIT} most recent</span>}
        </p>
      </header>

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Showing empty state.
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto mb-3 text-text-muted"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
          </svg>
          <p className="text-sm font-medium text-text-secondary">
            No workouts synced yet.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Go to{" "}
            <Link href="/workouts" className="text-teal underline">
              Workouts
            </Link>{" "}
            and click Sync.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2 font-medium">Synced</th>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 text-right font-medium">Calories</th>
                <th className="px-4 py-2 text-right font-medium">Avg HR</th>
                <th className="px-4 py-2 font-medium">Garmin ID</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.rows.map((r) => (
                <tr key={r.hevy_id}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                    {fmtDate(r.synced_at)}
                  </td>
                  <td className="px-4 py-2 font-medium text-text">
                    {r.title || "Untitled workout"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                    {r.calories ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                    {r.avg_hr ?? "—"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-text-muted">
                    {r.garmin_activity_id ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={r.status} />
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
