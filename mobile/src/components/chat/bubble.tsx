import { memo, useRef } from "react";
import { Animated, Image, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, dynamic } from "@/components/ui";
import { bubbleTime, fileSize } from "@/lib/chat-format";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat-types";

/**
 * One message, as WhatsApp draws one: mine on the right, theirs on the left with the sender's name in a group, the
 * message it answers above, pictures and files, the time and my ticks in the corner, reactions underneath. Long-press
 * for the menu; swipe it to the right to answer it.
 */

export type Ticks = "sending" | "failed" | "sent" | "delivered" | "read";

/** WhatsApp's colours, light — and on iOS dark too, from WhatsApp's own dark theme. */
export const CHAT = {
  wallpaper: dynamic("#EFEAE2", "#0B141A"),
  mine: dynamic("#E3E6FF", "#1E40AF"),
  theirs: dynamic("#FFFFFF", "#1F2C34"),
  read: "#53BDEB",
  system: dynamic("#FFF5C4", "#3A3520"),
  /** The grey of a day line and a system line. */
  note: dynamic("#54656F", "#CBD5E1"),
  /** A quote or a file inside a bubble: a little darker than the bubble, or lighter in the dark. */
  inset: dynamic("rgba(0,0,0,0.05)", "rgba(255,255,255,0.08)"),
  /** The time in a bubble — the muted grey, lighter in the dark where it sits on my blue. */
  meta: dynamic("#64748B", "#CBD5E1"),
};

type Props = {
  message: ChatMessageView;
  mine: boolean;
  /** The sender's name over it: a group, theirs, the first of a run. */
  showName: boolean;
  /** The first of a run from one sender: the bubble's corner points at them. */
  first: boolean;
  ticks: Ticks | null;
  meId: string;
  image: (a: ChatAttachmentView) => { uri: string; headers: Record<string, string> };
  onLongPress: (m: ChatMessageView) => void;
  onReply: (m: ChatMessageView) => void;
  onImage: (a: ChatAttachmentView) => void;
  onFile: (a: ChatAttachmentView) => void;
  onRetry?: () => void;
};

