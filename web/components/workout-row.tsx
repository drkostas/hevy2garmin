"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface WorkoutItem {
  hevy_id: string;
  title: string | null;
  when: string | null;
  garmin_activity_id: string | null;
  detail?: string | null;
  kind: "terminal" | "pending";
  state: string;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ item }: { item: WorkoutItem }) {
  const terminal: Record<string, { cls: string; label: string }> = {
    success: { cls: "bg-success/15 text-success", label: "Uploaded" },
    manual: { cls: "bg-warm/15 text-warm", label: "Marked as synced" },
    skipped: { cls: "bg-surface-active text-text-muted", label: "Skipped" },
    failed: { cls: "bg-danger/15 text-danger", label: "Failed" },
  };
  if (item.kind === "terminal") {
    const s = terminal[item.state] ?? { cls: "bg-surface-active text-text-secondary", label: item.state };
    return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
  }
  return <span className="inline-block rounded-full bg-teal/15 px-2.5 py-0.5 text-xs font-medium text-teal">{item.state}</span>;
}

function HrChart({ samples }: { samples: number[] }) {
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  const W = 600;
  const H = 120;
  const pad = 8;
  const xy = (v: number, i: number) => {
    const x = pad + (i / Math.max(1, samples.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const line = samples.map(xy).join(" ");
  const area = `${pad},${H - pad} ${line} ${W - pad},${H - pad}`;
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full rounded-lg bg-surface" style={{ height: 110 }}>
        <polygon points={area} fill="rgba(239, 68, 68, 0.12)" />
        <polyline points={line} fill="none" stroke="#ef4444" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-xs text-text-muted tabular-nums">
        <span>min {min} bpm</span>
        <span>avg {avg} bpm</span>
        <span>max {max} bpm</span>
      </div>
    </div>
  );
}

const actionBtn =
  "rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50";

/**
 * A workout row with an on-demand heart-rate chart and, for in-flight (pending)
 * workouts, manual-resolution controls. The HR toggle appears only when the
 * workout is matched to a Garmin activity; expanding it fetches the cached HR
 * from /api/workout/[id]/hr (read-only) and draws an inline SVG.
 *
 * Pending rows get a "Resolve" affordance revealing "Mark as synced" (the user
 * uploaded it themselves), "Skip" (never sync this one), and "Abandon" (drop the
 * stuck in-flight attempt so it can retry). Terminal rows get an "Unsync"
 * affordance that drops the local ledger row so the workout becomes a sync
 * candidate again. All POST to DB-only routes (no Garmin call) and refresh the
 * list on success.
 */
export function WorkoutRow({ item }: { item: WorkoutItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [samples, setSamples] = useState<number[] | null | undefined>(undefined); // undefined = not fetched
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [unsyncing, setUnsyncing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [recoveryMsg, setRecoveryMsg] = useState<string | null>(null);
  const [retryConfirm, setRetryConfirm] = useState(false);
  const canHr = Boolean(item.garmin_activity_id);
  const canResolve = item.kind === "pending";
  const canUnsync = item.kind === "terminal";

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && samples === undefined) {
      setLoading(true);
      try {
        const res = await fetch(`/api/workout/${encodeURIComponent(item.hevy_id)}/hr`);
        const d = (await res.json().catch(() => ({}))) as { samples?: unknown };
        setSamples(Array.isArray(d.samples) ? (d.samples as number[]) : null);
      } catch {
        setSamples(null);
      } finally {
        setLoading(false);
      }
    }
  }

  async function resolve(action: "mark-synced" | "skip") {
    setActing(true);
    setActionErr(null);
    try {
      const res = await fetch(`/api/workout/${encodeURIComponent(item.hevy_id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "resolved from web" }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setActionErr(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      // The server component re-queries; this row moves to terminal and the
      // pending banner count drops.
      setResolving(false);
      router.refresh();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function abandon() {
    setActing(true);
    setActionErr(null);
    try {
      const res = await fetch(`/api/pending/${encodeURIComponent(item.hevy_id)}/abandon`, {
        method: "POST",
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setActionErr(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      // The pending row is dropped; the workout becomes a candidate again and
      // this row leaves the list on refresh.
      setResolving(false);
      router.refresh();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function reconcile() {
    setActing(true);
    setActionErr(null);
    setRecoveryMsg(null);
    try {
      const res = await fetch(`/api/pending/${encodeURIComponent(item.hevy_id)}/reconcile`, {
        method: "POST",
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };
      if (!res.ok || !d.ok) {
        setActionErr(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      if (d.status === "reconciled_synced") {
        setResolving(false);
        router.refresh(); // Garmin already had it — this row is now terminal.
      } else {
        setRecoveryMsg("Not on Garmin yet — still pending.");
      }
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function retry() {
    setActing(true);
    setActionErr(null);
    setRecoveryMsg(null);
    try {
      const res = await fetch(`/api/pending/${encodeURIComponent(item.hevy_id)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: item.hevy_id }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };
      if (!res.ok || !d.ok) {
        setActionErr(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setRetryConfirm(false);
      setResolving(false);
      router.refresh();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function unsync() {
    setActing(true);
    setActionErr(null);
    try {
      const res = await fetch(`/api/unsync/${encodeURIComponent(item.hevy_id)}`, {
        method: "POST",
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setActionErr(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      // The terminal row is gone; the server re-query drops it from the list and
      // the workout becomes a sync candidate again.
      setUnsyncing(false);
      router.refresh();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  return (
    <li className={`px-4 py-3 ${item.kind === "terminal" ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text">{item.title || "Untitled workout"}</div>
          <div className="mt-0.5 text-xs text-text-muted">
            {fmtDate(item.when)}
            {item.garmin_activity_id && (
              <>
                {" · "}
                <a
                  href={`https://connect.garmin.com/modern/activity/${item.garmin_activity_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal underline underline-offset-2 hover:text-teal/80"
                  onClick={(e) => e.stopPropagation()}
                >
                  Garmin {item.garmin_activity_id}
                </a>
              </>
            )}
            {" · "}
            <a
              href={`https://hevy.com/workout/${item.hevy_id}`}
              target="_blank"
              rel="noreferrer"
              className="text-text-secondary underline underline-offset-2 hover:text-text"
              onClick={(e) => e.stopPropagation()}
            >
              Hevy
            </a>
            {item.detail && <span className="text-text-secondary"> · {item.detail}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canResolve && (
            <button type="button" onClick={() => setResolving((v) => !v)} className={actionBtn}>
              {resolving ? "Cancel" : "Resolve"}
            </button>
          )}
          {canHr && (
            <button type="button" onClick={toggle} className={actionBtn}>
              {open ? "Hide HR" : "HR"}
            </button>
          )}
          {canUnsync && (
            <button type="button" onClick={() => setUnsyncing((v) => !v)} className={actionBtn}>
              {unsyncing ? "Cancel" : "Unsync"}
            </button>
          )}
          <StatusPill item={item} />
        </div>
      </div>

      {unsyncing && (
        <div className="mt-2 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-muted">
            Remove this from the synced ledger so it can be synced again? The
            Garmin activity itself is not deleted.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={unsync}
              disabled={acting}
              className="rounded-lg bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
            >
              {acting ? "Working…" : "Unsync"}
            </button>
            {actionErr && (
              <span className="text-xs text-danger" role="alert">
                {actionErr}
              </span>
            )}
          </div>
        </div>
      )}

      {resolving && (
        <div className="mt-2 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-muted">
            This workout is still in-flight. Mark it synced, skip it, or abandon
            the stuck attempt so it can retry — none of these upload to Garmin.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => resolve("mark-synced")}
              disabled={acting}
              className="rounded-lg bg-warm/20 px-3 py-1.5 text-xs font-medium text-warm transition-colors hover:bg-warm/30 disabled:opacity-50"
            >
              {acting ? "Working…" : "Mark as synced"}
            </button>
            <button
              type="button"
              onClick={() => resolve("skip")}
              disabled={acting}
              className="rounded-lg bg-surface-active px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-border disabled:opacity-50"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={abandon}
              disabled={acting}
              title="Drop the stuck attempt so it can be retried later"
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted underline-offset-2 transition-colors hover:text-text-secondary hover:underline disabled:opacity-50"
            >
              Abandon
            </button>
            {actionErr && (
              <span className="text-xs text-danger" role="alert">
                {actionErr}
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
            <span className="text-xs text-text-muted">Recovery:</span>
            <button
              type="button"
              onClick={reconcile}
              disabled={acting}
              title="Check whether Garmin already has this activity"
              className={actionBtn}
            >
              {acting ? "Working…" : "Check Garmin"}
            </button>
            {!retryConfirm ? (
              <button
                type="button"
                onClick={() => setRetryConfirm(true)}
                disabled={acting}
                title="Re-upload this workout to Garmin"
                className={actionBtn}
              >
                Retry upload
              </button>
            ) : (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={retry}
                  disabled={acting}
                  className="rounded-lg bg-teal/20 px-3 py-1.5 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
                >
                  {acting ? "Retrying…" : "Confirm re-upload"}
                </button>
                <button
                  type="button"
                  onClick={() => setRetryConfirm(false)}
                  disabled={acting}
                  className={actionBtn}
                >
                  Cancel
                </button>
              </span>
            )}
            {recoveryMsg && (
              <span className="text-xs text-text-secondary">{recoveryMsg}</span>
            )}
          </div>
        </div>
      )}

      {open && (
        <div>
          {loading ? (
            <p className="mt-2 text-xs text-text-muted">Loading heart-rate…</p>
          ) : samples ? (
            <HrChart samples={samples} />
          ) : (
            <p className="mt-2 text-xs text-text-muted">No cached heart-rate for this workout yet.</p>
          )}
        </div>
      )}
    </li>
  );
}
