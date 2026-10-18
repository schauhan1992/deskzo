import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { colors } from "@/components/ui";
import { ScreenRules } from "@/lib/screen-rules";
import { SessionProvider, useSession } from "@/lib/session";

/**
 * The tabs — Today, Tasks, Approvals, Calls, Deskzo — and over them, leave, Settings, pairing, call sync and the
 * after-call card. Everything but pairing needs a paired phone; a paired phone has no business on the pairing
 * screen.
 */
function Screens() {
  const { ready, paired } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    // Signing in: the screen itself, and the one the browser's sign-in comes back to.
    const onPair = segments[0] === "pair" || segments[0] === "signed-in";
    if (!paired && !onPair) router.replace("/pair");
    else if (paired && onPair) router.replace("/");
  }, [ready, paired, segments, router]);

  return (
    <>
      <Stack screenOptions={{ headerTintColor: colors.brand, headerTitleStyle: { fontWeight: "600", color: colors.text }, contentStyle: { backgroundColor: colors.sunken } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Sign in", headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="signed-in" options={{ title: "Signing in", headerBackVisible: false }} />
        <Stack.Screen name="setup" options={{ title: "Call sync" }} />
        <Stack.Screen name="review/[id]" options={{ title: "How did it go?" }} />
        <Stack.Screen name="leave" options={{ title: "Leave" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
      {/* The workspace's screenshot allowance and watermark, over every screen. */}
      <ScreenRules />
    </>
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
