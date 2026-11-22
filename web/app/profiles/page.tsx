import { ProfilesPanel } from "@/components/profiles-panel";
export const dynamic = "force-dynamic";

export default function ProfilesPage() {
  return <main className="mx-auto max-w-3xl p-5 md:p-8">
    <h1 className="mb-5 text-2xl font-bold">Profiles</h1>
    <ProfilesPanel />
  </main>;
}
