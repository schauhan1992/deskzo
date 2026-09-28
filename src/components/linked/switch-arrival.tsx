"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { arriveBySwitch, continueSwitchWithMicrosoft, submitSwitchCode, type SwitchView } from "@/actions/linked-sign-in";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { FlowMessage, INCOMPLETE, Progress, takeFragment } from "@/components/linked/link-steps";

/**
 * Where a switch from a linked workspace lands (spec §2.3, §4.3 S2–S3). Takes the ticket out of the
 * address's fragment and spends it once — even under React's double effects in development. Ready,
 * or already signed in here as that account: the action signs in and redirects to `/dashboard`, so no
 * view ever comes back. Otherwise this workspace asks for its two-factor code or a Microsoft sign-in,
 * or says why the switch ended.
 */
export function SwitchArrival({ workspace }: { workspace: string }) {
  const started = useRef(false);
  const [view, setView] = useState<SwitchView | null>(null);
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const codeId = useId();
  const errorId = useId();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ticket = takeFragment("t");
    if (!ticket) {
      Promise.resolve().then(() => setView({ state: "refused", message: INCOMPLETE }));
      return;
    }
    startTransition(async () => {
      const next = await arriveBySwitch(ticket);
      if (next) setView(next);
    });
  }, []);

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const typed = code;
    startTransition(async () => {
      const next = await submitSwitchCode(typed);
      if (next) {
        setView(next);
        setCode("");
      }
    });
  }

  function continueWithMicrosoft() {
    startTransition(async () => {
      await continueSwitchWithMicrosoft();
      // Reached only when the Microsoft sign-in could not start; otherwise the action has redirected.
      setView({ state: "refused", message: "Couldn't start the Microsoft sign-in. Sign in directly instead." });
    });
  }

  if (!view) return <Progress text={`Switching to ${workspace}…`} />;

  if (view.state === "refused") return <FlowMessage message={view.message} href="/login" label={`Sign in to ${workspace}`} />;

  if (view.state === "sso") {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-text">{view.workspace} signs in with Microsoft.</h2>
        <Button type="button" variant="secondary" className="w-full" onClick={continueWithMicrosoft} disabled={pending}>
          {pending ? "Opening Microsoft sign-in…" : "Continue with Microsoft"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submitCode} className="space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-text">{view.workspace} asks for your two-factor code</h2>
        <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app for {view.email}.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={codeId}>Authenticator code</Label>
        <Input
          id={codeId}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          autoFocus
          required
          aria-invalid={view.error ? true : undefined}
          aria-describedby={view.error ? errorId : undefined}
        />
        {view.error && (
          <p id={errorId} role="alert" className="text-sm text-danger">
            {view.error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Checking…" : "Continue"}
      </Button>
      <p className="text-center text-xs">
        <Link href="/login" className="text-muted hover:text-text hover:underline">
          Sign in to {view.workspace} instead
        </Link>
      </p>
    </form>
  );
}
