import { getDb } from "@/lib/db";
import { SettingsForm } from "@/components/settings-form";
import { DangerZone } from "@/components/danger-zone";
import { SessionsCard } from "@/components/sessions-card";
import { ScanDuplicates } from "@/components/scan-duplicates";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface PlatformRow {
  platform: string;
  auth_type: string;
  status: string;
  connected_at: string | null;
  expires_at: string | null;
}

interface ConfigEntry {
  key: string;
  value: Record<string, unknown>;
  updated_at: string | null;
}

interface SettingsData {
  dbConfigured: boolean;
  platforms: PlatformRow[];
  config: ConfigEntry[];
  syncedCount: number;
}

const EMPTY: SettingsData = { dbConfigured: false, platforms: [], config: [], syncedCount: 0 };

// The user-editable config the Python app persists to app_cache (config.py).
const CONFIG_KEYS = ["user_profile", "timing", "hr_fusion", "merge_settings", "auto_sync"];

async function loadSettings(): Promise<SettingsData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }

  const [platforms, config, counts] = await Promise.all([
    sql`
      SELECT platform, auth_type, status, connected_at, expires_at
      FROM platform_credentials
      ORDER BY platform ASC
    `.catch(() => [] as PlatformRow[]),
    sql`
      SELECT key, value, updated_at
      FROM app_cache
      WHERE key = ANY(${CONFIG_KEYS})
      ORDER BY key ASC
    `.catch(() => [] as ConfigEntry[]),
    sql`SELECT count(*)::int AS n FROM synced_workouts`.catch(
      () => [] as Array<{ n: number }>,
    ),
  ]);

  return {
    dbConfigured: true,
    syncedCount: Number(counts[0]?.n ?? 0),
    platforms: platforms.map((p) => ({
      platform: p.platform,
      auth_type: p.auth_type ?? "",
      status: p.status ?? "disconnected",
      connected_at: p.connected_at ?? null,
      expires_at: p.expires_at ?? null,
    })),
    config: config.map((c) => ({
      key: c.key,
      // The postgres driver returns JSONB as a parsed object already.
      value:
        c.value && typeof c.value === "object"
          ? (c.value as Record<string, unknown>)
          : {},
      updated_at: c.updated_at ?? null,
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

function titleCase(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function StatusPill({ status }: { status: string }) {
  const connected = status === "connected" || status === "active";
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
        connected ? "bg-success/15 text-success" : "bg-surface-active text-text-muted"
      }`}
    >
      {status}
    </span>
  );
}

export default async function SettingsPage() {
  const data = await loadSettings();
  const cfg = (key: string): Record<string, unknown> =>
    data.config.find((c) => c.key === key)?.value ?? {};
  const autoSync = cfg("auto_sync");
  const hrFusion = cfg("hr_fusion");
  const merge = cfg("merge_settings");
  const profile = cfg("user_profile");
  const timing = cfg("timing");
  const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-4">
        <h1 className="text-2xl font-bold text-text">Settings</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Configuration and connection status.
        </p>
      </header>

      <div className="mb-6 rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
        Editing platform credentials from the web comes in a later phase; the
        config below is editable now.
      </div>

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Showing empty state.
        </div>
      )}

      {/* Connections */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-text">Connections</h2>
        {data.platforms.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
            No platform connections recorded.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="px-4 py-2 font-medium">Platform</th>
                  <th className="px-4 py-2 font-medium">Auth</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Connected</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.platforms.map((p) => (
                  <tr key={p.platform}>
                    <td className="px-4 py-2 font-medium text-text">{p.platform}</td>
                    <td className="px-4 py-2 text-text-secondary">
                      {p.auth_type || "—"}
                    </td>
                    <td className="px-4 py-2">
                      <StatusPill status={p.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                      {fmtDate(p.connected_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-muted">
                      {fmtDate(p.expires_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Editable config */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-text">Configuration</h2>
        <SettingsForm
          autoSyncEnabled={Boolean(autoSync.enabled)}
          autoSyncInterval={Number(autoSync.interval_minutes) || 120}
          hrFusionEnabled={hrFusion.enabled == null ? true : Boolean(hrFusion.enabled)}
          mergeWatchStrategy={String(merge.merge_watch_strategy ?? "merge")}
          weightKg={numOrNull(profile.weight_kg)}
          birthYear={numOrNull(profile.birth_year)}
          sex={profile.sex != null ? String(profile.sex) : null}
          vo2max={numOrNull(profile.vo2max)}
          timezone={profile.timezone != null ? String(profile.timezone) : null}
          mergeMode={Boolean(merge.merge_mode)}
          descriptionEnabled={Boolean(merge.description_enabled)}
          mergeOverlapPct={numOrNull(merge.merge_overlap_pct)}
          mergeMaxDriftMin={numOrNull(merge.merge_max_drift_min)}
          mergeActivityTypes={Array.isArray(merge.merge_activity_types) ? (merge.merge_activity_types as unknown[]).map(String) : []}
          workingSetSeconds={numOrNull(timing.working_set_seconds)}
          warmupSetSeconds={numOrNull(timing.warmup_set_seconds)}
          restBetweenSetsSeconds={numOrNull(timing.rest_between_sets_seconds)}
          restBetweenExercisesSeconds={numOrNull(timing.rest_between_exercises_seconds)}
        />
      </section>

      {/* All stored config (read-only reference) */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-text">Stored config</h2>
        {data.config.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
            No configuration stored yet (defaults are in use).
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.config.map((c) => (
              <div
                key={c.key}
                className="rounded-xl border border-border bg-surface-elevated p-4"
              >
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text">
                    {titleCase(c.key)}
                  </h3>
                  <span className="text-xs text-text-muted">
                    {fmtDate(c.updated_at)}
                  </span>
                </div>
                <dl className="space-y-1">
                  {Object.entries(c.value).map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-baseline justify-between gap-3 text-sm"
                    >
                      <dt className="text-text-muted">{titleCase(k)}</dt>
                      <dd className="text-right font-medium text-text-secondary">
                        {fmtValue(v)}
                      </dd>
                    </div>
                  ))}
                  {Object.keys(c.value).length === 0 && (
                    <p className="text-xs text-text-muted">Empty.</p>
                  )}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Sessions & security */}
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-text">Sessions &amp; security</h2>
        <SessionsCard />
      </section>

      {/* Maintenance */}
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-text">Maintenance</h2>
        <ScanDuplicates />
      </section>

      {/* Danger zone */}
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold text-danger">Danger zone</h2>
        <DangerZone syncedCount={data.syncedCount} />
      </section>
    </main>
  );
}
