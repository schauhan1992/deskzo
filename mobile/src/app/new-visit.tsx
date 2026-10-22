import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { RangeCalendar } from "@/components/calendar";
import { Field, ListRow, SearchBox } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import { dayLabel, keyOf } from "@/lib/format";
import type { VisitOptions } from "@/lib/field-types";
import type { Company } from "@/lib/sales-types";
import { useList, useSettled } from "@/lib/use-list";

/**
 * A visit planned from the phone (owner, 22 Oct 2026 — field work): to a company the person reaches, whom they'll
 * see and for which lead if it's for one, what for, and when — the web's own rules (POST /api/app/visits). The time
 * is the workspace's, as the web takes it.
 */

/** The next half hour from now, as hh:mm. */
function nextHalfHour(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export default function NewVisitScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ company?: string; name?: string; lead?: string }>();
  const [company, setCompany] = useState<{ ref: string; name: string } | null>(params.company ? { ref: params.company, name: params.name ?? params.company } : null);
  const [options, setOptions] = useState<VisitOptions | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(params.lead ?? null);
  const [purpose, setPurpose] = useState<string | null>(null);
  const [day, setDay] = useState(keyOf(new Date()));
  const [pickDay, setPickDay] = useState(false);
  const [time, setTime] = useState(nextHalfHour);
  const [agenda, setAgenda] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [text, setText] = useState("");
  const search = useSettled(text.trim());
  const found = useList<Company>(company ? null : `/api/app/companies?view=all${search ? `&search=${encodeURIComponent(search)}` : ""}`);

  // What a visit can be for, and — once the company is known — whom there it can be with, and which of its leads.
  useEffect(() => {
    let live = true;
    void api<VisitOptions>("GET", `/api/app/visits/options${company ? `?company=${encodeURIComponent(company.ref)}` : ""}`)
      .then((o) => {
        if (!live) return;
        setOptions(o);
        setPurpose((p) => p ?? o.purposes[0]?.value ?? null);
        setContact((c) => (c && o.contacts.some((x) => x.id === c) ? c : (o.contacts[0]?.id ?? null)));
        setLead((l) => (l && o.leads.some((x) => x.id === l) ? l : null));
      })
      .catch((e) => live && setProblem(e instanceof Error ? e.message : "Couldn't load what a visit can be for."));
    return () => {
      live = false;
    };
  }, [company]);

  async function save() {
    if (!company) return;
    if (!TIME.test(time.trim())) return setFields({ scheduled_for: "A time like 14:30." });
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const [h, m] = time.trim().split(":");
      const made = await api<{ id: string; ref: string }>("POST", "/api/app/visits", {
        company: company.ref,
        ...(contact ? { contact } : {}),
        ...(lead ? { lead } : {}),
        ...(purpose ? { purpose } : {}),
        scheduled_for: `${day}T${h!.padStart(2, "0")}:${m}`,
        agenda: agenda.trim(),
      });
      router.replace({ pathname: "/visit/[id]", params: { id: made.id } });
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't plan the visit.");
    } finally {
      setBusy(false);
    }
  }

  if (!company) {
    return (
      <View style={styles.screen}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text style={styles.body}>Which company are you visiting?</Text>
          <SearchBox value={text} onChangeText={setText} placeholder="Search companies" />
          {found.problem && <Notice tone="danger">{found.problem}</Notice>}
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {found.rows === null ? <ActivityIndicator color={colors.brand} /> : found.rows.map((c) => <ListRow key={c.id} title={c.name} subtitle={[c.address?.city, c.account_manager?.name].filter(Boolean).join(" · ")} onPress={() => setCompany({ ref: c.ref, name: c.name })} />)}
          {found.rows?.length === 0 && <Text style={[styles.small, { padding: 16 }]}>{search ? `No company matches “${search}”.` : "No companies yet."}</Text>}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <Text style={styles.small}>Visiting</Text>
        <Text style={[styles.body, { fontWeight: "700" }]}>{company.name}</Text>
        {!params.company && <Button title="A different company" kind="secondary" onPress={() => (setCompany(null), setContact(null), setLead(null))} />}
      </Card>

      {options && options.contacts.length > 0 && (
        <>
          <Heading>Seeing</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.contacts.map((c) => (
              <Chip key={c.id} label={c.name} selected={contact === c.id} onPress={() => setContact(contact === c.id ? null : c.id)} />
            ))}
          </View>
        </>
      )}

      {options && options.leads.length > 0 && (
        <>
          <Heading>For a lead</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.leads.map((l) => (
              <Chip key={l.id} label={l.title} selected={lead === l.id} onPress={() => setLead(lead === l.id ? null : l.id)} />
            ))}
          </View>
        </>
      )}

      {options && (
        <>
          <Heading>What for</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.purposes.map((p) => (
              <Chip key={p.value} label={p.label} selected={purpose === p.value} onPress={() => setPurpose(p.value)} />
            ))}
          </View>
        </>
      )}

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>When</Text>
        {pickDay ? (
          <RangeCalendar from={day} to={day} onChange={(d) => (d && setDay(d), setPickDay(false))} />
        ) : (
          <Button title={dayLabel(day)} kind="secondary" onPress={() => setPickDay(true)} />
        )}
      </View>
      <Field label="At (24-hour)" value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" placeholder="14:30" maxLength={5} error={fields.scheduled_for} />

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>Agenda</Text>
        <TextInput style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]} multiline value={agenda} onChangeText={setAgenda} placeholder="What you'll go over" placeholderTextColor={colors.muted} maxLength={2000} />
      </View>

      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Plan the visit" busy={busy} disabled={!options} onPress={() => void save()} />
    </ScrollView>
  );
}
