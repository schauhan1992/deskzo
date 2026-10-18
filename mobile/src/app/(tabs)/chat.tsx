import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/chat/avatar";
import { Notice, colors } from "@/components/ui";
import { api } from "@/lib/api";
import { useChat } from "@/lib/chat";
import { listTime } from "@/lib/chat-format";
import type { ChatSummary } from "@/lib/chat-types";

/**
 * Chat (owner, 18 Oct 2026): the person's conversations, newest first — unread counts, who is online, muted and
 * @mentioned marks — and a button to start one. A conversation opens full screen (src/app/conversation/[id].tsx).
 */

type Hit = { chatId: string; messageId: string; chatTitle: string; senderName: string | null; snippet: string; createdAt: string };

const isMuted = (until: string | null) => !!until && new Date(until).getTime() > Date.now();

export default function ChatList() {
  const router = useRouter();
  const chat = useChat();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Coming back to the list: its rows as they are now.
  const { reloadSummaries } = chat;
  useFocusEffect(
    useCallback(() => {
      void reloadSummaries();
    }, [reloadSummaries]),
  );

  const query = q.trim().toLowerCase();
  const rows = useMemo(() => (query ? chat.summaries.filter((s) => s.title.toLowerCase().includes(query)) : chat.summaries), [chat.summaries, query]);

  async function searchMessages() {
    try {
      setHits(await api<Hit[]>("GET", `/api/app/chat/search?q=${encodeURIComponent(q.trim())}`));
    } catch {
      setHits([]);
    }
  }

  if (!chat.available) {
    return (
      <View style={s.screen}>
        <Notice>Chat isn&apos;t open to you in this workspace.</Notice>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={s.searchBox}>
        <Ionicons name="search" size={18} color={colors.muted} />
        <TextInput
          style={s.search}
          value={q}
          onChangeText={(t) => {
            setQ(t);
            setHits(null);
          }}
          placeholder="Search"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          onSubmitEditing={() => q.trim().length >= 2 && void searchMessages()}
          accessibilityLabel="Search chats"
        />
        {!!q && (
          <Pressable accessibilityLabel="Clear" onPress={() => (setQ(""), setHits(null))} hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={colors.muted} />
          </Pressable>
        )}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => <Row chat={item} online={!!item.otherUserId && chat.online.has(item.otherUserId)} onPress={() => router.push({ pathname: "/conversation/[id]", params: { id: item.id } })} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await chat.refresh();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          chat.loaded ? (
            <Text style={s.empty}>{query ? "No chat by that name." : "No chats yet. Start one with the button below — with anyone in your company."}</Text>
          ) : undefined
        }
        ListFooterComponent={
          query.length >= 2 ? (
            <View style={{ padding: 16, gap: 8 }}>
              {hits === null ? (
                <Pressable accessibilityRole="button" onPress={() => void searchMessages()}>
                  <Text style={s.link}>Search messages for “{q.trim()}”</Text>
                </Pressable>
              ) : hits.length === 0 ? (
                <Text style={s.empty}>No messages with that.</Text>
              ) : (
                hits.map((h) => (
                  <Pressable key={h.messageId} style={s.hit} onPress={() => router.push({ pathname: "/conversation/[id]", params: { id: h.chatId, around: h.messageId } })}>
                    <Text style={s.title} numberOfLines={1}>
                      {h.chatTitle}
                    </Text>
                    <Text style={s.preview} numberOfLines={2}>
                      {h.senderName ? `${h.senderName}: ` : ""}
                      {h.snippet}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          ) : (
            <View style={{ height: 96 }} />
          )
        }
      />

      <Pressable accessibilityRole="button" accessibilityLabel="New chat" style={s.fab} onPress={() => router.push("/new-chat")}>
        <Ionicons name="chatbubble-ellipses" size={26} color="#fff" />
      </Pressable>
    </View>
  );
}

function Row({ chat, online, onPress }: { chat: ChatSummary; online: boolean; onPress: () => void }) {
  const unread = chat.unread > 0;
  const muted = isMuted(chat.mutedUntil);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.sunken }]}>
      <Avatar name={chat.title} group={chat.kind === "GROUP"} online={online} />
      <View style={s.rowBody}>
        <View style={s.rowTop}>
          <Text style={[s.title, unread && { fontWeight: "700" }]} numberOfLines={1}>
            {chat.title}
          </Text>
          <Text style={[s.time, unread && !muted && { color: UNREAD }]}>{listTime(chat.lastMessageAt)}</Text>
        </View>
        <View style={s.rowTop}>
          <Text style={[s.preview, chat.left && { fontStyle: "italic" }]} numberOfLines={1}>
            {chat.left ? "You're no longer in this group" : chat.preview || " "}
          </Text>
          <View style={s.marks}>
            {muted && <Ionicons name="volume-mute" size={16} color={colors.muted} />}
            {chat.mentioned && unread && <Text style={s.at}>@</Text>}
            {unread && (
              <View style={[s.badge, muted && { backgroundColor: colors.muted }]}>
                <Text style={s.badgeText}>{chat.unread > 99 ? "99+" : chat.unread}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

/** WhatsApp's unread green. */
const UNREAD = "#16A34A";

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, margin: 12, paddingHorizontal: 12, borderRadius: 24, backgroundColor: colors.sunken },
  search: { flex: 1, paddingVertical: 9, fontSize: 16, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  rowBody: { flex: 1, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingBottom: 10, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
  time: { fontSize: 12, color: colors.muted },
  preview: { flex: 1, fontSize: 14, color: colors.muted },
  marks: { flexDirection: "row", alignItems: "center", gap: 6 },
  at: { color: UNREAD, fontWeight: "800", fontSize: 15 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: UNREAD, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  empty: { padding: 24, textAlign: "center", color: colors.muted, fontSize: 15 },
  link: { color: colors.brand, fontSize: 15, fontWeight: "600" },
  hit: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, gap: 2 },
  fab: {
    position: "absolute",
    right: 18,
    bottom: 18,
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});
