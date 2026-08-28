import { RefreshControl, ScrollView, View } from "react-native";
import { Text, Card, Badge, Button } from "soma-style";
import { useHevyStatus, usePullRefresh } from "../../lib/api";

/** Connection + sync settings for the hevy2garmin bridge. */
export default function SettingsScreen() {
  const { data, error, refetch } = useHevyStatus();
  const { refreshing, onRefresh } = usePullRefresh(refetch);

  const connections: { key: string; label: string; sub: string; ok: boolean | undefined }[] = [
    { key: "hevy", label: "Hevy", sub: "Workout source", ok: data?.hevyConnected },
    { key: "garmin", label: "Garmin", sub: "FIT upload target", ok: data?.garminConnected },
  ];

  return (
    <ScrollView
      className="flex-1 bg-base"
      contentContainerClassName="items-center px-5 py-6"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#77c8d1" />}
    >
      <View className="w-full max-w-2xl gap-4">
        <Text variant="headline">Settings</Text>

        {error ? (
          <Card><Text variant="body" className="text-danger">API: {error} — check EXPO_PUBLIC_API_URL.</Text></Card>
        ) : null}

        {/* Connections */}
        <Card className="gap-1">
          <Text variant="title" className="mb-2">Connections</Text>
          {connections.map((c) => (
            <View key={c.key} className="flex-row items-center justify-between border-b border-border-subtle py-3">
              <View>
                <Text variant="body" className="text-text">{c.label}</Text>
                <Text variant="micro" className="text-text-muted">{c.sub}</Text>
              </View>
              <Badge
                label={c.ok === undefined ? "…" : c.ok ? "Connected" : "Offline"}
                tone={c.ok ? "success" : c.ok === undefined ? "neutral" : "danger"}
              />
            </View>
          ))}
        </Card>

        {/* Sync summary */}
        <Card className="gap-3">
          <Text variant="eyebrow">Sync summary</Text>
          <View className="flex-row justify-between">
            {[
              ["All-time", `${data?.totalSynced ?? "—"}`],
              ["This week", `${data?.syncedThisWeek ?? "—"}`],
              ["Recent", `${data?.recent?.length ?? "—"}`],
            ].map(([label, val]) => (
              <View key={label} className="items-center gap-0.5">
                <Text variant="micro" className="text-text-muted">{label}</Text>
                <Text variant="title" className="tabular-nums text-text">{val}</Text>
              </View>
            ))}
          </View>
        </Card>

        {/* About */}
        <Card className="gap-3">
          <Text variant="title">About</Text>
          <Text variant="body" className="text-text-secondary">
            hevy2garmin uploads every Hevy strength workout to Garmin Connect as a FIT file, so
            your lifting shows up alongside your runs and rides.
          </Text>
          <Button label="Refresh status" variant="secondary" size="sm" className="self-start" onPress={onRefresh} />
        </Card>
      </View>
    </ScrollView>
  );
}
