/**
 * Exercise to muscle-group mapping, with primary and secondary targets, plus
 * the per-group labels, hex colours and the volume aggregation every body map
 * draws from. One table for the web dashboard and the app; the surfaces keep
 * only their own presentation extras (Tailwind classes, SVG slugs).
 * Based on standard exercise-science / Hevy / Garmin classifications.
 */

export type MuscleGroup =
  | "chest"
  | "back"
  | "shoulders"
  | "biceps"
  | "triceps"
  | "forearms"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "calves"
  | "core";

export const ALL_MUSCLE_GROUPS: MuscleGroup[] = [
  "chest", "back", "shoulders", "biceps", "triceps", "forearms",
  "quads", "hamstrings", "glutes", "calves", "core",
];

/**
 * Aggregate muscle volumes from exercises.
 * Returns a map of muscle group → { primary: number, secondary: number }
 * weight = 1.0 for primary muscles, 0.33 for secondary (proportional contribution)
 */

export const MUSCLE_LABELS: Record<MuscleGroup, string> = {
  chest: "Chest",
  back: "Back",
  shoulders: "Shoulders",
  biceps: "Biceps",
  triceps: "Triceps",
  forearms: "Forearms",
  quads: "Quads",
  hamstrings: "Hamstrings",
  glutes: "Glutes",
  calves: "Calves",
  core: "Core",
};

/**
 * Colors for each muscle group (hex for SVG, Tailwind class for UI)
 */

export const MUSCLE_HEX: Record<MuscleGroup, string> = {
  chest: "#ef4444", back: "#22c55e", shoulders: "#f97316", biceps: "#06b6d4",
  triceps: "#a855f7", forearms: "#ec4899", quads: "#3b82f6", hamstrings: "#8b5cf6",
  glutes: "#f59e0b", calves: "#10b981", core: "#eab308",
};

export interface MuscleMapping {
  primary: MuscleGroup[];
  secondary: MuscleGroup[];
}

