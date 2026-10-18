import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { colors } from "@/components/ui";
import { SessionProvider, useSession } from "@/lib/session";

/** Everything but pairing needs a paired phone; a paired phone has no business on the pairing screen. */
function Screens() {
  const { ready, paired } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const onPair = segments[0] === "pair";
    if (!paired && !onPair) router.replace("/pair");
    else if (paired && onPair) router.replace("/");
  }, [ready, paired, segments, router]);

  return (
    <Stack screenOptions={{ headerTintColor: colors.brand, headerTitleStyle: { fontWeight: "600", color: colors.text }, contentStyle: { backgroundColor: colors.sunken } }}>
      <Stack.Screen name="index" options={{ title: "Deskzo" }} />
      <Stack.Screen name="pair" options={{ title: "Pair this phone" }} />
      <Stack.Screen name="setup" options={{ title: "Call sync" }} />
      <Stack.Screen name="review/[id]" options={{ title: "How did it go?" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
    </Stack>
  );
}

export default function Layout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Screens />
    </SessionProvider>
  );
}
