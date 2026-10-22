import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { Pressable, useColorScheme } from "react-native";
import { colors, paletteFor } from "@/components/ui";
import { useWaiting } from "@/lib/badges";
import { useChat } from "@/lib/chat";
import { useSession } from "@/lib/session";

/**
 * The app's places (owner, 18 Oct 2026): Today (with what waits for a decision), Chat, Tasks, Calls and all of
 * Deskzo (its own pages) — five, as a phone's bar holds — each for somebody whose workspace has it; Settings behind
 * the gear. A conversation opens over the bar, full screen (src/app/conversation/[id].tsx). A company whose Deskzo is
 * older than the app doesn't name Chat or Tasks — it hasn't got them — so they don't show.
 */
export default function TabsLayout() {
  const router = useRouter();
  const { me } = useSession();
  const chat = useChat();
  const waiting = useWaiting();
  const can = me?.can;
  const tint = paletteFor(useColorScheme());
  const gear = () => (
    <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} hitSlop={12} style={{ marginRight: 16 }}>
      <Ionicons name="settings-outline" size={22} color={colors.text} />
    </Pressable>
  );
  const icon = (name: keyof typeof Ionicons.glyphMap) =>
    function TabIcon({ color, size }: { color: unknown; size: number }) {
      return <Ionicons name={name} color={String(color)} size={size} />;
    };

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: tint.brand, headerTitleStyle: { fontWeight: "600", color: tint.text }, headerRight: gear }}>
      <Tabs.Screen name="index" options={{ title: "Today", tabBarBadge: waiting > 0 ? waiting : undefined, tabBarIcon: icon("today-outline") }} />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          href: can && can.chat !== true ? null : undefined,
          tabBarBadge: chat.unread > 0 ? (chat.unread > 99 ? "99+" : chat.unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: "#16A34A" },
          tabBarIcon: icon("chatbubbles-outline"),
        }}
      />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", href: can && can.tasks !== true ? null : undefined, tabBarIcon: icon("checkbox-outline") }} />
      <Tabs.Screen name="calls" options={{ title: "Calls", href: can?.calls === false ? null : undefined, tabBarIcon: icon("call-outline") }} />
      <Tabs.Screen name="web" options={{ title: "Deskzo", headerShown: false, tabBarIcon: icon("grid-outline") }} />
    </Tabs>
  );
}
