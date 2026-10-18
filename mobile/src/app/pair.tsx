import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useLocalSearchParams } from "expo-router";
import { Button, Card, Notice, colors, styles } from "@/components/ui";
import { ApiError, request } from "@/lib/api";
import { APP_VERSION, readPairingLink, workspaceAddress } from "@/lib/config";
import { useSession } from "@/lib/session";

/**
 * Pairing (owner, 18 Oct 2026): the code from Settings › Deskzo app on Deskzo, scanned or typed with the
 * workspace's address. A phone's camera opening the QR's deskzo:// link lands here with both filled in.
 */
export default function Pair() {
  const params = useLocalSearchParams<{ host?: string; code?: string }>();
  const { paired_, signedOut } = useSession();
  const [permission, askPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [host, setHost] = useState(params.host ?? "");
  const [code, setCode] = useState(params.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  async function pair(hostValue: string, codeValue: string) {
    setError(null);
    const where = workspaceAddress(hostValue);
    if (!where) return setError("That isn't a Deskzo address. It looks like yourcompany.deskzo.com — it's under the code on Deskzo.");
    if (codeValue.replace(/[\s-]/g, "").length !== 10) return setError("The code is ten letters and numbers.");
    setBusy(true);
    try {
      const paired = await request<{ token: string; approved: boolean }>(where, "POST", "/api/app/pair", {
        code: codeValue,
        platform: Platform.OS,
        model: Device.modelName ?? Device.deviceName ?? null,
        app_version: APP_VERSION,
      });
      // Home, which leads on to setting up call sync (the layout moves a paired phone off this screen).
      await paired_(where.baseUrl, paired.token, where.host);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Pairing didn't work. Try again.");
      handled.current = false;
    } finally {
      setBusy(false);
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
        <Text style={styles.title}>Pair with Deskzo</Text>
        <Text style={styles.body}>On a computer, open Deskzo and go to Settings › Deskzo app, then choose Show a pairing code.</Text>
        {signedOut && <Notice tone="warning">This phone was signed out of Deskzo. Pair it again to carry on.</Notice>}

        <Button
          title="Scan the code"
          busy={busy}
          onPress={async () => {
            setError(null);
            handled.current = false;
            const answer = permission?.granted ? permission : await askPermission();
            if (answer.granted) setScanning(true);
            else setError("Deskzo needs the camera to scan the code. You can type it instead.");
          }}
        />

        <Card>
          <Text style={styles.small}>Or type it</Text>
          <TextInput
            style={styles.input}
            value={host}
            onChangeText={setHost}
            placeholder="yourcompany.deskzo.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Your Deskzo address"
          />
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
          <Button title="Pair" kind="secondary" busy={busy} onPress={() => void pair(host, code)} />
        </Card>

        {error && <Notice tone="danger">{error}</Notice>}
        <Notice>Pairing signs this phone in as you. Your administrators see it in Security › Devices and can sign it out.</Notice>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
