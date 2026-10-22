import { Ionicons } from "@expo/vector-icons";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Heading, Notice, colors, styles } from "@/components/ui";
import { ListRow } from "@/components/sales";
import { useSession } from "@/lib/session";

/**
 * More (owner, 22 Oct 2026 — the app made native, the web kept as the fallback): everything the person may open in
 * Deskzo, as the web's menu lists it. What the app has its own screen for opens there; the rest opens its web page in
 * the app — and moves out of the web as it gets a screen of its own.
 */

/** The web's pages the app has screens for, and where they are. */
const NATIVE: Record<string, string> = {
  "/leads": "/sales?seg=leads",
  "/companies": "/sales?seg=companies",
  "/contacts": "/sales?seg=contacts",
  "/tasks": "/tasks",
  "/chat": "/chat",
  "/calls": "/calls",
};

export default function MoreScreen() {
  const router = useRouter();
  const { me, refreshMe } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const can = me?.can;

  const open = (href: string) => {
    const native = NATIVE[href];
    if (native) router.push(native);
    else router.push({ pathname: "/web", params: { path: href } });
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => (setRefreshing(true), await refreshMe(), setRefreshing(false))} />}
    >
      <View style={{ paddingHorizontal: 16 }}>
        <Heading>Yours</Heading>
      </View>
      {can?.leads || can?.companies || can?.contacts ? <ListRow title="Search" subtitle="Leads, companies and people" onPress={() => router.push("/search")} /> : null}
      {can?.tasks ? <ListRow title="Tasks" onPress={() => router.push("/tasks")} /> : null}
      <ListRow title="Approvals" onPress={() => router.push("/approvals")} />
      {can?.attendance ? <ListRow title="Leave" onPress={() => router.push("/leave")} /> : null}
      <ListRow title="Settings" subtitle="This phone, call sync, signing out" onPress={() => router.push("/settings")} />

      {(me?.modules ?? []).map((section) => (
        <View key={section.group}>
          <View style={{ paddingHorizontal: 16 }}>
            <Heading>{section.group}</Heading>
          </View>
          {section.items.map((item) => (
            <ListRow
              key={item.href}
              title={item.label}
              right={NATIVE[item.href] ? null : <Ionicons name="globe-outline" size={16} color={colors.muted} accessibilityLabel="Opens its web page" />}
              onPress={() => open(item.href)}
            />
          ))}
        </View>
      ))}

      {me && !me.modules && (
        <View style={{ padding: 16 }}>
          <Notice>Your company&apos;s Deskzo is older than this app — the rest of Deskzo opens on its web pages.</Notice>
        </View>
      )}
      <View style={{ paddingHorizontal: 16 }}>
        <Heading>Everything else</Heading>
      </View>
      <ListRow title="All of Deskzo, as on the web" right={<Ionicons name="globe-outline" size={16} color={colors.muted} />} onPress={() => router.push("/web")} />
      {me?.modules && (
        <Text style={[styles.small, { padding: 16 }]}>
          <Ionicons name="globe-outline" size={13} color={colors.muted} /> opens the page as on the web, until it has a screen of its own here.
        </Text>
      )}
    </ScrollView>
  );
}
