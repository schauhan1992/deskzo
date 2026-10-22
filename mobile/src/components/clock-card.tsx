import { useRef, useState } from "react";
import { Linking, Platform, Text, TextInput, View } from "react-native";
import { Button, Card, Chip, Notice, styles } from "@/components/ui";
import { ApiError, api, type Attendance, type Clocked, type ExceptionReason, type LocationPolicy } from "@/lib/api";
import { clockTime, worked } from "@/lib/format";
import { askToTurnOnLocation, locate, whereAmI, type NoPlace, type Place } from "@/lib/location";

/**
 * Today's clock (owner, 18 Oct 2026; GPS attendance 22 Oct 2026). Where the person's office checks location, the
 * phone reads where it is at the tap — and only then — and Deskzo decides whether that is inside the office. Each
 * way it can go has its own words: the permission, location switched off, no fix, not accurate enough, outside,
 * the office not set up, an exception waiting or approved, a refusal, no connection. One tap is one clocking.
 */

type State =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "sending" }
  | { kind: "no_place"; reason: NoPlace }
  | { kind: "refused"; code: string; message: string; distanceM: number | null; canAsk: boolean }
  | { kind: "offline"; message: string }
  | { kind: "done"; text: string };

const NO_PLACE: Record<NoPlace, string> = {
  permission_denied: "Deskzo needs your location to clock you in or out at your office. Allow location while using the app, then try again.",
  permission_blocked: "Location is turned off for Deskzo in the phone's settings. Allow it there (while using the app), then try again.",
  services_off: "Your phone's location is switched off. Turn it on, then try again.",
  no_fix: "Couldn't get your location. Step outside or near a window and try again.",
};

const REASONS: { value: ExceptionReason; label: string }[] = [
  { value: "ALTERNATE_LOCATION", label: "Working elsewhere" },
  { value: "GPS_UNAVAILABLE", label: "GPS not working" },
  { value: "CORRECTION", label: "Correction" },
  { value: "OTHER", label: "Other" },
];

