import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Button, Card, Notice, colors, styles } from "@/components/ui";
import { api, type Approval, type ApprovalKind } from "@/lib/api";
import { setWaiting } from "@/lib/badges";
import { when } from "@/lib/format";

/**
 * What waits for the person's decision (owner, 18 Oct 2026): leave, attendance corrections, expense claims,
 * Deskzo Automate approvals, orders and new devices — each decided by its own action, with its own rule on who
 * may (src/lib/app/daily.ts).
 */

const KIND: Record<ApprovalKind, string> = {
  leave: "Leave",
  correction: "Attendance correction",
  expense: "Expense claim",
  workflow: "Approval",
  order: "Order",
  device: "New device",
  "attendance-exception": "Clock-in away from the office",
};

export default function ApprovalsScreen() {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const next = await api<Approval[]>("GET", "/api/app/approvals");
      setItems(next);
      setWaiting(next.length);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load what waits for you.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  function decided(item: Approval) {
    setItems((now) => {
      const next = (now ?? []).filter((x) => !(x.kind === item.kind && x.id === item.id));
      setWaiting(next.length);
      return next;
    });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {items && items.length === 0 && <Notice>Nothing waits for your decision.</Notice>}
      {items?.map((item) => <Decision key={`${item.kind}:${item.id}`} item={item} onDecided={() => decided(item)} />)}
    </ScrollView>
  );
}

function Decision({ item, onDecided }: { item: Approval; onDecided: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(approve: boolean) {
    if (!approve && item.reason_to_reject && !note.trim()) {
      setProblem("Say why, for the person who asked.");
      return;
    }
    setBusy(approve ? "approve" : "reject");
    setProblem(null);
    try {
      await api("POST", `/api/app/approvals/${item.kind}/${item.id}`, { approve, note: note.trim() || null });
      onDecided();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work.");
      setBusy(null);
    }
  }

  return (
    <Card>
      <Text style={[styles.small, { color: colors.brand, fontWeight: "600" }]}>{KIND[item.kind]}</Text>
      <Text style={styles.body}>{item.title}</Text>
      {item.detail && <Text style={styles.small}>{item.detail}</Text>}
      {item.asked_at && <Text style={styles.small}>Asked {when(item.asked_at)}</Text>}
      {rejecting && (
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          placeholder={item.reason_to_reject ? "Why (they'll see this)" : "Why — optional, they'll see it"}
          accessibilityLabel="Why you're rejecting it"
          placeholderTextColor={colors.muted}
          maxLength={300}
          multiline
          autoFocus
        />
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <View style={styles.row}>
        {rejecting ? (
          <>
            <Button title="Reject" kind="danger" style={{ flex: 1 }} busy={busy === "reject"} disabled={!!busy} onPress={() => void decide(false)} />
            <Button title="Back" kind="secondary" disabled={!!busy} onPress={() => setRejecting(false)} />
          </>
        ) : (
          <>
            <Button title="Approve" style={{ flex: 1 }} busy={busy === "approve"} disabled={!!busy} onPress={() => void decide(true)} />
            <Button title="Reject" kind="secondary" style={{ flex: 1 }} disabled={!!busy} onPress={() => setRejecting(true)} />
          </>
        )}
      </View>
    </Card>
  );
}
