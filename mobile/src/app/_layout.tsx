import { useEffect } from "react";
import { Platform, useColorScheme } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { colors, paletteFor } from "@/components/ui";
import { ChatBanner } from "@/components/chat/banner";
import { ChatProvider } from "@/lib/chat";
import { useIphone } from "@/lib/iphone";
import { ScreenRules } from "@/lib/screen-rules";
import { SessionProvider, useSession } from "@/lib/session";

/**
 * The tabs — Today, Chat, Tasks, Calls, Deskzo — and over them a conversation (full screen), approvals, leave,
 * Settings, signing in, call sync and the after-call card — and on an iPhone the after-call sheet, which asks how a
 * call went when the person is back from it (src/lib/iphone.ts). Everything but pairing needs a paired phone; a paired
 * phone has no business on the pairing screen.
 */
function Screens() {
  const { ready, paired } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const tint = paletteFor(useColorScheme());
  useIphone();

  useEffect(() => {
    if (!ready) return;
    // Signing in: the screen itself, and the one the browser's sign-in comes back to.
    const onPair = segments[0] === "pair" || segments[0] === "signed-in";
    if (!paired && !onPair) router.replace("/pair");
    else if (paired && onPair) router.replace("/");
  }, [ready, paired, segments, router]);

  return (
    <>
      <Stack screenOptions={{ headerTintColor: tint.brand, headerTitleStyle: { fontWeight: "600", color: tint.text }, contentStyle: { backgroundColor: colors.sunken } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: "Sign in", headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="signed-in" options={{ title: "Signing in", headerBackVisible: false }} />
        <Stack.Screen name="setup" options={{ title: Platform.OS === "ios" ? "Calls on this iPhone" : "Call sync" }} />
        <Stack.Screen name="review/[id]" options={{ title: "How did it go?" }} />
        <Stack.Screen name="after-call" options={{ title: "How did it go?", presentation: "modal" }} />
        <Stack.Screen name="conversation/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="new-chat" options={{ title: "New chat" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="leave" options={{ title: "Leave" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
      {/* The workspace's screenshot allowance and watermark, over every screen. */}
      <ScreenRules />
      {/* "New message" from a chat that isn't open — who, never what. */}
      <ChatBanner />
    </>
  );
}

/**
 * iOS follows the phone's light or dark appearance (app.config.ts): the headers, the tab bar and the screens behind
 * them take Deskzo's dark colours. Android stays light.
 */
function useTheme() {
  const scheme = useColorScheme();
  if (Platform.OS !== "ios" || scheme !== "dark") return DefaultTheme;
  const dark = paletteFor("dark");
  return { ...DarkTheme, colors: { ...DarkTheme.colors, primary: dark.brand, background: dark.sunken, card: dark.surface, text: dark.text, border: dark.line, notification: dark.danger } };
}

export default function Layout() {
  return (
    <ThemeProvider value={useTheme()}>
      <SessionProvider>
        <ChatProvider>
          <StatusBar style={Platform.OS === "ios" ? "auto" : "dark"} />
          <Screens />
        </ChatProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
