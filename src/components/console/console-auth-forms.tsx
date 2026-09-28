"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, CircleCheck, LoaderCircle, LogOut } from "lucide-react";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { CopyButton } from "@/components/console/kit/copy-field";
import { readLandingPage } from "@/components/console/kit/prefs";
import { consoleFinishEnrolment, consoleSetPassword, consoleSignIn, consoleSignOut } from "@/actions/platform/staff-auth";
import { cn } from "@/lib/utils";

/**
 * The console's three doors — signing in, enrolling an authenticator, choosing a password from a
 * one-time link (src/actions/platform/staff-auth.ts). None of them is the workspace sign-in: these
 * are staff accounts, in the control plane, with a session of their own.
 *
 * Buttons are marked busy rather than disabled while a request is out: disabling the button that has
 * focus drops focus to <body>, and the refusal then arrives with nothing focused near it.
 */

/** The same floor as `completePasswordSetup` (src/lib/platform/staff.ts), which is what enforces it. */
const MIN_PASSWORD = 12;

/** Said when the action itself could not be reached — never the thrown text, which is not for this screen. */
const UNREACHABLE = "The console could not be reached. Check your connection and try again.";

/** Digits only, at most six — applied after a paste, so "123 456" is not cut to "123 45" first. */
const sixDigits = (value: string) => value.replace(/\D/g, "").slice(0, 6);

/** Where a signed-in member lands: their own preference, read in the handler rather than a render. */
const landingPath = () => (readLandingPage() === "workspaces" ? "/workspaces" : "/");

/** A stable ref callback: moves focus to a message that replaced the form whose button had it. */
function focusOnMount(el: HTMLElement | null) {
  el?.focus();
}

function BusyLabel({ busy, idle, working }: { busy: boolean; idle: string; working: string }) {
  return (
    <>
      {busy && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
      {busy ? working : idle}
    </>
  );
}

export function ConsoleSignInForm() {
  const router = useRouter();
  const id = useId();
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const showId = `${id}-show`;
  const codeId = `${id}-code`;
  const codeRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set once the session exists: the page is being left, and the form stays locked until it has gone.
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = pending || leaving;
  const onCodeStep = step === "code";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || (onCodeStep && code.length !== 6)) return;
    setError(null);
    startTransition(async () => {
      let r: Awaited<ReturnType<typeof consoleSignIn>>;
      try {
        r = await consoleSignIn({ email, password, code: onCodeStep ? code : undefined });
      } catch {
        setError(UNREACHABLE);
        return;
      }
      if (r.ok) {
        setLeaving(true);
        router.replace(r.enrol ? "/enrol" : landingPath());
        router.refresh();
        return;
      }
      if (!onCodeStep && r.needsCode) {
        // The password was right and an authenticator is enrolled: the second step, not a mistake.
        setCode("");
        setStep("code");
        return;
      }
      setError(r.error);
      if (onCodeStep) {
        setCode("");
        codeRef.current?.focus();
      }
    });
  }

  function back() {
    setStep("password");
    setCode("");
    setError(null);
  }

  return (
    <div className="space-y-4">
      <form className="space-y-4" onSubmit={submit} aria-busy={busy || undefined}>
        {onCodeStep ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
              <p className="min-w-0 truncate text-sm text-text" title={email}>
                <span className="sr-only">Signing in as </span>
                {email}
              </p>
              <button
                type="button"
                onClick={back}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline disabled:opacity-45"
              >
                <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                Back
              </button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={codeId}>Enter the 6-digit code from your authenticator</Label>
              <Input
                ref={codeRef}
                id={codeId}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(sixDigits(e.target.value))}
                readOnly={busy}
                className="font-mono tracking-[0.3em] tabular-nums"
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input
                id={emailId}
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                readOnly={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={passwordId}>Password</Label>
              <Input
                id={passwordId}
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                readOnly={busy}
              />
              <div className="flex items-center gap-2 pt-1">
                <Checkbox id={showId} checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} aria-controls={passwordId} />
                <Label htmlFor={showId} className="cursor-pointer text-xs font-normal">
                  Show password
                </Label>
              </div>
            </div>
          </>
        )}

        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />

        <Button
          type="submit"
          className={cn("w-full", busy && "cursor-wait opacity-70")}
          disabled={onCodeStep && code.length !== 6}
          aria-disabled={busy || undefined}
        >
          <BusyLabel busy={busy} idle={onCodeStep ? "Verify and sign in" : "Sign in"} working="Signing in…" />
        </Button>
      </form>

      <p className="text-center text-xs text-muted">
        {onCodeStep ? "Lost your authenticator? Ask an owner to reset your two-factor." : "Forgot your password? Ask an owner for a new password link."}
      </p>
    </div>
  );
}

