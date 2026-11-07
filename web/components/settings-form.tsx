"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { convertWeightEntry, weightFromKg, weightToKg, type WeightUnit } from "@/lib/weight-units";
import { WeightConverter } from "./weight-converter";

interface Props {
  /** A GitHub token is saved (platform_credentials 'github'); the value itself is never sent to the browser. */
  githubTokenSet?: boolean;
  /** A self-hosted server's own sync schedule (lib/server-schedule.ts). When set, the
      GitHub token and the auto-sync controls, which only drive GitHub Actions, are hidden. */
  serverSchedule?: string | null;
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
  hrFusionEnabled: boolean;
  mergeWatchStrategy: string;
  weightKg: number | null;
  weightUnit?: WeightUnit;
  // Profile
  birthYear: number | null;
  sex: string | null;
  vo2max: number | null;
  timezone: string | null;
  // Enhance-watch + description
  mergeMode: boolean;
  descriptionEnabled: boolean;
  mergeOverlapPct: number | null;
  mergeMaxDriftMin: number | null;
  mergeActivityTypes: string[];
  // FIT timing
  workingSetSeconds: number | null;
  warmupSetSeconds: number | null;
  restBetweenSetsSeconds: number | null;
  restBetweenExercisesSeconds: number | null;
  /** Workouts that finished before this are never sync candidates (#647). */
  syncStartDate: string | null;
}

const INTERVALS = [30, 60, 120, 240, 360, 720, 1440];
const STRATEGIES: { value: string; label: string }[] = [
  { value: "replace", label: "Replace — upload a fresh strength activity" },
  { value: "merge", label: "Merge — fold sets/reps into the watch activity" },
  { value: "describe", label: "Describe — only set the watch activity's notes" },
];

function fmtInterval(m: number): string {
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return h === 1 ? "1 hour" : h < 24 ? `${h} hours` : "1 day";
}

