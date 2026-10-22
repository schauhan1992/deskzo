import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Heading, Notice, colors, styles } from "@/components/ui";
import { ApiError, api, type Callback, type ReviewCall, type Ring } from "@/lib/api";
import { calling, type CallAbout } from "@/lib/calling";
import { length, overdue, when } from "@/lib/format";
import { calls, phone } from "@/lib/native";
import { useSession } from "@/lib/session";

/**
 * Home: what to do on the phone now — a call Deskzo asked this phone to make ("Ring my phone"), the calls
 * with customers still waiting to be told how they went, and the callbacks owed. Opening it sends any
 * calls not yet sent; while it is open it looks for rings every few seconds.
 *
 * On an iPhone (owner, 22 Oct 2026) there is no call log to send: a call dialled from here is asked about when the
 * person is back from it (src/app/after-call.tsx), and "Log a call" notes one that started anywhere else.
 */

const dial = (number: string, about: CallAbout) => calling.dial(number, about);

export default function Home() {
  const router = useRouter();
  const { me, refreshMe } = useSession();
  const [rings, setRings] = useState<Ring[]>([]);
  const [review, setReview] = useState<ReviewCall[]>([]);
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [syncOn, setSyncOn] = useState(calls.getCallSync().on);
  const [iphoneOn, setIphoneOn] = useState(phone.callsOn());
  const focused = useRef(false);

  // Opened from a "Ring my phone" notification: that ring on top, though the app hasn't looked yet.
  const pushed = useLocalSearchParams<{ ring?: string; number?: string; label?: string }>();
  useEffect(() => {
    if (!pushed.ring || !pushed.number) return;
    const ring: Ring = { id: pushed.ring, number: pushed.number, label: pushed.label ?? pushed.number, asked_at: new Date().toISOString() };
    setRings((now) => (now.some((n) => n.id === ring.id) ? now : [ring, ...now]));
  }, [pushed.ring, pushed.number, pushed.label]);

  // Rings are handed over once each (src/lib/app/calls.ts takeCallRequests): kept here until dialled or dismissed.
  const takeRings = useCallback(async () => {
    try {
      const fresh = await api<Ring[]>("GET", "/api/app/calls/requests");
      if (fresh.length) setRings((now) => [...fresh.filter((f) => !now.some((n) => n.id === f.id)), ...now]);
    } catch {
      // The full refresh says what is wrong.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    setSyncOn(calls.getCallSync().on);
    setIphoneOn(phone.callsOn());
    try {
      if (calls.getCallSync().on) await calls.syncNow();
      const [, toReview, owed] = await Promise.all([takeRings(), api<ReviewCall[]>("GET", "/api/app/calls/review"), api<Callback[]>("GET", "/api/app/calls/callbacks")]);
      setReview(toReview);
      setCallbacks(owed);
      if (!me) void refreshMe();
    } catch (e) {
      if (e instanceof ApiError && e.code === "device_pending") setProblem("This phone is waiting for an administrator to approve it in Deskzo (Security › Devices). Pull down to check again.");
      else if (e instanceof ApiError && e.code === "calls_unavailable") setProblem(e.message);
      else setProblem(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, [takeRings, me, refreshMe]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
      };
    }, [load]),
  );

  // While the app is open and on this screen: rings every five seconds; back from another app, everything.
  useEffect(() => {
    const timer = setInterval(() => {
      if (focused.current && AppState.currentState === "active") void takeRings();
    }, 5000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && focused.current) void load();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [takeRings, load]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {me && (
        <Text style={styles.small}>
          {me.workspace.name ? `${me.workspace.name} · ` : ""}signed in as {me.person.name}
        </Text>
      )}
      {problem && (
        <Card>
          <Notice tone="warning">{problem}</Notice>
        </Card>
      )}
      {calls.available && !syncOn && !problem && (
        <Card style={{ borderColor: colors.brand }}>
          <Text style={styles.body}>Turn on call sync, and your calls with customers log themselves in Deskzo.</Text>
          <Button title="Set up call sync" onPress={() => router.push("/setup")} />
        </Card>
      )}
      {phone.available && !iphoneOn && !problem && (
        <Card style={{ borderColor: colors.brand }}>
          <Text style={styles.body}>Use this iPhone for your calls with customers: their names show when they ring, and a word after each call logs it in Deskzo.</Text>
          <Button title="Set up calls on this iPhone" onPress={() => router.push("/setup")} />
        </Card>
      )}
      {phone.available && iphoneOn && !problem && (
        <Button title="Log a call" kind="secondary" onPress={() => router.push({ pathname: "/after-call", params: { manual: "1" } })} />
      )}

      {rings.length > 0 && (
        <>
          <Heading count={rings.length}>Asked to call</Heading>
          {rings.map((r) => (
            <Card key={r.id}>
              <Text style={styles.body}>{r.label}</Text>
              <Text style={styles.small}>
                {r.number} · from Deskzo, {when(r.asked_at)}
              </Text>
              <View style={styles.row}>
                <Button
                  title="Call"
                  style={{ flex: 1 }}
                  onPress={() => {
                    dial(r.number, { label: r.label, via: "ring", request: r.id });
                    setRings((now) => now.filter((n) => n.id !== r.id));
                  }}
                />
                <Button title="Dismiss" kind="secondary" onPress={() => setRings((now) => now.filter((n) => n.id !== r.id))} />
              </View>
            </Card>
          ))}
        </>
      )}

      <Heading count={review.length}>How did these go?</Heading>
      {review.length === 0 ? (
        <Notice>{phone.available ? "Nothing waiting. A call you logged without a word on how it went shows here." : "Nothing waiting. After a call with a customer, it shows here for a word on how it went."}</Notice>
      ) : (
        review.map((c) => (
          <Pressable key={c.id} accessibilityRole="button" onPress={() => router.push({ pathname: "/review/[id]", params: { id: c.id } })}>
            <Card>
              <Text style={styles.body}>
                {c.direction === "in" ? "From " : "To "}
                {c.contact ?? c.number} — {c.company}
              </Text>
              <Text style={styles.small}>
                {when(c.started_at)} · {length(c.duration)}
              </Text>
            </Card>
          </Pressable>
        ))
      )}

      <Heading count={callbacks.length}>Callbacks</Heading>
      {callbacks.length === 0 ? (
        <Notice>No callbacks owed.</Notice>
      ) : (
        callbacks.map((c) => (
          <Card key={c.id}>
            <Text style={styles.body}>
              {c.contact ?? c.number} — {c.company}
            </Text>
            <Text style={[styles.small, overdue(c.due_at) && { color: colors.danger }]}>
              {overdue(c.due_at) ? "Was due " : "Due "}
              {when(c.due_at)}
              {c.notes ? ` · ${c.notes}` : ""}
            </Text>
            <View style={styles.row}>
              <Button title={`Call ${c.number}`} kind="secondary" style={{ flex: 1 }} onPress={() => dial(c.number, { label: c.contact ? `${c.contact}, ${c.company}` : c.company, via: "callback" })} />
              <Button
                title="Done"
                kind="secondary"
                onPress={async () => {
                  try {
                    await api("POST", `/api/app/calls/callbacks/${c.id}`);
                    setCallbacks((now) => now.filter((n) => n.id !== c.id));
                  } catch (e) {
                    setProblem(e instanceof Error ? e.message : "Couldn't mark it done.");
                  }
                }}
              />
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}
