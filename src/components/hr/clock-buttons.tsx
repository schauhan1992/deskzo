"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, LogOut } from "lucide-react";
import { clockIn, clockOut, myClockPolicy } from "@/actions/attendance";
import { requestAttendanceException } from "@/actions/attendance-exceptions";
import type { ClockPolicy } from "@/lib/hr/clock";
import { EXCEPTION_REASON_LABELS, PROBLEM_WORDS } from "@/lib/hr/geofence";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select, Textarea } from "@/components/ui/input";
import { locationAllowedHere, reloadToUseLocation, takeCarriedTap } from "@/lib/browser-location";

type Day = { checkInAt: Date | string | null; checkOutAt: Date | string | null } | null | undefined;
type Place = { latitude: number; longitude: number; accuracy: number | null };
type Step = "idle" | "locating" | "sending";

/** Set when this page was reloaded to use location: a refusal now is the person's, not the page's — no reload again. */
let reloadedForLocation = false;

/**
 * Clock in / Clock out on the web (owner, 22 Oct 2026). Where the person's office checks location, the browser is
 * asked where it is — only then, only at the tap, never in the background — and the server decides whether that is
 * inside (src/lib/hr/clock.ts). Refused, it says why, and offers to ask for an exception where the office allows one.
 */
export function ClockButtons({ today }: { today: Day }) {
  const router = useRouter();
  const [policy, setPolicy] = useState<ClockPolicy | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastPlace, setLastPlace] = useState<Place | null>(null);
  // One tap, one clocking: a second tap while the first is on its way does nothing.
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    myClockPolicy()
      .then((p) => current && setPolicy(p))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [today?.checkInAt, today?.checkOutAt]);

  // Clocked out already, they can clock out again (owner, 22 Oct 2026): a terminal's punch during the day may have
  // filled the clock-out, and the end of their day moves it on.
  const action: "in" | "out" = !today?.checkInAt ? "in" : "out";
  const again = !!today?.checkInAt && !!today.checkOutAt;

  // Reached by a link inside the app, this page may still carry the first page's "no location" policy; the tap
  // reloads it as itself (src/lib/browser-location.ts) and the reloaded page carries on with that tap here.
  const carryOn = useEffectEvent((which: "in" | "out") => void clock(which));
  useEffect(() => {
    const carried = takeCarriedTap("clock");
    if (carried === "in" || carried === "out") {
      reloadedForLocation = true;
      carryOn(carried);
    }
  }, []);

  async function clock(which: "in" | "out") {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setNotice(null);
    setCanAsk(false);
    try {
      const rule = policy ?? (await myClockPolicy());
      setPolicy(rule);
      let place: Place | null = null;
      if (rule.required && rule.configured) {
        if (locationAllowedHere() === false && !reloadedForLocation && reloadToUseLocation("clock", which)) return;
        setStep("locating");
        const located = await locate();
        // A browser that can't say whether the page may ask: a refusal could be the page's — reload once to see.
        if (!located.ok && located.denied && locationAllowedHere() === null && !reloadedForLocation && reloadToUseLocation("clock", which)) return;
        // An approved exception, unused this way, lets the clocking through without a location — the server checks it.
        const excused = rule.exception?.status === "APPROVED" && !(which === "in" ? rule.exception.usedIn : rule.exception.usedOut);
        if (!located.ok && !excused) {
          setError(located.error);
          setCanAsk(rule.exceptionsAllowed && rule.exception?.status !== "PENDING");
          setLastPlace(null);
          return;
        }
        place = located.ok ? located.place : null;
        setLastPlace(place);
      }
      setStep("sending");
      const result = which === "in" ? await clockIn(place) : await clockOut(place);
      if (!result.ok) {
        setError(result.error);
        setCanAsk(!!result.canRequestException && rule.exception?.status !== "PENDING");
        return;
      }
      setNotice(which === "in" ? "Clocked in." : "Clocked out.");
      router.refresh();
    } catch {
      setError("Couldn't reach Deskzo. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setStep("idle");
    }
  }

  const busy = step !== "idle";
  const exception = policy?.exception;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {action === "in" ? (
          <Button size="sm" disabled={busy} onClick={() => clock("in")}>
            <LogIn className="mr-1.5 h-3.5 w-3.5" />
            {step === "locating" ? "Getting your location…" : step === "sending" ? "Clocking in…" : "Clock in"}
          </Button>
        ) : (
          <>
            {again && <Badge tone="green">Done for the day</Badge>}
            <Button size="sm" variant={again ? "ghost" : "secondary"} disabled={busy} onClick={() => clock("out")} title={again ? "Moves your clock-out to now" : undefined}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              {step === "locating" ? "Getting your location…" : step === "sending" ? "Clocking out…" : again ? "Clock out again" : "Clock out"}
            </Button>
          </>
        )}
        {canAsk && action && !busy && (
          <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
            Ask for an exception
          </Button>
        )}
      </div>
      {policy?.required && action && !error && (
        <p className="text-xs text-subtle">
          {!policy.configured
            ? PROBLEM_WORDS.office_not_configured
            : exception?.status === "PENDING"
              ? "Your exception request is waiting for approval."
              : exception?.status === "APPROVED" && !(action === "in" ? exception.usedIn : exception.usedOut)
                ? "You have an approved exception — you can clock from where you are."
                : `Your location is checked against ${policy.officeName ?? "your office"} (within ${policy.radiusM} m).`}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted">
          {notice}
        </p>
      )}
      {asking && action && (
        <ExceptionRequestDialog
          action={action}
          place={lastPlace}
          onClose={() => setAsking(false)}
          onSent={() => {
            setAsking(false);
            setCanAsk(false);
            setError(null);
            setNotice("Asked. You'll be told when it is decided — then clock again.");
            myClockPolicy().then(setPolicy, () => {});
          }}
        />
      )}
    </div>
  );
}

