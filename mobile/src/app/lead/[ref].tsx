import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { RangeCalendar } from "@/components/calendar";
import { ActivityLine, ContactButtons, Detail, Field, Sheet, StagePill, money } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import { dayLabel } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { LeadDetail, Stage } from "@/lib/sales-types";

/**
 * A lead (owner, 22 Oct 2026 — the app made native): what it is and who to ring about it, moving it along its
 * pipeline by the stage rules the web keeps, logging a call or a note, changing its title, value and close date,
 * and everything that happened on it. Anything else about it is on its web page, one tap away.
 */

const TYPES = [
  { value: "CALL", label: "Call", icon: "call-outline" },
  { value: "MEETING", label: "Meeting", icon: "people-outline" },
  { value: "EMAIL", label: "Email", icon: "mail-outline" },
  { value: "NOTE", label: "Note", icon: "document-text-outline" },
] as const;
type ActivityType = (typeof TYPES)[number]["value"];

const ENDED = new Set(["LOST", "DISQUALIFIED"]);
const problemOf = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

export default function LeadScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();
  const router = useRouter();
  const { me } = useSession();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "stage" | "log" | "edit">(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setLead(await api<LeadDetail>("GET", `/api/app/leads/${encodeURIComponent(ref)}`));
    } catch (e) {
      setProblem(problemOf(e, "Couldn't open this lead."));
    } finally {
      setLoading(false);
    }
  }, [ref]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!lead) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Stack.Screen options={{ title: "Lead" }} />
        {problem ? <Notice tone="danger">{problem}</Notice> : <ActivityIndicator color={colors.brand} />}
        {problem && <Button title="Try again" kind="secondary" onPress={() => void load()} />}
      </View>
    );
  }

  const contact = lead.contact;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      <Stack.Screen options={{ title: lead.ref }} />

      <Card>
        <Text style={styles.title}>{lead.title}</Text>
        <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>
          {lead.stage && <StagePill name={lead.stage.name} status={lead.status} />}
          {lead.pipeline && <Text style={styles.small}>{lead.pipeline.name}</Text>}
        </View>
        <Detail label="Value" value={money(lead.value)} />
        <Detail label="Closes" value={lead.expected_close_date ? dayLabel(lead.expected_close_date) : null} />
        <Detail label="Owner" value={lead.owner?.name} />
        {lead.description ? <Text style={styles.body}>{lead.description}</Text> : null}
        <View style={[styles.row, { flexWrap: "wrap", gap: 8, marginTop: 4 }]}>
          <Button title="Move stage" onPress={() => setSheet("stage")} style={{ flexGrow: 1 }} />
          <Button title="Log a call or note" kind="secondary" onPress={() => setSheet("log")} style={{ flexGrow: 1 }} />
        </View>
      </Card>

      {problem && <Notice tone="danger">{problem}</Notice>}

      {(lead.company || contact) && (
        <Card>
          {lead.company && (
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/company/[ref]", params: { ref: lead.company!.ref ?? lead.company!.id } })} style={[styles.row, { justifyContent: "space-between" }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.small}>Company</Text>
                <Text style={[styles.body, { fontWeight: "600", color: colors.brand }]}>{lead.company.name}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          )}
          {contact && (
            <View style={[styles.row, { justifyContent: "space-between", marginTop: lead.company ? 8 : 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.small}>Contact</Text>
                <Text style={[styles.body, { fontWeight: "600" }]}>{contact.name}</Text>
                {contact.phone ? <Text style={styles.small}>{contact.phone}</Text> : null}
              </View>
              <ContactButtons phone={contact.phone} email={contact.email} name={contact.name} />
            </View>
          )}
        </Card>
      )}

      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Heading count={lead.activities.length}>History</Heading>
        <Pressable accessibilityRole="button" onPress={() => setSheet("edit")} hitSlop={8}>
          <Text style={{ color: colors.brand, fontWeight: "600", marginTop: 8 }}>Edit lead</Text>
        </Pressable>
      </View>
      <Card>{lead.activities.length === 0 ? <Notice>Nothing logged yet.</Notice> : lead.activities.map((a) => <ActivityLine key={a.id} activity={a} />)}</Card>

      {me?.can.visits && lead.company?.ref && (
        <Button title="Plan a visit" kind="secondary" onPress={() => router.push({ pathname: "/new-visit", params: { company: lead.company!.ref!, name: lead.company!.name, lead: lead.id } })} />
      )}
      {me?.can.calendar && <Button title="Schedule a meeting" kind="secondary" onPress={() => router.push({ pathname: "/new-meeting", params: { kind: "lead", id: lead.id, name: lead.company?.name ?? lead.title } })} />}
      <Button title="Open on the web" kind="secondary" onPress={() => router.push({ pathname: "/web", params: { path: `/leads/${lead.ref}` } })} />

      <StageSheet visible={sheet === "stage"} lead={lead} onClose={() => setSheet(null)} onMoved={(next) => (setSheet(null), setLead(next))} />
      <LogSheet visible={sheet === "log"} lead={lead} onClose={() => setSheet(null)} onLogged={() => (setSheet(null), void load())} />
      <EditSheet key={lead.updated_at} visible={sheet === "edit"} lead={lead} onClose={() => setSheet(null)} onSaved={() => (setSheet(null), void load())} />
    </ScrollView>
  );
}

