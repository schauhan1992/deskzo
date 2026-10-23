import { useCallback, useEffect, useRef, useState, type ForwardRefExoticComponent, type RefAttributes } from "react";
import { ActivityIndicator, BackHandler, Linking, Platform, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { WebView as NativeWebView, type WebViewNavigation, type WebViewProps } from "react-native-webview";
import { Button, Notice, colors, styles } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { calling } from "@/lib/calling";
import { webOrigin } from "@/lib/config";
import { calls, phone } from "@/lib/native";
import { PAGE_DOWNLOADS, readPageFile } from "@/lib/web-downloads";

/**
 * A page of Deskzo in the app (owner, 18 Oct 2026): the workspace's own pages, signed in by this phone and as this
 * phone (src/lib/app/web-session.ts on the server). Since the app went native (owner, 22 Oct 2026) it is the fallback,
 * opened from More for whatever has no screen of the app's own yet: `/web?path=/orders`.
 *
 * The pages keep their own sign-in, as a browser does, so they open straight in; only when Deskzo shows its
 * sign-in page does the app sign them in again — with a one-time pass, or, for somebody with two-factor, by
 * letting them sign in there once. Links to anywhere else open in the phone's browser; a phone number, its
 * dialler.
 *
 * On an iPhone (owner, 22 Oct 2026): WKWebView keeps the pages' cookies in the app's own store; swiping from the edge
 * goes back a page; a number dialled from a page is asked about afterwards (src/lib/calling.ios.ts); a file a page
 * offers — sent by the server, or made by the page itself, like an export (src/lib/web-downloads.ts) — is handed to the
 * share sheet; and a page whose web process iOS ended is loaded again rather than left blank.
 */

// The library's class types read as "never" under React 19.3's; the component, typed as it is used.
const WebView = NativeWebView as unknown as ForwardRefExoticComponent<WebViewProps & RefAttributes<NativeWebView>>;

type Opening = { open: { path: string; form: Record<string, string> }; sign_in: boolean };

const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, "") || "/";

export default function DeskzoPages() {
  const session = calls.getSession();
  const origin = session ? webOrigin(session) : "";
  const view = useRef<NativeWebView>(null);
  const [source, setSource] = useState<{ uri: string; method?: "POST"; body?: string; headers?: Record<string, string> } | null>(null);
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
          // Sent as a form — Android's WebView posts form-encoded, and takes no headers with a POST. iOS's posts the
          // body as it is given, so it is told what it is.
          body: new URLSearchParams(opening.open.form).toString(),
          ...(Platform.OS === "ios" ? { headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
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
    if (nav.url.startsWith(origin) && /^\/login(\?|$)/.test(path)) {
      const next = /callbackUrl=([^&]+)/.exec(path)?.[1];
      void signIn(next ? decodeURIComponent(next) : "/dashboard");
    }
  }

  function allow({ url, isTopFrame }: { url: string; isTopFrame?: boolean }): boolean {
    if (url.startsWith(origin) || url.startsWith("about:") || url.startsWith("blob:") || url.startsWith("data:")) return true;
    // iOS asks about a page's frames too — a map, a payment form inside a page: they are the page's, not a link.
    if (Platform.OS === "ios" && isTopFrame === false && /^https?:/i.test(url)) return true;
    if (Platform.OS === "ios" && /^tel:/i.test(url)) {
      calling.dial(decodeURIComponent(url.slice(4)), { via: "page" });
      return false;
    }
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
          {...(Platform.OS === "ios"
            ? {
                onFileDownload: ({ nativeEvent }: { nativeEvent: { downloadUrl: string } }) => void phone.saveDownload(nativeEvent.downloadUrl),
                onContentProcessDidTerminate: () => view.current?.reload(),
                injectedJavaScriptBeforeContentLoaded: PAGE_DOWNLOADS,
                // Only this workspace's own pages may hand the app a file.
                onMessage: ({ nativeEvent }: { nativeEvent: { url: string; data: string } }) => {
                  const file = nativeEvent.url.startsWith(origin) ? readPageFile(nativeEvent.data) : null;
                  if (file) void phone.shareFile(file.name, file.data);
                },
              }
            : {})}
          // A role that asks where you are at sign-in asks the page, as in a browser (the app holds the permission).
          geolocationEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          // iOS: every address comes to `allow` — a number, an email or a map isn't opened by the library itself, which
          // asks iOS first whether it may and is told no for any kind of link the app hasn't declared.
          {...(Platform.OS === "ios" ? { originWhitelist: ["*"] } : {})}
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