// Exact match mapping for all known exercises
const EXERCISE_MAP: Record<string, MuscleMapping> = {
  // --- CHEST ---
  "Bench Press (Barbell)":          { primary: ["chest"], secondary: ["triceps", "shoulders"] },
  "Incline Bench Press (Barbell)":  { primary: ["chest"], secondary: ["shoulders", "triceps"] },
  "Chest Dip":                      { primary: ["chest"], secondary: ["triceps", "shoulders"] },
  "Chest Dip (Weighted)":           { primary: ["chest"], secondary: ["triceps", "shoulders"] },
  "Chest Dip (Assisted)":           { primary: ["chest"], secondary: ["triceps", "shoulders"] },
  "Chest Fly (Machine)":            { primary: ["chest"], secondary: [] },
  "Chest Fly (Band)":               { primary: ["chest"], secondary: [] },
  "Push Up (Weighted)":             { primary: ["chest"], secondary: ["triceps", "shoulders"] },

  // --- BACK ---
  "Iso-Lateral Row (Machine)":      { primary: ["back"], secondary: ["biceps"] },
  "Iso-Lateral Low Row":            { primary: ["back"], secondary: ["biceps"] },
  "Pull Up":                        { primary: ["back"], secondary: ["biceps"] },
  "Pull Up (Assisted)":             { primary: ["back"], secondary: ["biceps"] },
  "Pull Up (Weighted)":             { primary: ["back"], secondary: ["biceps"] },
  "Bent Over Row (Barbell)":        { primary: ["back"], secondary: ["biceps", "core"] },
  "Chest Supported Incline Row (Dumbbell)": { primary: ["back"], secondary: ["biceps"] },
  "Lat Pulldown (Cable)":           { primary: ["back"], secondary: ["biceps"] },
  "Lat Pulldown (Machine)":         { primary: ["back"], secondary: ["biceps"] },
  "Reverse Grip Lat Pulldown (Cable)": { primary: ["back"], secondary: ["biceps"] },
  "Seated Cable Row - V Grip (Cable)": { primary: ["back"], secondary: ["biceps"] },
  "Straight Arm Lat Pulldown (Cable)": { primary: ["back"], secondary: [] },
  "Deadlift (Barbell)":             { primary: ["back", "hamstrings"], secondary: ["glutes", "core", "forearms"] },
  "Back Extension (Weighted Hyperextension)": { primary: ["back"], secondary: ["glutes", "hamstrings"] },
  "Back Extension (Hyperextension)": { primary: ["back"], secondary: ["glutes", "hamstrings"] },

  // --- SHOULDERS ---
  "Overhead Press (Barbell)":       { primary: ["shoulders"], secondary: ["triceps", "core"] },
  "Seated Overhead Press (Barbell)": { primary: ["shoulders"], secondary: ["triceps"] },
  "Seated Shoulder Press (Machine)": { primary: ["shoulders"], secondary: ["triceps"] },
  "Shoulder Press (Dumbbell)":      { primary: ["shoulders"], secondary: ["triceps"] },
  "Arnold Press (Dumbbell)":        { primary: ["shoulders"], secondary: ["triceps"] },
  "Lateral Raise (Dumbbell)":       { primary: ["shoulders"], secondary: [] },
  "Lateral Raise (Machine)":        { primary: ["shoulders"], secondary: [] },
  "Lateral Raise (Cable)":          { primary: ["shoulders"], secondary: [] },
  "Front Raise (Dumbbell)":         { primary: ["shoulders"], secondary: [] },
  "Front Raise (Barbell)":          { primary: ["shoulders"], secondary: [] },
  "Face Pull":                      { primary: ["shoulders"], secondary: ["back"] },
  "Rear Deltoid":                   { primary: ["shoulders"], secondary: ["back"] },
  "Rear Delt Reverse Fly (Machine)": { primary: ["shoulders"], secondary: ["back"] },
  "Rear Delt Reverse Fly (Cable)":  { primary: ["shoulders"], secondary: ["back"] },
  "Chest Supported Reverse Fly (Dumbbell)": { primary: ["shoulders"], secondary: ["back"] },
  "Shoulder Extension":             { primary: ["shoulders"], secondary: [] },
  "Shrug (Dumbbell)":               { primary: ["shoulders"], secondary: [] },

  // --- BICEPS ---
  "Hammer Curl (Dumbbell)":         { primary: ["biceps"], secondary: ["forearms"] },
  "Preacher Curl (Barbell)":        { primary: ["biceps"], secondary: [] },
  "Concentration Curl":             { primary: ["biceps"], secondary: [] },
  "Bicep Curl (Barbell)":           { primary: ["biceps"], secondary: [] },
  "Bicep Curl (Dumbbell)":          { primary: ["biceps"], secondary: [] },
  "Bicep Curl (Cable)":             { primary: ["biceps"], secondary: [] },
  "Reverse EZ-Bar Curl":            { primary: ["biceps"], secondary: ["forearms"] },

  // --- TRICEPS ---
  "Triceps Pushdown":               { primary: ["triceps"], secondary: [] },
  "Triceps Extension (Cable)":      { primary: ["triceps"], secondary: [] },
  "One-Arm Cable Cross Body Triceps Extension": { primary: ["triceps"], secondary: [] },
  "Overhead Triceps Extension (Cable)": { primary: ["triceps"], secondary: [] },

  // --- FOREARMS ---
  "Seated Palms Up Wrist Curl":     { primary: ["forearms"], secondary: [] },

  // --- QUADS ---
  "Leg Extension (Machine)":        { primary: ["quads"], secondary: [] },
  "Leg Press (Machine)":            { primary: ["quads", "glutes"], secondary: ["hamstrings", "calves"] },

  // --- HAMSTRINGS ---
  "Seated Leg Curl (Machine)":      { primary: ["hamstrings"], secondary: [] },
  "Lying Leg Curl (Machine)":       { primary: ["hamstrings"], secondary: [] },
  "Romanian Deadlift (Barbell)":    { primary: ["hamstrings"], secondary: ["glutes", "back"] },

  // --- GLUTES ---
  "Hip Abduction (Machine)":        { primary: ["glutes"], secondary: [] },
  "Hip Adduction (Machine)":        { primary: ["glutes"], secondary: [] },

  // --- CALVES ---
  "Calf Press (Machine)":           { primary: ["calves"], secondary: [] },
  "Seated Calf Raise":              { primary: ["calves"], secondary: [] },

  // --- CORE ---
  "Crunch (Weighted)":              { primary: ["core"], secondary: [] },
  "Crunch":                         { primary: ["core"], secondary: [] },
  "Crunch (Machine)":               { primary: ["core"], secondary: [] },
  "Hanging Leg Raise":              { primary: ["core"], secondary: [] },
  "Leg Raise Parallel Bars":        { primary: ["core"], secondary: [] },
  "Lying Leg Raise":                { primary: ["core"], secondary: [] },
  "Side Bend (Dumbbell)":           { primary: ["core"], secondary: [] },
  "Plank":                          { primary: ["core"], secondary: ["shoulders"] },
  "Russian Twist (Bodyweight)":     { primary: ["core"], secondary: [] },
  "Superman":                       { primary: ["core"], secondary: ["back", "glutes"] },
  "Torso Rotation":                 { primary: ["core"], secondary: [] },
};

