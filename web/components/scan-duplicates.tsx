"use client";

import { useState } from "react";

/**
 * "Scan for duplicates" maintenance action for the settings page. Posts to
 * /api/scan-duplicates (read-only — it reports, never deletes) and shows the
 * count of tool+watch duplicate Garmin activity pairs from a past sync race.
 */
export function ScanDuplicates() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/scan-duplicates", { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; count?: number; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      const n = d.count ?? 0;
      setResult(n === 0 ? "No duplicate activities found." : `Found ${n} possible duplicate${n === 1 ? "" : "s"} — see the details in Garmin Connect.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Scan for duplicates</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Checks recent workouts for a tool + watch activity pair on Garmin (a
            past sync race). Report only — nothing is deleted.
          </p>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={busy}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
        >
          {busy ? "Scanning…" : "Scan"}
        </button>
      </div>
      {result && <p className="mt-2 text-xs text-text-secondary">{result}</p>}
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
