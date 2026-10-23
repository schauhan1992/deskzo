import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { ContactButtons, Detail, Field, Sheet, StagePill, money } from "@/components/sales";
import { checkIn, checkOut, visitTone } from "@/components/field";
import { api, ApiError } from "@/lib/api";
import { when } from "@/lib/format";
import type { VisitDetail } from "@/lib/field-types";
import { useSession } from "@/lib/session";

/**
 * A visit (owner, 22 Oct 2026 — field work): who to see and where (to the map), the person to ring there, checking in
 * at the door and writing it up on leaving — each with where the phone was, if it says — what it cost, and a meeting
 * to follow. A visit that didn't happen is cancelled or marked a no-show, with why.
 */

const problemOf = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);
const mapOf = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

export default function VisitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { me } = useSession();
  const [visit, setVisit] = useState<VisitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "complete" | "cancel">(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setVisit(await api<VisitDetail>("GET", `/api/app/visits/${encodeURIComponent(id)}`));
    } catch (e) {
      setProblem(problemOf(e, "Couldn't open this visit."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!visit) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Stack.Screen options={{ title: "Visit" }} />
        {problem ? <Notice tone="danger">{problem}</Notice> : <ActivityIndicator color={colors.brand} />}
        {problem && <Button title="Try again" kind="secondary" onPress={() => void load()} />}
      </View>
    );
  }

  async function arrive() {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const { placeKept } = await checkIn(visit!.id);
      setNote(placeKept ? "Checked in — where you are is kept with the visit." : "Checked in. The phone didn't say where it is, so no place was kept.");
      await load();
    } catch (e) {
      setProblem(problemOf(e, "Couldn't check in."));
    } finally {
      setBusy(false);
    }
  }

  const where = visit.address ?? null;
  const open = visit.status === "PLANNED" || visit.status === "CHECKED_IN";
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      <Stack.Screen options={{ title: visit.ref }} />

      <Card>
        <Text style={styles.title}>{visit.company?.name ?? "A visit"}</Text>
        <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
          <StagePill name={visit.status_label} status={visitTone(visit.status)} />
          <Text style={styles.small}>{visit.purpose_label}</Text>
        </View>
        <Detail label="Planned for" value={when(visit.scheduled_for)} />
        <Detail label="Checked in" value={visit.check_in_at ? when(visit.check_in_at) : null} />
        <Detail label="Checked out" value={visit.check_out_at ? when(visit.check_out_at) : null} />
        <Detail label="Distance" value={visit.distance_km !== null ? `${visit.distance_km} km` : null} />
        {visit.agenda ? <Text style={styles.body}>{visit.agenda}</Text> : null}
        {where ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(mapOf(`${visit.company?.name ?? ""}, ${where}`))}>
            <Text style={[styles.body, { color: colors.brand }]}>{where}</Text>
          </Pressable>
        ) : null}
        {visit.status === "PLANNED" && <Button title="Check in" busy={busy} onPress={() => void arrive()} />}
        {open && <Button title={visit.status === "CHECKED_IN" ? "Check out and write it up" : "Write it up"} kind={visit.status === "CHECKED_IN" ? "primary" : "secondary"} onPress={() => setSheet("complete")} />}
        {visit.status === "PLANNED" && <Button title="Cancelled, or they didn't show" kind="secondary" onPress={() => setSheet("cancel")} />}
        {note && <Notice tone="success">{note}</Notice>}
        {problem && <Notice tone="danger">{problem}</Notice>}
      </Card>

      {visit.outcome ? (
        <>
          <Heading>What came of it</Heading>
          <Card>
            <Text style={styles.body}>{visit.outcome}</Text>
          </Card>
        </>
      ) : null}

      {visit.contact && (
        <Card>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.small}>Seeing</Text>
              <Text style={[styles.body, { fontWeight: "600" }]}>{visit.contact.name}</Text>
              {visit.contact.phone ? <Text style={styles.small}>{visit.contact.phone}</Text> : null}
            </View>
            <ContactButtons phone={visit.contact.phone} email={visit.contact.email} name={visit.contact.name} />
          </View>
        </Card>
      )}

      {visit.places.length > 0 && (
        <>
          <Heading>Where the phone was</Heading>
          <Card>
            {visit.places.map((p) => (
              <Pressable key={`${p.kind}-${p.at}`} accessibilityRole="link" onPress={() => void Linking.openURL(mapOf(`${p.latitude},${p.longitude}`))} style={{ paddingVertical: 4 }}>
                <Text style={[styles.body, { color: colors.brand }]}>{p.kind === "IN" ? "Checking in" : "Checking out"} — on the map</Text>
                <Text style={styles.small}>
                  {when(p.at)}
                  {p.accuracy_m !== null ? ` · within ${p.accuracy_m} m` : ""}
                </Text>
              </Pressable>
            ))}
          </Card>
        </>
      )}

      {me?.can.expenses && (
        <>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Heading count={visit.expenses.length}>What it cost</Heading>
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/new-expense", params: { visit: visit.id, name: visit.company?.name ?? "" } })} hitSlop={8}>
              <Text style={{ color: colors.brand, fontWeight: "600", marginTop: 8 }}>Add a claim</Text>
            </Pressable>
          </View>
          <Card>
            {visit.expenses.length === 0 ? (
              <Notice>No claims against this visit.</Notice>
            ) : (
              visit.expenses.map((e) => <Detail key={e.id} label={e.ref} value={`${money(e.amount) ?? ""} · ${e.status.toLowerCase()}`} />)
            )}
          </Card>
        </>
      )}

      {/* A follow-up is the lead's, or the company's — the web schedules from a visit only to put the visit itself on the calendar. */}
      {me?.can.calendar && visit.company && (
        <Button
          title="Schedule a follow-up meeting"
          kind="secondary"
          onPress={() =>
            router.push({ pathname: "/new-meeting", params: visit.lead ? { kind: "lead", id: visit.lead.id, name: visit.company?.name ?? "" } : { kind: "company", id: visit.company!.id, name: visit.company!.name } })
          }
        />
      )}
      <Button title="Open on the web" kind="secondary" onPress={() => router.push({ pathname: "/web", params: { path: `/visits/${visit.ref}` } })} />

      <CompleteSheet visible={sheet === "complete"} visit={visit} onClose={() => setSheet(null)} onDone={(kept) => (setSheet(null), setNote(kept ? "Written up — where you left from is kept with the visit." : "Written up."), void load())} />
      <CancelSheet visible={sheet === "cancel"} visit={visit} onClose={() => setSheet(null)} onDone={() => (setSheet(null), void load())} />
    </ScrollView>
  );
}

