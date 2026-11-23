export type WeightUnit = "kg" | "lb";
export const KG_PER_LB = 0.45359237;
export function weightUnit(value: unknown): WeightUnit { return value === "lb" ? "lb" : "kg"; }
export function weightFromKg(value: number, unit: WeightUnit): number { return unit === "lb" ? value / KG_PER_LB : value; }
export function weightToKg(value: number, unit: WeightUnit): number { return unit === "lb" ? value * KG_PER_LB : value; }
export function weightInput(value: number): string { return Number(value.toFixed(2)).toString(); }

/** Keep the original entry when switching units, so repeated switches don't round the stored weight. */
export function convertWeightEntry(entry: { value: string; unit: WeightUnit }, unit: WeightUnit): string {
  if (entry.unit === unit || !entry.value.trim()) return entry.value;
  const n = Number(entry.value);
  return Number.isFinite(n) ? weightInput(weightFromKg(weightToKg(n, entry.unit), unit)) : "";
}
