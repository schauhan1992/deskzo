import { useEffect, useRef } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { colors } from "@/components/ui";
import { ChatBanner } from "@/components/chat/banner";
import { ChatProvider } from "@/lib/chat";
import { ScreenRules } from "@/lib/screen-rules";
import { SessionProvider, useSession } from "@/lib/session";
import { dataOf, onPushAddressChange, registerForPush, routeFor } from "@/lib/push";

/**
 * Notifications (src/lib/push.ts): once signed in, the phone's push address handed to Deskzo — asking the person
 * first — and kept current; a tap on one, while the app was open or the tap that opened it, leads where it says.
 */
function PushSetup() {
  const { paired, me } = useSession();
  const router = useRouter();
  const registered = useRef(false);

  useEffect(() => {
    if (!paired) {
      registered.current = false;
      return;
    }
    if (!me || registered.current) return;
    registered.current = true;
    void registerForPush();
  }, [paired, me]);

  useEffect(() => (paired ? onPushAddressChange() : undefined), [paired]);

  useEffect(() => {
    if (!paired) return;
    const open = (response: Notifications.NotificationResponse) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const to = routeFor(dataOf(response));
      if (to) router.push(to);
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      open(response);
      void Notifications.clearLastNotificationResponseAsync();
    });
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [paired, router]);

  return null;
}

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
      <PushSetup />
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
