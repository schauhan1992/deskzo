import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { colors } from "@/components/ui";
import { useSession } from "@/lib/session";

/**
 * The app's three places (owner, 18 Oct 2026): all of Deskzo (its own pages), Calls — for somebody who has
 * Calls — and Settings.
 */
export default function TabsLayout() {
  const { me } = useSession();
  const calls = me?.can.calls !== false;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.brand, headerTitleStyle: { fontWeight: "600", color: colors.text } }}>
      <Tabs.Screen name="index" options={{ title: "Deskzo", headerShown: false, tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="calls" options={{ title: "Calls", href: calls ? undefined : null, tabBarIcon: ({ color, size }) => <Ionicons name="call-outline" color={String(color)} size={size} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" color={String(color)} size={size} /> }} />
    </Tabs>
  );
}
