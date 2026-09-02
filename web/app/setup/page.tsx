import { getDb } from "@/lib/db";
import { ConnectHevy } from "@/components/connect-hevy";
import { ConnectGarmin } from "@/components/connect-garmin";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface Conn {
  platform: string;
  status: string;
  connected_at: string | null;
}

interface SetupData {
  dbConfigured: boolean;
  hevy: Conn | null;
  garmin: Conn | null;
}

const EMPTY: SetupData = { dbConfigured: false, hevy: null, garmin: null };

async function loadSetup(): Promise<SetupData> {
  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return EMPTY;
  }
  const rows = await sql`
    SELECT platform, status, connected_at
    FROM platform_credentials
    WHERE platform IN ('hevy', 'garmin')
  `.catch(() => [] as Conn[]);
  const find = (p: string): Conn | null =>
    rows.find((r) => r.platform === p) ?? null;
  return { dbConfigured: true, hevy: find("hevy"), garmin: find("garmin") };
}

function isConnected(c: Conn | null): boolean {
  return Boolean(c && c.status !== "disconnected");
}

function fmtDate(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
        aria-hidden
      />
      <span className={`text-xs ${connected ? "text-success" : "text-text-muted"}`}>
        {connected ? "Connected" : "Not connected"}
      </span>
    </span>
  );
}

export default async function SetupPage() {
  const data = await loadSetup();
  const hevyConnected = isConnected(data.hevy);
  const garminConnected = isConnected(data.garmin);

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
        {hevyConnected && data.hevy?.connected_at && (
          <p className="mb-3 text-xs text-text-muted">
            Connected {fmtDate(data.hevy.connected_at)}.
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
        {garminConnected && data.garmin?.connected_at && (
          <p className="mb-3 text-xs text-text-muted">
            Connected {fmtDate(data.garmin.connected_at)}.
          </p>
        )}
        <ConnectGarmin connected={garminConnected} />
      </section>
    </main>
  );
}
