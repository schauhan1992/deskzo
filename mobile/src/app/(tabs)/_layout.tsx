import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { colors } from "@/components/ui";
import { useWaiting } from "@/lib/badges";
import { useSession } from "@/lib/session";

/**
 * The app's places (owner, 18 Oct 2026): Today, Tasks, Approvals, Calls and all of Deskzo (its own pages) —
 * each for somebody whose workspace has it; Settings behind the gear.
 */
export default function TabsLayout() {
  const router = useRouter();
  const { me } = useSession();
  const waiting = useWaiting();
  const can = me?.can;
  const gear = () => (
    <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} hitSlop={12} style={{ marginRight: 16 }}>
      <Ionicons name="settings-outline" size={22} color={colors.text} />
    </Pressable>
  );
  const icon =
    (name: keyof typeof Ionicons.glyphMap) =>
    ({ color, size }: { color: unknown; size: number }) => <Ionicons name={name} color={String(color)} size={size} />;

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { fontWeight: "600", color: colors.text }, headerRight: gear }}>
      <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: icon("today-outline") }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", href: can?.tasks === false ? null : undefined, tabBarIcon: icon("checkbox-outline") }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals", tabBarBadge: waiting > 0 ? waiting : undefined, tabBarIcon: icon("checkmark-done-outline") }} />
      <Tabs.Screen name="calls" options={{ title: "Calls", href: can?.calls === false ? null : undefined, tabBarIcon: icon("call-outline") }} />
      <Tabs.Screen name="web" options={{ title: "Deskzo", headerShown: false, tabBarIcon: icon("grid-outline") }} />
    </Tabs>
  );
}
