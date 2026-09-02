"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Entry {
  scheduleId: string;
  date: string;
}

/**
 * The scheduled calendar dates for a synced routine, each with an unschedule
 * (×) control that POSTs to /api/routines/[id]/unschedule (removes the Garmin
 * calendar entry + the local record).
 */
export function RoutineSchedules({
  hevyRoutineId,
  entries,
}: {
  hevyRoutineId: string;
  entries: Entry[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(entries);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unschedule(scheduleId: string) {
    setBusy(scheduleId);
    setError(null);
    try {
      const res = await fetch(`/api/routines/${encodeURIComponent(hevyRoutineId)}/unschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setItems((x) => x.filter((e) => e.scheduleId !== scheduleId));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((e) => (
        <span
          key={e.scheduleId}
          className="inline-flex items-center gap-1 rounded-full bg-teal/15 px-2 py-0.5 text-xs font-medium text-teal"
        >
          {e.date}
          <button
            type="button"
            onClick={() => unschedule(e.scheduleId)}
            disabled={busy !== null}
            title="Unschedule"
            className="leading-none text-teal/70 transition-colors hover:text-danger disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ))}
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