/** Its pipeline's stages — the web's stage rules decide; a lead lost says why. */
function StageSheet({ visible, lead, onClose, onMoved }: { visible: boolean; lead: LeadDetail; onClose: () => void; onMoved: (lead: LeadDetail) => void }) {
  const [target, setTarget] = useState<Stage | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function move(stage: Stage, lostReason?: string) {
    setBusy(true);
    setProblem(null);
    try {
      await api("POST", `/api/app/leads/${encodeURIComponent(lead.ref)}/stage`, { stage: stage.id, ...(lostReason ? { lost_reason: lostReason } : {}) });
      const next = await api<LeadDetail>("GET", `/api/app/leads/${encodeURIComponent(lead.ref)}`);
      setTarget(null);
      setReason("");
      onMoved(next);
    } catch (e) {
      setProblem(problemOf(e, "Couldn't move it."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title={target ? `Why was it ${target.name.toLowerCase()}?` : "Move to"} onClose={() => (setTarget(null), setProblem(null), onClose())}>
      {target ? (
        <>
          <TextInput style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]} multiline value={reason} onChangeText={setReason} placeholder="The reason, as the team will read it" placeholderTextColor={colors.muted} maxLength={500} />
          {problem && <Notice tone="danger">{problem}</Notice>}
          <Button title={`Mark ${target.name.toLowerCase()}`} kind="danger" busy={busy} disabled={!reason.trim()} onPress={() => void move(target, reason.trim())} />
          <Button title="Back" kind="secondary" onPress={() => setTarget(null)} />
        </>
      ) : (
        <>
          {lead.stages.length === 0 && <Notice>This lead&apos;s stages couldn&apos;t be read — move it on its web page.</Notice>}
          {lead.stages.map((s) => {
            const here = s.id === lead.stage?.id;
            return (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityState={{ selected: here, disabled: here || busy }}
                disabled={here || busy}
                onPress={() => (ENDED.has(s.status) ? setTarget(s) : void move(s))}
                style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }, pressed && { opacity: 0.6 }]}
              >
                <Ionicons name={here ? "radio-button-on" : "radio-button-off"} size={20} color={here ? colors.brand : colors.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.body, here && { fontWeight: "700" }]}>{s.name}</Text>
                  {s.required_fields.length > 0 && <Text style={styles.small}>Needs: {s.required_fields.join(", ").replace(/cf:/g, "")}</Text>}
                </View>
              </Pressable>
            );
          })}
          {busy && <ActivityIndicator color={colors.brand} />}
          {problem && <Notice tone="danger">{problem}</Notice>}
        </>
      )}
    </Sheet>
  );
}

/** A call, meeting, email or note on the lead — in its history, and its company's. */
function LogSheet({ visible, lead, onClose, onLogged }: { visible: boolean; lead: LeadDetail; onClose: () => void; onLogged: () => void }) {
  const [type, setType] = useState<ActivityType>("CALL");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      await api("POST", `/api/app/leads/${encodeURIComponent(lead.ref)}/notes`, { type, notes: notes.trim() });
      setNotes("");
      onLogged();
    } catch (e) {
      setProblem(problemOf(e, "Couldn't log it."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="Log on this lead" onClose={onClose}>
      <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
        {TYPES.map((t) => (
          <Chip key={t.value} label={t.label} selected={type === t.value} onPress={() => setType(t.value)} />
        ))}
      </View>
      <TextInput
        style={[styles.input, { minHeight: 110, textAlignVertical: "top" }]}
        multiline
        value={notes}
        onChangeText={setNotes}
        placeholder={type === "CALL" ? "What was said, and what's next" : type === "MEETING" ? "Who was there, what was agreed" : "What happened"}
        placeholderTextColor={colors.muted}
        maxLength={10_000}
        autoFocus
      />
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Save" busy={busy} disabled={!notes.trim()} onPress={() => void save()} />
    </Sheet>
  );
}

/** Its title, value and expected close date — the rest of it on the web. */
function EditSheet({ visible, lead, onClose, onSaved }: { visible: boolean; lead: LeadDetail; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(lead.title);
  const [value, setValue] = useState(typeof lead.value === "number" ? String(lead.value) : "");
  const [close, setClose] = useState<string | null>(lead.expected_close_date);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const masked = typeof lead.value === "string" && !/^\d/.test(lead.value);

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const amount = value.replace(/[,\s₹]/g, "");
      await api("PATCH", `/api/app/leads/${encodeURIComponent(lead.ref)}`, {
        title: title.trim(),
        ...(masked ? {} : { value: amount ? Number(amount) : null }),
        expected_close_date: close ?? "",
      });
      onSaved();
    } catch (e) {
      setProblem(problemOf(e, "Couldn't save it."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} title="Edit lead" onClose={onClose}>
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={200} />
      {!masked && <Field label="Value (₹)" value={value} onChangeText={setValue} keyboardType="numeric" placeholder="0" />}
      <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>Expected to close{close ? ` — ${dayLabel(close)}` : ""}</Text>
      <RangeCalendar from={close} to={close} onChange={(day) => setClose(day)} />
      {close && <Button title="No close date" kind="secondary" onPress={() => setClose(null)} />}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Save" busy={busy} disabled={title.trim().length < 2} onPress={() => void save()} />
    </Sheet>
  );
}
