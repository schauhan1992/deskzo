import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { colors } from "@/components/ui";
import { ChatBanner } from "@/components/chat/banner";
import { ChatProvider } from "@/lib/chat";
import { ScreenRules } from "@/lib/screen-rules";
import { SessionProvider, useSession } from "@/lib/session";

/**
 * The tabs — Today, Sales, Chat, Calls, More — and over them a conversation (full screen), approvals, leave,
 * Settings, signing in, call sync and the after-call card. Everything but pairing needs a paired phone; a paired phone has no business on the pairing
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
        <Stack.Screen name="conversation/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="leave" options={{ title: "Leave" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        {/* The sales screens (22 Oct 2026), and the web's own pages for whatever has no screen of the app's yet. */}
        <Stack.Screen name="lead/[ref]" options={{ title: "Lead" }} />
        <Stack.Screen name="company/[ref]" options={{ title: "Company" }} />
        <Stack.Screen name="new-lead" options={{ title: "New lead" }} />
        <Stack.Screen name="new-company" options={{ title: "New company" }} />
        <Stack.Screen name="new-contact" options={{ title: "New contact" }} />
        <Stack.Screen name="search" options={{ title: "Search" }} />
        <Stack.Screen name="web" options={{ title: "Deskzo" }} />
      </Stack>
      {/* The workspace's screenshot allowance and watermark, over every screen. */}
      <ScreenRules />
      {/* "New message" from a chat that isn't open — who, never what. */}
      <ChatBanner />
    </>
  );
}

export default function Layout() {
  return (
    <SessionProvider>
      <ChatProvider>
        <StatusBar style="dark" />
        <Screens />
      </ChatProvider>
    </SessionProvider>
  );
}
