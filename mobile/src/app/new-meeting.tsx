import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { RangeCalendar } from "@/components/calendar";
import { Field } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import { dayLabel, keyOf } from "@/lib/format";

/**
 * A meeting scheduled from a record on the phone (owner, 22 Oct 2026 — field work): a lead, a company, a contact or a
 * visit — what it's about, when and for how long, online or where. It's on the person's calendar, linked to the
 * record, the web's own way (POST /api/app/meetings); people are invited from the web.
 */

const DURATIONS = [15, 30, 45, 60, 90];
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export default function NewMeetingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind: string; id: string; name?: string }>();
  const [title, setTitle] = useState(params.name ? `Meeting — ${params.name}` : "");
  const [day, setDay] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return keyOf(d);
  });
  const [pickDay, setPickDay] = useState(false);
  const [time, setTime] = useState("11:00");
  const [minutes, setMinutes] = useState(30);
  const [online, setOnline] = useState(true);
  const [location, setLocation] = useState("");
  const [agenda, setAgenda] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function save() {
    if (!TIME.test(time.trim())) return setFields({ starts_at: "A time like 14:30." });
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const [h, m] = time.trim().split(":");
      await api("POST", "/api/app/meetings", {
        record: { kind: params.kind, id: params.id },
        title: title.trim(),
        starts_at: `${day}T${h!.padStart(2, "0")}:${m}`,
        duration_minutes: minutes,
        online,
        ...(online ? {} : { location: location.trim() }),
        agenda: agenda.trim(),
      });
      router.replace("/meetings");
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't schedule the meeting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {params.name ? (
        <Card>
          <Text style={styles.small}>From</Text>
          <Text style={[styles.body, { fontWeight: "700" }]}>{params.name}</Text>
        </Card>
      ) : null}

      <Field label="What it's about" value={title} onChangeText={setTitle} placeholder="Pricing call" maxLength={200} error={fields.title} />

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>When</Text>
        {pickDay ? (
          <RangeCalendar from={day} to={day} onChange={(d) => (d && setDay(d), setPickDay(false))} />
        ) : (
          <Button title={dayLabel(day)} kind="secondary" onPress={() => setPickDay(true)} />
        )}
      </View>
      <Field label="At (24-hour)" value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" placeholder="14:30" maxLength={5} error={fields.starts_at} />

      <Heading>For how long</Heading>
      <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
        {DURATIONS.map((d) => (
          <Chip key={d} label={d < 60 ? `${d} min` : d === 60 ? "1 hour" : "1½ hours"} selected={minutes === d} onPress={() => setMinutes(d)} />
        ))}
      </View>

      <Heading>Where</Heading>
      <View style={[styles.row, { gap: 8 }]} accessibilityRole="radiogroup">
        <Chip label="Online" selected={online} onPress={() => setOnline(true)} />
        <Chip label="In person" selected={!online} onPress={() => setOnline(false)} />
      </View>
      {!online && <Field label="Location" value={location} onChangeText={setLocation} placeholder="Their office, 4th floor" maxLength={300} error={fields.location} />}

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>Agenda</Text>
        <TextInput style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]} multiline value={agenda} onChangeText={setAgenda} placeholder="What you'll go over" placeholderTextColor={colors.muted} maxLength={2000} />
      </View>

      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Schedule it" busy={busy} disabled={title.trim().length < 2 || !params.kind || !params.id} onPress={() => void save()} />
    </ScrollView>
  );
}
