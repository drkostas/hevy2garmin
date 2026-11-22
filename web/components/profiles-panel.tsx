"use client";

import { useEffect, useState, type FormEvent } from "react";
import { withBasePath } from "@/lib/base-path";
import { profileChanged, type ProfileOption } from "./profile-switcher";

export function ProfilesPanel() {
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch(withBasePath("/api/profiles"), { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setProfiles(data.profiles);
      setSelected(data.selectedId ?? "");
    }).catch((error) => setError(error.message));
  }, []);

  async function save(event: FormEvent, profile?: ProfileOption) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const response = await fetch(withBasePath("/api/profiles"), {
        method: profile ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile ? { id: profile.id, name: form.get("name") } : { name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      profileChanged(profile ? "/profiles" : "/setup");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save profile.");
      setBusy(false);
    }
  }

  return <div className="space-y-6">
    <p className="text-text-secondary">Each profile has its own Hevy key, Garmin connection, settings and sync history. Everyone using this dashboard can manage all profiles.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="space-y-3">
      {profiles.map((profile) => <form key={profile.id} onSubmit={(event) => void save(event, profile)}
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
        <label className="flex-1 min-w-40">
          <span className="mb-1 block text-sm text-text-secondary">{profile.id === selected ? "Active profile" : "Profile name"}</span>
          <input aria-label={`Name for ${profile.name}`} name="name" defaultValue={profile.name} required maxLength={80}
            className="w-full rounded-lg border border-border bg-base px-3 py-2" />
        </label>
        <button disabled={busy} className="rounded-lg border border-border px-4 py-2 hover:bg-surface-hover disabled:opacity-50">Rename</button>
      </form>)}
    </div>
    <form onSubmit={(event) => void save(event)} className="rounded-xl border border-border bg-surface p-5 space-y-3">
      <h2 className="font-semibold">Add a profile</h2>
      <label className="block text-sm text-text-secondary" htmlFor="new-profile">Name</label>
      <input id="new-profile" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80}
        placeholder="e.g. Marvin" className="w-full rounded-lg border border-border bg-base px-3 py-2" />
      <p className="text-sm text-text-secondary">Next, connect this person’s Hevy and Garmin accounts. The server’s scheduled sync includes them once Hevy is connected.</p>
      <button disabled={busy} className="rounded-lg bg-warm px-4 py-2 font-medium text-base disabled:opacity-50">
        {busy ? "Saving…" : "Add profile and connect accounts"}
      </button>
    </form>
  </div>;
}
