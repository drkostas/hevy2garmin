"use client";
import { useState } from "react";
import { convertWeightEntry, type WeightUnit } from "@/lib/weight-units";

export function WeightConverter() {
  const [entry, setEntry] = useState<{ value: string; unit: WeightUnit }>({ value: "100", unit: "lb" });
  return (
    <div className="mt-4 border-t border-border pt-4" onChange={(e) => e.stopPropagation()}>
      <h4 className="text-sm font-semibold text-text">Quick converter</h4>
      <p className="mt-1 text-xs text-text-muted">Type in either field. Conversions are instant and don’t change your saved preferences.</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {(["lb", "kg"] as const).map((unit) => (
          <label key={unit} className="block text-xs text-text-muted">
            {unit === "lb" ? "Pounds (lbs)" : "Kilograms (kg)"}
            <input aria-label={unit === "lb" ? "Pounds to convert" : "Kilograms to convert"} type="text" inputMode="decimal" autoComplete="off" value={convertWeightEntry(entry, unit)} onChange={(e) => setEntry({ value: e.target.value, unit })} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none" />
          </label>
        ))}
      </div>
    </div>
  );
}