/** The browser's location, once, with a reason in plain words when it can't give one. */
function locate(): Promise<{ ok: true; place: Place } | { ok: false; error: string; denied?: boolean }> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve({ ok: false, error: "This browser can't share its location. Use the Deskzo app to clock in." });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          ok: true,
          place: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null },
        }),
      (err) =>
        resolve({
          ok: false,
          denied: err.code === err.PERMISSION_DENIED,
          error:
            err.code === err.PERMISSION_DENIED
              ? "Location is blocked for Deskzo in this browser. Allow it in the site's settings, then try again."
              : err.code === err.TIMEOUT
                ? "Couldn't get your location in time. Try again, or use the Deskzo app."
                : "Your location isn't available. Turn on location services and try again.",
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

function ExceptionRequestDialog({ action, place, onClose, onSent }: { action: "in" | "out"; place: Place | null; onClose: () => void; onSent: () => void }) {
  const [reasonCode, setReasonCode] = useState<keyof typeof EXCEPTION_REASON_LABELS>("ALTERNATE_LOCATION");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await requestAttendanceException({ scope: action === "in" ? "IN" : "OUT", reasonCode, reason, location: place });
      if (!result.ok) setError(result.error);
      else onSent();
    } catch {
      setError("Couldn't reach Deskzo. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Ask to clock ${action} away from the office`}>
      <p className="text-sm text-muted">
        Somebody who approves attendance exceptions will decide. Once approved, clock {action} again — it counts once, today.
      </p>
      <Label htmlFor="exception-reason-code" className="mt-3 block">
        Reason
      </Label>
      <Select id="exception-reason-code" value={reasonCode} onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)}>
        {(Object.keys(EXCEPTION_REASON_LABELS) as (keyof typeof EXCEPTION_REASON_LABELS)[]).map((k) => (
          <option key={k} value={k}>
            {EXCEPTION_REASON_LABELS[k]}
          </option>
        ))}
      </Select>
      <Label htmlFor="exception-reason" className="mt-3 block">
        What happened
      </Label>
      <Textarea id="exception-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. At the client's office for the audit" />
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={send} disabled={sending}>
          {sending ? "Sending…" : "Send request"}
        </Button>
      </div>
    </Dialog>
  );
}
