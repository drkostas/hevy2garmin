"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { categoryName } from "@/lib/garmin-categories";

interface Entry {
  name: string;
  category: number;
  subcategory: number;
  source: "custom" | "built-in";
}

/**
 * The full exercise-mapping table — ports the Python mappings table: every
 * built-in AND custom mapping (a custom entry overrides the built-in for the
 * same Hevy name and is marked "custom"), a live search filter, and rows that
 * expand to a detail panel. Replaces the previous 12-row built-in sample.
 */
export function MappingsTable({
  builtin,
  custom,
}: {
  builtin: Array<{ name: string; category: number; subcategory: number }>;
  custom: Array<{ name: string; category: number; subcategory: number }>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  function override(e: Entry) {
    router.replace(
      `/mappings?edit=${encodeURIComponent(e.name)}&cat=${e.category}&sub=${e.subcategory}`,
    );
    if (typeof document !== "undefined") {
      document.getElementById("mapping-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const entries = useMemo<Entry[]>(() => {
    const byName = new Map<string, Entry>();
    for (const b of builtin) byName.set(b.name, { ...b, source: "built-in" });
    for (const c of custom) byName.set(c.name, { ...c, source: "custom" }); // custom overrides
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [builtin, custom]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.name.toLowerCase().includes(q) || categoryName(e.category).toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search exercises…"
          aria-label="Search exercises"
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none"
        />
        <span className="text-xs text-text-muted tabular-nums">
          {filtered.length} of {entries.length}
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
              <th className="px-4 py-2 font-medium">Hevy exercise</th>
              <th className="px-4 py-2 font-medium">Garmin category</th>
              <th className="px-4 py-2 text-right font-medium">Cat</th>
              <th className="px-4 py-2 text-right font-medium">Sub</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-text-muted">
                  No exercises match “{query}”.
                </td>
              </tr>
            ) : (
              filtered.map((e) => {
                const isOpen = open === e.name;
                return (
                  <Fragment key={e.name}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : e.name)}
                      className="cursor-pointer hover:bg-surface-active/40"
                    >
                      <td className="px-4 py-2 font-medium text-text">
                        {e.name}
                        {e.source === "custom" && (
                          <span className="ml-2 rounded-full bg-teal/15 px-1.5 py-0.5 text-[10px] font-medium text-teal">
                            custom
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-text-secondary">{categoryName(e.category)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">{e.category}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">{e.subcategory}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-surface/60">
                        <td colSpan={4} className="px-4 py-3">
                          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                            <div>
                              <dt className="text-text-muted">Hevy name</dt>
                              <dd className="text-text">{e.name}</dd>
                            </div>
                            <div>
                              <dt className="text-text-muted">FIT category</dt>
                              <dd className="text-text">{categoryName(e.category)} ({e.category})</dd>
                            </div>
                            <div>
                              <dt className="text-text-muted">FIT sub-category</dt>
                              <dd className="text-text">{e.subcategory}</dd>
                            </div>
                            <div>
                              <dt className="text-text-muted">Source</dt>
                              <dd className="text-text">{e.source === "custom" ? "Custom" : "Built-in"}</dd>
                            </div>
                          </dl>
                          <p className="mt-2 text-xs text-text-muted">
                            {e.source === "custom"
                              ? "This custom mapping overrides the built-in map for this exact Hevy exercise name."
                              : "Built-in mapping. Add a custom mapping above to override it."}
                          </p>
                          <button
                            type="button"
                            onClick={() => override(e)}
                            className="mt-2 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-teal transition-colors hover:bg-surface-active"
                          >
                            {e.source === "custom" ? "Edit" : "Override"}
                          </button>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
