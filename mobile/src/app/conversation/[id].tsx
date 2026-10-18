import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Avatar } from "@/components/chat/avatar";
import { Bubble, CHAT, type Ticks } from "@/components/chat/bubble";
import { Composer, type Picked } from "@/components/chat/composer";
import { MessageMenu, type MenuAction } from "@/components/chat/message-menu";
import { colors } from "@/components/ui";
import { ApiError, api, signedIn, upload } from "@/lib/api";
import { useChat } from "@/lib/chat";
import { dayKey, dayLine, lastSeenLine, ticksFor } from "@/lib/chat-format";
import type { ChatAttachmentView, ChatMemberView, ChatMessageView, ChatPinView, ChatReactionView, OpenedChat } from "@/lib/chat-types";
import { useSession } from "@/lib/session";

/**
 * One conversation, full screen and nothing else on it (owner, 18 Oct 2026) — as WhatsApp's: who it is with and
 * whether they're online or typing, the pinned message, the messages with their ticks, and the bar to write in. It
 * listens to the live stream for its own chat (src/lib/chat.tsx) and marks itself read while it's on screen.
 */

type Local = ChatMessageView & { local?: "sending" | "failed" };
type Row = { kind: "day"; key: string; label: string } | { kind: "msg"; key: string; m: Local; first: boolean; showName: boolean };

const MUTE = [
  { hours: 8, label: "Mute for 8 hours" },
  { hours: 24 * 7, label: "Mute for a week" },
];

