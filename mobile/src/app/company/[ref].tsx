import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, colors, styles } from "@/components/ui";
import { ActivityLine, ContactButtons, Detail, ListRow, StagePill, money } from "@/components/sales";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { CompanyDetail } from "@/lib/sales-types";

/**
 * A company (owner, 22 Oct 2026 — the app made native): where it is, the people there to ring, WhatsApp or email,
 * its open leads and the last things logged on them — and a new lead or contact added from here. Its orders, money
 * and documents are on its web page until they have screens of their own.
 */

const STAGES: Record<string, string> = { PROSPECT: "Prospect", LEAD: "In discussion", CUSTOMER: "Customer", DISQUALIFIED: "Disqualified" };

export default function CompanyScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();
  const router = useRouter();
  const { me } = useSession();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setCompany(await api<CompanyDetail>("GET", `/api/app/companies/${encodeURIComponent(ref)}`));
    } catch (e) {
      setProblem(e instanceof ApiError || e instanceof Error ? e.message : "Couldn't open this company.");
    } finally {
      setLoading(false);
    }
  }, [ref]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!company) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Stack.Screen options={{ title: "Company" }} />
        {problem ? <Notice tone="danger">{problem}</Notice> : <ActivityIndicator color={colors.brand} />}
        {problem && <Button title="Try again" kind="secondary" onPress={() => void load()} />}
      </View>
    );
  }

  const a = company.address;
  const where = [a?.line, a?.city, a?.state, a?.pincode].filter(Boolean).join(", ");
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      <Stack.Screen options={{ title: company.ref }} />

      <Card>
        <Text style={styles.title}>{company.name}</Text>
        {company.stage && (
          <View style={{ flexDirection: "row" }}>
            <StagePill name={STAGES[company.stage] ?? company.stage} status={company.stage === "CUSTOMER" ? "WON" : company.stage === "DISQUALIFIED" ? "LOST" : null} />
          </View>
        )}
        <Detail label="Account manager" value={company.account_manager?.name} />
        <Detail label="Owner" value={company.owner?.name} />
        <Detail label="Industry" value={company.industry?.name} />
        <Detail label="GSTIN" value={a?.gstin} />
        {where ? (
          <Pressable accessibilityRole="link" accessibilityLabel={`Open ${where} in maps`} onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${company.name}, ${where}`)}`)}>
            <Text style={[styles.body, { color: colors.brand }]}>{where}</Text>
          </Pressable>
        ) : null}
      </Card>

      {problem && <Notice tone="danger">{problem}</Notice>}

      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Heading count={company.contacts.length}>People</Heading>
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/new-contact", params: { company: company.ref, name: company.name } })} hitSlop={8}>
          <Text style={{ color: colors.brand, fontWeight: "600", marginTop: 8 }}>Add contact</Text>
        </Pressable>
      </View>
      <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
        {company.contacts.length === 0 ? (
          <View style={{ padding: 14 }}>
            <Notice>Nobody here yet.</Notice>
          </View>
        ) : (
          company.contacts.map((c) => <ListRow key={c.id} title={c.name + (c.is_primary ? " · primary" : "")} subtitle={[c.designation_name, c.phone, c.email].filter(Boolean).join(" · ")} right={<ContactButtons phone={c.phone} email={c.email} name={`${c.name}, ${company.name}`} />} />)
        )}
      </Card>

      {me?.can.leads && (
        <>
          <View style={[styles.row, { justifyContent: "space-between" }]}>
            <Heading count={company.open_leads.length}>Open leads</Heading>
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/new-lead", params: { company: company.ref, name: company.name } })} hitSlop={8}>
              <Text style={{ color: colors.brand, fontWeight: "600", marginTop: 8 }}>New lead</Text>
            </Pressable>
          </View>
          <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
            {company.open_leads.length === 0 ? (
              <View style={{ padding: 14 }}>
                <Notice>No open leads.</Notice>
              </View>
            ) : (
              company.open_leads.map((l) => (
                <ListRow
                  key={l.id}
                  title={l.title}
                  subtitle={[money(l.value), l.owner?.name].filter(Boolean).join(" · ")}
                  right={l.stage ? <StagePill name={l.stage.name} status={l.status} /> : null}
                  onPress={() => router.push({ pathname: "/lead/[ref]", params: { ref: l.ref } })}
                />
              ))
            )}
          </Card>

          <Heading>Latest</Heading>
          <Card>{company.activities.length === 0 ? <Notice>Nothing logged on its leads yet.</Notice> : company.activities.map((x) => <ActivityLine key={x.id} activity={x} showLead />)}</Card>
        </>
      )}

      {me?.can.visits && <Button title="Plan a visit" kind="secondary" onPress={() => router.push({ pathname: "/new-visit", params: { company: company.ref, name: company.name } })} />}
      {me?.can.calendar && <Button title="Schedule a meeting" kind="secondary" onPress={() => router.push({ pathname: "/new-meeting", params: { kind: "company", id: company.id, name: company.name } })} />}
      <Button title="Open on the web" kind="secondary" onPress={() => router.push({ pathname: "/web", params: { path: `/companies/${company.ref}` } })} />
    </ScrollView>
  );
}
