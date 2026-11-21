import type { Sql } from "./pending-store";
import { weightUnit, type WeightUnit } from "./weight-units";

/** Read the presentation preference separately from canonical profile/FIT units. */
export async function loadWeightUnit(sql: Sql): Promise<WeightUnit> {
  const rows = await sql`SELECT value FROM app_cache WHERE key = ${"display_units"} LIMIT 1`
    .catch(() => [] as Array<{ value: unknown }>);
  return weightUnit(rows[0]?.value?.weight);
}
