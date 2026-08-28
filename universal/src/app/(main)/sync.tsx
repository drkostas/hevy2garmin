import { RefreshControl, ScrollView, View } from "react-native";
import { Text, Card, Badge, ProgressBar, Sparkline } from "soma-style";
import { useHevyStatus, usePullRefresh } from "../../lib/api";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** hevy2garmin sync dashboard — live via /api/hevy/status. */
export default function SyncScreen() {
  const { data, error, refetch } = useHevyStatus();
  const { refreshing, onRefresh } = usePullRefresh(refetch);
  const recent = data?.recent ?? [];
  // recent is newest-first; a sparkline reads oldest→newest.
  const kcalSeries = [...recent].reverse().map((w) => w.calories ?? 0);

  return (
    <ScrollView
      className="flex-1 bg-base"
      contentContainerClassName="items-center px-5 py-6"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#77c8d1" />}
    >
      <View className="w-full max-w-2xl gap-4">
        <View className="flex-row items-center gap-2">
          <Text variant="title">Sync status</Text>
          <Badge
            label={data?.garminConnected ? "Garmin connected" : "Garmin offline"}
            tone={data?.garminConnected ? "success" : "danger"}
          />
        </View>

        {error ? (
          <Card><Text variant="body" className="text-danger">API: {error} — check EXPO_PUBLIC_API_URL.</Text></Card>
        ) : null}

        {/* Connection cards */}
        <View className="flex-row gap-3">
          <Card className="flex-1 gap-1">
            <Text variant="eyebrow">Hevy</Text>
            <Text variant="title" className={data?.hevyConnected ? "text-teal" : "text-text-muted"}>
              {data?.hevyConnected ? "Connected" : "—"}
            </Text>
            <Text variant="micro">{recent.length} recent workouts</Text>
          </Card>
          <Card className="flex-1 gap-1">
            <Text variant="eyebrow">Garmin</Text>
            <Text variant="title" className={data?.garminConnected ? "text-teal" : "text-text-muted"}>
              {data?.garminConnected ? "Connected" : "—"}
            </Text>
            <Text variant="micro">FIT upload active</Text>
          </Card>
        </View>

        {/* Totals */}
        <Card className="gap-3">
          <Text variant="eyebrow">Synced to Garmin</Text>
          <View className="flex-row items-end gap-2">
            <Text variant="display">{data ? data.totalSynced : "…"}</Text>
            <Text variant="title" className="text-text-muted">workouts all-time</Text>
          </View>
          <ProgressBar pct={1} color="#6ad4a0" />
          <Text variant="caption" className="text-text-secondary">
            {data?.syncedThisWeek ?? 0} this week · every workout uploaded to Garmin
          </Text>
        </Card>

        {/* Recent-workout calorie trend */}
        {kcalSeries.length >= 2 ? (
          <Card className="gap-2">
            <View className="flex-row items-center justify-between">
              <Text variant="eyebrow">Workout calories · last {kcalSeries.length}</Text>
              <Text variant="caption" className="tabular-nums text-text-secondary">
                {kcalSeries[kcalSeries.length - 1]} kcal
              </Text>
            </View>
            <Sparkline data={kcalSeries} baseline color="#b17850" />
          </Card>
        ) : null}

        {/* Latest few — full list is on History */}
        <View className="gap-2">
          <Text variant="eyebrow">Latest</Text>
          {recent.slice(0, 3).map((w, i) => (
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
        </View>
      </View>
    </ScrollView>
  );
}
