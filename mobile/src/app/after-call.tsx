import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Chip, Heading, Notice, colors, styles } from "@/components/ui";
import { ApiError, OUTCOMES, api, type Outcome } from "@/lib/api";
import { CALLBACKS } from "@/lib/callbacks";
import { when } from "@/lib/format";
import { dialString } from "@/lib/phone-numbers";

/**
 * The after-call sheet, on an iPhone (owner, 22 Oct 2026). iOS lets no app read its calls, so a call with a customer
 * can't log itself as on Android: when the person is back from a call started in the app (src/lib/calling.ios.ts) —
 * or taps "Log a call" on Calls — this asks how it went, then logs it as theirs:
 *
 *   1. POST /api/app/calls/sync with the call marked `manual` and its outcome (its length the phone can't know).
 *   2. PATCH /api/app/calls/:id with the notes, a callback and the lead — Android's after-call card, as it is.
 *
 * A number on nobody the person can see in Deskzo is said so first, and nothing is sent: it stays on the phone, as
 * Android's sync leaves such calls.
 */

type Card = {
  contact: { id: string; name: string };
  company: { id: string; name: string };
  leads: { id: string; title: string; stage: string }[];
} | null;

type Synced = { key: string; status: "logged" | "duplicate" | "no_match" | "too_old"; call_id?: string };

