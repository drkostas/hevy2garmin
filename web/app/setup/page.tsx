import { getDb } from "@/lib/db";
import { demoMode } from "@/lib/demo";
import { demoSetup } from "@/lib/demo-data";
import { authEnabled, productionRuntime } from "@/lib/auth";
import { loadGarminConnection, loadHevyConnection, type Connection } from "@/lib/connections";
import { ConnectHevy } from "@/components/connect-hevy";
import { ConnectGarmin } from "@/components/connect-garmin";
import { directGarminLogin } from "@/lib/direct-login-flag";
import { SetupTimezone } from "@/components/setup-timezone";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface SetupData {
  dbConfigured: boolean;
  hevy: Connection;
  garmin: Connection;
  /** user_profile.timezone, or null when nothing has been chosen yet (#639). */
  timezone: string | null;
}

const NONE: Connection = { connected: false, connectedAt: null };
const EMPTY: SetupData = { dbConfigured: false, hevy: NONE, garmin: NONE, timezone: null };

async function loadSetup(): Promise<SetupData> {
  if (demoMode()) return demoSetup();
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }
  const [hevy, garmin, profile] = await Promise.all([
    loadHevyConnection(sql),
    loadGarminConnection(sql),
    sql`SELECT value FROM app_cache WHERE key = 'user_profile' LIMIT 1`.catch(
      () => [] as Array<{ value: unknown }>,
    ),
  ]);
  const raw = profile[0]?.value;
  const tz =
    raw && typeof raw === "object" && typeof (raw as { timezone?: unknown }).timezone === "string"
      ? ((raw as { timezone: string }).timezone.trim() || null)
      : null;
  return { dbConfigured: true, hevy, garmin, timezone: tz };
}

function fmtDate(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * `labels` exists because a timezone is not a connection (#639). Reusing this
 * dot unchanged put "Not connected" under the Timezone heading, which reads as
 * a broken integration rather than a field nobody has filled in yet.
 */
function StatusDot({
  connected,
  labels = ["Connected", "Not connected"],
  tone = "bg-danger",
}: {
  connected: boolean;
  labels?: [string, string];
  /** A missing timezone is not a failure, so it should not be red like one. */
  tone?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "bg-success" : tone}`}
        aria-hidden
      />
      <span className={`text-xs ${connected ? "text-success" : "text-text-muted"}`}>
        {connected ? labels[0] : labels[1]}
      </span>
    </span>
  );
}

/* A production deploy with no password: the proxy serves only this page and the login page
   (#550), so the connect forms would only fail. Say what to do instead. */
function SetPasswordFirst() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">Set a password first</h1>
        <p className="mt-1 text-sm text-text-secondary">
          This deployment has no dashboard password, so it serves nothing but this page.
        </p>
      </header>
      <section
        data-testid="set-password-first"
        className="rounded-xl border border-warm/40 bg-warm/10 p-5 text-sm text-text"
      >
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            In Vercel open your project, then <strong>Settings</strong> then{" "}
            <strong>Environment Variables</strong>.
          </li>
          <li>
            Add <code className="rounded bg-surface px-1">H2G_PASSWORD</code> with a password of your
            choice. Optionally add{" "}
            <code className="rounded bg-surface px-1">HEVY2GARMIN_SECRET</code> (32 random characters)
            to sign the session cookie.
          </li>
          <li>Redeploy, come back here and sign in. Setup continues after that.</li>
        </ol>
        <p className="mt-4 text-xs text-text-muted">
          Self-hosting with Docker or <code className="rounded bg-surface px-1">next start</code>: put
          the same variables in the environment. The README section &quot;Securing the dashboard&quot;
          has the details.
        </p>
      </section>
    </main>
  );
}

export default async function SetupPage() {
  // The public demo is read-only and has no owner to set a password, so it shows
  // the connected sample here rather than the password prompt, the same choice the
  // proxy makes for every demo page (#634).
  if (productionRuntime() && !authEnabled() && !demoMode()) return <SetPasswordFirst />;
  const data = await loadSetup();
  const hevyConnected = data.hevy.connected;
  const garminConnected = data.garmin.connected;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">Setup</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Connect Hevy and Garmin so your workouts can sync.
        </p>
      </header>

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset).
        </div>
      )}

      {/* Hevy */}
      <section className="mb-6 rounded-xl border border-border bg-surface-elevated p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text">Hevy</h2>
          <StatusDot connected={hevyConnected} />
        </div>
        {hevyConnected && data.hevy.connectedAt && (
          <p className="mb-3 text-xs text-text-muted">
            Connected {fmtDate(data.hevy.connectedAt)}.
          </p>
        )}
        <ConnectHevy connected={hevyConnected} />
      </section>

      {/* Garmin */}
      <section className="rounded-xl border border-border bg-surface-elevated p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text">Garmin Connect</h2>
          <StatusDot connected={garminConnected} />
        </div>
        {garminConnected && data.garmin.connectedAt && (
          <p className="mb-3 text-xs text-text-muted">
            Connected {fmtDate(data.garmin.connectedAt)}.
          </p>
        )}
        <ConnectGarmin connected={garminConnected} directLogin={directGarminLogin()} />
      </section>

      {/* Timezone (#639). Last, because it only matters once something can sync,
          and first-time users should not meet a text field before the two
          connections that actually gate everything. */}
      <section className="mt-6 rounded-xl border border-border bg-surface-elevated p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text">Timezone</h2>
          <StatusDot connected={data.timezone !== null} labels={["Set", "Not set"]} tone="bg-text-muted" />
        </div>
        <SetupTimezone current={data.timezone} />
      </section>
    </main>
  );
}
