import { useCallback, useState } from "react";
import { Linking, PermissionsAndroid, Platform, ScrollView, Text } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { IphoneSetup } from "@/components/iphone-calls";
import { Button, Card, Notice, styles } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { calls } from "@/lib/native";
import { useSession } from "@/lib/session";

/**
 * Call sync, switched on by the person on their own phone — never from anywhere else (owner, 18 Oct 2026).
 * What it reads and what leaves the phone, the permissions Android asks for, and the battery setting that
 * decides whether Android lets it run with the app closed. On an iPhone, which lets no app read its calls, the
 * closest it allows (src/components/iphone-calls.tsx).
 */

const WANTED = [PermissionsAndroid.PERMISSIONS.READ_CALL_LOG, PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE, ...(Number(Platform.Version) >= 33 ? [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] : [])];

export default function Setup() {
  return Platform.OS === "ios" ? <IphoneSetup /> : <CallSync />;
}

function CallSync() {
  const router = useRouter();
  const { refreshMe } = useSession();
  const [on, setOn] = useState(calls.getCallSync().on);
  const [battery, setBattery] = useState(calls.ignoresBatteryOptimizations());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setOn(calls.getCallSync().on);
      setBattery(calls.ignoresBatteryOptimizations());
    }, []),
  );

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      const answers = await PermissionsAndroid.requestMultiple(WANTED);
      const callLog = answers[PermissionsAndroid.PERMISSIONS.READ_CALL_LOG] === "granted" && answers[PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE] === "granted";
      if (!callLog) {
        setError("Call sync needs to read the call log and the phone's state. Allow both in the app's settings, then try again.");
        return;
      }
      await api("PATCH", "/api/app/device", { call_sync: true });
      calls.setCallSync(true);
      setOn(true);
      await calls.syncNow();
      void refreshMe();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't switch call sync on. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await api("PATCH", "/api/app/device", { call_sync: false });
    } catch {
      // Off on the phone whatever Deskzo says: nothing more is sent from here.
    }
    calls.setCallSync(false);
    setOn(false);
    setBusy(false);
  }

  if (!calls.available) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Notice>Call sync works on Android phones. On this phone, call from the app and say how it went in Deskzo.</Notice>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{on ? "Call sync is on" : "Log your calls with customers"}</Text>
      <Card>
        <Text style={styles.body}>• After each call, Deskzo is sent the number, the time and how long it lasted.</Text>
        <Text style={styles.body}>• Only calls with a number on a customer or contact you can see in Deskzo are kept. Everything else — your own calls — goes no further.</Text>
        <Text style={styles.body}>• When a customer rings, their name shows while it rings.</Text>
        <Text style={styles.body}>• Calls from before you switch it on are never sent.</Text>
      </Card>
      {!on && (
        <Notice>
          Android asks for your call logs and calls this one &quot;make and manage phone calls&quot;. Deskzo only notices when a call starts and ends — it never makes, answers or ends a call.
        </Notice>
      )}

      {on ? (
        <>
          {!battery && (
            <Card>
              <Text style={styles.body}>So calls log even with the app closed, let Deskzo run in the background: in the list, find Deskzo and choose Don&apos;t optimise (or Unrestricted).</Text>
              <Button
                title="Open battery settings"
                kind="secondary"
                onPress={() => {
                  calls.openBatterySettings();
                }}
              />
            </Card>
          )}
          <Button title="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
          <Button title="Turn call sync off" kind="secondary" busy={busy} onPress={() => void turnOff()} />
        </>
      ) : (
        <>
          <Button title="Turn on call sync" busy={busy} onPress={() => void turnOn()} />
          <Button title="Not now" kind="secondary" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
        </>
      )}
      {error && (
        <>
          <Notice tone="danger">{error}</Notice>
          <Button title="Open the app's settings" kind="secondary" onPress={() => void Linking.openSettings()} />
        </>
      )}
    </ScrollView>
  );
}
