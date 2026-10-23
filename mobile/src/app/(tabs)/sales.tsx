import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Chip, Notice, colors, styles } from "@/components/ui";
import { ContactButtons, Fab, ListRow, SearchBox, Segments, StagePill, money } from "@/components/sales";
import type { Company, Contact, Lead } from "@/lib/sales-types";
import { useSession } from "@/lib/session";
import { useList, useSettled } from "@/lib/use-list";

/**
 * Sales (owner, 22 Oct 2026 — the app made native, sales first): leads, companies and contacts, each a list to
 * search, "mine" or everybody's the person reaches — the web's own lists, through /api/app. A lead or a company
 * opens its own screen; + adds one.
 */

type Seg = "leads" | "companies" | "contacts";

const COMPANY_STAGES: Record<string, string> = { PROSPECT: "Prospect", LEAD: "In discussion", CUSTOMER: "Customer", DISQUALIFIED: "Disqualified" };

const place = (c: Company) => [c.address?.city, c.address?.state].filter(Boolean).join(", ");

export default function SalesScreen() {
  const router = useRouter();
  const { me } = useSession();
  const { seg: asked } = useLocalSearchParams<{ seg?: string }>();
  const open = useMemo(() => {
    const out: { value: Seg; label: string }[] = [];
    if (me?.can.leads) out.push({ value: "leads", label: "Leads" });
    if (me?.can.companies) out.push({ value: "companies", label: "Companies" });
    if (me?.can.contacts) out.push({ value: "contacts", label: "Contacts" });
    return out;
  }, [me]);
  const [seg, setSeg] = useState<Seg>("leads");
  const [mine, setMine] = useState(true);
  const [text, setText] = useState("");
  const search = useSettled(text.trim());

  // Opened at one of them from More (`/sales?seg=companies`), or the first the person may open.
  useEffect(() => {
    const want = open.find((o) => o.value === asked) ?? (open.some((o) => o.value === seg) ? null : open[0]);
    if (want) setSeg(want.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, open]);

  const q = search ? `&search=${encodeURIComponent(search)}` : "";
  const view = mine ? "mine" : "all";
  const path = !open.some((o) => o.value === seg) ? null : seg === "leads" ? `/api/app/leads?view=${view}${q}` : seg === "companies" ? `/api/app/companies?view=${view}${q}` : `/api/app/contacts?${q.slice(1)}`;
  const list = useList<Lead | Company | Contact>(path);

  if (me && open.length === 0) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Notice>Leads, companies and contacts aren&apos;t open to you in Deskzo.</Notice>
      </View>
    );
  }

  const empty = search ? `Nothing matches “${search}”.` : seg === "leads" ? (mine ? "No leads of yours yet. Add one with +." : "No leads yet.") : seg === "companies" ? (mine ? "No companies you're the account manager of." : "No companies yet.") : "No contacts yet.";

  return (
    <View style={styles.screen}>
      <FlatList
        data={list.rows ?? []}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 12 }}>
            {open.length > 1 && <Segments options={open} value={seg} onChange={(v) => (setSeg(v), setText(""))} />}
            <SearchBox value={text} onChangeText={setText} placeholder={seg === "leads" ? "Search leads" : seg === "companies" ? "Search companies" : "Search contacts"} />
            {seg !== "contacts" && (
              <View style={[styles.row, { gap: 8 }]} accessibilityRole="radiogroup">
                <Chip label="Mine" selected={mine} onPress={() => setMine(true)} />
                <Chip label="Everyone's" selected={!mine} onPress={() => setMine(false)} />
                {list.total !== null && <Text style={[styles.small, { marginLeft: "auto" }]}>{list.total}</Text>}
              </View>
            )}
            {list.problem && <Notice tone="danger">{list.problem}</Notice>}
          </View>
        }
        renderItem={({ item: row }) => {
          if (seg === "leads") {
            const item = row as Lead;
            return (
            <ListRow
              title={item.title}
              subtitle={[item.company?.name, money(item.value), mine ? null : item.owner?.name].filter(Boolean).join(" · ")}
              right={item.stage ? <StagePill name={item.stage.name} status={item.status} /> : null}
              onPress={() => router.push({ pathname: "/lead/[ref]", params: { ref: item.ref } })}
            />
            );
          }
          if (seg === "companies") {
            const item = row as Company;
            return (
            <ListRow
              title={item.name}
              subtitle={[place(item), item.stage ? COMPANY_STAGES[item.stage] ?? item.stage : null, mine ? null : item.account_manager?.name].filter(Boolean).join(" · ")}
              onPress={() => router.push({ pathname: "/company/[ref]", params: { ref: item.ref } })}
            />
            );
          }
          const item = row as Contact;
          return (
            <ListRow
              title={item.name}
              subtitle={[item.company?.name, item.designation_name].filter(Boolean).join(" · ")}
              right={<ContactButtons phone={item.phone} email={item.email} name={item.name} />}
              onPress={item.company ? () => router.push({ pathname: "/company/[ref]", params: { ref: item.company!.ref ?? item.company!.id } }) : undefined}
            />
          );
        }}
        onEndReached={() => void list.loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={list.loading && list.rows !== null} onRefresh={() => void list.reload()} />}
        ListEmptyComponent={list.rows === null ? <ActivityIndicator color={colors.brand} style={{ marginTop: 24 }} /> : list.problem ? undefined : <Text style={[styles.small, { textAlign: "center", padding: 24 }]}>{empty}</Text>}
        ListFooterComponent={list.more ? <ActivityIndicator color={colors.brand} style={{ margin: 16 }} /> : <View style={{ height: 90 }} />}
      />
      {seg !== "contacts" && (
        <Fab label={seg === "leads" ? "New lead" : "New company"} onPress={() => router.push(seg === "leads" ? "/new-lead" : "/new-company")} />
      )}
    </View>
  );
}
