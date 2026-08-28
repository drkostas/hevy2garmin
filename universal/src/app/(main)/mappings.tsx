import { RefreshControl, ScrollView, View } from "react-native";
import { Text, Card, Badge } from "soma-style";
import { useMappings, usePullRefresh } from "../../lib/api";

/**
 * Exercise mappings — how Hevy exercises map to Garmin FIT categories.
 * Custom overrides live in the DB (custom_mappings); the built-in map ships with
 * the hevy2garmin package. Live from /api/mappings, styled like the Sync screen.
 */
export default function MappingsScreen() {
  const { data, error, refetch } = useMappings();
  const { refreshing, onRefresh } = usePullRefresh(refetch);
  const custom = data?.custom ?? [];
  const sample = data?.sample ?? [];

  return (
    <ScrollView
      className="flex-1 bg-base"
      contentContainerClassName="items-center px-5 py-6"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#77c8d1" />}
    >
      <View className="w-full max-w-2xl gap-4">
        <View className="flex-row items-center gap-2">
          <Text variant="headline">Mappings</Text>
          {data && !data.dbConfigured ? <Badge label="No DB" tone="warm" /> : null}
        </View>

        {error ? (
          <Card><Text variant="body" className="text-danger">API: {error} — check EXPO_PUBLIC_API_URL.</Text></Card>
        ) : null}

        {/* Counts */}
        <View className="flex-row gap-3">
          <Card className="flex-1 gap-1">
            <Text variant="eyebrow">Custom</Text>
            <Text variant="display" className="text-teal">{data ? data.customCount : "…"}</Text>
            <Text variant="micro">your overrides</Text>
          </Card>
          <Card className="flex-1 gap-1">
            <Text variant="eyebrow">Built-in</Text>
            <Text variant="display" className="text-text">{data ? data.builtinCount : "…"}</Text>
            <Text variant="micro">shipped with the package</Text>
          </Card>
        </View>

        {/* Custom mappings — overrides win over the built-in map. */}
        <View className="gap-2">
          <Text variant="eyebrow">Your custom mappings</Text>
          {custom.map((m) => (
            <Card key={m.hevy_name} className="gap-2">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 pr-2">
                  <Text variant="body" className="text-text" numberOfLines={1}>{m.hevy_name}</Text>
                  <Text variant="micro">cat {m.category} · sub {m.subcategory}</Text>
                </View>
                <Badge label="Override" tone="teal" />
              </View>
            </Card>
          ))}
          {data && custom.length === 0 ? (
            <Card><Text variant="body" className="text-text-secondary">
              No custom mappings yet. Add overrides from the web dashboard.
            </Text></Card>
          ) : null}
        </View>

        {/* Built-in sample */}
        {sample.length > 0 ? (
          <View className="gap-2">
            <Text variant="eyebrow">Built-in map · sample</Text>
            {sample.map((b) => (
              <Card key={b.name} className="gap-2">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-2">
                    <Text variant="body" className="text-text" numberOfLines={1}>{b.name}</Text>
                    <Text variant="micro">→ {b.categoryName} · cat {b.category}</Text>
                  </View>
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {!data && !error ? (
          <Card><Text variant="body" className="text-text-muted">Loading…</Text></Card>
        ) : null}
      </View>
    </ScrollView>
  );
}
