/**
 * Text description for a synced gym workout. Ported from garmin.py
 * generate_description so every upload path produces the same body.
 * Pure — builds a string, no network.
 */
export function generateDescription(
  workout: Record<string, unknown>,
  calories: number | null,
  avgHr: number | null,
): string {
  const lines: string[] = [];
  const title = (workout.title as string) || "Workout";
  const start = (workout.start_time as string) || (workout.startTime as string) || "";
  const end = (workout.end_time as string) || (workout.endTime as string) || "";
  let durationS = 0;
  if (start && end) {
    const t0 = Date.parse(start.replace(" ", "T"));
    const t1 = Date.parse(end.replace(" ", "T"));
    if (!Number.isNaN(t0) && !Number.isNaN(t1)) durationS = Math.floor((t1 - t0) / 1000);
  }

  lines.push(`🏋️ ${title}`);
  if (durationS > 0) lines.push(`⏱️ ${Math.floor(durationS / 60)} min`);
  if (calories) lines.push(`🔥 ${calories} kcal`);
  if (avgHr) lines.push(`❤️ avg ${avgHr} bpm`);

  const exercises = (workout.exercises as Array<Record<string, unknown>>) || [];
  if (exercises.length) {
    lines.push("");
    for (const ex of exercises) {
      const name = (ex.title as string) || (ex.name as string) || "Unknown";
      const allSets = (ex.sets as Array<Record<string, unknown>>) || [];
      const normal = allSets.filter((s) => s.type === "normal");
      const warmup = allSets.filter((s) => s.type === "warmup");
      if (normal.length) {
        const nLabel = normal.length === 1 ? "set" : "sets";
        const hasDistance = normal.some((s) => s.distance_meters);
        const hasDuration = normal.some((s) => s.duration_seconds);
        const hasWeight = normal.some((s) => s.weight_kg || s.weight);
        if (hasDistance || (hasDuration && !hasWeight)) {
          const totalDist = normal.reduce((a, s) => a + (Number(s.distance_meters) || 0), 0);
          const totalDur = normal.reduce((a, s) => a + (Number(s.duration_seconds) || 0), 0);
          const parts = [`${normal.length} ${nLabel}`];
          if (totalDist > 0) parts.push(`${(totalDist / 1000).toFixed(1)}km`);
          if (totalDur > 0) parts.push(`${Math.floor(totalDur / 60)}min`);
          lines.push(`• ${name}: ${parts.join(" · ")}`);
        } else {
          const weights = normal
            .map((s) => (s.weight_kg ?? s.weight) as number | undefined)
            .filter((w): w is number => w != null);
          const reps = normal
            .map((s) => s.reps as number | undefined)
            .filter((r): r is number => r != null);
          const topWeight = weights.length ? Math.max(...weights) : 0;
          const topReps = reps.length ? Math.max(...reps) : 0;
          lines.push(`• ${name}: ${normal.length} ${nLabel} · ${topWeight.toFixed(1)}kg × ${topReps}`);
        }
      } else if (warmup.length) {
        const sLabel = warmup.length === 1 ? "set" : "sets";
        lines.push(`• ${name}: ${warmup.length} warmup ${sLabel}`);
      }
    }
  }

  lines.push("\n— synced by hevy2garmin");
  return lines.join("\n");
}
