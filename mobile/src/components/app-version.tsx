import { useState } from "react";
import { Text } from "react-native";
import * as Updates from "expo-updates";
import { Button, Card, Heading, Notice, styles } from "@/components/ui";
import { APP_VERSION } from "@/lib/config";
import { when } from "@/lib/format";

/**
 * Which version of the app's screens this phone runs (owner, 23 Oct 2026 — over-the-air updates, app.config.ts): the
 * ones it was installed with, or an update from deskzo.com and when it was made — and a check for a newer one, taken
 * at once instead of at the next launch. A development build takes no updates: it runs what's on the computer.
 */
export function AppVersion() {
  const { isUpdatePending } = Updates.useUpdates();
  const [state, setState] = useState<"idle" | "checking" | "none" | "failed">("idle");
  const updated = Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.createdAt ? Updates.createdAt : null;
  const commit = (Updates.manifest as { metadata?: { commit?: string } } | null | undefined)?.metadata?.commit ?? null;

  async function check() {
    setState("checking");
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) return setState("none");
      await Updates.fetchUpdateAsync();
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <Heading>This app</Heading>
      <Card>
        <Text style={styles.body}>Deskzo app {APP_VERSION}</Text>
        <Text style={styles.small}>
          {!Updates.isEnabled ? "A development build — it runs the screens on this computer." : updated ? `Screens updated ${when(updated.toISOString())}${commit ? ` · ${commit}` : ""}` : "Screens as installed."}
        </Text>
        {Updates.isEnabled &&
          (isUpdatePending ? (
            <Button title="Restart with the new version" onPress={() => void Updates.reloadAsync()} />
          ) : (
            <Button title="Check for a newer version" kind="secondary" busy={state === "checking"} onPress={() => void check()} />
          ))}
        {state === "none" && !isUpdatePending && <Notice>This is the newest version.</Notice>}
        {state === "failed" && <Notice tone="warning">Couldn&apos;t check — is the phone online?</Notice>}
      </Card>
    </>
  );
}
