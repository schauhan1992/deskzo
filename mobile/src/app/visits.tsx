import { useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Notice, colors, styles } from "@/components/ui";
import { Fab, Segments } from "@/components/sales";
import { VisitLine } from "@/components/field";
import { dayLabel, keyOf } from "@/lib/format";
import type { VisitRow } from "@/lib/field-types";
import { useList } from "@/lib/use-list";

/**
 * The person's visits (owner, 22 Oct 2026 — field work): today's in the order they happen, the next thirty days', and
 * those done — each opening to check in, write up, or claim what it cost. + plans another.
 */

type View_ = "today" | "upcoming" | "past";

const VIEWS: { value: View_; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Coming up" },
  { value: "past", label: "Done" },
];

const EMPTY: Record<View_, string> = {
  today: "No visits planned for today. Plan one with +.",
  upcoming: "Nothing planned for the next thirty days.",
  past: "No visits before today yet.",
};

export default function VisitsScreen() {
  const router = useRouter();
  const [view, setView] = useState<View_>("today");
  const list = useList<VisitRow>(`/api/app/visits?view=${view}`);
  const today = keyOf(new Date());

  return (
    <View style={styles.screen}>
      <FlatList
        data={list.rows ?? []}
        keyExtractor={(v) => v.id}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 12 }}>
            <Segments options={VIEWS} value={view} onChange={setView} />
            {list.problem && <Notice tone="danger">{list.problem}</Notice>}
          </View>
        }
        renderItem={({ item, index }) => {
          const day = keyOf(new Date(item.scheduled_for));
          const previous = index > 0 ? keyOf(new Date(list.rows![index - 1]!.scheduled_for)) : null;
          return (
            <View style={{ paddingHorizontal: 16, backgroundColor: colors.surface }}>
              {view !== "today" && day !== previous && <Text style={[styles.small, { paddingTop: 12, fontWeight: "700" }]}>{dayLabel(day, today)}</Text>}
              <VisitLine visit={item} onPress={() => router.push({ pathname: "/visit/[id]", params: { id: item.id } })} />
            </View>
          );
        }}
        onEndReached={() => void list.loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={list.loading && list.rows !== null} onRefresh={() => void list.reload()} />}
        ListEmptyComponent={list.rows === null ? <ActivityIndicator color={colors.brand} style={{ marginTop: 24 }} /> : list.problem ? undefined : <Text style={[styles.small, { textAlign: "center", padding: 24 }]}>{EMPTY[view]}</Text>}
        ListFooterComponent={list.more ? <ActivityIndicator color={colors.brand} style={{ margin: 16 }} /> : <View style={{ height: 90 }} />}
      />
      <Fab label="Plan a visit" onPress={() => router.push("/new-visit")} />
    </View>
  );
}