export default function AfterCall() {
  const params = useLocalSearchParams<{ number?: string; label?: string; at?: string; via?: string; request?: string; manual?: string }>();
  const router = useRouter();
  const manual = params.manual === "1";
  // When the call started — or, for one logged by hand, when the sheet opened: fixed, so trying again is the same call.
  const [startedAt] = useState(() => Number(params.at) || Date.now());
  const [number, setNumber] = useState(params.number ?? "");
  const [direction, setDirection] = useState<"out" | "in">(manual ? "in" : "out");
  /** Who the number is — for the number it was looked up for; another number typed since is still being looked up. */
  const [found, setFound] = useState<{ digits: string; card: Card } | null>(null);
  const [outcome, setOutcome] = useState<Outcome>("CONNECTED");
  const [notes, setNotes] = useState("");
  const [callback, setCallback] = useState<number | null>(null);
  /** Undefined: Deskzo picks the lead when there's no doubt, as for a call from Android. */
  const [leadId, setLeadId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = dialString(number);
  const enough = digits.replace(/\D/g, "").length >= 6;
  /** Undefined while it is being looked up; null for nobody the person can see (or no number yet). */
  const card: Card | undefined = !enough ? null : found?.digits === digits ? found.card : undefined;
  const close = () => (router.canGoBack() ? router.back() : router.replace("/calls"));

  // Who it was, as the person may see them — and whether there is anything to log it on. A number being typed is
  // looked up once it has stopped changing.
  useEffect(() => {
    if (!enough) return;
    let live = true;
    const timer = setTimeout(
      () => {
        api<Card>("GET", `/api/app/calls/lookup?number=${encodeURIComponent(digits)}`).then(
          (card) => live && setFound({ digits, card }),
          (e) => {
            if (!live) return;
            setFound({ digits, card: null });
            if (e instanceof ApiError && e.status !== 404) setError(e.message);
          },
        );
      },
      manual ? 400 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [digits, enough, manual]);

  async function save() {
    setError(null);
    if (outcome === "CALLBACK_REQUESTED" && callback === null) return setError("They asked to be called back — pick when.");
    setBusy(true);
    try {
      const [sent] = await api<Synced[]>("POST", "/api/app/calls/sync", {
        // The same call twice — a retry, a second tap — is one call: its key is when it started and the number.
        calls: [{ key: `ios-${startedAt}-${digits.replace(/\D/g, "")}`, number: digits, direction, started_at: new Date(startedAt).toISOString(), manual: true, outcome }],
      });
      if (!sent || sent.status === "no_match") return setError("This number isn't on a customer or contact you can see in Deskzo, so the call stays on your phone.");
      if (sent.status === "too_old" || !sent.call_id) return setError("This call is from before this iPhone was signed in to Deskzo, so it isn't logged.");
      try {
        await api("PATCH", `/api/app/calls/${sent.call_id}`, {
          outcome,
          notes: notes.trim() || undefined,
          follow_up_at: callback === null ? undefined : CALLBACKS[callback]!.at().toISOString(),
          ...(leadId !== undefined ? { lead_id: leadId } : {}),
        });
      } catch (e) {
        // Logged, but the rest didn't go: it waits on Calls under "How did these go?".
        setError(`The call is logged, but ${e instanceof ApiError ? e.message.charAt(0).toLowerCase() + e.message.slice(1) : "the rest didn't save"} — finish it on Calls.`);
        return;
      }
      close();
    } catch (e) {
      if (e instanceof ApiError && e.code === "call_sync_off") setError("Calls are switched off for this iPhone. Turn them on in Settings › Calls on this iPhone, then log it.");
      else setError(e instanceof ApiError ? e.message : "Couldn't log the call. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const who = card?.contact.name ?? params.label ?? (number || "the call");

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {manual ? (
          <>
            <Text style={styles.title}>Log a call</Text>
            <TextInput
              style={styles.input}
              value={number}
              onChangeText={setNumber}
              placeholder="The customer's number"
              placeholderTextColor={colors.muted}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoFocus={!params.number}
              accessibilityLabel="The customer's number"
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
              <Chip label="They called me" selected={direction === "in"} onPress={() => setDirection("in")} />
              <Chip label="I called them" selected={direction === "out"} onPress={() => setDirection("out")} />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title} accessibilityRole="header">
              {who}
            </Text>
            <Text style={styles.small}>
              {card ? `${card.company.name} · ` : ""}you called {when(new Date(startedAt).toISOString())}
            </Text>
          </>
        )}

        {card === undefined ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 16 }} accessibilityLabel="Looking the number up" />
        ) : card === null ? (
          enough && <Notice>This number isn&apos;t on a customer or contact you can see in Deskzo, so there&apos;s nothing to log it on.</Notice>
        ) : card ? (
          <>
            {manual && (
              <Text style={styles.body}>
                {card.contact.name} — {card.company.name}
              </Text>
            )}
            <Heading>How did it go?</Heading>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
              {OUTCOMES.map((o) => (
                <Chip key={o.value} label={o.label} selected={outcome === o.value} onPress={() => setOutcome(o.value)} />
              ))}
            </View>

            <Heading>Notes</Heading>
            <TextInput
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
              value={notes}
              onChangeText={setNotes}
              placeholder="What was said, and what happens next"
              placeholderTextColor={colors.muted}
              multiline
              maxLength={4000}
              accessibilityLabel="Notes"
            />

            <Heading>Call back</Heading>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
              <Chip label="No callback" selected={callback === null} onPress={() => setCallback(null)} />
              {CALLBACKS.map((c, i) => (
                <Chip key={c.label} label={c.label} selected={callback === i} onPress={() => setCallback(i)} />
              ))}
            </View>

            {card.leads.length > 0 && (
              <>
                <Heading>About</Heading>
                <View style={{ gap: 8 }} accessibilityRole="radiogroup">
                  {card.leads.map((l) => (
                    <Chip key={l.id} label={`${l.title} · ${l.stage}`} selected={leadId === l.id} onPress={() => setLeadId(leadId === l.id ? undefined : l.id)} />
                  ))}
                  <Chip label="No lead" selected={leadId === null} onPress={() => setLeadId(leadId === null ? undefined : null)} />
                </View>
                {leadId === undefined && <Text style={styles.small}>Leave it, and Deskzo puts it on the lead when there&apos;s no doubt which.</Text>}
              </>
            )}
          </>
        ) : null}

        {error && <Notice tone="danger">{error}</Notice>}
        {card ? <Button title="Save" busy={busy} onPress={() => void save()} /> : null}
        <Button title={card ? "Not now" : "Close"} kind="secondary" disabled={busy} onPress={close} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