function upsert(list: Local[], m: ChatMessageView): Local[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = m;
    return next;
  }
  return [...list, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export default function Conversation() {
  const { id, around } = useLocalSearchParams<{ id: string; around?: string }>();
  const router = useRouter();
  const chat = useChat();
  const { me: whoAmI } = useSession();
  const meId = chat.me?.id ?? whoAmI?.person.id ?? "";
  const copyBlocked = whoAmI?.screen?.copyBlocked === true;

  const [opened, setOpened] = useState<OpenedChat | null>(null);
  const [messages, setMessages] = useState<Local[]>([]);
  const [members, setMembers] = useState<ChatMemberView[]>([]);
  const [pins, setPins] = useState<ChatPinView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [typing, setTyping] = useState<{ name: string; until: number } | null>(null);
  const [reply, setReply] = useState<ChatMessageView | null>(null);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const [menuFor, setMenuFor] = useState<ChatMessageView | null>(null);
  const [viewing, setViewing] = useState<ChatAttachmentView | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const list = useRef<FlatList<Row>>(null);
  const earlier = useRef(false);
  const lastTyping = useRef(0);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retries = useRef(new Map<string, () => void>());

  const markRead = useCallback(() => {
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      void api("POST", `/api/app/chat/${id}/read`).then(
        () => chat.reloadSummaries([id]),
        () => {},
      );
    }, 400);
  }, [id, chat.reloadSummaries]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    try {
      const o = await api<OpenedChat>("GET", `/api/app/chat/${id}${around ? `?around=${encodeURIComponent(around)}` : ""}`);
      setOpened(o);
      setMembers(o.members);
      setPins(o.pins);
      setHasMore(o.hasMore);
      // Kept: what is still sending from here.
      setMessages((now) => [...o.messages, ...now.filter((m) => m.local)]);
      setProblem(null);
      markRead();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "Couldn't open this chat.");
    }
  }, [id, around, markRead]);

  useEffect(() => {
    void load();
    chat.setOpenChat(id);
    return () => chat.setOpenChat(null);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // This chat's events from the live stream.
  useEffect(
    () =>
      chat.listen((e) => {
        switch (e.type) {
          case "ready":
            // Back after a gap: whatever came in it.
            void load();
            break;
          case "message":
            if (e.message.chatId !== id) return;
            setMessages((now) => {
              // My own, back from the stream before the send has answered: its stand-in goes now.
              const mine = e.message.senderId === meId;
              const standIn = mine ? now.find((m) => m.local && m.body === e.message.body && m.attachments.length === e.message.attachments.length) : undefined;
              return upsert(standIn ? now.filter((m) => m !== standIn) : now, e.message);
            });
            if (e.message.senderId !== meId) {
              setTyping(null);
              if (AppState.currentState === "active") markRead();
            }
            break;
          case "message-updated":
            if (e.message.chatId === id) setMessages((now) => upsert(now, e.message));
            break;
          case "reactions":
            if (e.chatId === id) setMessages((now) => now.map((m) => (m.id === e.messageId ? { ...m, reactions: e.reactions } : m)));
            break;
          case "receipt":
            if (e.chatId === id) setMembers((now) => now.map((m) => (m.userId === e.userId ? { ...m, lastDeliveredAt: e.lastDeliveredAt, lastReadAt: e.lastReadAt } : m)));
            break;
          case "typing":
            if (e.chatId === id && e.userId !== meId) setTyping({ name: e.name, until: Date.now() + 5000 });
            break;
          case "pins-changed":
            if (e.chatId === id) void api<ChatPinView[]>("GET", `/api/app/chat/${id}/pins`).then(setPins, () => {});
            break;
          case "chat-changed":
            if (e.chatId === id) void load();
            break;
        }
      }),
    [id, meId, load, markRead], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!typing) return;
    const t = setTimeout(() => setTyping(null), Math.max(0, typing.until - Date.now()));
    return () => clearTimeout(t);
  }, [typing]);

  const summary = opened?.summary;
  const group = summary?.kind === "GROUP";
  const otherId = summary?.otherUserId ?? null;
  const subtitle = typing
    ? group
      ? `${typing.name.split(" ")[0]} is typing…`
      : "typing…"
    : group
      ? members
          .filter((m) => !m.leftAt)
          .map((m) => (m.userId === meId ? "You" : m.name.split(" ")[0]))
          .join(", ")
      : otherId && chat.online.has(otherId)
        ? "online"
        : lastSeenLine(otherId ? chat.lastSeen[otherId] : undefined);
  const closed = !summary
    ? null
    : summary.left
      ? "You're no longer in this group."
      : !group && !summary.otherActive
        ? `${summary.title} can't receive messages — their account is switched off.`
        : null;

  // Days apart; a run from one sender sits together, its first with the corner and (in a group) the name.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let prev: Local | null = null;
    for (const m of messages) {
      if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) out.push({ kind: "day", key: `day-${dayKey(m.createdAt)}`, label: dayLine(m.createdAt) });
      const first = !prev || prev.senderId !== m.senderId || prev.kind === "SYSTEM" || dayKey(prev.createdAt) !== dayKey(m.createdAt) || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
      out.push({ kind: "msg", key: m.id, m, first, showName: group && first && m.senderId !== meId });
      prev = m;
    }
    return out.reverse();
  }, [messages, group, meId]);

  const where = signedIn();
  const image = useCallback(
    (a: ChatAttachmentView) => (/^(file|content):/.test(a.id) ? { uri: a.id, headers: {} } : { uri: `${where?.baseUrl}/api/app/chat/files/${a.id}`, headers: where?.headers ?? {} }),
    [where?.baseUrl], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function typingNow() {
    if (Date.now() - lastTyping.current < 3000) return;
    lastTyping.current = Date.now();
    void api("POST", `/api/app/chat/${id}/typing`).catch(() => {});
  }

  function send(text: string, files: Picked[]) {
    const tempId = `local-${Date.now()}`;
    const quoted = reply;
    setReply(null);
    const local: Local = {
      id: tempId,
      chatId: id,
      kind: "TEXT",
      senderId: meId,
      senderName: chat.me?.name ?? null,
      body: text,
      replyTo: quoted ? { id: quoted.id, senderName: quoted.senderName, body: quoted.body, deleted: false, attachmentCount: quoted.attachments.length } : null,
      attachments: files.map((f) => ({ id: f.uri, fileName: f.name, mimeType: f.type, size: f.size })),
      mentionIds: [],
      reactions: [],
      editedAt: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      local: "sending",
    };
    setMessages((now) => [...now, local]);
    list.current?.scrollToOffset({ offset: 0, animated: true });
    const go = async () => {
      setMessages((now) => now.map((m) => (m.id === tempId ? { ...m, local: "sending" } : m)));
      const form = new FormData();
      form.append("body", text);
      if (quoted) form.append("replyToId", quoted.id);
      for (const f of files) form.append("files", { uri: f.uri, name: f.name, type: f.type } as unknown as Blob);
      try {
        const sent = await upload<ChatMessageView>(`/api/app/chat/${id}/messages`, form);
        retries.current.delete(tempId);
        setMessages((now) => upsert(now.filter((m) => m.id !== tempId), sent));
        void chat.reloadSummaries([id]);
      } catch (e) {
        setMessages((now) => now.map((m) => (m.id === tempId ? { ...m, local: "failed" } : m)));
        if (e instanceof ApiError && e.status !== 0) Alert.alert("Not sent", e.message);
      }
    };
    retries.current.set(tempId, () => void go());
    void go();
  }

  async function saveEdit(text: string): Promise<boolean> {
    if (!editing) return false;
    try {
      const updated = await api<ChatMessageView>("PATCH", `/api/app/chat/messages/${editing.id}`, { body: text });
      setMessages((now) => upsert(now, updated));
      setEditing(null);
      return true;
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
      return false;
    }
  }

  async function react(m: ChatMessageView, emoji: string | null) {
    setMenuFor(null);
    try {
      const reactions = await api<ChatReactionView[]>("POST", `/api/app/chat/messages/${m.id}/react`, { emoji });
      setMessages((now) => now.map((x) => (x.id === m.id ? { ...x, reactions } : x)));
    } catch (e) {
      Alert.alert("Not done", e instanceof Error ? e.message : "Try again.");
    }
  }

  async function act(m: ChatMessageView, action: MenuAction) {
    setMenuFor(null);
    if (action === "reply") return setReply(m);
    if (action === "copy") return void Clipboard.setStringAsync(m.body);
    if (action === "edit") return setEditing(m);
    if (action === "pin" || action === "unpin") {
      try {
        setPins(await api<ChatPinView[]>("POST", `/api/app/chat/messages/${m.id}/pin`, { pinned: action === "pin" }));
      } catch (e) {
        Alert.alert("Not done", e instanceof Error ? e.message : "Try again.");
      }
      return;
    }
    if (action === "delete") {
      Alert.alert("Delete for everyone?", "It's removed for everyone in this chat.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const gone = await api<ChatMessageView>("DELETE", `/api/app/chat/messages/${m.id}`);
              setMessages((now) => upsert(now, gone));
            } catch (e) {
              Alert.alert("Not deleted", e instanceof Error ? e.message : "Try again.");
            }
          },
        },
      ]);
    }
  }

  function menu() {
    if (!summary) return;
    const muted = !!summary.mutedUntil && new Date(summary.mutedUntil).getTime() > Date.now();
    const mute = (hours: number | null) =>
      api("POST", `/api/app/chat/${id}/mute`, { hours }).then(
        () => (chat.reloadSummaries([id]), load()),
        (e: Error) => Alert.alert("Not done", e.message),
      );
    Alert.alert(summary.title, undefined, [
      ...(muted ? [{ text: "Unmute", onPress: () => void mute(null) }] : MUTE.map((c) => ({ text: c.label, onPress: () => void mute(c.hours) }))),
      ...(group && !summary.left
        ? [
            {
              text: "Leave group",
              style: "destructive" as const,
              onPress: () =>
                Alert.alert("Leave this group?", "Its messages so far stay with you; nothing new will arrive.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Leave",
                    style: "destructive",
                    onPress: () => void api("POST", `/api/app/chat/${id}/leave`).then(() => (chat.reloadSummaries([id]), load()), (e: Error) => Alert.alert("Not done", e.message)),
                  },
                ]),
            },
          ]
        : []),
      { text: "Close", style: "cancel" },
    ]);
  }

  const pinnedIds = new Set(pins.map((p) => p.messageId));
  const mentionable = group ? members.filter((m) => !m.leftAt && m.userId !== meId).map((m) => ({ userId: m.userId, name: m.name })) : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={["top", "bottom"]}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/chat"))} hitSlop={10} style={{ padding: 6 }}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </Pressable>
        <Avatar name={summary?.title ?? "…"} group={group} size={40} online={!!otherId && chat.online.has(otherId)} />
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>
            {summary?.title ?? ""}
          </Text>
          {!!subtitle && (
            <Text style={[s.subtitle, typing && { color: "#16A34A" }]} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Chat options" onPress={menu} hitSlop={10} style={{ padding: 6 }}>
          <Ionicons name="ellipsis-vertical" size={22} color={colors.text} />
        </Pressable>
      </View>

      {pins.length > 0 && (
        <View style={s.pins}>
          <Ionicons name="pin" size={16} color={colors.muted} />
          <Text style={s.pinText} numberOfLines={1}>
            {pins[0]!.senderName ? `${pins[0]!.senderName}: ` : ""}
            {pins[0]!.body || "📎 Attachment"}
          </Text>
          {pins.length > 1 && <Text style={s.pinCount}>+{pins.length - 1}</Text>}
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: CHAT.wallpaper }} behavior="padding">
        {problem && !opened ? (
          <Text style={s.problem}>{problem}</Text>
        ) : !opened ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={rows}
            keyExtractor={(r) => r.key}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingVertical: 8 }}
            onScroll={(e) => setScrolledUp(e.nativeEvent.contentOffset.y > 400)}
            scrollEventThrottle={200}
            onEndReachedThreshold={0.3}
            onEndReached={async () => {
              if (!hasMore || earlier.current || !messages[0]) return;
              earlier.current = true;
              try {
                const page = await api<{ messages: ChatMessageView[]; hasMore: boolean }>("GET", `/api/app/chat/${id}/earlier?before=${encodeURIComponent(messages[0].createdAt)}`);
                setMessages((now) => [...page.messages.filter((m) => !now.some((x) => x.id === m.id)), ...now]);
                setHasMore(page.hasMore);
              } finally {
                earlier.current = false;
              }
            }}
            renderItem={({ item }) =>
              item.kind === "day" ? (
                <View style={s.dayRow}>
                  <Text style={s.day}>{item.label}</Text>
                </View>
              ) : (
                <Bubble
                  message={item.m}
                  mine={item.m.senderId === meId}
                  showName={item.showName}
                  first={item.first}
                  meId={meId}
                  ticks={item.m.senderId === meId ? ((item.m.local ?? ticksFor(item.m, members, meId)) as Ticks) : null}
                  image={image}
                  onLongPress={setMenuFor}
                  onReply={setReply}
                  onImage={setViewing}
                  onFile={() =>
                    Alert.alert("Open on the Deskzo tab", "Files open in Deskzo's own chat, where your workspace's rules for them apply.", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Open", onPress: () => router.push({ pathname: "/web", params: { path: `/chat?c=${id}` } }) },
                    ])
                  }
                  onRetry={retries.current.get(item.m.id)}
                />
              )
            }
          />
        )}
        {scrolledUp && (
          <Pressable accessibilityRole="button" accessibilityLabel="Latest messages" style={s.down} onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}>
            <Ionicons name="chevron-down" size={22} color={colors.text} />
          </Pressable>
        )}
        {opened && (
          <Composer
            members={mentionable}
            reply={reply}
            editing={editing}
            closed={closed}
            onCancel={() => (setReply(null), setEditing(null))}
            onSend={send}
            onEdit={saveEdit}
            onTyping={typingNow}
          />
        )}
      </KeyboardAvoidingView>

      <MessageMenu
        message={menuFor}
        mine={menuFor?.senderId === meId}
        pinned={!!menuFor && pinnedIds.has(menuFor.id)}
        copyBlocked={copyBlocked}
        meId={meId}
        onReact={(emoji) => menuFor && void react(menuFor, emoji)}
        onAction={(a) => menuFor && void act(menuFor, a)}
        onClose={() => setMenuFor(null)}
      />

      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <View style={s.viewer}>
          <SafeAreaView edges={["top"]} style={s.viewerBar}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setViewing(null)} hitSlop={10} style={{ padding: 8 }}>
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
            <Text style={s.viewerName} numberOfLines={1}>
              {viewing?.fileName}
            </Text>
          </SafeAreaView>
          {viewing && <Image source={image(viewing)} style={{ flex: 1 }} resizeMode="contain" />}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 6, paddingVertical: 6, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 13, color: colors.muted },
  pins: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pinText: { flex: 1, fontSize: 14, color: colors.text },
  pinCount: { fontSize: 12, color: colors.muted },
  problem: { margin: 24, textAlign: "center", color: colors.danger },
  dayRow: { alignItems: "center", marginVertical: 8 },
  day: { fontSize: 12.5, color: "#54656F", backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden", elevation: 1 },
  down: { position: "absolute", right: 14, bottom: 80, width: 40, height: 40, borderRadius: 20, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", elevation: 3 },
  viewer: { flex: 1, backgroundColor: "#000" },
  viewerBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  viewerName: { flex: 1, color: "#fff", fontSize: 15 },
});
