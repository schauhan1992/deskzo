"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { allowAppSignIn } from "@/actions/app-devices";

/** Where "Cancel" goes: back to the app, which says it wasn't signed in. */
const CANCELLED = "deskzo://signed-in?error=cancelled";

/**
 * "Allow" or "Cancel" for the Deskzo app that opened this page (src/app/(auth)/app-sign-in). Allowing sends a
 * one-time code back to the app; the browser hands over to it, and the page says so in case it doesn't.
 */
export function AppSignInConsent({
  kind,
  challenge,
  workspace,
  person,
  refusal,
}: {
  kind: "phone" | "tablet";
  challenge: string;
  workspace: string;
  person: { name: string; email: string };
  refusal: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  if (refusal) {
    return (
      <div className="space-y-4 text-sm">
        <h1 className="text-lg font-semibold text-text">{"The Deskzo app can't sign in"}</h1>
        <p className="text-text">{refusal}</p>
        <a href={CANCELLED} className="inline-block text-brand hover:underline">
          Back to the app
        </a>
      </div>
    );
  }

  if (link) {
    return (
      <div className="space-y-4 text-sm">
        <h1 className="text-lg font-semibold text-text">Back to the app</h1>
        <p className="text-muted">{"The Deskzo app is finishing signing you in. If it didn't open, tap below — within two minutes."}</p>
        <a href={link} className="inline-block font-medium text-brand hover:underline">
          Open the Deskzo app
        </a>
      </div>
    );
  }

  function allow() {
    setError(null);
    startTransition(async () => {
      const result = await allowAppSignIn(kind, challenge);
      if (!result.ok) {
        setError(result.error ?? "That didn't work. Start again from the app.");
        return;
      }
      setLink(result.data.link);
      window.location.href = result.data.link;
    });
  }

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold text-text">Sign in to the Deskzo app?</h1>
      <p className="text-text">
        The Deskzo app on this {kind} will be signed in to <span className="font-medium">{workspace}</span> as you:
      </p>
      <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <p className="font-medium text-text">{person.name}</p>
        <p className="text-muted">{person.email}</p>
      </div>
      <p className="text-muted">
        Only allow this if you just opened the app to sign in. Your administrators see the {kind} in Security › Devices and can sign it out.
      </p>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={allow} disabled={pending} className="flex-1">
          {pending ? "Signing in…" : "Allow"}
        </Button>
        <a href={CANCELLED} className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm text-text shadow-sm hover:bg-surface-sunken">
          Cancel
        </a>
      </div>
    </div>
  );
}
