import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as WebBrowser from "expo-web-browser";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Notice, colors, styles } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { FIND_WORKSPACE_URL, readPairingLink, workspaceAddress } from "@/lib/config";
import { formFactor, openBrowserSignIn, pairWith } from "@/lib/sign-in";
import { useSession } from "@/lib/session";

/**
 * Signing in (owner, 18 Oct 2026): the workspace's address, then the workspace's own sign-in in the phone's
 * browser (src/lib/sign-in.ts) — or, from a computer, the code on Settings › Deskzo app, scanned or typed. A
 * phone's camera opening the QR's deskzo:// link lands here with both filled in.
 */
export default function Pair() {
  const params = useLocalSearchParams<{ host?: string; code?: string }>();
  const router = useRouter();
  const { paired_, signedOut } = useSession();
  const [permission, askPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [withCode, setWithCode] = useState(!!params.code);
  const [host, setHost] = useState(params.host ?? "");
  const [code, setCode] = useState(params.code ?? "");
  const [busy, setBusy] = useState<"browser" | "code" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  const device = formFactor();

  const NOT_AN_ADDRESS = "That isn't a Deskzo address. It's your company's name on Deskzo — like yourcompany, or yourcompany.deskzo.com.";

  async function signIn() {
    setError(null);
    const where = workspaceAddress(host);
    if (!where) return setError(NOT_AN_ADDRESS);
    setBusy("browser");
    try {
      const back = await openBrowserSignIn(where);
      if ("code" in back) {
        // The link may have reached the signed-in screen already; it finishes there, once.
        router.replace({ pathname: "/signed-in", params: { code: back.code } });
      } else if (back.error !== "cancelled") {
        setError("The sign-in didn't come back to the app. Try again.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function pair(hostValue: string, codeValue: string) {
    setError(null);
    const where = workspaceAddress(hostValue);
    if (!where) return setError(NOT_AN_ADDRESS);
    if (codeValue.replace(/[\s-]/g, "").length !== 10) return setError("The code is ten letters and numbers.");
    setBusy("code");
    try {
      const paired = await pairWith(where, { code: codeValue });
      // Home (the layout moves a paired phone off this screen).
      await paired_(where.baseUrl, paired.token, where.host);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Pairing didn't work. Try again.");
      handled.current = false;
    } finally {
      setBusy(null);
    }
  }

  // Opened from the QR's link: pair at once.
  useEffect(() => {
    if (params.host && params.code && !handled.current) {
      handled.current = true;
      void pair(params.host, params.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.host, params.code]);

  if (scanning && permission?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            const link = readPairingLink(data);
            if (!link) return setError("That QR isn't a Deskzo pairing code.");
            handled.current = true;
            setScanning(false);
            setHost(link.host);
            setCode(link.code);
            void pair(link.host, link.code);
          }}
        />
        <View style={{ padding: 16, gap: 8 }}>
          <Text style={{ color: "#fff", fontSize: 15 }}>Point the camera at the code on Settings › Deskzo app in Deskzo.</Text>
          <Button title="Type the code instead" kind="secondary" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Sign in to Deskzo</Text>
        {signedOut && <Notice tone="warning">This {device} was signed out of Deskzo. Sign in again to carry on.</Notice>}

        <Card>
          <Text style={styles.small}>Your company's Deskzo</Text>
          <TextInput
            style={styles.input}
            value={host}
            onChangeText={setHost}
            placeholder="yourcompany.deskzo.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void signIn()}
            accessibilityLabel="Your company's Deskzo address"
          />
          <Button title="Sign in" busy={busy === "browser"} disabled={!!busy} onPress={() => void signIn()} />
          <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(FIND_WORKSPACE_URL)} hitSlop={8}>
            <Text style={{ color: colors.brand, fontSize: 14 }}>Don't know it? Find my workspace</Text>
          </Pressable>
        </Card>
        <Notice>You sign in on your company's own Deskzo page, as you do on a computer — with its password, two-factor or single sign-on.</Notice>

        {withCode ? (
          <Card>
            <Text style={styles.body}>On a computer, open Deskzo and go to Settings › Deskzo app, then choose Show a pairing code.</Text>
            <Button
              title="Scan the code"
              kind="secondary"
              disabled={!!busy}
              onPress={async () => {
                setError(null);
                handled.current = false;
                const answer = permission?.granted ? permission : await askPermission();
                if (answer.granted) setScanning(true);
                else setError("Deskzo needs the camera to scan the code. You can type it instead.");
              }}
            />
            <Text style={styles.small}>Or type it, with the address above</Text>
            <TextInput
              style={[styles.input, { letterSpacing: 2, fontWeight: "600" }]}
              value={code}
              onChangeText={setCode}
              placeholder="K7QX M4PR T9"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={14}
              accessibilityLabel="Pairing code"
            />
            <Button title="Pair" kind="secondary" busy={busy === "code"} disabled={!!busy} onPress={() => void pair(host, code)} />
          </Card>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setWithCode(true)} hitSlop={8}>
            <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Pair with a code from a computer instead</Text>
          </Pressable>
        )}

        {error && <Notice tone="danger">{error}</Notice>}
        <Notice>Signing in makes this {device} one of your devices. Your administrators see it in Security › Devices and can sign it out.</Notice>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
