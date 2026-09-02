import { getDb } from "@/lib/db";
import { SyncPanel } from "@/components/sync-panel";
import { SyncLoop } from "@/components/sync-loop";
import { BatchSync } from "@/components/batch-sync";
import { AutoSyncToggle } from "@/components/autosync-toggle";
import { PipelineDiagram } from "@/components/pipeline-diagram";
import { HEVY_TO_GARMIN } from "hevy2garmin";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface RecentWorkout {
  hevy_id: string;
  title: string;
  synced_at: string | null;
  calories: number;
  avg_hr: number | null;
  garmin_activity_id: string | null;
  status: string;
}

interface SyncLogEntry {
  id: number;
  time: string | null;
  synced: number;
  skipped: number;
  failed: number;
  trigger: string;
}

interface DashboardData {
  dbConfigured: boolean;
  hevyConnected: boolean;
  garminConnected: boolean;
  totalSynced: number;
  syncedThisWeek: number;
  markedSynced: number;
  skipped: number;
  pending: number;
  routinesSynced: number;
  routinesScheduled: number;
  recent: RecentWorkout[];
  syncLog: SyncLogEntry[];
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
}

const EMPTY: DashboardData = {
  dbConfigured: false,
  hevyConnected: false,
  garminConnected: false,
  totalSynced: 0,
  syncedThisWeek: 0,
  markedSynced: 0,
  skipped: 0,
  pending: 0,
  routinesSynced: 0,
  routinesScheduled: 0,
  recent: [],
  syncLog: [],
  autoSyncEnabled: false,
  autoSyncInterval: 120,
};

