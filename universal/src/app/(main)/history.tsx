import { RefreshControl, ScrollView, View } from "react-native";
import { Text, Card, Badge, Sparkline } from "soma-style";
import { useHevyStatus, usePullRefresh } from "../../lib/api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Full synced-workout history — every recent Hevy → Garmin upload. */
export default function HistoryScreen() {
  const { data, error, refetch } = useHevyStatus();
  const { refreshing, onRefresh } = usePullRefresh(refetch);
  const recent = data?.recent ?? [];
  const kcalSeries = [...recent].reverse().map((w) => w.calories ?? 0);
  const totalKcal = recent.reduce((s, w) => s + (w.calories || 0), 0);

  return (
    <ScrollView
      className="flex-1 bg-base"
      contentContainerClassName="items-center px-5 py-6"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#77c8d1" />}
    >
      <View className="w-full max-w-2xl gap-4">
        <Text variant="headline">History</Text>

        {error ? (
          <Card><Text variant="body" className="text-danger">API: {error} — check EXPO_PUBLIC_API_URL.</Text></Card>
        ) : null}

        {/* Rollup + calorie trend */}
        {kcalSeries.length >= 2 ? (
          <Card className="gap-3">
            <View className="flex-row justify-between">
              {[
                ["Workouts", `${recent.length}`],
                ["Total kcal", totalKcal.toLocaleString()],
              ].map(([label, val]) => (
                <View key={label} className="items-center gap-0.5">
                  <Text variant="micro" className="text-text-muted">{label}</Text>
                  <Text variant="caption" className="tabular-nums text-text">{val}</Text>
                </View>
              ))}
            </View>
            <Sparkline data={kcalSeries} baseline color="#b17850" />
          </Card>
        ) : null}

        {/* Full list */}
        <View className="gap-2">
          {recent.map((w, i) => (
            <Card key={`${w.hevy_id}-${i}`} className="gap-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-2">
                  <Text variant="body" className="text-text" numberOfLines={1}>{w.title}</Text>
                  <Text variant="micro">
                    {fmtDate(w.synced_at)} · {w.calories ?? "—"} kcal
                  </Text>
                </View>
                <Badge
                  label={w.status === "success" ? "Synced" : w.status}
                  tone={w.status === "success" ? "success" : "warm"}
                />
              </View>
            </Card>
          ))}
          {data && recent.length === 0 ? (
            <Card><Text variant="body" className="text-text-secondary">No workouts synced yet.</Text></Card>
          ) : null}
          {!data && !error ? (
            <Card><Text variant="body" className="text-text-muted">Loading…</Text></Card>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
