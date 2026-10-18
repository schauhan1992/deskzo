import { Pressable, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/components/ui";
import { useChat } from "@/lib/chat";

/**
 * A message in a chat that isn't open, while the app is: a banner at the top for a few seconds — who and where, never
 * what, as the website's alerts (src/lib/chat.tsx). A tap opens the chat.
 */
export function ChatBanner() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { banner, dismissBanner } = useChat();
  if (!banner) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${banner.title}. Open it.`}
      style={[s.banner, { top: insets.top + 6 }]}
      onPress={() => {
        dismissBanner();
        router.push({ pathname: "/conversation/[id]", params: { id: banner.chatId } });
      }}
    >
      <Ionicons name="chatbubble-ellipses" size={20} color={colors.brand} />
      <Text style={s.text} numberOfLines={1}>
        {banner.title}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  text: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
});
