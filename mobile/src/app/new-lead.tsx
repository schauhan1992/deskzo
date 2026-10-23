import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { RangeCalendar } from "@/components/calendar";
import { Field, ListRow, SearchBox } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import { dayLabel } from "@/lib/format";
import type { Company, CompanyDetail, Lead, Pipelines } from "@/lib/sales-types";
import { useSession } from "@/lib/session";
import { useList, useSettled } from "@/lib/use-list";

/**
 * A new lead from the phone (owner, 22 Oct 2026 — the app made native): on a company the person reaches — or one
 * they add first — with somebody there to talk to, what it's for, roughly what it's worth and when it should close.
 * It's theirs; the stage it starts at, and everything else, are the web's own rules (POST /api/app/leads).
 */
export default function NewLeadScreen() {
  const router = useRouter();
  const { me } = useSession();
  const params = useLocalSearchParams<{ company?: string; name?: string }>();
  const [company, setCompany] = useState<{ ref: string; name: string } | null>(params.company ? { ref: params.company, name: params.name ?? params.company } : null);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [close, setClose] = useState<string | null>(null);
  const [pickClose, setPickClose] = useState(false);
  const [options, setOptions] = useState<Pipelines | null>(null);
  const [pipeline, setPipeline] = useState<string | null>(null);
  const [source, setSource] = useState("OTHER");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [text, setText] = useState("");
  const search = useSettled(text.trim());
  const found = useList<Company>(company ? null : `/api/app/companies?view=all${search ? `&search=${encodeURIComponent(search)}` : ""}`);

  useEffect(() => {
    void api<Pipelines>("GET", "/api/app/pipelines")
      .then((p) => {
        setOptions(p);
        setPipeline((p.pipelines.find((x) => x.sales) ?? p.pipelines[0])?.id ?? null);
      })
      .catch((e) => setProblem(e instanceof Error ? e.message : "Couldn't load the pipelines."));
  }, []);

  // The company's people, the primary one picked.
  useEffect(() => {
    if (!company) return setDetail(null);
    let live = true;
    void api<CompanyDetail>("GET", `/api/app/companies/${encodeURIComponent(company.ref)}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setContact((d.contacts.find((c) => c.is_primary) ?? d.contacts[0])?.ref ?? null);
      })
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [company]);

  const sources = useMemo(() => options?.sources.filter((s) => s.value !== "DIGITAL_CARD") ?? [], [options]);

  async function save() {
    if (!company || !me) return;
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const amount = value.replace(/[,\s₹]/g, "");
      const made = await api<Lead>("POST", "/api/app/leads", {
        company: company.ref,
        ...(contact ? { contact } : {}),
        title: title.trim(),
        ...(amount ? { value: Number(amount) } : {}),
        ...(close ? { expected_close_date: close } : {}),
        owner: me.person.id,
        source,
        source_detail: "Deskzo app",
        ...(pipeline ? { pipeline } : {}),
      });
      router.replace({ pathname: "/lead/[ref]", params: { ref: made.ref } });
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(e instanceof Error ? e.message : "Couldn't add the lead.");
    } finally {
      setBusy(false);
    }
  }

  if (!company) {
    return (
      <View style={styles.screen}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text style={styles.body}>Which company is it with?</Text>
          <SearchBox value={text} onChangeText={setText} placeholder="Search companies" />
          <Button title="A company that isn't in Deskzo yet" kind="secondary" onPress={() => router.push({ pathname: "/new-company", params: { then: "lead", name: text.trim() } })} />
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
        <Text style={styles.small}>Company</Text>
        <Text style={[styles.body, { fontWeight: "700" }]}>{company.name}</Text>
        {!params.company && <Button title="A different company" kind="secondary" onPress={() => (setCompany(null), setDetail(null), setContact(null))} />}
      </Card>

      {detail && detail.contacts.length > 0 && (
        <>
          <Heading>Who you&apos;re talking to</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {detail.contacts.map((c) => (
              <Chip key={c.id} label={c.name} selected={contact === c.ref} onPress={() => setContact(contact === c.ref ? null : c.ref)} />
            ))}
          </View>
        </>
      )}

      <Field label="What it's for" value={title} onChangeText={setTitle} placeholder="25 laptops and Microsoft 365" maxLength={200} error={fields.title} />
      <Field label="Roughly what it's worth (₹)" value={value} onChangeText={setValue} keyboardType="numeric" placeholder="Leave empty if you don't know yet" error={fields.value} />

      <View style={{ gap: 6 }}>
        <Text style={[styles.small, { color: colors.text, fontWeight: "600" }]}>Expected to close</Text>
        {pickClose ? (
          <RangeCalendar from={close} to={close} onChange={(day) => (setClose(day), setPickClose(false))} />
        ) : (
          <Button title={close ? dayLabel(close) : "Pick a day"} kind="secondary" onPress={() => setPickClose(true)} />
        )}
      </View>

      {options && options.pipelines.length > 1 && (
        <>
          <Heading>Pipeline</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {options.pipelines.map((p) => (
              <Chip key={p.id} label={p.name} selected={pipeline === p.id} onPress={() => setPipeline(p.id)} />
            ))}
          </View>
        </>
      )}

      {sources.length > 0 && (
        <>
          <Heading>Where it came from</Heading>
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]} accessibilityRole="radiogroup">
            {sources.map((s) => (
              <Chip key={s.value} label={s.label} selected={source === s.value} onPress={() => setSource(s.value)} />
            ))}
          </View>
        </>
      )}

      {problem && <Notice tone="danger">{problem}</Notice>}
      <Button title="Add lead" busy={busy} disabled={title.trim().length < 2} onPress={() => void save()} />
    </ScrollView>
  );
}
