"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  autoSyncEnabled: boolean;
  autoSyncInterval: number;
  hrFusionEnabled: boolean;
  mergeWatchStrategy: string;
  weightKg: number | null;
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
  const [interval, setIntervalMin] = useState(p.autoSyncInterval);
  const [hrFusion, setHrFusion] = useState(p.hrFusionEnabled);
  const [strategy, setStrategy] = useState(p.mergeWatchStrategy);
  const [weight, setWeight] = useState(p.weightKg != null ? String(p.weightKg) : "");
  const [birthYear, setBirthYear] = useState(p.birthYear != null ? String(p.birthYear) : "");
  const [sex, setSex] = useState(p.sex ?? "male");
  const [vo2max, setVo2max] = useState(p.vo2max != null ? String(p.vo2max) : "");
  const [timezone, setTimezone] = useState(p.timezone ?? "");
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
      const w = numOrUndef(weight); if (w !== undefined) profile.weight_kg = w;
      const by = numOrUndef(birthYear); if (by !== undefined) profile.birth_year = by;
      profile.sex = sex;
      const vo = numOrUndef(vo2max); if (vo !== undefined) profile.vo2max = vo;
      if (timezone.trim()) profile.timezone = timezone.trim();

      const extras = extraTypes.split(",").map((t) => t.trim()).filter(Boolean);
      const body = {
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
        timing: {
          working_set_seconds: numOrUndef(workingSet) ?? 40,
          warmup_set_seconds: numOrUndef(warmupSet) ?? 25,
          rest_between_sets_seconds: numOrUndef(restSets) ?? 75,
          rest_between_exercises_seconds: numOrUndef(restEx) ?? 120,
        },
      };
      const res = await fetch("/api/settings", {
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
      {/* Sync */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        <Toggle label="HR fusion" checked={hrFusion} onChange={setHrFusion} hint="Pull heart-rate from a matched Garmin activity into the synced workout." />
      </div>

      {/* Profile */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text">Your profile</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={cardCls}>
            <label className={labelCls} htmlFor="sf-weight">Body weight (kg)</label>
            <input id="sf-weight" type="number" min={1} max={499} step={0.1} value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="80" className={controlCls} />
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
