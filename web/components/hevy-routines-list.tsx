"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface Routine {
  id: string;
  title: string;
  exercises: number;
}

const btn =
  "rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50";

function RoutineRow({ r }: { r: Routine }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "sync" | "schedule">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [date, setDate] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [weekday, setWeekday] = useState(1); // Mon
  const [weeks, setWeeks] = useState("4");

  async function sync() {
    setBusy("sync");
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/routines/${encodeURIComponent(r.id)}/sync`, { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSynced(true);
      setMsg("Synced to Garmin as a planned workout.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function schedule() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError(recurring ? "Pick a start date first." : "Pick a date first.");
      return;
    }
    setBusy("schedule");
    setError(null);
    setMsg(null);
    try {
      const payload = recurring
        ? { mode: "recurring", weekday, start_date: date, weeks: Number.parseInt(weeks || "1", 10) }
        : { date };
      const res = await fetch(`/api/routines/${encodeURIComponent(r.id)}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; scheduled?: number; total?: number };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setShowSchedule(false);
      setMsg(recurring ? `Scheduled ${d.scheduled ?? d.total} weekly sessions.` : `Scheduled for ${date}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text">{r.title}</div>
          <div className="mt-0.5 text-xs text-text-muted">
            {r.exercises} exercise{r.exercises === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={sync} disabled={busy !== null} className={btn}>
            {busy === "sync" ? "Syncing…" : synced ? "Re-sync" : "Sync to Garmin"}
          </button>
          <button
            type="button"
            onClick={() => setShowSchedule((v) => !v)}
            disabled={busy !== null}
            className={btn}
          >
            {showSchedule ? "Cancel" : "Schedule"}
          </button>
        </div>
      </div>
      {showSchedule && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-text-muted">{recurring ? "Start date" : "Date"}</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text focus:border-teal focus:outline-none"
            />
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} className="h-3.5 w-3.5 accent-teal" />
              Repeat weekly
            </label>
          </div>
          {recurring && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-text-muted">on</label>
              <select
                value={weekday}
                onChange={(e) => setWeekday(Number.parseInt(e.target.value, 10))}
                aria-label="Weekday"
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-teal focus:outline-none"
              >
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
              <label className="text-xs text-text-muted">for</label>
              <input
                type="number"
                min={1}
                max={52}
                value={weeks}
                onChange={(e) => setWeeks(e.target.value)}
                aria-label="Weeks"
                className="w-16 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-teal focus:outline-none"
              />
              <span className="text-xs text-text-muted">weeks</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={schedule}
              disabled={busy !== null}
              className="rounded-lg bg-teal/20 px-3 py-1.5 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
            >
              {busy === "schedule" ? "Scheduling…" : recurring ? "Add weekly" : "Add to calendar"}
            </button>
            <span className="text-xs text-text-muted">Sync the routine first if you haven&apos;t.</span>
          </div>
        </div>
      )}
      {msg && !error && <div className="mt-1.5 text-xs text-success">{msg}</div>}
      {error && (
        <div className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

/**
 * Your Hevy routines, with per-routine "Sync to Garmin" (create a planned
 * workout) and "Schedule" (add it to a calendar date). Fetches /api/hevy-routines
 * (read-only) on mount; degrades quietly when Hevy is unreachable.
 */
interface BulkState {
  running: boolean;
  total: number;
  synced: number;
  failed: number;
  done: boolean;
}

export function HevyRoutinesList() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const stopRef = useRef(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/hevy-routines")
      .then((res) => res.json())
      .then((d: { routines?: Routine[]; error?: string }) => {
        if (!alive) return;
        setRoutines(Array.isArray(d.routines) ? d.routines : []);
        if (d.error) setNote(d.error);
        setPhase("ready");
      })
      .catch((err) => {
        if (!alive) return;
        setNote(err instanceof Error ? err.message : String(err));
        setPhase("ready");
      });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = query.trim()
    ? routines.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
    : routines;

  // Sync every (filtered) routine to Garmin, one at a time, with live progress.
  // Each iteration is a real Garmin planned-workout write, so it's confirmed first.
  async function syncAll() {
    setConfirmAll(false);
    const list = filtered;
    if (list.length === 0) return;
    stopRef.current = false;
    let synced = 0;
    let failed = 0;
    setBulk({ running: true, total: list.length, synced, failed, done: false });
    for (const r of list) {
      if (stopRef.current) break;
      try {
        const res = await fetch(`/api/routines/${encodeURIComponent(r.id)}/sync`, { method: "POST" });
        const d = (await res.json().catch(() => ({}))) as { ok?: boolean };
        if (res.ok && d.ok) synced += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
      setBulk({ running: true, total: list.length, synced, failed, done: false });
    }
    setBulk({ running: false, total: list.length, synced, failed, done: true });
    router.refresh();
  }

  const bulkPct = bulk && bulk.total ? Math.round(((bulk.synced + bulk.failed) / bulk.total) * 100) : 0;

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-text">Your Hevy routines</h2>
        <div className="flex flex-wrap items-center gap-2">
          {routines.length > 0 && (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search routines…"
              aria-label="Search routines"
              className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none"
            />
          )}
          {routines.length > 0 &&
            (bulk?.running ? (
              <button
                type="button"
                onClick={() => { stopRef.current = true; }}
                className="rounded-lg border border-warm/50 px-3 py-2 text-xs font-medium text-warm hover:bg-warm/15"
              >
                Stop
              </button>
            ) : !confirmAll ? (
              <button
                type="button"
                onClick={() => setConfirmAll(true)}
                className="rounded-lg bg-teal/20 px-3 py-2 text-xs font-medium text-teal hover:bg-teal/30"
              >
                Sync all
              </button>
            ) : (
              <span className="flex items-center gap-2">
                <span className="text-xs text-text-muted">Sync {filtered.length} to Garmin?</span>
                <button type="button" onClick={syncAll} className="rounded-lg bg-teal px-3 py-2 text-xs font-medium text-black">
                  Start
                </button>
                <button type="button" onClick={() => setConfirmAll(false)} className="text-xs text-text-muted underline">
                  Cancel
                </button>
              </span>
            ))}
        </div>
      </div>

      {bulk && (
        <div className="mb-3" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-active">
            <div className="h-full rounded-full bg-teal transition-all" style={{ width: `${bulkPct}%` }} role="progressbar" aria-valuenow={bulkPct} aria-valuemin={0} aria-valuemax={100} />
          </div>
          <p className="mt-1.5 text-xs text-text-secondary tabular-nums">
            {bulk.done ? "Done — " : "Syncing — "}
            <span className="text-success">{bulk.synced} synced</span>
            {bulk.failed > 0 && <span className="text-danger"> · {bulk.failed} failed</span>}
            {" of "}
            {bulk.total}
          </p>
        </div>
      )}
      {phase === "loading" ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
          Loading routines from Hevy…
        </div>
      ) : routines.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
          {note ? `Couldn't load routines: ${note}` : "No routines found in Hevy."}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
          No routines match “{query}”.
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
            {filtered.map((r) => (
              <RoutineRow key={r.id} r={r} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted tabular-nums">
            {filtered.length} of {routines.length} routine{routines.length === 1 ? "" : "s"}
          </p>
        </>
      )}
    </section>
  );
}
