"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { Profile } from "@/lib/profiles";

export type ProfileOption = Profile;
const CHANGED = "h2g.profile-changed";

/** Reload other tabs too, so an old dashboard cannot keep displaying the previous person. */
export function profileChanged(destination: string): void {
  try { localStorage.setItem(CHANGED, String(Date.now())); } catch { /* Storage may be disabled. */ }
  window.location.assign(withBasePath(destination));
}

export function ProfileSwitcher() {
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let mounted = true;
    fetch(withBasePath("/api/profiles"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Profiles unavailable");
        return response.json();
      })
      .then((data) => { if (mounted) { setProfiles(data.profiles); setSelected(data.selectedId ?? ""); } })
      // Before setup or while the database is down there is nothing to switch between.
      .catch(() => { if (mounted) setUnavailable(true); });
    const changed = (event: StorageEvent) => { if (event.key === CHANGED) window.location.reload(); };
    window.addEventListener("storage", changed);
    return () => { mounted = false; window.removeEventListener("storage", changed); };
  }, []);

  async function select(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(withBasePath("/api/profiles/select"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error("Profile could not be selected");
      profileChanged("/dashboard");
    } catch {
      setError("Could not switch profiles");
      setBusy(false);
    }
  }

  if (unavailable) return null;
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <select aria-label="Active profile" value={selected} disabled={busy || !profiles.length}
      onChange={(event) => void select(event.target.value)}
      className="max-w-40 rounded-lg border border-border bg-surface px-2 py-1.5 text-text">
      {!selected && <option value="">Choose profile</option>}
      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>
    <Link href="/profiles" className="text-text-secondary hover:text-warm">Profiles</Link>
    {error && <span role="alert" className="text-danger text-xs">{error}</span>}
  </div>;
}
