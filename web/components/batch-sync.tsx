"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface BatchResult {
  dryRun: boolean;
  mode: "preview" | "dispatch" | "inline";
  candidates?: number;
  triggered?: boolean;
  ran?: number;
  totalSynced?: number;
  totalSkipped?: number;
  totalDeferred?: number;
  totalError?: number;
  error?: string;
}

/**
 * Batch "Sync all" for the dashboard.
 *
 * "Preview all" runs /api/sync in dry-run and reports how many workouts would
 * sync. "Sync all" opts into a real batch (?live=1): on a deployed instance it
 * triggers the sync GitHub Action (repository_dispatch); locally it loops the
 * sync engine. Because a batch uploads many activities, it is guarded behind an
 * inline confirmation, and the server independently requires authorization.
 */
export function BatchSync({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [result, setResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "live">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function run(live: boolean) {
    setBusy(live ? "live" : "preview");
    setError(null);
    try {
      const res = await fetch(`/api/sync${live ? "?live=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(live ? { live: 1 } : {}),
      });
      const d = (await res.json().catch(() => ({}))) as BatchResult;
      if (!res.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setResult(d);
      setConfirm(false);
      if (live) router.refresh();
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
          <h2 className="text-lg font-semibold text-text">Sync everything</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Preview all counts what would sync. Sync all uploads every pending
            workout (via the scheduled job when deployed).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy !== null}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
          >
            {busy === "preview" ? "Checking…" : "Preview all"}
          </button>
          {!confirm ? (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              disabled={busy !== null || !ready}
              title={ready ? undefined : "Connect Hevy and Garmin first"}
              className="rounded-lg bg-teal/20 px-3 py-1.5 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
            >
              Sync all
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => run(true)}
                disabled={busy !== null}
                className="rounded-lg bg-teal/30 px-3 py-1.5 text-sm font-medium text-teal transition-colors hover:bg-teal/40 disabled:opacity-50"
              >
                {busy === "live" ? "Starting…" : "Confirm sync all"}
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                disabled={busy !== null}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
              >
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>

      {confirm && (
        <p className="mt-3 rounded-lg border border-warm/40 bg-warm/10 p-3 text-xs text-warm">
          This syncs every pending workout to Garmin Connect. Each upload runs the
          same duplicate-safety checks as the automatic sync.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-sm">
          {result.mode === "preview" && (
            <span className="text-text">
              {result.candidates === 0
                ? "Nothing to sync — every workout is already handled."
                : `${result.candidates} workout${result.candidates === 1 ? "" : "s"} would sync.`}
            </span>
          )}
          {result.mode === "dispatch" && (
            <span className="text-success">
              Sync triggered. Workouts will appear in a few minutes.
            </span>
          )}
          {result.mode === "inline" && (
            <span className="text-text tabular-nums">
              Synced {result.totalSynced ?? 0}, skipped {result.totalSkipped ?? 0}
              {result.totalDeferred ? `, deferred ${result.totalDeferred}` : ""}
              {result.totalError ? `, ${result.totalError} error(s)` : ""}.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
