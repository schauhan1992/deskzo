import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, ScrollView, Text } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, styles } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { calling, type CallerIdState } from "@/lib/calling";
import { when } from "@/lib/format";
import { phone } from "@/lib/native";
import { notifications, type PushPermission } from "@/lib/notifications";
import { useSession } from "@/lib/session";

/**
 * Calls on an iPhone (owner, 22 Oct 2026) — switched on by the person on their own phone, as call sync is on Android,
 * with what iOS allows said plainly: no app may read an iPhone's calls, so they don't log themselves; caller ID is a
 * list iOS is given ahead of time and the person switches on in Settings; a call started from Deskzo is asked about
 * afterwards. On, it tells Deskzo this iPhone takes "Ring my phone" (PATCH /api/app/device call_sync).
 */

/** Asked again when the person comes back from Settings, where both are switched. */
function useStatus() {
  const [callerId, setCallerId] = useState<"enabled" | "disabled" | "unknown">("unknown");
  const [push, setPush] = useState<PushPermission>("undetermined");
  const check = useCallback(() => {
    void phone.callerIdStatus().then(setCallerId);
    void notifications.permission().then(setPush);
  }, []);
  useFocusEffect(check);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => state === "active" && check());
    return () => sub.remove();
  }, [check]);
  return { callerId, push, setPush, check };
}

const describeLoad = (state: CallerIdState | null) => {
  if (!state) return "Not loaded yet.";
  if (state.error === "disabled" || state.error === "no_extension") return `${state.count.toLocaleString()} numbers ready — iOS loads them once caller ID is on in Settings.`;
  if (state.error) return `Couldn't load them ${when(new Date(state.at).toISOString()).toLowerCase()} — try again.`;
  return `${state.count.toLocaleString()} customer number${state.count === 1 ? "" : "s"}, loaded ${when(new Date(state.at).toISOString()).toLowerCase()}${state.truncated ? " (the first 20,000)" : ""}.`;
};

export function CallerIdCard() {
  const { callerId } = useStatus();
  const [loaded, setLoaded] = useState<CallerIdState | null>(calling.lastCallerIds());
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <Text style={styles.body}>{callerId === "enabled" ? "Caller ID is on: a customer's name shows when they ring." : "Caller ID is off in the iPhone's settings."}</Text>
      {callerId !== "enabled" && (
        <>
          <Text style={styles.small}>Turn on Deskzo in Settings › Phone › Call Blocking &amp; Identification.</Text>
          <Button title="Open the iPhone's settings" kind="secondary" onPress={() => void phone.openCallerIdSettings().then((opened) => void (opened || Linking.openSettings()))} />
        </>
      )}
      <Text style={styles.small}>{describeLoad(loaded)}</Text>
      <Button
        title="Refresh caller ID"
        kind="secondary"
        busy={busy}
        onPress={async () => {
          setBusy(true);
          setLoaded(await calling.refreshCallerIds());
          setBusy(false);
        }}
      />
    </Card>
  );
}

/** Asking for notifications, from a tap of the person's — or, once on and `on` is given, saying so. */
export function NotificationsCard({ why, on }: { why: string; on?: string }) {
  const { push, setPush } = useStatus();
  if (push === "granted") {
    return on ? (
      <Card>
        <Text style={styles.body}>{on}</Text>
      </Card>
    ) : null;
  }
  return (
    <Card>
      <Text style={styles.body}>{why}</Text>
      <Button
        title={push === "denied" ? "Open the iPhone's settings" : "Turn on notifications"}
        kind="secondary"
        onPress={async () => (push === "denied" ? void Linking.openSettings() : setPush(await notifications.turnOn()))}
      />
    </Card>
  );
}

/**
 * Today's one offer of notifications (owner, 22 Oct 2026): made once the day's screen has something they're for, and
 * only until the person answers — "Not now" is kept, and Settings › Notifications still has it.
 */
export function NotificationsOffer() {
  const { push, setPush } = useStatus();
  const [declined, setDeclined] = useState(notifications.offerDeclined());
  if (!notifications.available || declined || push !== "undetermined") return null;
  return (
    <Card>
      <Text style={styles.body}>Get a notification when something waits for your decision, a colleague messages you, or Deskzo rings this phone — who and where, never what.</Text>
      <Button title="Turn on notifications" onPress={async () => setPush(await notifications.turnOn())} />
      <Button
        title="Not now"
        kind="secondary"
        onPress={() => {
          notifications.declineOffer();
          setDeclined(true);
        }}
      />
    </Card>
  );
}

export function IphoneSetup() {
  const router = useRouter();
  const { refreshMe } = useSession();
  const [on, setOn] = useState(phone.callsOn());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = () => (router.canGoBack() ? router.back() : router.replace("/"));

  async function turnOn() {
    setError(null);
    setBusy(true);
    try {
      await api("PATCH", "/api/app/device", { call_sync: true });
      phone.setCallsOn(true);
      setOn(true);
      // Now, when it means something: "Ring my phone" and the reminder after a call need them.
      await notifications.turnOn();
      void calling.refreshCallerIds();
      void refreshMe();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't switch calls on. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await api("PATCH", "/api/app/device", { call_sync: false });
    } catch {
      // Off on the phone whatever Deskzo says: nothing more is logged from here.
    }
    phone.setCallsOn(false);
    await phone.setCallerIds([]).then(() => phone.reloadCallerIds()).catch(() => null);
    setOn(false);
    setBusy(false);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title} accessibilityRole="header">
        {on ? "Calls on this iPhone are on" : "Use this iPhone for calls with customers"}
      </Text>
      <Card>
        <Text style={styles.body}>• When a customer rings, their name and company show while it rings — for the customers you can see in Deskzo.</Text>
        <Text style={styles.body}>• After a call you start from Deskzo — a callback, &quot;Ring my phone&quot;, a number on a Deskzo page — the app asks how it went, and logs it on the customer.</Text>
        <Text style={styles.body}>• &quot;Ring my phone&quot; in Deskzo on a computer makes this iPhone offer to call.</Text>
      </Card>
      <Notice>
        An iPhone doesn&apos;t let any app read its calls, so calls don&apos;t log themselves as they do on Android. A call you make from the Phone app can be noted with Log a call on Calls.
      </Notice>

      {on ? (
        <>
          <Heading>Caller ID</Heading>
          <CallerIdCard />
          <NotificationsCard why={'Notifications are off: "Ring my phone" and the reminder after a call need them.'} />
          {error && <Notice tone="danger">{error}</Notice>}
          <Button title="Done" onPress={done} />
          <Button title="Turn calls off on this iPhone" kind="secondary" busy={busy} onPress={() => void turnOff()} />
        </>
      ) : (
        <>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button title="Turn on calls on this iPhone" busy={busy} onPress={() => void turnOn()} />
          <Button title="Not now" kind="secondary" onPress={done} />
        </>
      )}
    </ScrollView>
  );
}