/** Leaving: what came of it and how far it was — checked out, with where the phone is then. */
function CompleteSheet({ visible, visit, onClose, onDone }: { visible: boolean; visit: VisitDetail; onClose: () => void; onDone: (placeKept: boolean) => void }) {
  const [outcome, setOutcome] = useState(visit.outcome ?? "");
  const [distance, setDistance] = useState(visit.distance_km !== null ? String(visit.distance_km) : "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const km = distance.trim() ? Number(distance.replace(",", ".")) : null;
      const { placeKept } = await checkOut(visit.id, outcome.trim(), km !== null && Number.isFinite(km) ? km : null);
      onDone(placeKept);
    } catch (e) {
      setProblem(problemOf(e, "Couldn't save it."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="What came of it" onClose={onClose}>
      <TextInput
        style={[styles.input, { minHeight: 120, textAlignVertical: "top" }]}
        multiline
        value={outcome}
        onChangeText={setOutcome}
        placeholder="What was agreed, and what happens next"
        placeholderTextColor={colors.muted}
        autoFocus
      />
      <Field label="Distance travelled (km)" value={distance} onChangeText={setDistance} keyboardType="decimal-pad" placeholder="For the mileage claim" />
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title={visit.status === "CHECKED_IN" ? "Check out and save" : "Save"} busy={busy} disabled={!outcome.trim()} onPress={() => void save()} />
    </Sheet>
  );
}

/** A visit that didn't happen — cancelled, or they weren't there — and why, as the log needs it. */
function CancelSheet({ visible, visit, onClose, onDone }: { visible: boolean; visit: VisitDetail; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<"CANCELLED" | "NO_SHOW">("CANCELLED");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await api("POST", `/api/app/visits/${encodeURIComponent(visit.id)}/status`, { status, note: note.trim() });
      onDone();
    } catch (e) {
      setProblem(problemOf(e, "Couldn't save it."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="It didn't happen" onClose={onClose}>
      <View style={[styles.row, { gap: 8 }]} accessibilityRole="radiogroup">
        <Chip label="Cancelled" selected={status === "CANCELLED"} onPress={() => setStatus("CANCELLED")} />
        <Chip label="They didn't show" selected={status === "NO_SHOW"} onPress={() => setStatus("NO_SHOW")} />
      </View>
      <TextInput style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]} multiline value={note} onChangeText={setNote} placeholder="Why" placeholderTextColor={colors.muted} />
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Save" kind="danger" busy={busy} disabled={!note.trim()} onPress={() => void save()} />
    </Sheet>
  );
}
