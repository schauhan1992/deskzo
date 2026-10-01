"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Clock, LogIn } from "lucide-react";
import { consoleTouch } from "@/actions/platform/console-shell";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";

/**
 * The server ends a console session after 30 minutes without a request (src/lib/platform/staff-session.ts).
 * This is the browser's half: it counts from the last thing the operator did here, warns five minutes
 * before, and says so plainly once the time is up — rather than letting the next click fail with a
 * refusal nobody saw coming.
 */
const WARN_AFTER_MS = 25 * 60_000;
const IDLE_MS = 30 * 60_000;
const TICK_MS = 30_000;

/** Dispatched by the shell when a background read is refused: the session is gone, whatever the clock says. */
const ENDED_EVENT = "deskzo-console-session-ended";

/** Tells the banner the session has ended — for a read the server refused (the shell's badge poll). */
export function announceSessionEnded(): void {
  window.dispatchEvent(new Event(ENDED_EVENT));
}

type IdleState = { kind: "active" } | { kind: "warning"; minutesLeft: number } | { kind: "ended" };

export function IdleWarning() {
  /** When the operator last pressed, clicked or scrolled here. Written by listeners, read by the timer. */
  const lastInteraction = useRef(0);
  const [state, setState] = useState<IdleState>({ kind: "active" });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const touching = useRef(false);
  /** The banner's state for the listeners, which are added once. */
  const showing = useRef<IdleState["kind"]>("active");
  useEffect(() => {
    showing.current = state.kind;
  });

  // "Stay signed in": one request, which is what refreshes the session's last-seen time on the server.
  // Refused means it has already ended — signed out elsewhere, switched off, or simply too late.
  const stay = useCallback(() => {
    if (touching.current) return;
    touching.current = true;
    setPending(true);
    setFailed(false);
    consoleTouch()
      .then(
        (result) => {
          if (result.ok) {
            lastInteraction.current = Date.now();
            setState({ kind: "active" });
          } else {
            setState({ kind: "ended" });
          }
        },
        // The network, not the session: leave the warning up so the button can be pressed again.
        () => setFailed(true),
      )
      .finally(() => {
        touching.current = false;
        setPending(false);
      });
  }, []);

  useEffect(() => {
    lastInteraction.current = Date.now();

    function check() {
      const idle = Date.now() - lastInteraction.current;
      setState((prev) => {
        // An ended session does not come back by moving the mouse; only signing in again does.
        if (prev.kind === "ended") return prev;
        if (idle >= IDLE_MS) return { kind: "ended" };
        if (idle >= WARN_AFTER_MS) {
          const minutesLeft = Math.max(1, Math.ceil((IDLE_MS - idle) / 60_000));
          return prev.kind === "warning" && prev.minutesLeft === minutesLeft ? prev : { kind: "warning", minutesLeft };
        }
        return prev.kind === "active" ? prev : { kind: "active" };
      });
    }

    function interacted() {
      lastInteraction.current = Date.now();
      // Somebody pressing a key while the warning is up is plainly here: tell the server now, not at
      // the next badge poll, which could land after the session has already run out.
      if (showing.current === "warning") stay();
    }

    function onVisibility() {
      // Timers are slowed in a background tab; coming back should not show a warning half a minute late.
      if (document.visibilityState === "visible") check();
    }

    const onEnded = () => setState({ kind: "ended" });

    window.addEventListener("pointerdown", interacted, true);
    window.addEventListener("keydown", interacted, true);
    window.addEventListener("wheel", interacted, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(ENDED_EVENT, onEnded);
    const timer = window.setInterval(check, TICK_MS);
    return () => {
      window.removeEventListener("pointerdown", interacted, true);
      window.removeEventListener("keydown", interacted, true);
      window.removeEventListener("wheel", interacted);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(ENDED_EVENT, onEnded);
      window.clearInterval(timer);
    };
  }, [stay]);

  if (state.kind === "active") return null;

  // Sticky under the top bar: a warning that scrolled away with the page would warn nobody.
  const strip = "sticky top-14 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning-bg px-4 py-2 text-sm text-warning md:px-6";

  if (state.kind === "ended") {
    return (
      <div role="status" className={strip}>
        <LogIn aria-hidden="true" className="h-4 w-4 shrink-0" />
        <p className="min-w-0 flex-1">
          Your session has ended —{" "}
          <Link href="/login" className="font-medium underline underline-offset-2 hover:no-underline">
            sign in again
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div role="alert" className={strip}>
      <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        You&apos;ll be signed out in {plural(state.minutesLeft, "minute")} for inactivity
        {failed && <span className="text-danger"> — the console didn&apos;t answer, try again</span>}
      </p>
      <Button type="button" size="sm" variant="secondary" onClick={stay} aria-disabled={pending || undefined}>
        {pending ? "Staying signed in…" : "Stay signed in"}
      </Button>
    </div>
  );
}
