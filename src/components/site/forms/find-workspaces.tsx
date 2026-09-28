"use client";

import { useState, useTransition } from "react";
import { MailCheck } from "lucide-react";
import { findMyWorkspaces } from "@/actions/platform/site";
import { Honeypot } from "@/components/site/forms/honeypot";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * "Find my workspaces": an email address in, the same confirmation out whatever it is — the list
 * goes to the address, never to this page (src/lib/platform/find-workspaces.ts).
 */
export function FindWorkspacesForm({ confirmationHeading, confirmationBody }: { confirmationHeading: string; confirmationBody: string }) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (sent) {
    return (
      <div role="status" className="rounded-xl border border-line bg-surface-sunken p-5">
        <div className="flex items-start gap-3">
          <MailCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div>
            <p className="text-sm font-semibold text-text">{confirmationHeading}</p>
            <p className="mt-1 text-sm leading-6 text-muted">{confirmationBody}</p>
            <button
              type="button"
              className="mt-3 text-sm font-medium text-brand hover:underline"
              onClick={() => {
                setSent(false);
                setEmail("");
              }}
            >
              Use another address
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          try {
            await findMyWorkspaces({ email, website });
            setSent(true);
          } catch {
            setError("Something went wrong. Try again in a moment.");
          }
        });
      }}
      className="space-y-3"
    >
      <Label htmlFor="site-find-email">Work email</Label>
      <Input id="site-find-email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      <Honeypot id="site-find-website" value={website} onChange={setWebsite} />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="secondary" className="h-10 w-full" disabled={pending}>
        {pending ? "Sending…" : "Email me my workspaces"}
      </Button>
    </form>
  );
}
