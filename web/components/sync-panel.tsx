"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Mirrors the SyncOneResult shape returned by /api/sync-one. */
interface SyncResult {
  status: "synced" | "skipped" | "deferred" | "dry_run" | "none" | "error";
  dryRun: boolean;
  wouldUpload: boolean;
  dedupDecision: string;
  workout: { hevy_id: string; title: string | null; start_time: string | null } | null;
  fitStats: {
    exercises: number;
    totalSets: number;
    calories: number;
    avgHr: number | null;
    durationS: number;
  } | null;
  existingGarminActivityId: number | null;
  garminActivityId: number | null;
  remaining: number;
  syncMethod: "upload" | "match" | null;
  error: string | null;
}

const DECISION_LABEL: Record<string, string> = {
  would_upload: "A new Garmin activity would be uploaded",
  already_synced: "Already synced — skipped",
  existing_garmin_activity: "Garmin already has this — it will be matched, not re-uploaded",
  claim_lost: "Another sync is already handling this workout",
  no_candidates: "Nothing to sync — every workout is already handled",
  no_start_time: "The next workout has no start time, so it can't be matched safely",
};

const STATUS_STYLE: Record<string, string> = {
  synced: "bg-success/15 text-success",
  dry_run: "bg-teal/15 text-teal",
  skipped: "bg-surface-active text-text-muted",
  deferred: "bg-warm/15 text-warm",
  none: "bg-surface-active text-text-muted",
  error: "bg-danger/15 text-danger",
};

function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Sync controls for the dashboard.
 *
 * "Preview" runs /api/sync-one in its default DRY-RUN mode: it computes what the
 * next sync WOULD do (which workout, whether it would upload or match an
 * existing Garmin activity) without writing anything to Garmin or the DB.
 *
 * "Sync now" opts into a real upload (?live=1). Because a bad upload creates a
 * duplicate Garmin/Strava activity, it is guarded behind an explicit inline
 * confirmation, and the server independently requires authorization before it
 * will run live.
 */
export function SyncPanel({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "live">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  async function run(live: boolean) {
    setBusy(live ? "live" : "preview");
    setError(null);
    try {
      const res = await fetch(`/api/sync-one${live ? "?live=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(live ? { live: 1 } : {}),
      });
      const d = (await res.json().catch(() => ({}))) as SyncResult & { error?: string };
      if (!res.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setResult(d);
      setConfirmLive(false);
      if (live && d.status === "synced") router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-8 rounded-xl border border-border bg-surface-elevated p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text">Run a sync</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Preview shows what the next sync would do. Nothing is uploaded until
            you choose Sync now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy !== null}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            {busy === "preview" ? "Previewing…" : "Preview"}
          </button>
          {!confirmLive ? (
            <button
              type="button"
              onClick={() => setConfirmLive(true)}
              disabled={busy !== null || !ready}
              title={ready ? undefined : "Connect Hevy and Garmin first"}
              className="rounded-lg bg-teal/20 px-3 py-1.5 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
            >
              Sync now
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => run(true)}
                disabled={busy !== null}
                className="rounded-lg bg-teal/30 px-3 py-1.5 text-sm font-medium text-teal transition-colors hover:bg-teal/40 disabled:opacity-50"
              >
                {busy === "live" ? "Syncing…" : "Confirm upload"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmLive(false)}
                disabled={busy !== null}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>

      {confirmLive && (
        <p className="mt-3 rounded-lg border border-warm/40 bg-warm/10 p-3 text-xs text-warm">
          This uploads the next workout to Garmin Connect. It runs the same
          duplicate-safety checks as the automatic sync, but it is a real upload.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                STATUS_STYLE[result.status] ?? "bg-surface-active text-text-secondary"
              }`}
            >
              {result.dryRun ? "Preview" : result.status}
            </span>
            <span className="text-sm text-text">
              {DECISION_LABEL[result.dedupDecision] ?? result.dedupDecision}
            </span>
          </div>

          {result.workout && (
            <div className="mt-3 text-sm">
              <div className="font-medium text-text">
                {result.workout.title || "Untitled workout"}
              </div>
              {result.fitStats && (
                <div className="mt-1 text-xs text-text-muted tabular-nums">
                  {result.fitStats.exercises} exercises · {result.fitStats.totalSets} sets ·{" "}
                  {result.fitStats.calories} kcal
                  {result.fitStats.avgHr != null && <> · {result.fitStats.avgHr} bpm avg</>} ·{" "}
                  {fmtDuration(result.fitStats.durationS)}
                </div>
              )}
            </div>
          )}

          {(result.garminActivityId || result.existingGarminActivityId) && (
            <div className="mt-2 text-xs text-text-muted">
              Garmin activity {result.garminActivityId ?? result.existingGarminActivityId}
              {result.syncMethod === "match" && " (matched existing)"}
            </div>
          )}

          <div className="mt-2 text-xs text-text-muted">
            {result.remaining} workout{result.remaining === 1 ? "" : "s"} left to consider
          </div>
        </div>
      )}
    </section>
  );
}
