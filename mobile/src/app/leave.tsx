import { useCallback, useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { RangeCalendar } from "@/components/calendar";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { api, type Leave, type LeaveRequest } from "@/lib/api";
import { days, keyOf, span } from "@/lib/format";

/**
 * Leave (owner, 18 Oct 2026): what's left of each kind, asking for leave — the days it takes worked out by
 * Deskzo first, weekends and holidays left out — and the person's requests, cancelled from here while they
 * haven't started. The web's own leave actions and rules (src/app/api/app/leave).
 */

const STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Waiting for approval", color: colors.warning },
  APPROVED: { label: "Approved", color: colors.success },
  REJECTED: { label: "Rejected", color: colors.danger },
  CANCELLED: { label: "Cancelled", color: colors.muted },
};

export default function LeaveScreen() {
  const [leave, setLeave] = useState<Leave | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setLeave(await api<Leave>("GET", "/api/app/leave"));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load your leave.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {leave && (
        <>
          <Heading>Apply for leave</Heading>
          <Apply leave={leave} onApplied={() => void load()} />
          <Heading count={leave.requests.length}>Your requests</Heading>
          {leave.requests.length === 0 ? <Notice>You haven't asked for leave yet.</Notice> : leave.requests.map((r) => <Request key={r.id} request={r} onCancelled={() => void load()} />)}
        </>
      )}
    </ScrollView>
  );
}

function Apply({ leave, onApplied }: { leave: Leave; onApplied: () => void }) {
  const [typeId, setTypeId] = useState<string | null>(leave.types[0]?.id ?? null);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [fromHalf, setFromHalf] = useState(false);
  const [toHalf, setToHalf] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ days: number; skipped: { date: string; why: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  const last = to ?? from;
  const oneDay = !!from && from === last;

  // How many days it takes, from Deskzo — it knows the weekly offs and the holidays.
  useEffect(() => {
    if (!from || !last) return setPreview(null);
    let live = true;
    const timer = setTimeout(() => {
      api<{ days: number; skipped: { date: string; why: string }[] }>("POST", "/api/app/leave/preview", { from, to: last, from_half_day: fromHalf, to_half_day: !oneDay && toHalf }).then(
        (p) => live && setPreview(p),
        () => live && setPreview(null),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [from, last, fromHalf, toHalf, oneDay]);

  async function apply() {
    if (!typeId || !from || !last) return setMessage({ tone: "danger", text: "Pick the kind of leave and the days." });
    if (!reason.trim()) return setMessage({ tone: "danger", text: "Say what it's for." });
    setBusy(true);
    setMessage(null);
    try {
      const done = await api<{ id: string; days: number }>("POST", "/api/app/leave", { type_id: typeId, from, to: last, from_half_day: fromHalf, to_half_day: !oneDay && toHalf, reason: reason.trim() });
      setMessage({ tone: "success", text: `Asked for ${days(done.days)}. You'll hear when it's decided.` });
      setFrom(null);
      setTo(null);
      setFromHalf(false);
      setToHalf(false);
      setReason("");
      onApplied();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "That didn't go through." });
    } finally {
      setBusy(false);
    }
  }

  if (leave.types.length === 0) return <Notice>Your workspace hasn't set up any kinds of leave yet.</Notice>;

  return (
    <Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {leave.types.map((t) => {
          const balance = leave.balances.find((b) => b.type_id === t.id);
          return <Chip key={t.id} label={balance && t.paid ? `${t.name} · ${balance.available} left` : t.name} selected={typeId === t.id} onPress={() => setTypeId(t.id)} />;
        })}
      </View>
      <RangeCalendar
        from={from}
        to={to}
        onChange={(a, b) => {
          setFrom(a);
          setTo(b);
          setMessage(null);
        }}
      />
      <Text style={styles.small}>{from ? `${span(from, last ?? from)}${!to && from ? " — tap another day for more than one" : ""}` : "Tap the first day, then the last."}</Text>
      {from && (
        <View style={styles.row}>
          <Text style={[styles.body, { flex: 1 }]}>{oneDay ? "Half a day" : "Half day on the first day"}</Text>
          <Switch value={fromHalf} onValueChange={setFromHalf} trackColor={{ true: colors.brand }} />
        </View>
      )}
      {from && !oneDay && (
        <View style={styles.row}>
          <Text style={[styles.body, { flex: 1 }]}>Half day on the last day</Text>
          <Switch value={toHalf} onValueChange={setToHalf} trackColor={{ true: colors.brand }} />
        </View>
      )}
      {preview && (
        <Text style={styles.small}>
          Takes {days(preview.days)}
          {preview.skipped.length ? ` — ${preview.skipped.length} day${preview.skipped.length === 1 ? "" : "s"} off or holiday left out` : ""}
        </Text>
      )}
      <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="What it's for" placeholderTextColor={colors.muted} maxLength={500} multiline />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <Button title="Ask for leave" busy={busy} disabled={!typeId || !from || preview?.days === 0} onPress={() => void apply()} />
    </Card>
  );
}

function Request({ request, onCancelled }: { request: LeaveRequest; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = STATUS[request.status] ?? { label: request.status, color: colors.muted };
  // Deskzo's rule: only before it starts, and not once rejected or cancelled.
  const cancellable = (request.status === "PENDING" || request.status === "APPROVED") && request.from > keyOf(new Date());

  function cancel() {
    Alert.alert("Cancel this leave?", `${request.type}, ${span(request.from, request.to)}`, [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel leave",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          setProblem(null);
          try {
            await api("DELETE", `/api/app/leave/${request.id}`);
            onCancelled();
          } catch (e) {
            setProblem(e instanceof Error ? e.message : "Couldn't cancel it.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <Card>
      <Text style={styles.body}>
        {request.type}, {span(request.from, request.to)} · {days(request.days)}
      </Text>
      <Text style={[styles.small, { color: status.color, fontWeight: "600" }]}>
        {status.label}
        {request.decided_by && request.status !== "PENDING" ? ` by ${request.decided_by}` : ""}
      </Text>
      <Text style={styles.small}>{request.reason}</Text>
      {request.note && <Text style={styles.small}>“{request.note}”</Text>}
      {problem && <Notice tone="danger">{problem}</Notice>}
      {cancellable && <Button title="Cancel this leave" kind="secondary" busy={busy} onPress={cancel} />}
    </Card>
  );
}