/**
 * Get primary and secondary muscle groups for an exercise.
 * Falls back to ILIKE-style pattern matching for unknown exercises.
 */
export function getExerciseMuscles(exerciseName: string): MuscleMapping {
  // Exact match
  const exact = EXERCISE_MAP[exerciseName];
  if (exact) return exact;

  // Pattern fallback for unknown exercises
  const lower = exerciseName.toLowerCase();
  if (lower.includes("bench") || lower.includes("chest") || lower.includes("push up"))
    return { primary: ["chest"], secondary: ["triceps"] };
  if (lower.includes("row") || lower.includes("pull up") || lower.includes("lat ") || lower.includes("pulldown"))
    return { primary: ["back"], secondary: ["biceps"] };
  if (lower.includes("shoulder") || lower.includes("overhead press") || lower.includes("lateral raise") || lower.includes("front raise") || lower.includes("face pull") || lower.includes("rear delt") || lower.includes("reverse fly") || lower.includes("shrug"))
    return { primary: ["shoulders"], secondary: [] };
  if (lower.includes("curl") || lower.includes("hammer") || lower.includes("preacher") || lower.includes("concentration"))
    return { primary: ["biceps"], secondary: [] };
  if (lower.includes("tricep") || lower.includes("pushdown"))
    return { primary: ["triceps"], secondary: [] };
  if (lower.includes("deadlift") || lower.includes("back extension"))
    return { primary: ["back"], secondary: ["hamstrings"] };
  if (lower.includes("leg press") || lower.includes("leg extension") || lower.includes("squat"))
    return { primary: ["quads"], secondary: ["glutes"] };
  if (lower.includes("leg curl") || lower.includes("romanian"))
    return { primary: ["hamstrings"], secondary: ["glutes"] };
  if (lower.includes("hip"))
    return { primary: ["glutes"], secondary: [] };
  if (lower.includes("calf"))
    return { primary: ["calves"], secondary: [] };
  if (lower.includes("crunch") || lower.includes("plank") || lower.includes("leg raise") || lower.includes("twist") || lower.includes("superman") || lower.includes("torso"))
    return { primary: ["core"], secondary: [] };
  if (lower.includes("wrist"))
    return { primary: ["forearms"], secondary: [] };
  if (lower.includes("dip"))
    return { primary: ["chest"], secondary: ["triceps", "shoulders"] };

  return { primary: [], secondary: [] };
}

/** Per-workout muscle volumes for the body map, exactly as web's workout dialog computes
 *  them: working sets only (weight × reps), primary ×1, secondary ×0.33, bodyweight
 *  exercises count as 1 so they still light up (soma#761). */
export function aggregateMuscleVolumes(exercises: { title?: string | null; sets?: { weight_kg?: number | null; reps?: number | null; type?: string | null }[] | null }[]): Record<string, { primary: number; secondary: number; total: number }> {
  const out: Record<string, { primary: number; secondary: number; total: number }> = {};
  for (const mg of ALL_MUSCLE_GROUPS) out[mg] = { primary: 0, secondary: 0, total: 0 };
  for (const ex of exercises) {
    const mapping = getExerciseMuscles(ex.title || "");
    let exVol = 0;
    for (const st of ex.sets ?? []) if ((st.type ?? "normal") === "normal" && (st.weight_kg ?? 0) > 0 && (st.reps ?? 0) > 0) exVol += (st.weight_kg as number) * (st.reps as number);
    if (exVol === 0) exVol = 1;
    for (const mg of mapping.primary) { out[mg].primary += exVol; out[mg].total += exVol; }
    for (const mg of mapping.secondary) { const c = exVol * 0.33; out[mg].secondary += c; out[mg].total += c; }
  }
  return out;
}
