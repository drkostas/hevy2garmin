import { HEVY_TO_GARMIN } from "hevy2garmin";
import { getDb } from "@/lib/db";
import {
  CATEGORY_OPTIONS,
  categoryName,
} from "@/lib/garmin-categories";
import { DeleteMappingButton, MappingForm } from "@/components/mapping-form";
import { MappingsTable } from "@/components/mappings-table";
import { UnmappedCard } from "@/components/unmapped-card";

// Queries the live hevy2garmin Postgres per request — never at build time.
export const dynamic = "force-dynamic";

interface CustomMapping {
  hevy_name: string;
  category: number;
  subcategory: number;
}

interface MappingsData {
  dbConfigured: boolean;
  custom: CustomMapping[];
  builtin: Array<{ name: string; category: number; subcategory: number }>;
}

async function loadMappings(): Promise<MappingsData> {
  // The built-in map ships with the package — available regardless of DB state.
  const builtin = Object.entries(HEVY_TO_GARMIN).map(([name, pair]) => ({
    name,
    category: pair[0],
    subcategory: pair[1],
  }));

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch {
    return { dbConfigured: false, custom: [], builtin };
  }

  const rows = await sql`
    SELECT hevy_name, category, subcategory
    FROM custom_mappings
    ORDER BY hevy_name ASC
  `.catch(() => [] as CustomMapping[]);

  return {
    dbConfigured: true,
    custom: rows.map((r) => ({
      hevy_name: r.hevy_name,
      category: Number(r.category),
      subcategory: Number(r.subcategory),
    })),
    builtin,
  };
}

export default async function MappingsPage() {
  const data = await loadMappings();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">Exercise mappings</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {data.builtin.length} Hevy exercises mapped to Garmin FIT categories.
          When you upload a workout, each exercise is translated so it displays
          correctly in Garmin Connect.
        </p>
      </header>

      {!data.dbConfigured && (
        <div className="mb-6 rounded-lg border border-warm/40 bg-warm/10 p-4 text-sm text-warm">
          No database is configured (DATABASE_URL is unset). Custom mappings are
          unavailable; the built-in map below still works.
        </div>
      )}

      {/* Unmapped exercises (from recent Hevy workouts) */}
      <UnmappedCard categories={CATEGORY_OPTIONS} />

      {/* Add a custom mapping */}
      <section className="mb-8" id="mapping-form">
        <h2 className="mb-3 text-lg font-semibold text-text">
          Add a custom mapping
        </h2>
        <div className="rounded-xl border border-border bg-surface-elevated p-4">
          <MappingForm categories={CATEGORY_OPTIONS} />
          <p className="mt-3 text-xs text-text-muted">
            A custom mapping overrides the built-in map for that exact Hevy
            exercise name. Sub ID 0 uses the category&apos;s generic exercise.
          </p>
        </div>
      </section>

      {/* Custom mappings */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-text">
          Your custom mappings ({data.custom.length})
        </h2>
        {data.custom.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-muted">
            No custom mappings yet. Add one above to override a built-in mapping.
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-elevated">
            {data.custom.map((m) => (
              <li
                key={m.hevy_name}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-text">
                    {m.hevy_name}
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    {categoryName(m.category)} · cat {m.category} · sub{" "}
                    {m.subcategory}
                  </div>
                </div>
                <DeleteMappingButton hevyName={m.hevy_name} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Full mapping table (built-in + custom, searchable) */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-text">All mappings</h2>
        <MappingsTable
          builtin={data.builtin}
          custom={data.custom.map((m) => ({
            name: m.hevy_name,
            category: m.category,
            subcategory: m.subcategory,
          }))}
        />
      </section>
    </main>
  );
}
