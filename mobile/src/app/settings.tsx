import { useCallback, useState } from "react";
import { Alert, ScrollView, Text } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, styles } from "@/components/ui";
import { APP_VERSION } from "@/lib/config";
import { when } from "@/lib/format";
import { calls } from "@/lib/native";
import { useSession } from "@/lib/session";

/** Who this phone is signed in as, call sync, and signing out. */
export default function Settings() {
  const router = useRouter();
  const { me, signOut } = useSession();
  const [sync, setSync] = useState(calls.getCallSync());
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => setSync(calls.getCallSync()), []));

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
