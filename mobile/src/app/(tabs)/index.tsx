import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, Heading, Notice, colors, styles } from "@/components/ui";
import { TaskRow } from "@/components/task-row";
import { ClockCard } from "@/components/clock-card";
import { ApiError, api, type Today } from "@/lib/api";
import { setWaiting } from "@/lib/badges";
import { dayOf, days, span } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Today (owner, 18 Oct 2026): the app's home — clocking in and out, the tasks due today, what waits for the
 * person's decision, and their leave. Each part only for somebody whose workspace has it and who may use it
 * (src/lib/app/daily.ts todayFor).
 */

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export default function TodayScreen() {
  const router = useRouter();
  const { me } = useSession();
  const [today, setToday] = useState<Today | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const next = await api<Today>("GET", "/api/app/today");
      setToday(next);
      setWaiting(next.approvals_waiting);
    } catch (e) {
      setProblem(e instanceof ApiError && e.code === "device_pending" ? "This phone is waiting for an administrator to approve it in Deskzo (Security › Devices). Pull down to check again." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const first = me?.person.name.split(" ")[0];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      <View>
        <Text style={styles.title}>
          {greeting()}
          {first ? `, ${first}` : ""}
        </Text>
        <Text style={styles.small}>{(today ? dayOf(today.date) : new Date()).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</Text>
      </View>

      {problem && (
        <Card>
          <Notice tone="warning">{problem}</Notice>
        </Card>
      )}

      {today?.attendance && (
        <ClockCard attendance={today.attendance} policy={today.location ?? null} onChanged={(attendance, location) => setToday({ ...today, attendance, location })} />
      )}

      {/* Always here — Approvals has no tab of its own, so this is the way in, with or without anything waiting. */}
      {today && (
        <Pressable accessibilityRole="button" accessibilityLabel="Approvals" onPress={() => router.push("/approvals")}>
          <Card style={[styles.row, today.approvals_waiting > 0 && { borderColor: colors.brand }]}>
            <Ionicons name="checkmark-done-circle-outline" size={26} color={today.approvals_waiting > 0 ? colors.brand : colors.muted} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.body, { fontWeight: "600" }]}>Approvals</Text>
              <Text style={styles.small}>
                {today.approvals_waiting > 0
                  ? `${today.approvals_waiting} ${today.approvals_waiting === 1 ? "thing waits" : "things wait"} for your decision`
                  : "Nothing waits for your decision"}
              </Text>
            </View>
            {today.approvals_waiting > 0 ? (
              <View style={{ minWidth: 24, height: 24, borderRadius: 12, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: 7 }}>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>{today.approvals_waiting}</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Card>
        </Pressable>
      )}

      {today?.tasks && (
        <>
          <Heading count={today.tasks.due_today.length}>Due today</Heading>
          <Card>
            {today.tasks.due_today.length === 0 ? (
              <Notice>Nothing due today.</Notice>
            ) : (
              today.tasks.due_today.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onProblem={setProblem}
                  onChanged={(changed) => {
                    const tasks = today.tasks;
                    if (!tasks) return;
                    setToday({ ...today, tasks: { ...tasks, due_today: tasks.due_today.map((x) => (x.id === changed.id ? changed : x)), open: tasks.open + (changed.status === "DONE" ? -1 : 1) } });
                  }}
                />
              ))
            )}
            <Text style={styles.small}>
              {today.tasks.open} open{today.tasks.overdue ? ` · ` : ""}
              {today.tasks.overdue ? <Text style={{ color: colors.danger }}>{today.tasks.overdue} overdue</Text> : null}
            </Text>
            <Button title="All my tasks" kind="secondary" onPress={() => router.push("/tasks")} />
          </Card>
        </>
      )}

      {today?.leave && (
        <>
          <Heading>Leave</Heading>
          <Card>
            {today.leave.balances.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {today.leave.balances.map((b) => (
                  <View key={b.type_id} style={{ backgroundColor: colors.sunken, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                    <Text style={[styles.body, { fontWeight: "600" }]}>{b.available}</Text>
                    <Text style={styles.small}>{b.name}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Notice>No leave balances set up for you yet.</Notice>
            )}
            {today.leave.upcoming.map((l) => (
              <Text key={l.id} style={styles.small}>
                {l.type}, {span(l.from, l.to)} ({days(l.days)}) — {l.status === "PENDING" ? "waiting for approval" : "approved"}
              </Text>
            ))}
            <Button title="Apply for leave" kind="secondary" onPress={() => router.push("/leave")} />
          </Card>
        </>
      )}

      {today && !today.attendance && !today.tasks && !today.leave && today.approvals_waiting === 0 && !problem && (
        <Notice>Nothing here for you yet. Everything else in Deskzo is on the Deskzo tab.</Notice>
      )}
    </ScrollView>
  );
}
