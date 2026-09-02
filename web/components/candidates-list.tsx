"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Candidate {
  hevy_id: string;
  title: string | null;
  start_time: string | null;
}

interface SyncResult {
  status: string;
  dryRun: boolean;
  wouldUpload: boolean;
  dedupDecision: string;
  garminActivityId: number | null;
  error: string | null;
}

const DECISION_LABEL: Record<string, string> = {
  would_upload: "Would upload a new Garmin activity",
  existing_garmin_activity: "Garmin already has this — would match, not upload",
  already_synced: "Already synced",
  no_start_time: "No start time — can't sync safely",
  no_candidates: "No longer a candidate",
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const btn =
  "rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50";

function CandidateRow({ c, onSynced }: { c: Candidate; onSynced: (id: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "preview" | "live">(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function run(live: boolean) {
    setBusy(live ? "live" : "preview");
    setError(null);
    try {
      const res = await fetch(`/api/sync/${encodeURIComponent(c.hevy_id)}${live ? "?live=1" : ""}`, {
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
      setConfirm(false);
      if (live && d.status === "synced") {
        onSynced(c.hevy_id);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text">{c.title || "Untitled workout"}</div>
          <div className="mt-0.5 text-xs text-text-muted">{fmtDate(c.start_time)}</div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => run(false)} disabled={busy !== null} className={btn}>
            {busy === "preview" ? "Previewing…" : "Preview"}
          </button>
          {!confirm ? (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              disabled={busy !== null}
              className="rounded-lg bg-teal/20 px-2.5 py-1 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
            >
              Sync
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => run(true)}
                disabled={busy !== null}
                className="rounded-lg bg-teal/30 px-2.5 py-1 text-xs font-medium text-teal transition-colors hover:bg-teal/40 disabled:opacity-50"
              >
                {busy === "live" ? "Syncing…" : "Confirm"}
              </button>
              <button type="button" onClick={() => setConfirm(false)} disabled={busy !== null} className={btn}>
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>
      {result && !error && (
        <div className="mt-1.5 text-xs text-text-secondary">
          {result.dryRun ? "Preview: " : ""}
          {DECISION_LABEL[result.dedupDecision] ?? result.dedupDecision}
          {result.status === "synced" && result.garminActivityId
            ? ` · Garmin ${result.garminActivityId}`
            : ""}
        </div>
      )}
      {error && (
        <div className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </div>
      )}
    </li>
  );
}

/**
 * The unsynced-workouts ("to sync") list on the workouts page. Fetches
 * /api/candidates (a read-only Hevy probe) on mount and offers a per-workout
 * Preview (dry-run) and gated Sync (live). Degrades quietly when Hevy is
 * unreachable or nothing is pending.
 */
export function CandidatesList() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/candidates")
      .then((r) => r.json())
      .then((d: { candidates?: Candidate[]; error?: string }) => {
        if (!alive) return;
        setCandidates(Array.isArray(d.candidates) ? d.candidates : []);
        if (d.error) setNote(d.error);
        setPhase("ready");
      })
      .catch((err) => {
        if (!alive) return;
        setNote(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const onSynced = (id: string) => setCandidates((cs) => cs.filter((c) => c.hevy_id !== id));

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-text">To sync</h2>
      {phase === "loading" ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
          Checking Hevy for unsynced workouts…
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
          {note ? `Couldn't load candidates: ${note}` : "Everything from Hevy is already synced."}
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
          {candidates.map((c) => (
            <CandidateRow key={c.hevy_id} c={c} onSynced={onSynced} />
          ))}
        </ul>
      )}
    </section>
  );
}
