"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  initialLoopState,
  stepLoop,
  loopPercent,
  errorHint,
  type LoopState,
  type SyncOneLike,
} from "@/lib/sync-loop";

/**
 * Live "Sync all" for the dashboard — ports the Python syncNow() loop. Clicking
 * Start runs /api/sync-one?live=1 repeatedly, advancing a pure reducer
 * (lib/sync-loop) and showing a live progress bar + per-status counts until
 * nothing is left, an error, or Stop. Because each iteration performs a real
 * Garmin upload, Start is behind an inline confirmation and the server also
 * requires authorization for ?live=1.
 */
export function SyncLoop({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<LoopState>(initialLoopState);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef(false);

  async function runLoop() {
    setConfirming(false);
    setRunning(true);
    stopRef.current = false;
    let cur: LoopState = { ...initialLoopState };
    setState(cur);
    try {
      // Cap iterations defensively so a misbehaving server can't spin forever.
      for (let i = 0; i < 500; i++) {
        if (stopRef.current) {
          cur = { ...cur, done: true, message: `Paused after ${cur.synced + cur.skipped} workout(s).` };
          setState(cur);
          break;
        }
        let httpStatus = 0;
        let result: SyncOneLike = {};
        try {
          const res = await fetch("/api/sync-one?live=1", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ live: 1 }),
          });
          httpStatus = res.status;
          result = (await res.json().catch(() => ({}))) as SyncOneLike;
        } catch (err) {
          cur = { ...cur, done: true, errorKind: "generic", message: err instanceof Error ? err.message : "Network error." };
          setState(cur);
          break;
        }
        const { state: next, cont } = stepLoop(cur, { httpStatus, result });
        cur = next;
        setState(cur);
        if (!cont) break;
      }
    } finally {
      setRunning(false);
      if (cur.synced > 0) router.refresh();
    }
  }

  const pct = loopPercent(state);
  const onGarmin = state.total > 0 ? state.total - state.remaining : state.synced;

  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Sync all</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Upload every pending Hevy workout to Garmin, one at a time, with live progress.
          </p>
        </div>
        {running ? (
          <button
            type="button"
            onClick={() => { stopRef.current = true; }}
            className="rounded-lg border border-warm/50 px-3 py-1.5 text-xs font-medium text-warm transition-colors hover:bg-warm/15"
          >
            Stop
          </button>
        ) : !confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!ready}
            title={!ready ? "Connect Hevy and Garmin first" : undefined}
            className="rounded-lg bg-teal/20 px-4 py-1.5 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
          >
            Sync all now
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Upload all pending to Garmin?</span>
            <button type="button" onClick={runLoop} className="rounded-lg bg-teal px-3 py-1.5 text-xs font-medium text-black">
              Start
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-xs text-text-muted underline">
              Cancel
            </button>
          </div>
        )}
      </div>

      {(running || state.started || state.done) && (
        <div className="mt-3" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-active">
            <div
              className="h-full rounded-full bg-teal transition-all duration-300"
              style={{ width: `${pct}%` }}
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-text-secondary">
            <span>On Garmin: <span className="font-semibold text-text">{onGarmin}</span></span>
            <span>Pending: <span className="font-semibold text-text">{state.remaining}</span></span>
            <span>Synced: <span className="font-semibold text-success">{state.synced}</span></span>
            {state.skipped > 0 && <span>Skipped: <span className="font-semibold text-text-muted">{state.skipped}</span></span>}
            {running && state.currentTitle && <span className="text-text-muted">· {state.currentTitle}…</span>}
          </div>
          {state.done && state.message && (
            <p className={`mt-2 text-xs ${state.errorKind ? "text-danger" : "text-text-secondary"}`} role={state.errorKind ? "alert" : undefined}>
              {state.errorKind ? errorHint(state.errorKind) : state.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