export function ClockCard({
  attendance,
  policy,
  onChanged,
}: {
  attendance: Attendance;
  policy: LocationPolicy | null;
  onChanged: (attendance: Attendance, policy: LocationPolicy | null) => void;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [asking, setAsking] = useState(false);
  const [lastPlace, setLastPlace] = useState<Place | null>(null);
  // Two taps at once are one clocking: the second does nothing while the first is on its way.
  const inFlight = useRef(false);
  // Clocked out already, they can clock out again (owner, 22 Oct 2026): a terminal's punch during the day may have
  // filled the clock-out, and the end of their day moves it on.
  const action: "in" | "out" = !attendance.check_in_at ? "in" : "out";
  const again = !!attendance.check_in_at && !!attendance.check_out_at;
  const required = !!policy?.required;

  async function clock(which: "in" | "out") {
    if (inFlight.current) return;
    inFlight.current = true;
    setAsking(false);
    try {
      let place: Place | null = null;
      if (required && policy?.configured) {
        setState({ kind: "locating" });
        const located = await locate();
        // An approved exception, unused this way, lets the clocking through without a location — the server checks it.
        const excused = policy.exception?.status === "APPROVED" && !(which === "in" ? policy.exception.used_in : policy.exception.used_out);
        if (!located.ok && !excused) {
          setLastPlace(null);
          setState({ kind: "no_place", reason: located.reason });
          return;
        }
        place = located.ok ? located.place : null;
      } else {
        // An office that doesn't check: where the phone is if it says, as before — clocking never waits on it.
        setState({ kind: "locating" });
        place = await whereAmI();
      }
      setLastPlace(place);
      setState({ kind: "sending" });
      const next = await api<Clocked>("POST", "/api/app/attendance", { action: which, ...(place ?? {}) });
      onChanged(next, next.location ?? policy);
      setState({ kind: "done", text: doneText(which, next, !!place) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const distance = Number(e.fields?.distance_m);
        setState({ kind: "refused", code: e.code, message: e.message, distanceM: Number.isFinite(distance) ? distance : null, canAsk: e.fields?.can_request_exception === "true" });
      } else if (e instanceof ApiError && e.status === 0) {
        setState({ kind: "offline", message: e.message });
      } else {
        setState({ kind: "refused", code: "error", message: e instanceof Error ? e.message : "That didn't work.", distanceM: null, canAsk: false });
      }
    } finally {
      inFlight.current = false;
    }
  }

  const busy = state.kind === "locating" || state.kind === "sending";
  const exception = policy?.exception ?? null;
  const exceptionUsable = exception?.status === "APPROVED" && !(action === "in" ? exception.used_in : exception.used_out);
  const canAsk =
    !!action &&
    !!policy?.exceptions_allowed &&
    exception?.status !== "PENDING" &&
    !exceptionUsable &&
    ((state.kind === "refused" && state.canAsk) || (state.kind === "no_place" && required));

  return (
    <Card>
      <Text style={styles.body}>
        {attendance.check_out_at && attendance.check_in_at
          ? `Clocked in ${clockTime(attendance.check_in_at)}, out ${clockTime(attendance.check_out_at)}${attendance.worked_minutes ? ` · ${worked(attendance.worked_minutes)}` : ""}`
          : attendance.check_in_at
            ? `Clocked in at ${clockTime(attendance.check_in_at)}`
            : "You haven't clocked in today."}
      </Text>

      {action && required && !policy?.configured && <Notice tone="warning">Office location has not been configured. Please contact your administrator.</Notice>}
      {action && exception?.status === "PENDING" && <Notice tone="warning">Your request to clock {action} away from the office is waiting for approval.</Notice>}
      {exceptionUsable && <Notice tone="success">Your exception is approved — you can clock {action} from where you are.</Notice>}

      {action && (
        <Button
          title={state.kind === "locating" ? "Getting your location…" : state.kind === "sending" ? "Checking…" : action === "in" ? "Clock in" : again ? "Clock out again" : "Clock out"}
          kind={action === "in" ? "primary" : "secondary"}
          busy={busy}
          onPress={() => void clock(action)}
        />
      )}
      {again && !busy && <Text style={styles.small}>Clocking out again moves your clock-out to now.</Text>}
      {busy && <Text style={styles.small}>{state.kind === "locating" ? "Getting your location…" : "Checking your location with Deskzo…"}</Text>}

      {state.kind === "no_place" && (
        <>
          <Notice tone="danger">{NO_PLACE[state.reason]}</Notice>
          {state.reason === "permission_blocked" && <Button title="Open the app's settings" kind="secondary" onPress={() => void Linking.openSettings()} />}
          {state.reason === "services_off" && (
            <Button
              title="Turn on location"
              kind="secondary"
              onPress={() => void (Platform.OS === "android" ? askToTurnOnLocation().then((on) => on && setState({ kind: "idle" })) : Linking.openSettings())}
            />
          )}
        </>
      )}
      {state.kind === "refused" && (
        <Notice tone="danger">
          {state.message}
          {state.code === "outside_office" && state.distanceM !== null ? ` You're about ${state.distanceM.toLocaleString()} m from ${policy?.office ?? "the office"}.` : ""}
        </Notice>
      )}
      {state.kind === "offline" && <Notice tone="danger">{state.message} Nothing was recorded — try again.</Notice>}
      {state.kind === "done" && <Notice tone="success">{state.text}</Notice>}

      {canAsk && !asking && <Button title={`Ask to clock ${action} away from the office`} kind="secondary" onPress={() => setAsking(true)} />}
      {asking && action && (
        <ExceptionForm
          action={action}
          place={lastPlace}
          onCancel={() => setAsking(false)}
          onSent={(next) => {
            setAsking(false);
            setState({ kind: "idle" });
            onChanged(attendance, next);
          }}
        />
      )}

      {action && !required && <Text style={styles.small}>Your location when you clock {action} is saved with your attendance, if you let the phone share it.</Text>}
      {action && required && policy?.configured && (
        <Text style={styles.small}>
          Clocking {action} checks that you are within {policy.radius_m ?? 100} m of {policy.office ?? "your office"}. Your location is read once, now — never in the background.
        </Text>
      )}
    </Card>
  );
}

function doneText(which: "in" | "out", next: Clocked, shared: boolean) {
  const verb = which === "in" ? "Clocked in" : "Clocked out";
  if (next.check === "INSIDE") return `${verb} at ${next.location?.office ?? "the office"}${next.distance_m !== null ? ` (${next.distance_m} m from its point)` : ""}.`;
  if (next.check === "EXCEPTION") return `${verb} under your approved exception.`;
  return shared ? `${verb}.` : `${verb} — without your location: the phone didn't share it.`;
}

/** Asking for an exception, from the card that refused — today, this way; an approver decides. */
function ExceptionForm({ action, place, onCancel, onSent }: { action: "in" | "out"; place: Place | null; onCancel: () => void; onSent: (policy: LocationPolicy) => void }) {
  const [reasonCode, setReasonCode] = useState<ExceptionReason>("ALTERNATE_LOCATION");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ id: string; location: LocationPolicy }>("POST", "/api/app/attendance/exception", { action, reason_code: reasonCode, reason, ...(place ?? {}) });
      onSent(out.location);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={[styles.body, { fontWeight: "600" }]}>Ask to clock {action} away from the office</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="radiogroup">
        {REASONS.map((r) => (
          <Chip key={r.value} label={r.label} selected={reasonCode === r.value} onPress={() => setReasonCode(r.value)} />
        ))}
      </View>
      <TextInput
        style={[styles.input, { minHeight: 70, textAlignVertical: "top" }]}
        multiline
        maxLength={500}
        value={reason}
        onChangeText={setReason}
        placeholder="What happened — e.g. at the client's office for the audit"
        accessibilityLabel="Reason"
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title="Send request" busy={busy} onPress={() => void send()} style={{ flex: 1 }} />
        <Button title="Cancel" kind="secondary" disabled={busy} onPress={onCancel} style={{ flex: 1 }} />
      </View>
      <Text style={styles.small}>Somebody who approves attendance exceptions decides. Once approved, clock {action} again — it counts once, today.</Text>
    </View>
  );
}
