"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const INTERVALS = [30, 60, 120, 240, 360, 720, 1440];
function fmtInterval(m: number): string {
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return h === 1 ? "1 hour" : h < 24 ? `${h} hours` : "1 day";
}

/**
 * A compact on/off switch for scheduled auto-sync, for the dashboard, with an
 * interval selector shown when it's on. The toggle posts to /api/toggle-autosync
 * (DB-only) and the interval to /api/settings (auto_sync.interval_minutes) —
 * both editable in Settings too; this is the quick control.
 */
export function AutoSyncToggle({ enabled, interval = 120 }: { enabled: boolean; interval?: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/toggle-autosync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeInterval(minutes: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_sync: { interval_minutes: minutes } }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex-1">
        <div className="text-sm font-medium text-text">Auto-sync</div>
        <div className="text-xs text-text-muted">
          {enabled
            ? `On — new workouts sync every ${fmtInterval(interval)}.`
            : "Off — sync only when you run it."}
        </div>
        {error && (
          <div className="mt-1 text-xs text-danger" role="alert">
            {error}
          </div>
        )}
      </div>
      {enabled && (
        <select
          value={interval}
          onChange={(e) => changeInterval(Number.parseInt(e.target.value, 10))}
          disabled={busy}
          aria-label="Auto-sync interval"
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-teal focus:outline-none disabled:opacity-50"
        >
          {INTERVALS.map((m) => (
            <option key={m} value={m}>
              {fmtInterval(m)}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={enabled}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-teal/60" : "bg-surface-active"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-text transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </div>
  );
}