async function loadDashboard(): Promise<DashboardData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }

  // Every query is guarded so a missing/empty table degrades to a sane default
  // rather than crashing the whole page render.
  const [connected, counts, recent, syncLog, autoSync, pendingRow, routinesRow] = await Promise.all([
    sql`
      SELECT platform, status
      FROM platform_credentials
      WHERE platform IN ('hevy', 'garmin')
    `.catch(() => [] as Array<{ platform: string; status: string }>),
    sql`
      SELECT
        count(*) FILTER (WHERE COALESCE(status, 'success') = 'success')::int AS total,
        count(*) FILTER (
          WHERE COALESCE(status, 'success') = 'success'
            AND synced_at >= (now() - interval '7 days')
        )::int AS week,
        count(*) FILTER (WHERE status = 'manual')::int AS marked,
        count(*) FILTER (WHERE status = 'skipped')::int AS skipped
      FROM synced_workouts
    `.catch(() => [] as Array<{ total: number; week: number; marked: number; skipped: number }>),
    sql`
      SELECT hevy_id, title, synced_at, calories, avg_hr,
             garmin_activity_id, COALESCE(status, 'success') AS status
      FROM synced_workouts
      ORDER BY synced_at DESC
      LIMIT 10
    `.catch(() => [] as RecentWorkout[]),
    sql`
      SELECT id, time, synced, skipped, failed, trigger
      FROM sync_log
      ORDER BY id DESC
      LIMIT 10
    `.catch(() => [] as SyncLogEntry[]),
    sql`
      SELECT value FROM app_cache WHERE key = 'auto_sync' LIMIT 1
    `.catch(() => [] as Array<{ value: unknown }>),
    sql`SELECT count(*)::int AS n FROM pending_uploads`.catch(() => [] as Array<{ n: number }>),
    sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE hevy_routine_id IN (SELECT DISTINCT hevy_routine_id FROM routine_schedules)
        )::int AS scheduled
      FROM synced_routines
    `.catch(() => [] as Array<{ total: number; scheduled: number }>),
  ]);

  const autoSyncValue =
    autoSync[0]?.value && typeof autoSync[0].value === "object"
      ? (autoSync[0].value as Record<string, unknown>)
      : {};

  return {
    dbConfigured: true,
    // A saved credential row is "connected" unless explicitly disconnected.
    // The DB uses status='active' for a live connection (not 'connected').
    hevyConnected:
      connected.some((r) => r.platform === "hevy" && r.status !== "disconnected") ||
      recent.length > 0,
    garminConnected:
      connected.some((r) => r.platform === "garmin" && r.status !== "disconnected") ||
      recent.some((r) => r.garmin_activity_id != null),
    totalSynced: counts[0]?.total ?? 0,
    syncedThisWeek: counts[0]?.week ?? 0,
    markedSynced: counts[0]?.marked ?? 0,
    skipped: counts[0]?.skipped ?? 0,
    pending: pendingRow[0]?.n ?? 0,
    routinesSynced: routinesRow[0]?.total ?? 0,
    routinesScheduled: routinesRow[0]?.scheduled ?? 0,
    recent: recent.map((r) => ({
      hevy_id: r.hevy_id,
      title: r.title ?? "",
      synced_at: r.synced_at ?? null,
      calories: Number(r.calories) || 0,
      avg_hr: r.avg_hr != null ? Number(r.avg_hr) : null,
      garmin_activity_id: r.garmin_activity_id ?? null,
      status: r.status,
    })),
    syncLog: syncLog.map((r) => ({
      id: Number(r.id),
      time: r.time ?? null,
      synced: Number(r.synced) || 0,
      skipped: Number(r.skipped) || 0,
      failed: Number(r.failed) || 0,
      trigger: r.trigger ?? "manual",
    })),
    autoSyncEnabled: Boolean(autoSyncValue.enabled),
    autoSyncInterval: Number(autoSyncValue.interval_minutes) || 120,
  };
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ConnectionBadge({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface px-4 py-3 border border-border">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          connected ? "bg-success" : "bg-danger"
        }`}
        aria-hidden
      />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium text-text">{label}</span>
        <span className={`text-xs ${connected ? "text-success" : "text-text-muted"}`}>
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="rounded-xl bg-surface-elevated border border-border p-5">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${accent}`}>{value}</div>
    </div>
  );
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
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

export default async function DashboardPage() {
  const data = await loadDashboard();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">Sync status</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Your Hevy workouts flowing into Garmin Connect.
        </p>
      </header>

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Showing empty state.
        </div>
      )}

      {/* Connection badges */}
      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ConnectionBadge label="Hevy" connected={data.hevyConnected} />
        <ConnectionBadge label="Garmin Connect" connected={data.garminConnected} />
      </section>

      {data.dbConfigured && (!data.hevyConnected || !data.garminConnected) && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warm/40 bg-warm/10 p-4">
          <p className="text-sm text-warm">
            {!data.hevyConnected && !data.garminConnected
              ? "Connect Hevy and Garmin to start syncing."
              : !data.garminConnected
                ? "Garmin isn't connected — connect it to upload workouts."
                : "Hevy isn't connected — connect it to pull workouts."}
          </p>
          <a
            href="/setup"
            className="rounded-lg bg-warm/20 px-3 py-1.5 text-xs font-medium text-warm transition-colors hover:bg-warm/30"
          >
            {!data.garminConnected ? "Connect Garmin" : "Connect Hevy"} →
          </a>
        </div>
      )}

      {/* Stat cards */}
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="On Garmin" value={data.totalSynced} accent="text-teal" />
        <StatCard label="Marked synced" value={data.markedSynced} accent="text-warm" />
        <StatCard label="Skipped" value={data.skipped} accent="text-text-muted" />
        <StatCard label="Pending" value={data.pending} accent="text-warm" />
        <StatCard label="Routines synced" value={data.routinesSynced} accent="text-teal" />
        <StatCard label="Synced this week" value={data.syncedThisWeek} accent="text-text-secondary" />
      </section>

      {data.routinesSynced > 0 && (
        <section className="mb-8">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-elevated p-4">
            <div>
              <h3 className="text-sm font-semibold text-text">Routines</h3>
              <p className="mt-0.5 text-xs text-text-muted tabular-nums">
                {data.routinesSynced} synced · {data.routinesScheduled} scheduled
              </p>
            </div>
            <a href="/routines" className="text-xs font-medium text-teal underline">
              Manage →
            </a>
          </div>
        </section>
      )}

      {/* Sync controls (preview is dry-run; live upload is gated) */}
      <SyncPanel ready={data.hevyConnected && data.garminConnected} />
      <div className="mt-3">
        <SyncLoop ready={data.hevyConnected && data.garminConnected} />
      </div>
      <div className="mt-3">
        <BatchSync ready={data.hevyConnected && data.garminConnected} />
      </div>

      <div className="mb-8">
        <AutoSyncToggle enabled={data.autoSyncEnabled} interval={data.autoSyncInterval} />
      </div>

      <PipelineDiagram mappingCount={Object.keys(HEVY_TO_GARMIN).length} />

      {/* Recent synced workouts */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Recent workouts</h2>
          {data.recent.length > 0 && (
            <a href="/history" className="text-xs font-medium text-teal underline">
              All →
            </a>
          )}
        </div>
        {data.recent.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
            No synced workouts yet.
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
            {data.recent.map((w) => (
              <li
                key={w.hevy_id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-text">
                    {w.title || "Untitled workout"}
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {fmtDate(w.synced_at)}
                    {w.calories > 0 && <span> · {w.calories} kcal</span>}
                    {w.avg_hr != null && <span> · {w.avg_hr} bpm avg</span>}
                  </div>
                </div>
                <StatusPill status={w.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Sync log */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-text">Sync log</h2>
        {data.syncLog.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
            No sync runs recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Trigger</th>
                  <th className="px-4 py-2 text-right font-medium">Synced</th>
                  <th className="px-4 py-2 text-right font-medium">Skipped</th>
                  <th className="px-4 py-2 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.syncLog.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-4 py-2 text-text-secondary">{fmtDate(entry.time)}</td>
                    <td className="px-4 py-2 text-text-secondary">{entry.trigger}</td>
                    <td className="px-4 py-2 text-right text-success">{entry.synced}</td>
                    <td className="px-4 py-2 text-right text-text-muted">{entry.skipped}</td>
                    <td
                      className={`px-4 py-2 text-right ${
                        entry.failed > 0 ? "text-danger" : "text-text-muted"
                      }`}
                    >
                      {entry.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