const NAME_COLOURS = ["#1E88E5", "#D81B60", "#43A047", "#FB8C00", "#8E24AA", "#00897B", "#E53935", "#5E35B1"];
const nameColour = (id: string | null) => {
  let h = 0;
  for (const ch of id ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLOURS[h % NAME_COLOURS.length]!;
};

function BubbleView({ message, mine, showName, first, ticks, meId, image, onLongPress, onReply, onImage, onFile, onRetry }: Props) {
  const dx = useRef(new Animated.Value(0)).current;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 10,
      onPanResponderMove: (_, g) => dx.setValue(Math.max(0, Math.min(80, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx > 60) onReply(message);
        Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(dx, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;

  if (message.kind === "SYSTEM") {
    return (
      <View style={s.systemRow}>
        <Text style={s.system}>{message.body}</Text>
      </View>
    );
  }

  const deleted = !!message.deletedAt;
  const pictures = deleted ? [] : message.attachments.filter((a) => a.mimeType.startsWith("image/"));
  const files = deleted ? [] : message.attachments.filter((a) => !a.mimeType.startsWith("image/"));
  const canSwipe = !deleted && ticks !== "sending" && ticks !== "failed";

  return (
    <View style={[s.row, mine ? s.rowMine : s.rowTheirs, first && { marginTop: 6 }]}>
      <Animated.View style={[s.replyHint, { opacity: dx.interpolate({ inputRange: [0, 60], outputRange: [0, 1] }) }]}>
        <Ionicons name="arrow-undo" size={18} color={colors.muted} />
      </Animated.View>
      <Animated.View {...(canSwipe ? pan.panHandlers : {})} style={{ transform: [{ translateX: dx }], maxWidth: "82%" }}>
        <Pressable
          onLongPress={() => !deleted && ticks !== "sending" && onLongPress(message)}
          // For VoiceOver and TalkBack, what a long-press and a swipe do, as actions on the message.
          accessibilityActions={deleted || ticks === "sending" ? undefined : [{ name: "longpress", label: "Message options" }, ...(canSwipe ? [{ name: "reply", label: "Reply" }] : [])]}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === "longpress" ? onLongPress(message) : e.nativeEvent.actionName === "reply" ? onReply(message) : undefined)}
          onPress={ticks === "failed" ? onRetry : undefined}
          delayLongPress={300}
          style={[s.bubble, mine ? s.mine : s.theirs, first && (mine ? s.tailMine : s.tailTheirs)]}
        >
          {showName && <Text style={[s.sender, { color: nameColour(message.senderId) }]}>{message.senderName ?? "Former colleague"}</Text>}
          {message.replyTo && !deleted && (
            <View style={[s.quote, { borderLeftColor: nameColour(message.replyTo.senderName) }]}>
              <Text style={[s.quoteName, { color: nameColour(message.replyTo.senderName) }]} numberOfLines={1}>
                {message.replyTo.senderName ?? "Former colleague"}
              </Text>
              <Text style={s.quoteBody} numberOfLines={2}>
                {message.replyTo.deleted ? "This message was deleted" : message.replyTo.body || (message.replyTo.attachmentCount ? "📎 Attachment" : "")}
              </Text>
            </View>
          )}
          {pictures.map((a) => (
            <Pressable key={a.id} onPress={() => onImage(a)} accessibilityRole="button" accessibilityLabel={`Picture: ${a.fileName}`}>
              <Image source={image(a)} style={s.picture} resizeMode="cover" />
            </Pressable>
          ))}
          {files.map((a) => (
            <Pressable key={a.id} onPress={() => onFile(a)} style={s.file} accessibilityRole="button" accessibilityLabel={`File: ${a.fileName}`}>
              <Ionicons name="document-text" size={28} color={colors.brand} />
              <View style={{ flex: 1 }}>
                <Text style={s.fileName} numberOfLines={1}>
                  {a.fileName}
                </Text>
                <Text style={s.meta}>{fileSize(a.size)}</Text>
              </View>
            </Pressable>
          ))}
          {deleted ? (
            <Text style={[s.body, s.deleted]}>
              <Ionicons name="ban" size={14} color={colors.muted} /> {mine ? "You deleted this message" : "This message was deleted"}
            </Text>
          ) : message.body ? (
            <Text style={s.body} selectable={false}>
              {highlightMentions(message.body, message.mentionIds.includes(meId))}
              {/* Room for the time, as WhatsApp leaves it, so the last line doesn't run under it. */}
              <Text style={[s.spacer, { color: mine ? CHAT.mine : CHAT.theirs }]}>{`      ${message.editedAt ? "edited " : ""}${bubbleTime(message.createdAt)}${mine ? "    " : ""}`}</Text>
            </Text>
          ) : null}
          <View style={s.stamp}>
            {message.editedAt && !deleted && <Text style={s.meta}>edited</Text>}
            <Text style={s.meta}>{bubbleTime(message.createdAt)}</Text>
            {mine && ticks && <TickMark ticks={ticks} />}
          </View>
        </Pressable>
        {message.reactions.length > 0 && !deleted && (
          <View style={[s.reactions, mine ? { alignSelf: "flex-end" } : { alignSelf: "flex-start" }]}>
            {message.reactions.map((r) => (
              <Text key={r.emoji} style={[s.reaction, r.userIds.includes(meId) && { borderColor: colors.brand }]}>
                {r.emoji}
                {r.userIds.length > 1 ? ` ${r.userIds.length}` : ""}
              </Text>
            ))}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

export const Bubble = memo(BubbleView);

function TickMark({ ticks }: { ticks: Ticks }) {
  if (ticks === "sending") return <Ionicons name="time-outline" size={14} color={colors.muted} />;
  if (ticks === "failed") return <Ionicons name="alert-circle" size={15} color={colors.danger} />;
  if (ticks === "sent") return <Ionicons name="checkmark" size={16} color={colors.muted} />;
  return <Ionicons name="checkmark-done" size={16} color={ticks === "read" ? CHAT.read : colors.muted} />;
}

/** "@Name" in brand colour; the whole message bold where it mentions me. */
function highlightMentions(body: string, mentionsMe: boolean) {
  // "@Priya" or "@Priya Nair" — a second word only when it starts with a capital, as names do.
  const parts = body.split(/(@[^\s@]+(?: [A-Z][^\s@]*)?)/);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <Text key={i} style={{ color: colors.brand, fontWeight: mentionsMe ? "700" : "600" }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, marginVertical: 1.5 },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  replyHint: { position: "absolute", left: 14 },
  bubble: { borderRadius: 10, paddingHorizontal: 9, paddingTop: 6, paddingBottom: 6, minWidth: 80, elevation: 1, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 1, shadowOffset: { width: 0, height: 1 } },
  mine: { backgroundColor: CHAT.mine },
  theirs: { backgroundColor: CHAT.theirs },
  tailMine: { borderTopRightRadius: 2 },
  tailTheirs: { borderTopLeftRadius: 2 },
  sender: { fontSize: 13, fontWeight: "700", marginBottom: 2 },
  quote: { borderLeftWidth: 4, backgroundColor: CHAT.inset, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4 },
  quoteName: { fontSize: 13, fontWeight: "700" },
  quoteBody: { fontSize: 13, color: colors.muted },
  body: { fontSize: 16, lineHeight: 21, color: colors.text },
  deleted: { fontStyle: "italic", color: colors.muted },
  // Drawn in the bubble's own colour: Android shows a nested span's "transparent".
  spacer: { fontSize: 11 },
  stamp: { position: "absolute", right: 8, bottom: 4, flexDirection: "row", alignItems: "center", gap: 3 },
  meta: { fontSize: 11, color: CHAT.meta },
  picture: { width: 230, height: 230, borderRadius: 8, marginBottom: 4, backgroundColor: "#ddd" },
  file: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: CHAT.inset, borderRadius: 8, padding: 8, marginBottom: 4, minWidth: 200 },
  fileName: { fontSize: 14, fontWeight: "600", color: colors.text },
  reactions: { flexDirection: "row", gap: 4, marginTop: -4, paddingHorizontal: 6 },
  reaction: { fontSize: 14, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 6, paddingVertical: 1, overflow: "hidden" },
  systemRow: { alignItems: "center", marginVertical: 6 },
  system: { fontSize: 12.5, color: CHAT.note, backgroundColor: CHAT.system, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, overflow: "hidden", textAlign: "center", maxWidth: "85%" },
});
