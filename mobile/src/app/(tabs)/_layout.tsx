import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { Pressable, View, useColorScheme } from "react-native";
import { colors, paletteFor } from "@/components/ui";
import { useWaiting } from "@/lib/badges";
import { useChat } from "@/lib/chat";
import { useSession } from "@/lib/session";

/**
 * The app's places (owner, 18 Oct 2026; made native 22 Oct 2026): Today (with what waits for a decision), Sales
 * (leads, companies, contacts), Chat, Calls and More — five, as a phone's bar holds — each for somebody whose
 * workspace has it. More lists the rest of Deskzo: Tasks, Approvals, Leave, Settings, and every module, natively
 * where the app has a screen for it and as its web page where it hasn't yet. A company whose Deskzo is older than the
 * app doesn't name the parts it hasn't got, so they don't show.
 */
export default function TabsLayout() {
  const router = useRouter();
  const { me } = useSession();
  const chat = useChat();
  const waiting = useWaiting();
  const can = me?.can;
  const tint = paletteFor(useColorScheme());
  const sales = !!(can?.leads || can?.companies || can?.contacts);
  const button = (name: keyof typeof Ionicons.glyphMap, label: string, to: string) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => router.push(to)} hitSlop={12} style={{ marginRight: 16 }}>
      <Ionicons name={name} size={22} color={colors.text} />
    </Pressable>
  );
  const gear = () => button("settings-outline", "Settings", "/settings");
  const icon = (name: keyof typeof Ionicons.glyphMap) =>
    function TabIcon({ color, size }: { color: unknown; size: number }) {
      return <Ionicons name={name} color={String(color)} size={size} />;
    };

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: tint.brand, headerTitleStyle: { fontWeight: "600", color: tint.text }, headerRight: gear }}>
      <Tabs.Screen name="index" options={{ title: "Today", tabBarBadge: waiting > 0 ? waiting : undefined, tabBarIcon: icon("today-outline") }} />
      <Tabs.Screen
        name="sales"
        options={{
          title: "Sales",
          // Shown while /me is on its way, as Chat is; hidden once it says none of the three is open.
          href: can && !sales ? null : undefined,
          tabBarIcon: icon("briefcase-outline"),
          headerRight: () => <View style={{ flexDirection: "row" }}>{button("search", "Search", "/search")}</View>,
        }}
      />
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
      <Tabs.Screen name="calls" options={{ title: "Calls", href: can?.calls === false ? null : undefined, tabBarIcon: icon("call-outline") }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("grid-outline") }} />
    </Tabs>
  );
}
