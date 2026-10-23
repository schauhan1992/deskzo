import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/components/ui";
import { DELETE_WINDOW_MS, EDIT_WINDOW_MS, REACTIONS, type ChatMessageView } from "@/lib/chat-types";

/**
 * What a long-press on a message offers, as a sheet from the bottom: the six reactions, then reply, copy (unless the
 * workspace blocks copying), edit and delete for everyone (one's own, within the website's windows) and pin.
 */
export type MenuAction = "reply" | "copy" | "edit" | "delete" | "pin" | "unpin";

export function MessageMenu({
  message,
  mine,
  pinned,
  copyBlocked,
  meId,
  onReact,
  onAction,
  onClose,
}: {
  message: ChatMessageView | null;
  mine: boolean;
  pinned: boolean;
  copyBlocked: boolean;
  meId: string;
  onReact: (emoji: string | null) => void;
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}) {
  if (!message) return null;
  const age = Date.now() - new Date(message.createdAt).getTime();
  const myEmoji = message.reactions.find((r) => r.userIds.includes(meId))?.emoji ?? null;
  const items: { action: MenuAction; label: string; icon: keyof typeof Ionicons.glyphMap; danger?: boolean }[] = [
    { action: "reply", label: "Reply", icon: "arrow-undo-outline" },
    ...(!copyBlocked && message.body ? [{ action: "copy" as const, label: "Copy", icon: "copy-outline" as const }] : []),
    ...(mine && message.body && age < EDIT_WINDOW_MS ? [{ action: "edit" as const, label: "Edit", icon: "create-outline" as const }] : []),
    { action: pinned ? "unpin" : "pin", label: pinned ? "Unpin" : "Pin", icon: "pin-outline" },
    ...(mine && age < DELETE_WINDOW_MS ? [{ action: "delete" as const, label: "Delete for everyone", icon: "trash-outline" as const, danger: true }] : []),
  ];

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      {/* Not one element each for VoiceOver and TalkBack, or the buttons inside couldn't be reached: the sheet closes with
          the screen reader's own "back" (two-finger scrub on iOS) instead. */}
      <Pressable style={s.backdrop} onPress={onClose} accessible={false}>
        <Pressable style={s.sheet} onPress={() => {}} accessible={false} onAccessibilityEscape={onClose}>
          <View style={s.emojis}>
            {REACTIONS.map((e) => (
              <Pressable
                key={e}
                accessibilityRole="button"
                accessibilityLabel={myEmoji === e ? `Take ${e} away` : `React ${e}`}
                onPress={() => onReact(myEmoji === e ? null : e)}
                style={[s.emoji, myEmoji === e && s.emojiOn]}
              >
                <Text style={{ fontSize: 26 }}>{e}</Text>
              </Pressable>
            ))}
          </View>
          {items.map((item) => (
            <Pressable key={item.action} accessibilityRole="button" style={({ pressed }) => [s.item, pressed && { backgroundColor: colors.sunken }]} onPress={() => onAction(item.action)}>
              <Ionicons name={item.icon} size={22} color={item.danger ? colors.danger : colors.text} />
              <Text style={[s.itemText, item.danger && { color: colors.danger }]}>{item.label}</Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingBottom: 24, paddingTop: 10 },
  emojis: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  emoji: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  emojiOn: { backgroundColor: colors.brandSoft },
  item: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 22, paddingVertical: 14 },
  itemText: { fontSize: 16, color: colors.text },
});
