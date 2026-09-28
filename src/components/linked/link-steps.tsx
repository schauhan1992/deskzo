"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cancelLinkRequest, confirmLinkRequest, finishLinkRequest, openLinkRequest, switchToWorkspace } from "@/actions/linked-sign-in";
import { Button } from "@/components/ui/button";

/**
 * The client halves of linking's three cross-host pages (spec §2.2, §4.2): `/link/start` and
 * `/link/confirm` at the workspace being added, `/link/complete` back where the person started.
 *
 * Every token rides in the address's fragment (`#i=`, `#c=`), which no server, proxy log or link
 * unfurler ever sees. Each page takes it out of the address as soon as it loads and spends it once.
 * Nothing here puts a token in component state that is rendered, in a link, or in a log.
 */

/** What a page says when its fragment is missing — a link cut short in copying, or opened a second time. */
export const INCOMPLETE = "This link is incomplete.";

/**
 * The one-time token in this page's address fragment, taken once: read, then wiped from the address
 * bar. Call it from an effect guarded by a ref, so React's double effects in development don't read an
 * address already wiped.
 */
export function takeFragment(key: "i" | "c" | "t"): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(key);
  const strip = () => window.history.replaceState(null, "", window.location.pathname);
  strip();
  // A child's effect can run before Next's router has hooked `history` (its ancestors' effects come
  // after), which leaves the fragment in the router's own copy of the address — and an action that
  // sets a cookie re-renders the page at that address, putting the token back in the address bar.
  // The hooked call keeps Next's `__NA` mark on the entry; without it, strip once more through the hook.
  queueMicrotask(() => {
    if (!window.history.state?.__NA) strip();
  });
  return value || null;
}

const linkClass = "text-brand hover:underline";
const secondaryLinkClass =
  "inline-flex h-9 w-full items-center justify-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken";

/** A step that has ended — refused, cancelled, incomplete — and the one way on from it. */
export function FlowMessage({ message, href, label }: { message: string; href: "/login" | "/dashboard"; label: string }) {
  return (
    <div className="space-y-3 text-sm">
      <p role="alert" className="text-text">
        {message}
      </p>
      <Link href={href} className={linkClass}>
        {label}
      </Link>
    </div>
  );
}

/** "Working on it", announced once. */
export function Progress({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
      {text}
    </p>
  );
}

// ─── /link/start, at the workspace being added ───────────────────────────────────────────────────

/**
 * Asks the person to sign in here, then presents the request. Only the click presents it: presenting
 * signs out any session here, and merely opening a link — or a prefetcher opening it — must not.
 * The page never shows who asked from where; `/link/confirm` does, once they have signed in.
 */
export function LinkStart({ workspace, signedInAs }: { workspace: string; signedInAs: string | null }) {
  const taken = useRef(false);
  const request = useRef<string | null>(null);
  // As first rendered: presenting signs the session out, and Next then re-renders the page without it.
  const [signedIn] = useState(signedInAs);
  const [problem, setProblem] = useState<{ message: string; href: "/login" | "/dashboard"; label: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    request.current = takeFragment("i");
    if (!request.current) Promise.resolve().then(() => setProblem({ message: INCOMPLETE, href: "/login", label: `Sign in to ${workspace}` }));
  }, [workspace]);

  function present() {
    const token = request.current;
    // Spent on the first click: a second one has nothing to send.
    request.current = null;
    if (!token) return;
    startTransition(async () => {
      const result = await openLinkRequest(token);
      if (result.ok) {
        setLeaving(true);
        // A full load, not a router push: any session here was just signed out, and nothing the router
        // cached while it was signed in should be what the sign-in page is built from.
        window.location.assign(new URL("/login?callbackUrl=%2Flink%2Fconfirm", window.location.origin).href);
      } else {
        setProblem({ message: result.error, href: "/dashboard", label: "Go to dashboard" });
      }
    });
  }

  if (problem) return <FlowMessage {...problem} />;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-text">Link {workspace} with your other workspace</h2>
        {signedIn ? (
          <p className="text-sm text-muted">
            You&apos;re signed in here as <span className="font-medium text-text">{signedIn}</span>. To link, sign in again.
          </p>
        ) : (
          <p className="text-sm text-muted">Sign in to {workspace} to confirm this account is yours. You&apos;ll see both accounts before anything is linked.</p>
        )}
      </div>
      <Button type="button" className="w-full" onClick={present} disabled={pending || leaving}>
        {pending || leaving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
        {signedIn ? "Sign in again" : `Sign in to ${workspace}`}
      </Button>
    </div>
  );
}

