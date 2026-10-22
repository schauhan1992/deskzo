import { useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/chat/avatar";
import { Button, Notice, colors } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useChat } from "@/lib/chat";

/**
 * Starting a chat (owner, 18 Oct 2026): a colleague for a chat of two — the same one however often it's started — or
 * several and a name for a group, with the person as its admin. Switched-off colleagues aren't offered.
 */
export default function NewChat() {
  const router = useRouter();
  const chat = useChat();
  const [group, setGroup] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const people = useMemo(() => {
    const query = q.trim().toLowerCase();
    return chat.people.filter((p) => p.active && (!query || p.name.toLowerCase().includes(query) || (p.department ?? "").toLowerCase().includes(query)));
  }, [chat.people, q]);

  async function direct(userId: string) {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ chat_id: string }>("POST", "/api/app/chat/direct", { user_id: userId });
      router.replace({ pathname: "/conversation/[id]", params: { id: r.chat_id } });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Couldn't open that chat.");
      setBusy(false);
    }
  }

  async function createGroup() {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ chat_id: string }>("POST", "/api/app/chat/groups", { name: name.trim(), member_ids: picked });
      void chat.reloadSummaries();
      router.replace({ pathname: "/conversation/[id]", params: { id: r.chat_id } });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Couldn't make the group.");
      setBusy(false);
    }
  }

  if (naming) {
    return (
      <KeyboardAvoidingView style={[s.screen, { padding: 16, gap: 12 }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Text style={s.label}>Group name</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="e.g. Sales — North" placeholderTextColor={colors.muted} maxLength={60} autoFocus accessibilityLabel="Group name" />
        <Text style={s.small}>
          {picked.length} {picked.length === 1 ? "person" : "people"} and you. You&apos;ll be the group&apos;s admin.
        </Text>
        {problem && <Notice tone="danger">{problem}</Notice>}
        <Button title="Create group" busy={busy} disabled={!name.trim()} onPress={() => void createGroup()} />
        <Button title="Back" kind="secondary" disabled={busy} onPress={() => setNaming(false)} />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={s.screen}>
      <View style={s.searchBox}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search name or department" placeholderTextColor={colors.muted} autoFocus accessibilityLabel="Search people" />
      </View>
      {!group && (
        <Pressable accessibilityRole="button" style={s.row} onPress={() => setGroup(true)}>
          <View style={s.groupIcon}>
            <Ionicons name="people" size={24} color="#fff" />
          </View>
          <Text style={s.name}>New group</Text>
        </Pressable>
      )}
      {problem && (
        <View style={{ paddingHorizontal: 16 }}>
          <Notice tone="danger">{problem}</Notice>
        </View>
      )}
      <FlatList
        data={people}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const on = picked.includes(item.id);
          return (
            <Pressable
              accessibilityRole={group ? "checkbox" : "button"}
              accessibilityState={group ? { checked: on } : undefined}
              disabled={busy}
              style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.sunken }]}
              onPress={() => (group ? setPicked((now) => (on ? now.filter((x) => x !== item.id) : [...now, item.id])) : void direct(item.id))}
            >
              <Avatar name={item.name} size={44} online={chat.online.has(item.id)} />
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                {item.department && <Text style={s.small}>{item.department}</Text>}
              </View>
              {group && <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={24} color={on ? colors.brand : colors.line} />}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={[s.small, { padding: 24, textAlign: "center" }]}>Nobody matches that.</Text>}
      />
      {group && (
        <View style={s.bar}>
          <Text style={[s.small, { flex: 1 }]}>{picked.length ? `${picked.length} picked` : "Pick the people for the group"}</Text>
          <Button title="Cancel" kind="secondary" onPress={() => (setGroup(false), setPicked([]))} />
          <Button title="Next" disabled={picked.length === 0} onPress={() => setNaming(true)} />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, margin: 12, paddingHorizontal: 12, borderRadius: 24, backgroundColor: colors.sunken },
  search: { flex: 1, paddingVertical: 9, fontSize: 16, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  groupIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.brandFill, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  small: { fontSize: 13, color: colors.muted },
  label: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.text, backgroundColor: colors.surface },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
