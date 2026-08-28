import { RefreshControl, ScrollView, View } from "react-native";
import { Text, Card, Badge, type BadgeTone } from "soma-style";
import { useWorkouts, usePullRefresh, type WorkoutItem } from "../../lib/api";

function fmtWhen(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Status pill for a workout row. Terminal statuses map to fixed tones (mirroring
 * the web /workouts StatusPill); any pending phase is teal / in-flight.
 */
function statusBadge(w: WorkoutItem): { label: string; tone: BadgeTone } {
  if (w.kind === "pending") return { label: w.status, tone: "teal" };
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    success: { label: "Uploaded", tone: "success" },
    manual: { label: "Marked synced", tone: "warm" },
    skipped: { label: "Skipped", tone: "neutral" },
    failed: { label: "Failed", tone: "danger" },
  };
  return map[w.status] ?? { label: w.status, tone: "neutral" };
}

/** Synced + in-flight workouts, from /api/workouts. Styled like the Sync screen. */
export default function WorkoutsScreen() {
  const { data, error, refetch } = useWorkouts();
  const { refreshing, onRefresh } = usePullRefresh(refetch);
  const workouts = data?.workouts ?? [];
  const pending = workouts.filter((w) => w.kind === "pending").length;
  const synced = workouts.length - pending;

  return (
    <ScrollView
      className="flex-1 bg-base"
      contentContainerClassName="items-center px-5 py-6"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#77c8d1" />}
    >
      <View className="w-full max-w-2xl gap-4">
        <View className="flex-row items-center gap-2">
          <Text variant="headline">Workouts</Text>
          {data && !data.dbConfigured ? <Badge label="No DB" tone="warm" /> : null}
        </View>

        {error ? (
          <Card><Text variant="body" className="text-danger">API: {error} — check EXPO_PUBLIC_API_URL.</Text></Card>
        ) : null}

        {/* Rollup */}
        {workouts.length > 0 ? (
          <Card className="gap-3">
            <View className="flex-row justify-between">
              {[
                ["Total", `${workouts.length}`],
                ["Synced", `${synced}`],
                ["Pending", `${pending}`],
              ].map(([label, val]) => (
                <View key={label} className="items-center gap-0.5">
                  <Text variant="micro" className="text-text-muted">{label}</Text>
                  <Text variant="title" className="tabular-nums text-text">{val}</Text>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        {/* List — pending first, then terminal, each newest-first (server order). */}
        <View className="gap-2">
          {workouts.map((w) => {
            const s = statusBadge(w);
            return (
              <Card key={w.hevy_id} className="gap-2">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-2">
                    <Text variant="body" className="text-text" numberOfLines={1}>
                      {w.title || "Untitled workout"}
                    </Text>
                    <Text variant="micro">
                      {fmtWhen(w.synced_at)}
                      {w.calories != null ? ` · ${w.calories} kcal` : ""}
                      {w.avg_hr != null ? ` · ${w.avg_hr} bpm` : ""}
                    </Text>
                    {w.detail ? (
                      <Text variant="micro" className="text-text-secondary" numberOfLines={1}>{w.detail}</Text>
                    ) : null}
                  </View>
                  <Badge label={s.label} tone={s.tone} />
                </View>
              </Card>
            );
          })}
          {data && workouts.length === 0 ? (
            <Card><Text variant="body" className="text-text-secondary">No workouts recorded yet.</Text></Card>
          ) : null}
          {!data && !error ? (
            <Card><Text variant="body" className="text-text-muted">Loading…</Text></Card>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
