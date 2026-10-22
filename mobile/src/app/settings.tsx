import { useCallback, useState } from "react";
import { Alert, Linking, ScrollView, Text } from "react-native";
import * as Notifications from "expo-notifications";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, styles } from "@/components/ui";
import { APP_VERSION } from "@/lib/config";
import { when } from "@/lib/format";
import { calls } from "@/lib/native";
import { useSession } from "@/lib/session";
import { PUSH_BUILT_IN, registerForPush } from "@/lib/push";

/** Who this phone is signed in as, notifications, call sync, and signing out. */
export default function Settings() {
  const router = useRouter();
  const { me, signOut } = useSession();
  const [sync, setSync] = useState(calls.getCallSync());
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Whether Deskzo may notify this phone (src/lib/push.ts) — the phone's own say, changed in its settings once refused.
  const [notifying, setNotifying] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setSync(calls.getCallSync());
      if (PUSH_BUILT_IN) void Notifications.getPermissionsAsync().then((p) => setNotifying(p.granted)).catch(() => setNotifying(null));
    }, []),
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Heading>Signed in</Heading>
      <Card>
        <Text style={styles.body}>{me?.person.name ?? "…"}</Text>
        <Text style={styles.small}>{me?.person.email}</Text>
        <Text style={styles.small}>
          {me?.workspace.name ?? ""} · this phone: {me?.phone.name ?? ""}
        </Text>
      </Card>

      <Heading>Notifications</Heading>
      <Card>
        {!PUSH_BUILT_IN ? (
          <Text style={styles.body}>This version of the app doesn&apos;t receive Deskzo&apos;s notifications yet — they&apos;re in your bell on the web.</Text>
        ) : notifying ? (
          <Text style={styles.body}>On — a lead given to you, something to approve, a task or a ticket&apos;s reply shows on this phone, even with the app closed.</Text>
        ) : (
          <>
            <Text style={styles.body}>Off — Deskzo can&apos;t tell you anything while the app is closed.</Text>
            <Button
              title="Turn on notifications"
              kind="secondary"
              busy={asking}
              onPress={async () => {
                setAsking(true);
                const state = await registerForPush();
                setAsking(false);
                setNotifying(state === "on");
                // Refused before: Android asks no more — the app's own settings are where it's switched on.
                if (state === "denied") void Linking.openSettings();
              }}
            />
          </>
        )}
      </Card>

      {calls.available && (
        <>
          <Heading>Call sync</Heading>
          <Card>
            <Text style={styles.body}>{sync.on ? "On — your calls with customers log themselves." : "Off."}</Text>
            {sync.on && <Text style={styles.small}>{sync.lastSyncAt ? `Last sent ${when(new Date(sync.lastSyncAt).toISOString())}` : "Nothing sent yet."}</Text>}
            {sync.on && (
              <Button
                title="Send calls now"
                kind="secondary"
                busy={busy}
                onPress={async () => {
                  setBusy(true);
                  const r = await calls.syncNow();
                  setBusy(false);
                  setSync(calls.getCallSync());
                  setResult(r.error ? (r.error === "offline" ? "No internet — they'll go when there is." : `Deskzo didn't take them (${r.error}).`) : r.logged ? `${r.logged} call${r.logged === 1 ? "" : "s"} with customers logged.` : "Nothing new to log.");
                }}
              />
            )}
            {result && <Notice>{result}</Notice>}
            <Button title={sync.on ? "Change call sync" : "Set up call sync"} kind="secondary" onPress={() => router.push("/setup")} />
          </Card>
        </>
      )}

      <Heading>This phone</Heading>
      <Button
        title="Sign out of Deskzo"
        kind="danger"
        onPress={() =>
          Alert.alert("Sign out?", "Calls stop logging from this phone until you pair it again.", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => void signOut() },
          ])
        }
      />
      <Notice>Deskzo app {APP_VERSION}</Notice>
    </ScrollView>
  );
}