// ─── /link/confirm, at the workspace being added, signed in ─────────────────────────────────────

/** One account in "Link these accounts?": its workspace's name and host, and the account's address there. */
export type LinkAccountSide = { name: string; host: string; email: string };

function AccountRow({ side, caption }: { side: LinkAccountSide; caption: string }) {
  return (
    <li className="rounded-lg border border-line bg-surface-sunken px-3.5 py-3">
      <p className="text-xs text-subtle">{caption}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-text">{side.name}</p>
      <p className="truncate text-xs text-muted">{side.host}</p>
      <p className="truncate text-xs text-muted">{side.email}</p>
    </li>
  );
}

/**
 * The account that has just signed in here approves — or cancels. `intent` is null when this browser
 * has no open request here (expired, used, or never presented in it).
 *
 * The rows are kept from the first render: each action sets or clears the request's cookie, after
 * which Next re-renders the page, and the page — the request now proven or cancelled — would pass null.
 */
export function LinkConfirm({ intent }: { intent: { source: LinkAccountSide; here: LinkAccountSide } | null }) {
  const [rows] = useState(intent);
  const [doing, setDoing] = useState<"link" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setDoing("link");
    setError(null);
    startTransition(async () => {
      const result = await confirmLinkRequest();
      if (result.ok) {
        setLeaving(true);
        window.location.assign(result.url);
      } else {
        setError(result.error);
      }
    });
  }

  function cancel() {
    setDoing("cancel");
    setError(null);
    startTransition(async () => {
      await cancelLinkRequest();
      setCancelled(true);
    });
  }

  if (cancelled) return <FlowMessage message="Linking was cancelled." href="/dashboard" label="Back to dashboard" />;
  if (!rows) return <FlowMessage message="This link request has expired. Start again from your other workspace." href="/dashboard" label="Back to dashboard" />;

  const busy = pending || leaving;
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text">Link these accounts?</h2>
      <ul className="space-y-2">
        <AccountRow side={rows.source} caption="Where you started" />
        <AccountRow side={rows.here} caption="This account" />
      </ul>
      <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Once linked, being signed in to either workspace lets you switch into the other without signing in again. Each workspace still asks for its own
          two-factor code and applies its own rules. Only link workspaces you use yourself — never because someone asked you to.
        </span>
      </p>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
          <Link href="/dashboard" className={`text-sm ${linkClass}`}>
            Back to dashboard
          </Link>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="secondary" onClick={cancel} disabled={busy}>
          {busy && doing === "cancel" ? "Cancelling…" : "Cancel"}
        </Button>
        <Button type="button" onClick={confirm} disabled={busy}>
          {busy && doing === "link" ? "Linking…" : "Link accounts"}
        </Button>
      </div>
    </div>
  );
}

// ─── /link/complete, back where the person started ──────────────────────────────────────────────

type Finished = Awaited<ReturnType<typeof finishLinkRequest>>;

/**
 * Records the link. The action spends the completion token first and only then looks at the session
 * (§4.2 L4), so this page never redirects and never needs a session to load — a redirect to sign in
 * would carry the fragment along, unspent. Called exactly once.
 */
export function LinkComplete({ workspace }: { workspace: string }) {
  const started = useRef(false);
  const [result, setResult] = useState<Finished | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const completion = takeFragment("c");
    if (!completion) {
      Promise.resolve().then(() => setResult({ ok: false, error: INCOMPLETE }));
      return;
    }
    startTransition(async () => {
      const finished = await finishLinkRequest(completion);
      setResult(finished);
    });
  }, []);

  if (!result) return <Progress text="Linking…" />;
  if (!result.ok) return <FlowMessage message={result.error} href="/login" label={`Sign in to ${workspace}`} />;

  const linked = result;
  function switchNow() {
    setSwitchError(null);
    startTransition(async () => {
      const issued = await switchToWorkspace(linked.memberId);
      if (issued.ok) {
        setLeaving(true);
        window.location.assign(issued.url);
      } else {
        setSwitchError(issued.error);
      }
    });
  }

  const busy = pending || leaving;
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm text-text">
        Linked. {linked.workspace} is now in your workspace switcher.
      </p>
      {switchError && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {switchError}
        </p>
      )}
      <div className="space-y-2">
        <Button type="button" className="w-full" onClick={switchNow} disabled={busy}>
          {busy ? "Switching…" : `Switch to ${linked.workspace}`}
        </Button>
        <Link href="/dashboard" className={secondaryLinkClass}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
