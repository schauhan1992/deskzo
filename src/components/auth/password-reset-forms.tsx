"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { requestPasswordReset, resetPassword } from "@/actions/password-reset";

/** Asking for a link. The answer is the same whether or not the address has an account here. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  if (sent) {
    return (
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-text">If {email} has an account here, a link to set a new password is on its way. It works for an hour.</p>
        <Link href="/login" className="text-brand hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          await requestPasswordReset(email);
          setSent(true);
        });
      }}
    >
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <Button type="submit" disabled={pending || !email.includes("@")}>
        {pending ? "Sending…" : "Send me a link"}
      </Button>
    </form>
  );
}

/** Choosing the new password, from the emailed link. */
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  if (done) {
    return (
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-text">Your password is set, and anybody signed in with the old one has been signed out.</p>
        <Link href="/login" className="text-brand hover:underline">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (password !== again) {
          setError("The two passwords don't match.");
          return;
        }
        startTransition(async () => {
          const r = await resetPassword({ token, password });
          if (r.ok) setDone(true);
          else setError(r.error);
        });
      }}
    >
      <div>
        <Label htmlFor="password">New password</Label>
        <Input id="password" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="again">The same again</Label>
        <Input id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending || password.length < 10}>
        {pending ? "Saving…" : "Set my password"}
      </Button>
    </form>
  );
}
