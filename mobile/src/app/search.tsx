import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Heading, Notice, colors, styles } from "@/components/ui";
import { ListRow, SearchBox } from "@/components/sales";
import { api } from "@/lib/api";
import type { Contact, SearchResult } from "@/lib/sales-types";
import { useSettled } from "@/lib/use-list";

/**
 * Everything at once (owner, 22 Oct 2026 — the app made native): leads, companies and contacts matching what's typed,
 * each where the web's own search offers it to the person (GET /api/app/search). A contact opens their company.
 */

const KINDS = [
  { kind: "lead", label: "Leads" },
  { kind: "company", label: "Companies" },
  { kind: "contact", label: "Contacts" },
] as const;

export default function SearchScreen() {
  const router = useRouter();
  const [text, setText] = useState("");
  const query = useSettled(text.trim());
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (query.length < 2) return setResults(null);
    let live = true;
    setLoading(true);
    setProblem(null);
    void api<{ query: string; results: SearchResult[] }>("GET", `/api/app/search?q=${encodeURIComponent(query)}`)
      .then((r) => live && setResults(r.results))
      .catch((e) => live && setProblem(e instanceof Error ? e.message : "Couldn't search."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query]);

  async function open(r: SearchResult) {
    if (r.kind === "lead") return router.push({ pathname: "/lead/[ref]", params: { ref: r.id } });
    if (r.kind === "company") return router.push({ pathname: "/company/[ref]", params: { ref: r.id } });
    try {
      const c = await api<Contact>("GET", `/api/app/contacts/${encodeURIComponent(r.id)}`);
      if (c.company) router.push({ pathname: "/company/[ref]", params: { ref: c.company.ref ?? c.company.id } });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't open them.");
    }
  }

  return (
    <View style={styles.screen}>
      <View style={{ padding: 16, gap: 12 }}>
        <SearchBox value={text} onChangeText={setText} placeholder="Leads, companies, people" />
        {problem && <Notice tone="danger">{problem}</Notice>}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled">
        {loading && <ActivityIndicator color={colors.brand} />}
        {results?.length === 0 && !loading && <Text style={[styles.small, { padding: 16 }]}>Nothing matches “{query}”.</Text>}
        {results &&
          KINDS.map(({ kind, label }) => {
            const hits = results.filter((r) => r.kind === kind);
            if (hits.length === 0) return null;
            return (
              <View key={kind}>
                <View style={{ paddingHorizontal: 16 }}>
                  <Heading count={hits.length}>{label}</Heading>
                </View>
                {hits.map((r) => (
                  <ListRow key={`${kind}-${r.id}`} title={r.title} subtitle={r.subtitle} onPress={() => void open(r)} />
                ))}
              </View>
            );
          })}
      </ScrollView>
    </View>
  );
}
