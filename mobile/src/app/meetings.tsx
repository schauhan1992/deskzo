import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { Button, Card, Notice, colors, styles } from "@/components/ui";
import { api } from "@/lib/api";
import { clockTime, dayLabel, dayOf, keyOf } from "@/lib/format";
import type { CalendarItem } from "@/lib/field-types";

/**
 * The person's meetings, a week at a time (owner, 22 Oct 2026 — field work): Deskzo's own and their connected
 * calendar's, with the link to join. A meeting they organised can be cancelled from here — those invited are told, as
 * from the web.
 */

export default function MeetingsScreen() {
  const [week, setWeek] = useState(0);
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const start = new Date();
  start.setDate(start.getDate() + week * 7);
  const from = keyOf(start);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const to = keyOf(end);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setItems(await api<CalendarItem[]>("GET", `/api/app/meetings?from=${from}&to=${to}`));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load the calendar.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  function cancel(m: CalendarItem) {
    Alert.alert("Cancel this meeting?", `${m.title} — those invited are told.`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel it",
        style: "destructive",
        onPress: () =>
          void api<{ warning?: string | null }>("POST", `/api/app/meetings/${encodeURIComponent(m.id)}/cancel`, {})
            .then((done) => {
              if (done.warning) Alert.alert("Cancelled", done.warning);
              return load();
            })
            .catch((e) => setProblem(e instanceof Error ? e.message : "Couldn't cancel it.")),
      },
    ]);
  }

  const today = keyOf(new Date());
  const days: string[] = [];
  for (let d = dayOf(from); keyOf(d) <= to; d.setDate(d.getDate() + 1)) days.push(keyOf(d));
  const dayOfItem = (i: CalendarItem) => (i.all_day ? i.starts_at.slice(0, 10) : keyOf(new Date(i.starts_at)));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading && items !== null} onRefresh={() => void load()} />}>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="The week before" onPress={() => setWeek(week - 1)} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </Pressable>
        <Text style={[styles.body, { fontWeight: "700" }]}>{week === 0 ? "This week" : `${dayLabel(from, today)} – ${dayLabel(to, today)}`}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="The week after" onPress={() => setWeek(week + 1)} hitSlop={12}>
          <Ionicons name="chevron-forward" size={22} color={colors.text} />
        </Pressable>
      </View>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {items === null && !problem ? <ActivityIndicator color={colors.brand} /> : null}
      {items !== null && items.length === 0 && <Notice>Nothing on the calendar this week.</Notice>}
      {items !== null &&
        days.map((d) => {
          const on = items.filter((i) => dayOfItem(i) === d);
          if (on.length === 0) return null;
          return (
            <View key={d} style={{ gap: 6 }}>
              <Text style={[styles.small, { fontWeight: "700" }]}>{dayLabel(d, today)}</Text>
              <Card>
                {on.map((m) => {
                  const off = m.status === "CANCELLED";
                  const detail = [off ? "Cancelled" : m.status === "TENTATIVE" ? "Not confirmed" : null, m.location].filter(Boolean).join(" · ");
                  return (
                    <View key={`${m.kind}-${m.id}`} style={[styles.row, { paddingVertical: 6, opacity: off ? 0.5 : 1 }]}>
                      <Text style={[styles.body, { fontWeight: "700", width: 78 }]}>{m.all_day ? "All day" : clockTime(m.starts_at)}</Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.body, { fontWeight: "600", textDecorationLine: off ? "line-through" : "none" }]} numberOfLines={2}>
                          {m.title}
                        </Text>
                        {detail ? (
                          <Text style={styles.small} numberOfLines={1}>
                            {detail}
                          </Text>
                        ) : null}
                      </View>
                      {m.join_url && !off ? (
                        <Pressable accessibilityRole="link" accessibilityLabel={`Join ${m.title}`} onPress={() => void Linking.openURL(m.join_url!)} hitSlop={8}>
                          <Ionicons name="videocam" size={22} color={colors.brand} />
                        </Pressable>
                      ) : null}
                      {m.kind === "meeting" && m.organizer && !off && new Date(m.ends_at).getTime() > Date.now() ? (
                        <Pressable accessibilityRole="button" accessibilityLabel={`Cancel ${m.title}`} onPress={() => cancel(m)} hitSlop={8} style={{ marginLeft: 12 }}>
                          <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
              </Card>
            </View>
          );
        })}
      {week !== 0 && <Button title="Back to this week" kind="secondary" onPress={() => setWeek(0)} />}
    </ScrollView>
  );
}
