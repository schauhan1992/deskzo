"use client";

import { useId, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { reauthWithMicrosoft, startLinkingWorkspace } from "@/actions/linked-sign-in";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

const noSubscribe = () => () => {};

/** For a throw that is not one of the action's own answers — the network, or the server falling over. */
const FAILED = "That didn't work. Try again.";

type Reauth = "password" | "password+code" | "sso";

/**
 * "Add a workspace" (spec §2.2, steps 1–3): which workspace, then proof that it's the person here —
 * their password (and code), or a fresh Microsoft sign-in — then the browser goes to that workspace's
 * `/link/start` to sign in there. Opened from the header switcher and from Profile.
 *
 * A dialog and never a field inside the switcher's popover, whose mousedown handling keeps focus on its
 * anchor. Drawn only once hydrated (the dialog portals into `<body>`, which the server does not have),
 * so a caller may pass `open` from the first render — Profile does, for `?link=`.
 */
export function AddWorkspaceDialog({
  open,
  onClose,
  domain,
  reauth,
  initialWorkspace,
  sso,
  currentName,
}: {
  open: boolean;
  onClose: () => void;
  /** PLATFORM_DOMAIN, shown after the address field as `.<domain>`. */
  domain: string;
  /** How this account confirms it's them — `myLinkedWorkspaces().reauth`. */
  reauth: Reauth;
  /** The address to start with: Profile's `?link=`, after a Microsoft sign-in. */
  initialWorkspace?: string;
  /** True when that Microsoft sign-in has just happened, so Continue uses it instead of asking again. */
  sso?: boolean;
  /** This workspace's name, for "confirm your password for <name>". "this workspace" when absent. */
  currentName?: string;
}) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);

  return (
    <Dialog
      open={open && isClient}
      // Not while a request is out, nor once the browser is on its way to the other workspace: closing
      // would hide the answer, or a page that is already leaving.
      onClose={() => {
        if (!pending && !leaving) onClose();
      }}
      title="Add a workspace"
    >
      <AddWorkspaceForm
        domain={domain}
        reauth={reauth}
        initialWorkspace={initialWorkspace ?? ""}
        freshSso={reauth === "sso" && sso === true}
        currentName={currentName?.trim() || "this workspace"}
        busy={pending || leaving}
        start={startTransition}
        onLeaving={() => setLeaving(true)}
        onCancel={onClose}
      />
    </Dialog>
  );
}

/** The form itself — mounted only while the dialog is open, so every opening starts clean. */
function AddWorkspaceForm({
  domain,
  reauth,
  initialWorkspace,
  freshSso,
  currentName,
  busy,
  start,
  onLeaving,
  onCancel,
}: {
  domain: string;
  reauth: Reauth;
  initialWorkspace: string;
  freshSso: boolean;
  currentName: string;
  busy: boolean;
  start: (work: () => Promise<void>) => void;
  onLeaving: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const addressId = `${id}-address`;
  const helpId = `${id}-help`;
  const suffixId = `${id}-suffix`;
  const passwordId = `${id}-password`;
  const codeId = `${id}-code`;
  const errorId = `${id}-error`;
  const passwordRef = useRef<HTMLInputElement>(null);

  const [address, setAddress] = useState(initialWorkspace);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The action can ask for more than the dialog opened with: a code after a right password, or a
  // Microsoft sign-in (the workspace began enforcing it, or the last one is too old to count).
  const [askCode, setAskCode] = useState(reauth === "password+code");
  const [microsoft, setMicrosoft] = useState(reauth === "sso" && !freshSso);

  // A full address or a custom domain is taken as typed, so the suffix would only mislead.
  const showSuffix = !address.includes(".");
  const describedBy = [helpId, showSuffix ? suffixId : null, error ? errorId : null].filter(Boolean).join(" ");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const workspace = address.trim();
    setError(null);

    if (microsoft) {
      start(async () => {
        // It ends in a redirect to Microsoft, which is left to reach Next's boundary — never caught
        // here. Returning at all means the sign-in could not start.
        await reauthWithMicrosoft(workspace);
        setError(FAILED);
      });
      return;
    }

    const attempt = freshSso
      ? { workspace, sso: true }
      : { workspace, password, totpCode: askCode ? code.trim() : undefined };
    // Held no longer than the attempt: a wrong one is typed again, and a right one is never needed twice.
    setPassword("");
    setCode("");
    start(async () => {
      let result: Awaited<ReturnType<typeof startLinkingWorkspace>>;
      try {
        result = await startLinkingWorkspace(attempt);
      } catch {
        setError(FAILED);
        return;
      }
      if (result.ok) {
        onLeaving();
        window.location.assign(result.url);
        return;
      }
      // The Microsoft step's own line says it; the same sentence again as an error would only repeat it.
      if (result.needs === "sso") {
        setMicrosoft(true);
        return;
      }
      setError(result.error);
      if (result.needs === "code") setAskCode(true);
      // The password was cleared with the attempt, so the next one starts there.
      passwordRef.current?.focus();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={addressId}>Workspace address</Label>
        <div className="flex min-w-0 items-center rounded-base border border-line-strong bg-surface shadow-sm focus-within:border-brand">
          <Input
            id={addressId}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="yourcompany"
            required
            className="min-w-0 border-0 shadow-none"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={describedBy}
          />
          {showSuffix && (
            <span id={suffixId} className="max-w-[55%] shrink-0 truncate pr-3 text-sm text-muted">
              .{domain}
            </span>
          )}
        </div>
        <p id={helpId} className="text-xs text-subtle">
          The address you sign in at.
        </p>
      </div>

      {microsoft ? (
        <p className="text-sm text-muted">Sign in with Microsoft again to continue.</p>
      ) : (
        !freshSso && (
          <fieldset className="space-y-3">
            <legend className="text-sm text-muted">
              To link workspaces, confirm your password for <span className="font-medium text-text">{currentName}</span>.
            </legend>
            <div className="space-y-1.5">
              <Label htmlFor={passwordId}>Password</Label>
              <Input
                ref={passwordRef}
                id={passwordId}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {askCode && (
              <div className="space-y-1.5">
                <Label htmlFor={codeId}>Authenticator code</Label>
                <Input
                  id={codeId}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  className="w-32 tabular-nums tracking-widest"
                />
              </div>
            )}
          </fieldset>
        )
      )}

      {error && (
        <p id={errorId} role="alert" className="rounded-base border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {microsoft ? "Sign in with Microsoft again" : "Continue"}
          </Button>
        </div>
        <p className="text-xs text-subtle">
          Next you&apos;ll sign in to that workspace. Nothing is shared between the workspaces — this only lets you switch
          between accounts you already have.
        </p>
      </div>
    </form>
  );
}