type StepState = "done" | "current" | "upcoming";

const MARKER: Record<StepState, string> = {
  done: "border-success/40 bg-success-bg text-success",
  current: "border-transparent bg-brand text-brand-contrast",
  upcoming: "border-line-strong bg-surface text-muted",
};

/** One numbered step of a vertical stepper, with the rail that joins it to the next. */
function Step({ n, title, state, last = false, children }: { n: number; title: string; state: StepState; last?: boolean; children: ReactNode }) {
  return (
    <li aria-current={state === "current" ? "step" : undefined} className="relative flex gap-3">
      {!last && <span aria-hidden="true" className="absolute top-7 -bottom-4 left-3 w-px -translate-x-1/2 bg-line" />}
      <span aria-hidden="true" className={cn("relative grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums", MARKER[state])}>
        {state === "done" ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <h2 className="text-sm font-semibold text-text">
          <span className="sr-only">{`Step ${n}${state === "done" ? ", done" : ""}: `}</span>
          {title}
        </h2>
        {children}
      </div>
    </li>
  );
}

/** A setup key as the apps print it — blocks of four — so it can be read across and typed without losing the place. */
function keyBlocks(secret: string): string {
  return (secret.replace(/\s+/g, "").match(/.{1,4}/g) ?? []).join(" ");
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" size="sm" aria-disabled={pending || undefined} className={pending ? "cursor-wait opacity-70" : undefined}>
      {pending ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <LogOut aria-hidden="true" className="h-3.5 w-3.5" />}
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/**
 * Enrolling an authenticator: scan (the page shows the QR code above this), then confirm with a code.
 * The first step reads as done once a code is being typed — there is nothing to click between them,
 * because somebody with the app already open should not be made to press "Next".
 */
export function ConsoleEnrolForm({ secret }: { secret: string }) {
  const router = useRouter();
  const id = useId();
  const codeId = `${id}-code`;
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  // Typing a code means the scan happened; a wrong code clears the field but does not undo that.
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const busy = pending || leaving;
  const confirming = started || code.length > 0;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setError(null);
    startTransition(async () => {
      let r: Awaited<ReturnType<typeof consoleFinishEnrolment>>;
      try {
        r = await consoleFinishEnrolment(code);
      } catch {
        setError(UNREACHABLE);
        return;
      }
      if (r.ok) {
        setLeaving(true);
        router.replace("/");
        router.refresh();
        return;
      }
      setError(r.error);
      setCode("");
      codeRef.current?.focus();
    });
  }

  return (
    <div className="space-y-5">
      <ol className="space-y-5">
        <Step n={1} title="Scan" state={confirming ? "done" : "current"}>
          <p className="text-sm text-muted">Open your authenticator app, add an account, and scan the QR code above.</p>
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              Can&apos;t scan it?
            </summary>
            <div className="mt-2 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
              <p className="text-xs text-muted">Type this setup key into the app instead, as a time-based key:</p>
              <div className="mt-1.5 flex items-start gap-1">
                <code translate="no" className="min-w-0 flex-1 pt-1 font-mono text-sm tracking-wide break-words text-text select-all">
                  {keyBlocks(secret)}
                </code>
                <CopyButton value={secret} label="Copy setup key" />
              </div>
            </div>
          </details>
          <p className="text-xs text-subtle">Any TOTP authenticator app works — Google Authenticator, Microsoft Authenticator, 1Password, Authy and the like.</p>
        </Step>

        <Step n={2} title="Confirm" state={confirming ? "current" : "upcoming"} last>
          <form className="space-y-3" onSubmit={submit} aria-busy={busy || undefined}>
            <div className="space-y-1.5">
              <Label htmlFor={codeId}>The 6-digit code the app shows</Label>
              <Input
                ref={codeRef}
                id={codeId}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => {
                  const next = sixDigits(e.target.value);
                  setCode(next);
                  if (next) setStarted(true);
                }}
                readOnly={busy}
                className="font-mono tracking-[0.3em] tabular-nums"
              />
            </div>
            <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
            <Button type="submit" className={cn("w-full", busy && "cursor-wait opacity-70")} disabled={code.length !== 6} aria-disabled={busy || undefined}>
              <BusyLabel busy={busy} idle="Turn on two-factor" working="Checking…" />
            </Button>
          </form>
        </Step>
      </ol>

      {/* The way out for somebody without their phone, or signed in as the wrong person. */}
      <form action={consoleSignOut} className="flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-xs text-muted">No phone to hand, or not your account?</p>
        <SignOutButton />
      </form>
    </div>
  );
}

