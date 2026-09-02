"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface CategoryOption {
  id: number;
  name: string;
}
interface Unmapped {
  name: string;
  count: number;
}

/**
 * The "Unmapped exercises" card — exercises in recent Hevy workouts that don't
 * map to a Garmin FIT category (they show as "Unknown" on Garmin). Fetches
 * /api/unmapped-exercises (read-only) on mount and offers a per-exercise
 * quick-map form (category + sub ID → POST /api/mapping). Hidden when there are
 * none. Mirrors the Python unmapped-exercises card.
 */
export function UnmappedCard({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [items, setItems] = useState<Unmapped[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/unmapped-exercises")
      .then((r) => r.json())
      .then((d: { unmapped?: Unmapped[] }) => {
        if (!alive) return;
        setItems(Array.isArray(d.unmapped) ? d.unmapped : []);
        setPhase("ready");
      })
      .catch(() => alive && setPhase("ready"));
    return () => {
      alive = false;
    };
  }, []);

  if (phase === "loading" || items.length === 0) return null;

  return (
    <section className="mb-8 rounded-xl border border-warm/40 bg-warm/10 p-4">
      <div className="mb-2 flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-warm" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <h2 className="text-sm font-semibold text-warm">{items.length} unmapped exercise{items.length === 1 ? "" : "s"}</h2>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        These show as &ldquo;Unknown&rdquo; on Garmin. Pick a category to map them.
      </p>
      <ul className="space-y-2">
        {items.map((it) => (
          <UnmappedRow key={it.name} item={it} categories={categories} onMapped={() => router.refresh()} />
        ))}
      </ul>
    </section>
  );
}

function UnmappedRow({
  item,
  categories,
  onMapped,
}: {
  item: Unmapped;
  categories: CategoryOption[];
  onMapped: () => void;
}) {
  const [category, setCategory] = useState(categories[0]?.id ?? 0);
  const [sub, setSub] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function map() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hevy_name: item.name, category, subcategory: Number.parseInt(sub || "0", 10) }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? `Request failed (${res.status}).`);
        return;
      }
      setDone(true);
      onMapped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) return null;

  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text">{item.name}</div>
          <div className="text-xs text-text-muted">{item.count}× in recent workouts</div>
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(Number.parseInt(e.target.value, 10))}
          aria-label={`Category for ${item.name}`}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-teal focus:outline-none"
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.id})
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          aria-label={`Sub ID for ${item.name}`}
          className="w-16 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text focus:border-teal focus:outline-none"
        />
        <button
          type="button"
          onClick={map}
          disabled={busy}
          className="rounded-lg bg-teal/20 px-3 py-1.5 text-xs font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
        >
          {busy ? "…" : "Map"}
        </button>
      </div>
      {error && (
        <p className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
