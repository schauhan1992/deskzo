"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { checkCredentials, loginAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCredentialsSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await checkCredentials(email, password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.needsTotp) {
        setStep("totp");
        return;
      }
      const loginResult = await loginAction({ email, password, callbackUrl });
      if (loginResult?.error) setError(loginResult.error);
    });
  }

  function handleTotpSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const loginResult = await loginAction({ email, password, totpCode, callbackUrl });
      if (loginResult?.error) setError(loginResult.error);
    });
  }

  if (step === "totp") {
    return (
      <form onSubmit={handleTotpSubmit} className="space-y-4">
        <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="space-y-1.5">
          <Label htmlFor="totpCode">Authenticator code</Label>
          <Input
            id="totpCode"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? "Verifying…" : "Verify"}
        </Button>
        <button
          type="button"
          className="w-full text-center text-xs text-subtle hover:text-muted"
          onClick={() => {
            setStep("credentials");
            setTotpCode("");
            setError(null);
          }}
        >
          ← Back
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleCredentialsSubmit} className="space-y-4">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-xs">
        <Link href="/forgot-password" className="text-muted hover:text-text hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