/** One line of the password checklist, ticked as it is met. */
function Rule({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-center gap-1.5", met ? "text-success" : "text-muted")}>
      {met ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <span aria-hidden="true" className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-current" />}
      <span>
        {children}
        <span className="sr-only">{met ? " — done" : " — not yet"}</span>
      </span>
    </li>
  );
}

/**
 * Choosing a password from a one-time link. The link's token is checked when this is sent, not
 * before, so an old link and a made-up one look the same until then. The checklist is live and the
 * button waits for it; the server holds the same rule regardless.
 */
export function ConsoleSetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const id = useId();
  const passwordId = `${id}-password`;
  const againId = `${id}-again`;
  const showId = `${id}-show`;
  const rulesId = `${id}-rules`;
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  // The move to /login after a success; cleared if the page is left first.
  const redirectTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = redirectTimer;
    return () => window.clearTimeout(timer.current);
  }, []);

  const longEnough = password.length >= MIN_PASSWORD;
  const matches = again.length > 0 && password === again;
  const ready = longEnough && matches;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || !ready) return;
    setError(null);
    startTransition(async () => {
      let r: Awaited<ReturnType<typeof consoleSetPassword>>;
      try {
        r = await consoleSetPassword(token, password);
      } catch {
        setError(UNREACHABLE);
        return;
      }
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone(true);
      window.clearTimeout(redirectTimer.current);
      redirectTimer.current = window.setTimeout(() => router.replace("/login"), 3000);
    });
  }

  if (done) {
    return (
      <div ref={focusOnMount} tabIndex={-1} role="status" className="space-y-3 rounded-base outline-none">
        <p className="flex items-center gap-2 text-sm font-semibold text-success">
          <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0" />
          Your password is set
        </p>
        <p className="text-sm text-muted">Taking you to the sign-in page in a moment.</p>
        <Link
          href="/login"
          replace
          className="inline-flex h-9 w-full items-center justify-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110"
        >
          Sign in now
        </Link>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} aria-busy={pending || undefined}>
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>New password</Label>
        <Input
          id={passwordId}
          name="new-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          readOnly={pending}
          aria-describedby={rulesId}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={againId}>The same again</Label>
        <Input
          id={againId}
          name="confirm-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          readOnly={pending}
          aria-describedby={rulesId}
        />
        <div className="flex items-center gap-2 pt-1">
          <Checkbox id={showId} checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} aria-controls={`${passwordId} ${againId}`} />
          <Label htmlFor={showId} className="cursor-pointer text-xs font-normal">
            Show passwords
          </Label>
        </div>
      </div>

      <ul id={rulesId} aria-label="Password rules" className="space-y-1 rounded-lg border border-line bg-surface-sunken px-3 py-2.5 text-xs">
        <Rule met={longEnough}>At least {MIN_PASSWORD} characters</Rule>
        <Rule met={matches}>Both entries match</Rule>
      </ul>

      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />

      <Button type="submit" className={cn("w-full", pending && "cursor-wait opacity-70")} disabled={!ready} aria-disabled={pending || undefined}>
        <BusyLabel busy={pending} idle="Set password" working="Saving…" />
      </Button>
    </form>
  );
}
