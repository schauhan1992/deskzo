import { useState } from "react";
import { ActivityIndicator, Alert, FlatList, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Chip, Notice, colors, styles } from "@/components/ui";
import { Fab, ListRow, StagePill, money } from "@/components/sales";
import { api } from "@/lib/api";
import { dayLabel } from "@/lib/format";
import type { Expense } from "@/lib/field-types";
import { useList } from "@/lib/use-list";

/**
 * The person's claims (owner, 22 Oct 2026 — field work): saved, waiting, decided and paid, the newest first. A saved
 * one is submitted from here, or taken back; + adds a claim, with the photo of its receipt.
 */

const STATUSES = [
  { value: "", label: "All" },
  { value: "DRAFT", label: "Drafts" },
  { value: "SUBMITTED", label: "Awaiting approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "REIMBURSED", label: "Reimbursed" },
];

const tone = (status: string) => (status === "APPROVED" || status === "REIMBURSED" ? "WON" : status === "REJECTED" ? "LOST" : null);

export default function ExpensesScreen() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const list = useList<Expense>(`/api/app/expenses${status ? `?status=${status}` : ""}`);
  const [problem, setProblem] = useState<string | null>(null);

  function act(e: Expense) {
    if (e.status !== "DRAFT") {
      if (e.decision_note) Alert.alert(e.ref, e.decision_note);
      return;
    }
    Alert.alert(`${e.ref} · ${money(e.amount) ?? ""}`, e.description, [
      { text: "Submit for approval", onPress: () => void run(() => api("POST", `/api/app/expenses/${encodeURIComponent(e.id)}/submit`)) },
      { text: "Delete it", style: "destructive", onPress: () => void run(() => api("DELETE", `/api/app/expenses/${encodeURIComponent(e.id)}`)) },
      { text: "Not now", style: "cancel" },
    ]);
  }

  async function run(step: () => Promise<unknown>) {
    setProblem(null);
    try {
      await step();
      await list.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't do that.");
    }
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={list.rows ?? []}
        keyExtractor={(e) => e.id}
        ListHeaderComponent={
          <View style={{ paddingVertical: 12, gap: 12 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
              {STATUSES.map((s) => (
                <Chip key={s.value} label={s.label} selected={status === s.value} onPress={() => setStatus(s.value)} />
              ))}
            </ScrollView>
            {(problem ?? list.problem) && (
              <View style={{ paddingHorizontal: 16 }}>
                <Notice tone="danger">{problem ?? list.problem}</Notice>
              </View>
            )}
          </View>
        }
        renderItem={({ item: e }) => (
          <ListRow
            title={`${money(e.amount) ?? "—"} · ${e.category_label}`}
            subtitle={[e.ref, e.spent_on ? dayLabel(e.spent_on.slice(0, 10)) : null, e.description, e.has_receipt ? null : "no receipt"].filter(Boolean).join(" · ")}
            right={<StagePill name={e.status_label} status={tone(e.status)} />}
            onPress={() => act(e)}
          />
        )}
        onEndReached={() => void list.loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={list.loading && list.rows !== null} onRefresh={() => void list.reload()} />}
        ListEmptyComponent={list.rows === null ? <ActivityIndicator color={colors.brand} style={{ marginTop: 24 }} /> : list.problem ? undefined : <Text style={[styles.small, { textAlign: "center", padding: 24 }]}>No claims here. Add one with +.</Text>}
        ListFooterComponent={list.more ? <ActivityIndicator color={colors.brand} style={{ margin: 16 }} /> : <View style={{ height: 90 }} />}
      />
      <Fab label="Add a claim" onPress={() => router.push("/new-expense")} />
    </View>
  );
}
