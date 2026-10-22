import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { ApiError, OUTCOMES, api, type Outcome, type ReviewCall } from "@/lib/api";
import { CALLBACKS } from "@/lib/callbacks";
import { length, when } from "@/lib/format";

/**
 * The after-call card (owner, 18 Oct 2026): how a call from this phone went, what was said, a callback and
 * the lead it was about — PATCH /api/app/calls/:id. Opened from the "How did it go?" notification too.
 */

export default function Review() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [call, setCall] = useState<ReviewCall | null | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome>("CONNECTED");
  const [notes, setNotes] = useState("");
  const [callback, setCallback] = useState<number | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ReviewCall[]>("GET", "/api/app/calls/review").then(
      (rows) => {
        const found = rows.find((r) => r.id === id) ?? null;
        setCall(found);
        if (found) {
          setOutcome(found.outcome);
          setLeadId(found.lead_id);
        }
      },
      () => setCall(null),
    );
  }, [id]);

  async function save() {
    setError(null);
    if (outcome === "CALLBACK_REQUESTED" && callback === null) return setError("They asked to be called back — pick when.");
    setBusy(true);
    try {
      await api("PATCH", `/api/app/calls/${id}`, {
        outcome,
        notes: notes.trim() || undefined,
        follow_up_at: callback === null ? undefined : CALLBACKS[callback]!.at().toISOString(),
        lead_id: leadId,
      });
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (call === undefined) return <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />;
  if (call === null) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Notice>This call has already been noted, or it&apos;s more than three days old — change it in Deskzo.</Notice>
        <Button title="Back" kind="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{call.contact ?? call.number}</Text>
      <Text style={styles.small}>
        {call.company} · {call.direction === "in" ? "they called" : "you called"} {when(call.started_at)} · {length(call.duration)}
      </Text>

      <Heading>How did it go?</Heading>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {OUTCOMES.map((o) => (
          <Chip key={o.value} label={o.label} selected={outcome === o.value} onPress={() => setOutcome(o.value)} />
        ))}
      </View>

      <Heading>Notes</Heading>
      <TextInput
        style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
        value={notes}
        onChangeText={setNotes}
        placeholder="What was said, and what happens next"
        placeholderTextColor={colors.muted}
        multiline
        accessibilityLabel="Notes"
      />

      <Heading>Call back</Heading>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        <Chip label="No callback" selected={callback === null} onPress={() => setCallback(null)} />
        {CALLBACKS.map((c, i) => (
          <Chip key={c.label} label={c.label} selected={callback === i} onPress={() => setCallback(i)} />
        ))}
      </View>

      {call.open_leads.length > 0 && (
        <>
          <Heading>About</Heading>
          <View style={{ gap: 8 }} accessibilityRole="radiogroup">
            <Chip label="No lead" selected={leadId === null} onPress={() => setLeadId(null)} />
            {call.open_leads.map((l) => (
              <Chip key={l.id} label={`${l.title} · ${l.stage}`} selected={leadId === l.id} onPress={() => setLeadId(l.id)} />
            ))}
          </View>
        </>
      )}

      {error && <Notice tone="danger">{error}</Notice>}
      <Card style={{ backgroundColor: "transparent", borderWidth: 0, padding: 0 }}>
        <Button title="Save" busy={busy} onPress={() => void save()} />
      </Card>
    </ScrollView>
  );
}
