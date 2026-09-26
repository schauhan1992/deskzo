"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { consoleFinishEnrolment, consoleSetPassword, consoleSignIn } from "@/actions/platform/staff-auth";

/**
 * The console's three doors — signing in, enrolling an authenticator, choosing a password from a
 * one-time link (src/actions/platform/staff-auth.ts). None of them is the workspace sign-in: these
 * are staff accounts, in the control plane, with a session of their own.
 */

export function ConsoleSignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [askCode, setAskCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await consoleSignIn({ email, password, code: askCode ? code : undefined });
          if (r.ok) {
            router.replace(r.enrol ? "/enrol" : "/");
            router.refresh();
            return;
          }
          if (r.needsCode) setAskCode(true);
          setError(r.error);
        });
      }}
    >
      <div>
        <Label htmlFor="console-email">Email</Label>
        <Input id="console-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="console-password">Password</Label>
        <Input id="console-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {askCode && (
        <div>
          <Label htmlFor="console-code">Code from your authenticator</Label>
          <Input id="console-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
      )}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

export function ConsoleEnrolForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await consoleFinishEnrolment(code);
          if (!r.ok) return setError(r.error);
          router.replace("/");
          router.refresh();
        });
      }}
    >
      <div>
        <Label htmlFor="enrol-code">The 6-digit code it shows</Label>
        <Input id="enrol-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      </div>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending || code.length !== 6}>
        {pending ? "Checking…" : "Turn on two-factor"}
      </Button>
    </form>
  );
}

export function ConsoleSetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  if (done) {
    return (
      <p className="text-sm text-text">
        Your password is set.{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (password !== again) return setError("The two passwords are not the same.");
        startTransition(async () => {
          const r = await consoleSetPassword(token, password);
          if (r.ok) setDone(true);
          else setError(r.error);
        });
      }}
    >
      <div>
        <Label htmlFor="setup-password">New password (at least 12 characters)</Label>
        <Input id="setup-password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="setup-again">The same again</Label>
        <Input id="setup-again" type="password" autoComplete="new-password" minLength={12} required value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