const cardCls = "rounded-xl border border-border bg-surface-elevated p-4";
const labelCls = "mb-1 block text-xs text-text-muted";
const controlCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none";

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className={cardCls}>
      <label className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text">{label}</span>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-teal" />
      </label>
      {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

/**
 * Editable configuration form for the settings page. Posts the changed config
 * keys to /api/settings (which upserts them into app_cache, matching the Python
 * config schema in settings_save) and refreshes the server-rendered view.
 * Covers every field the Python POST /settings edits except credentials, which
 * are managed on /setup (connect-hevy / connect-garmin).
 */
export function SettingsForm(p: Props) {
  const router = useRouter();
  const [autoSync, setAutoSync] = useState(p.autoSyncEnabled);
  const [githubPat, setGithubPat] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string | null>(null);
  async function pullFromGarmin() {
    setPulling(true); setPullMsg(null);
    try {
      const res = await fetch(withBasePath("/api/pull-garmin-profile"), { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; profile?: { weight_kg?: number | null; birth_year?: number | null; sex?: string | null; vo2max?: number | null } };
      if (!res.ok || !j.ok || !j.profile) { setPullMsg(j.error ?? `Request failed (${res.status}).`); return; }
      if (j.profile.weight_kg != null) setWeightEntry({ value: String(j.profile.weight_kg), unit: "kg" });
      if (j.profile.birth_year != null) setBirthYear(String(j.profile.birth_year));
      if (j.profile.sex) setSex(j.profile.sex);
      if (j.profile.vo2max != null) setVo2max(String(j.profile.vo2max));
      setPullMsg("Pulled from Garmin. Values updated below; save to keep them.");
    } catch (err) { setPullMsg(err instanceof Error ? err.message : String(err)); }
    finally { setPulling(false); }
  }
  const [interval, setIntervalMin] = useState(p.autoSyncInterval);
  const [hrFusion, setHrFusion] = useState(p.hrFusionEnabled);
  const [strategy, setStrategy] = useState(p.mergeWatchStrategy);
  const [unit, setUnit] = useState<WeightUnit>(p.weightUnit ?? "kg");
  const [weightEntry, setWeightEntry] = useState<{ value: string; unit: WeightUnit }>({ value: p.weightKg != null ? String(p.weightKg) : "", unit: "kg" });
  const weight = convertWeightEntry(weightEntry, unit);
  const [birthYear, setBirthYear] = useState(p.birthYear != null ? String(p.birthYear) : "");
  const [sex, setSex] = useState(p.sex ?? "male");
  const [vo2max, setVo2max] = useState(p.vo2max != null ? String(p.vo2max) : "");
  const [timezone, setTimezone] = useState(p.timezone ?? "");
  const [syncStartDate, setSyncStartDate] = useState(p.syncStartDate ?? "");
  const [mergeMode, setMergeMode] = useState(p.mergeMode);
  const [descEnabled, setDescEnabled] = useState(p.descriptionEnabled);
  const [overlap, setOverlap] = useState(p.mergeOverlapPct != null ? String(p.mergeOverlapPct) : "70");
  const [drift, setDrift] = useState(p.mergeMaxDriftMin != null ? String(p.mergeMaxDriftMin) : "20");
  const [extraTypes, setExtraTypes] = useState(
    p.mergeActivityTypes.filter((t) => t && t !== "strength_training").join(", "),
  );
  const [workingSet, setWorkingSet] = useState(p.workingSetSeconds != null ? String(p.workingSetSeconds) : "40");
  const [warmupSet, setWarmupSet] = useState(p.warmupSetSeconds != null ? String(p.warmupSetSeconds) : "25");
  const [restSets, setRestSets] = useState(p.restBetweenSetsSeconds != null ? String(p.restBetweenSetsSeconds) : "75");
  const [restEx, setRestEx] = useState(p.restBetweenExercisesSeconds != null ? String(p.restBetweenExercisesSeconds) : "120");
  const [showCalc, setShowCalc] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function numOrUndef(s: string): number | undefined {
    const t = s.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const profile: Record<string, unknown> = {};
      const w = numOrUndef(weightEntry.value); if (w !== undefined) profile.weight_kg = weightToKg(w, weightEntry.unit);
      const by = numOrUndef(birthYear); if (by !== undefined) profile.birth_year = by;
      profile.sex = sex;
      const vo = numOrUndef(vo2max); if (vo !== undefined) profile.vo2max = vo;
      if (timezone.trim()) profile.timezone = timezone.trim();

      const extras = extraTypes.split(",").map((t) => t.trim()).filter(Boolean);
      const body = {
        display_units: { weight: unit },
        auto_sync: { enabled: autoSync, interval_minutes: interval },
        hr_fusion: { enabled: hrFusion },
        merge_settings: {
          merge_watch_strategy: strategy,
          merge_mode: mergeMode,
          description_enabled: descEnabled,
          merge_overlap_pct: numOrUndef(overlap) ?? 70,
          merge_max_drift_min: numOrUndef(drift) ?? 20,
          merge_activity_types: ["strength_training", ...extras],
        },
        user_profile: profile,
        // Sent even when blank: clearing it is how the older workouts come back
        // as candidates, so an empty string has to reach the server.
        sync_window: { start_date: syncStartDate.trim() },
        timing: {
          working_set_seconds: numOrUndef(workingSet) ?? 40,
          warmup_set_seconds: numOrUndef(warmupSet) ?? 25,
          rest_between_sets_seconds: numOrUndef(restSets) ?? 75,
          rest_between_exercises_seconds: numOrUndef(restEx) ?? 120,
        },
      };
      if (githubPat.trim()) (body as Record<string, unknown>).github_pat = githubPat.trim();
      const res = await fetch(withBasePath("/api/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Request failed (${res.status}).`);
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-text">Weight units</h3>
        <label className={`${labelCls} mt-3`} htmlFor="sf-weight-unit">Preferred weight unit</label>
        <select id="sf-weight-unit" value={unit} onChange={(e) => setUnit(e.target.value as WeightUnit)} className={controlCls}>
          <option value="kg">Kilograms (kg)</option>
          <option value="lb">Pounds (lbs)</option>
        </select>
        <p className="mt-2 text-xs text-text-muted">Used for your body weight and Garmin workout notes. Save to apply to future syncs and resyncs.</p>
        <WeightConverter />
      </div>
      {!p.serverSchedule && <div className={cardCls}>
        <label className={labelCls} htmlFor="github_pat">GitHub token (auto-sync on your fork)</label>
        <input id="github_pat" type="password" autoComplete="off" value={githubPat} onChange={(e) => setGithubPat(e.target.value)}
          placeholder={p.githubTokenSet ? "•••• saved — enter a new one to replace it" : "ghp_… (repo + workflow scope)"} className={controlCls} />
        <p className="mt-0.5 text-xs text-text-muted">Stored in your database, same row the Python dashboard uses. Needed to enable auto-sync on Vercel.</p>
      </div>}
      {/* Sync */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {p.serverSchedule ? (
          <div className={cardCls}>
            <span className="text-sm font-semibold text-text">Auto-sync</span>
            <p className="mt-0.5 text-xs text-text-muted">
              This server syncs {p.serverSchedule}, and the Hevy webhook syncs each finished workout.
              The schedule is part of the server&apos;s deployment.
            </p>
          </div>
        ) : (
        <div className={cardCls}>
          <label className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-text">Auto-sync</span>
            <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} className="h-4 w-4 accent-teal" />
          </label>
          <p className="mb-2 mt-0.5 text-xs text-text-muted">Poll Hevy and push new workouts on a schedule.</p>
          <label className={labelCls} htmlFor="sf-interval">Interval</label>
          <select id="sf-interval" value={interval} onChange={(e) => setIntervalMin(Number.parseInt(e.target.value, 10))} disabled={!autoSync} className={`${controlCls} disabled:opacity-50`}>
            {INTERVALS.map((m) => (<option key={m} value={m}>{fmtInterval(m)}</option>))}
          </select>
        </div>
        )}
        <Toggle label="HR fusion" checked={hrFusion} onChange={setHrFusion} hint="Pull heart-rate from a matched Garmin activity into the synced workout." />
      </div>

      {/* Profile */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Your profile</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={cardCls}>
            <label className={labelCls} htmlFor="sf-weight">Body weight ({unit === "lb" ? "lbs" : "kg"})</label>
            <input id="sf-weight" type="number" min={weightFromKg(1, unit)} max={weightFromKg(499, unit)} step="any" value={weight} onChange={(e) => setWeightEntry({ value: e.target.value, unit })} placeholder={unit === "lb" ? "180" : "80"} className={controlCls} />
          </div>
          <div className={cardCls}>
            <label className={labelCls} htmlFor="sf-birthyear">Birth year</label>
            <input id="sf-birthyear" type="number" min={1900} max={2025} step={1} value={birthYear} onChange={(e) => setBirthYear(e.target.value)} placeholder="1990" className={controlCls} />
          </div>
          <div className={cardCls}>
            <label className={labelCls} htmlFor="sf-sex">Sex</label>
            <select id="sf-sex" value={sex} onChange={(e) => setSex(e.target.value)} className={controlCls}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
          <div className={cardCls}>
            <label className={labelCls} htmlFor="sf-vo2max">VO₂max</label>
            <input id="sf-vo2max" type="number" min={1} max={99} step={0.1} value={vo2max} onChange={(e) => setVo2max(e.target.value)} placeholder="45" className={controlCls} />
          </div>
          <div className="col-span-full flex items-center gap-3">
            <button type="button" onClick={pullFromGarmin} disabled={pulling} className="rounded-lg border border-border px-3 py-1.5 text-xs text-text disabled:opacity-50">{pulling ? "Pulling…" : "Pull from Garmin"}</button>
            {pullMsg && <span className="text-xs text-text-muted">{pullMsg}</span>}
          </div>
        </div>
        <div className={`${cardCls} mt-4`}>
          <label className={labelCls} htmlFor="sf-timezone">Timezone (IANA)</label>
          <input id="sf-timezone" type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="e.g. Europe/Athens" className={controlCls} list="sf-tz-list" />
          <datalist id="sf-tz-list">
            {["UTC", "Europe/Athens", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <p className="mt-1.5 text-xs text-text-muted">Stamps local time into the FIT so Strava shows the correct workout time.</p>
        </div>
        <div className={`${cardCls} mt-4`}>
          <label className={labelCls} htmlFor="sf-start-date">Sync workouts from</label>
          <input id="sf-start-date" type="date" value={syncStartDate} onChange={(e) => setSyncStartDate(e.target.value)} className={controlCls} />
          <p className="mt-1.5 text-xs text-text-muted">
            Workouts finished before this date are never offered for sync. Useful if you logged
            older sessions in Garmin by hand. Leave it empty to consider your whole Hevy history.
          </p>
        </div>
        <button type="button" onClick={() => setShowCalc((v) => !v)} className="mt-2 text-xs text-teal underline">
          {showCalc ? "Hide" : "How are calories calculated?"}
        </button>
        {showCalc && (
          <div className="mt-2 rounded-lg border border-border bg-surface p-3 text-xs text-text-secondary">
            <p>Calories use the Keytel (2005) heart-rate equation, per minute:</p>
            <p className="my-1 font-mono text-[11px] text-text">
              male: (−55.0969 + 0.6309·HR + 0.1988·wt + 0.2017·age) / 4.184
            </p>
            <p className="font-mono text-[11px] text-text">
              female: (−20.4022 + 0.4472·HR − 0.1263·wt + 0.074·age) / 4.184
            </p>
            <p className="mt-1">Weight, birth year, sex and VO₂max above feed this estimate.</p>
          </div>
        )}
      </div>

      {/* Enhance watch / description */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Watch activities</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Toggle label="Enhance watch activities" checked={mergeMode} onChange={setMergeMode} hint="Merge Hevy sets/reps into a same-time Garmin watch activity instead of uploading a separate strength activity." />
          <Toggle label="Activity description" checked={descEnabled} onChange={setDescEnabled} hint="Write the exercise/sets summary into the Garmin activity's description." />
        </div>
        <div className={`${cardCls} mt-4`}>
          <label className={labelCls} htmlFor="sf-strategy">Merge watch strategy</label>
          <select id="sf-strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)} className={controlCls}>
            {STRATEGIES.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
          </select>
          <p className="mt-1.5 text-xs text-text-muted">How a Hevy workout is combined with a same-time watch activity.</p>
        </div>
      </div>

      {/* Advanced */}
      <div>
        <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-sm font-semibold text-text underline">
          {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
        </button>
        {showAdvanced && (
          <div className="mt-3 space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-text-muted">Watch activity matching</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-overlap">Min overlap %</label>
                  <input id="sf-overlap" type="number" min={50} max={95} step={1} value={overlap} onChange={(e) => setOverlap(e.target.value)} className={controlCls} />
                </div>
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-drift">Max drift (min)</label>
                  <input id="sf-drift" type="number" min={5} max={60} step={1} value={drift} onChange={(e) => setDrift(e.target.value)} className={controlCls} />
                </div>
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-extratypes">Extra activity types</label>
                  <input id="sf-extratypes" type="text" value={extraTypes} onChange={(e) => setExtraTypes(e.target.value)} placeholder="indoor_cardio, yoga" className={controlCls} />
                </div>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-text-muted">FIT file timing (seconds)</p>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-working">Working set</label>
                  <input id="sf-working" type="number" min={1} max={3600} step={1} value={workingSet} onChange={(e) => setWorkingSet(e.target.value)} className={controlCls} />
                </div>
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-warmup">Warmup set</label>
                  <input id="sf-warmup" type="number" min={1} max={3600} step={1} value={warmupSet} onChange={(e) => setWarmupSet(e.target.value)} className={controlCls} />
                </div>
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-restsets">Rest / sets</label>
                  <input id="sf-restsets" type="number" min={0} max={3600} step={1} value={restSets} onChange={(e) => setRestSets(e.target.value)} className={controlCls} />
                </div>
                <div className={cardCls}>
                  <label className={labelCls} htmlFor="sf-restex">Rest / exercises</label>
                  <input id="sf-restex" type="number" min={0} max={3600} step={1} value={restEx} onChange={(e) => setRestEx(e.target.value)} className={controlCls} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50">
          {busy ? "Saving…" : "Save settings"}
        </button>
        {saved && <span className="text-xs text-success">Saved.</span>}
        {error && <span className="text-xs text-danger" role="alert">{error}</span>}
      </div>
    </form>
  );
}
