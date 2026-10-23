import { useCallback, useEffect, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { ActivityIndicator, BackHandler, Linking, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { WebView as NativeWebView, type WebViewNavigation, type WebViewProps } from "react-native-webview";
import { Button, Notice, colors, styles } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { webOrigin } from "@/lib/config";
import { calls } from "@/lib/native";

/**
 * A page of Deskzo in the app (owner, 18 Oct 2026): the workspace's own pages, signed in by this phone and as this
 * phone (src/lib/app/web-session.ts on the server). Since the app went native (owner, 22 Oct 2026) it is the fallback,
 * opened from More for whatever has no screen of the app's own yet: `/web?path=/orders`.
 *
 * The pages keep their own sign-in, as a browser does, so they open straight in; only when Deskzo shows its
 * sign-in page does the app sign them in again — with a one-time pass, or, for somebody with two-factor, by
 * letting them sign in there once. Links to anywhere else open in the phone's browser; a phone number, its
 * dialler.
 */

// The library's class types read as "never" under React 19.3's; the component, typed as it is used.
const WebView = NativeWebView as unknown as ForwardRefExoticComponent<WebViewProps & RefAttributes<NativeWebView>>;

type Opening = { open: { path: string; form: Record<string, string> }; sign_in: boolean };

const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

/**
 * Whether an address is one of the workspace's own pages: its origin exactly, then nothing, a path, a query or a
 * fragment (security review, 23 Oct 2026). Starting with the workspace's address was the test before, and
 * "https://acme.deskzo.com.evil.example" and "https://acme.deskzo.com@evil.example" both do — opened here with no
 * address bar to tell them apart, and able to ask for the phone's location.
 */
function ownPage(url: string, origin: string): boolean {
  if (!origin || !url.startsWith(origin)) return false;
  const next = url.charAt(origin.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

export default function DeskzoPages() {
  const session = calls.getSession();
  const origin = session ? webOrigin(session) : "";
  const view = useRef<NativeWebView>(null);
  const [source, setSource] = useState<{ uri: string; method?: "POST"; body?: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const back = useRef(false);
  const lastOpened = useRef(0);
  const signsInHere = useRef(false);

  // Signing the pages in — at most once a minute, and never for somebody who signs in there themselves.
  const signIn = useCallback(
    async (next: string) => {
      if (signsInHere.current || Date.now() - lastOpened.current < 60_000) return;
      lastOpened.current = Date.now();
      setProblem(null);
      try {
        const opening = await api<Opening>("POST", "/api/app/web-session", { path: next });
        signsInHere.current = opening.sign_in;
        setSource({
          uri: `${origin}${opening.open.path}`,
          method: "POST",
          // Sent as a form — Android's WebView posts form-encoded, and takes no headers with a POST.
          body: new URLSearchParams(opening.open.form).toString(),
        });
      } catch (e) {
        setProblem(e instanceof ApiError && e.code === "device_pending" ? "This phone is waiting for an administrator to approve it." : e instanceof Error ? e.message : "Deskzo didn't open.");
      }
    },
    [origin],
  );

  // Opened at a page — from More, or a chat's file: `/web?path=/chat?c=…`. Only a page of this workspace; else its dashboard.
  const { path: openAt } = useLocalSearchParams<{ path?: string }>();
  useEffect(() => {
    if (!origin) return;
    const page = openAt && openAt.startsWith("/") && !openAt.startsWith("//") ? openAt : "/dashboard";
    setSource({ uri: `${origin}${page}` });
  }, [origin, openAt]);

  // Android's back button goes back a page while there is one.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!back.current) return false;
        view.current?.goBack();
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  function navigated(nav: WebViewNavigation) {
    back.current = nav.canGoBack;
    const path = pathOf(nav.url);
    if (ownPage(nav.url, origin) && /^\/login(\?|$)/.test(path)) {
      const next = /callbackUrl=([^&]+)/.exec(path)?.[1];
      void signIn(next ? decodeURIComponent(next) : "/dashboard");
    }
  }

  function allow({ url }: { url: string }): boolean {
    // The workspace's own pages only, by their exact origin; a file it made (blob:) only from them; and inline only a
    // picture or a PDF — a page written inline (data:text/html) could be anything, sign-in forms included.
    const inline = url.startsWith("data:image/") || url.startsWith("data:application/pdf");
    if (ownPage(url, origin) || url.startsWith("about:") || (url.startsWith("blob:") && ownPage(url.slice(5), origin)) || inline) return true;
    // A number, an email, a map, another site: the phone's own app for it.
    void Linking.openURL(url).catch(() => {});
    return false;
  }

  if (!session) return null;
  if (problem) {
    return (
      <SafeAreaView style={[styles.screen, styles.content]}>
        <Notice tone="warning">{problem}</Notice>
        <Button
          title="Try again"
          onPress={() => {
            lastOpened.current = 0;
            void signIn("/dashboard");
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={[]}>
      {source && (
        <WebView
          ref={view}
          source={source}
          onNavigationStateChange={navigated}
          onShouldStartLoadWithRequest={allow}
          onLoadEnd={() => setLoading(false)}
          onError={() => setProblem("Couldn't reach Deskzo. Check the phone's internet connection.")}
          // A role that asks where you are at sign-in asks the page, as in a browser (the app holds the permission).
          geolocationEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          style={{ flex: 1 }}
        />
      )}
      {loading && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }}>
          <ActivityIndicator color={colors.brand} />
          <Text style={[styles.small, { marginTop: 8 }]}>Opening Deskzo…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}
