"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { Cookie } from "lucide-react";
import { setCookieConsent } from "@/actions/platform/site";
import { CONSENT_COOKIE, isReferralCode } from "@/lib/partners/referral-cookie";
import { Button } from "@/components/ui/button";

/**
 * The public site's cookie notice (owner, 23 Oct 2026): always shown on a first visit. While the partner
 * programme's referral cookie is off — the default — the site sets only the cookies it needs, so the notice
 * only says so, and "OK" is remembered in this browser. With the referral cookie on it asks: Accept or
 * Decline, given the same weight, remembered for a year in `deskzo_consent` (src/actions/platform/site.ts
 * setCookieConsent), and the referral cookie waits for an Accept (src/proxy.ts). The footer's "Cookie
 * settings" opens it again, to change the answer.
 */

/** The footer's "Cookie settings" asks the notice to open again. */
const COOKIE_SETTINGS = "deskzo:cookie-settings";
/** `storage` only fires in other tabs, so this tab tells itself. */
const CHANGED = "deskzo:cookie-choice";
/** The essential-only notice's "OK", remembered in this browser. */
const SEEN_KEY = "deskzo:cookie-notice";
/** On the server, and while hydrating: nothing is known, so nothing shows. */
const UNKNOWN = "unknown";

function consent(): string | null {
  const pair = document.cookie.split("; ").find((c) => c.startsWith(`${CONSENT_COOKIE}=`));
  return pair ? decodeURIComponent(pair.slice(CONSENT_COOKIE.length + 1)) : null;
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode, or site data blocked: nothing was remembered.
    return false;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** A well-formed partner code in the address, if any. */
function refHere(): string | null {
  const ref = new URLSearchParams(window.location.search).get("ref");
  return ref && isReferralCode(ref) ? ref : null;
}

export function CookieNotice({ referralDays }: { referralDays: number }) {
  const tracking = referralDays > 0;
  const choice = useSyncExternalStore(subscribe, consent, () => UNKNOWN);
  const dismissed = useSyncExternalStore(subscribe, seen, () => true);
  const [reopened, setReopened] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [pending, startTransition] = useTransition();
  // The partner's code from the address the visitor landed on, for an Accept a page or two later. Held in
  // memory only — nothing is stored before they agree; the site's frame stays mounted as they move around.
  const landing = useRef<string | null>(null);

  useEffect(() => {
    landing.current ??= refHere();
    const open = () => {
      setAnswered(false);
      setReopened(true);
    };
    window.addEventListener(COOKIE_SETTINGS, open);
    return () => window.removeEventListener(COOKIE_SETTINGS, open);
  }, []);

  const owed = tracking ? choice === null : choice === null && !dismissed;
  if (choice === UNKNOWN || answered || !(reopened || owed)) return null;

  const close = () => {
    setReopened(false);
    setAnswered(true);
    window.dispatchEvent(new Event(CHANGED));
  };
  const answer = (value: "accepted" | "declined") =>
    startTransition(async () => {
      try {
        await setCookieConsent({ choice: value, ref: refHere() ?? landing.current ?? undefined });
      } catch {
        // Not remembered: the notice asks again on the next visit.
      }
      close();
    });

  return (
    <section
      aria-labelledby="cookie-notice-title"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-lg rounded-2xl border border-line bg-surface p-5 shadow-lg sm:left-6 sm:right-auto sm:mx-0"
    >
      <div className="flex gap-3">
        <Cookie aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div className="min-w-0">
          <h2 id="cookie-notice-title" className="text-sm font-semibold text-text">
            Cookies
          </h2>
          {tracking ? (
            <p className="mt-1 text-sm leading-6 text-muted">
              The site sets the cookies it needs to sign you up and sign you in. With your agreement it sets one more: when a partner&apos;s link brought
              you here, it lets us credit that partner if you sign up, and is kept up to {referralDays} days. No analytics, no advertising.
            </p>
          ) : (
            <p className="mt-1 text-sm leading-6 text-muted">
              The site sets only the cookies it needs to work — to sign you up and sign you in. No analytics, no advertising, nothing that follows you
              to other sites.
            </p>
          )}
          {tracking && reopened && (choice === "accepted" || choice === "declined") && (
            <p className="mt-2 text-xs text-subtle">On this browser you {choice === "accepted" ? "agreed to" : "declined"} the referral cookie.</p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            {tracking ? (
              <div className="flex gap-2">
                <Button type="button" variant="secondary" disabled={pending} onClick={() => answer("accepted")}>
                  Accept
                </Button>
                <Button type="button" variant="secondary" disabled={pending} onClick={() => answer("declined")}>
                  Decline
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  try {
                    localStorage.setItem(SEEN_KEY, "1");
                  } catch {
                    // ignore — shown again on the next visit
                  }
                  close();
                }}
              >
                OK
              </Button>
            )}
            <Link href="/privacy#cookies" className="text-sm font-medium text-muted underline underline-offset-2 hover:text-text">
              Cookies in the privacy notice
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The footer's "Cookie settings": opens the notice again, to read it or change the answer. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(COOKIE_SETTINGS))}>
      Cookie settings
    </button>
  );
}
