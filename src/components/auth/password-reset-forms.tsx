"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { requestPasswordReset, resetPassword, setPasswordAndSignIn } from "@/actions/password-reset";
import { startLinkingWorkspace } from "@/actions/linked-sign-in";

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

/** For a throw that is not one of the actions' own answers — the network, or the server falling over. */
const FAILED = "That didn't work. Try again.";
/** The sign-in straight after the password was refused: Microsoft sign-in enforced here, a blocked network, a code. */
const NOT_SIGNED_IN = "We couldn't sign you in here with that password, so linking hasn't started.";
const LINK_FAILED = "Linking couldn't start.";

/** Where the setup page goes once its button is pressed. */
export type SetupOutcome =
  /** The password was not set: the form again, and why. */
  | { next: "retry"; error: string }
  /** Set, and nothing else was asked — the page as it always was. */
  | { next: "done" }
  /** Set, signed in here, and linking started: the browser goes to the other workspace's `/link/start`. */
  | { next: "leave"; url: string }
  /** Set, but linking did not start: why, and whether this browser is now signed in here. */
  | { next: "later"; error: string; signedIn: boolean };

/**
 * The setup page's button. With no workspace address it is `resetPassword`, exactly as it always was.
 * With one — the invitation's optional field — the password is set and the person signed in here
 * (`setPasswordAndSignIn`), then linking starts as Profile's "Add a workspace" starts it
 * (`startLinkingWorkspace`), the password just chosen as the proof that it's them. Two requests, because
 * the second is the first to carry the new session. Nothing after the password is set undoes it.
 */
export async function setUpAccount(input: { token: string; password: string; workspace: string }): Promise<SetupOutcome> {
  const workspace = input.workspace.trim();
  if (!workspace) {
    const reset = await resetPassword({ token: input.token, password: input.password });
    return reset.ok ? { next: "done" } : { next: "retry", error: reset.error };
  }
  const set = await setPasswordAndSignIn({ token: input.token, password: input.password });
  if (!set.ok) return { next: "retry", error: set.error };
  if (!set.signedIn) return { next: "later", error: NOT_SIGNED_IN, signedIn: false };
  try {
    const started = await startLinkingWorkspace({ workspace, password: input.password });
    return started.ok ? { next: "leave", url: started.url } : { next: "later", error: started.error, signedIn: true };
  } catch {
    return { next: "later", error: LINK_FAILED, signedIn: true };
  }
}

/**
 * Choosing the new password, from the emailed link. `offerLink` (the invitation's `&link=1`) adds the
 * optional "link it to the workspace you already use" field; `domain` is PLATFORM_DOMAIN, shown after a
 * bare workspace name as "Add a workspace" shows it.
 */
export function ResetPasswordForm({ token, offerLink = false, domain = "" }: { token: string; offerLink?: boolean; domain?: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Exclude<SetupOutcome, { next: "retry" }> | null>(null);
  const [pending, startTransition] = useTransition();
  if (outcome?.next === "done") {
    return (
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-text">Your password is set, and anybody signed in with the old one has been signed out.</p>
        <Link href="/login" className="text-brand hover:underline">
          Sign in
        </Link>
      </div>
    );
  }
  if (outcome?.next === "leave") {
    return (
      <p role="status" className="mt-4 text-sm text-text">
        Your password is set. Taking you to that workspace to sign in there…
      </p>
    );
  }
  if (outcome?.next === "later") {
    return (
      <div className="mt-4 space-y-3 text-sm">
        <p className="text-text">Your password is set.</p>
        <p role="alert" className="rounded-base border border-danger/30 bg-danger-bg px-3 py-2 text-danger">
          {outcome.error}
        </p>
        <p className="text-muted">You can link later from your profile.</p>
        <Link href={outcome.signedIn ? "/profile#linked-workspaces" : "/login"} className="text-brand hover:underline">
          {outcome.signedIn ? "Go to your profile" : "Sign in"}
        </Link>
      </div>
    );
  }
  const linking = offerLink && workspace.trim() !== "";
  // A full address or a custom domain is taken as typed, so the suffix would only mislead.
  const showSuffix = !workspace.includes(".") && domain !== "";
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
          let r: SetupOutcome;
          try {
            r = await setUpAccount({ token, password, workspace: offerLink ? workspace : "" });
          } catch {
            setError(FAILED);
            return;
          }
          if (r.next === "retry") {
            setError(r.error);
            return;
          }
          setOutcome(r);
          if (r.next === "leave") window.location.assign(r.url);
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
      {offerLink && (
        <fieldset className="space-y-1.5 rounded-base border border-line p-3">
          <legend className="px-1 text-sm font-medium text-text">Link it to the workspace you already use</legend>
          <Label htmlFor="link-workspace">Workspace address (optional)</Label>
          <div className="flex min-w-0 items-center rounded-base border border-line-strong bg-surface shadow-sm focus-within:border-brand">
            <Input
              id="link-workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="yourcompany"
              className="min-w-0 border-0 shadow-none"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby={showSuffix ? "link-workspace-help link-workspace-suffix" : "link-workspace-help"}
            />
            {showSuffix && (
              <span id="link-workspace-suffix" className="max-w-[55%] shrink-0 truncate pr-3 text-sm text-muted">
                .{domain}
              </span>
            )}
          </div>
          <p id="link-workspace-help" className="text-xs text-subtle">
            The address you sign in at there. You&apos;ll sign in there to confirm it&apos;s you, then come back here.
            Leave it empty to link later from your profile.
          </p>
        </fieldset>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending || password.length < 10}>
        {pending ? "Saving…" : linking ? "Set my password and link" : "Set my password"}
      </Button>
    </form>
  );
}
