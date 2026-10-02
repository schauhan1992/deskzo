"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { Check, ChevronDown, Plus } from "lucide-react";
import { myLinkedWorkspaces, switchToWorkspace, type LinkedWorkspaceView, type MyLinkedWorkspaces } from "@/actions/linked-sign-in";
import { AddWorkspaceDialog } from "@/components/linked/add-workspace-dialog";
import { WorkspaceMark } from "@/components/linked/workspace-mark";
import { initialsOf } from "@/components/ui/avatar";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";

/** For a throw that is not one of the action's own answers — the network, or the server falling over. */
const FAILED = "That didn't work. Try again.";

type List = { status: "idle" | "loading" | "error" } | { status: "ready"; data: MyLinkedWorkspaces };

/**
 * Linked sign-in's switcher, the first thing in the header's right-hand group (spec §2.1): this
 * workspace's mark and name, and a panel listing the person's own accounts in other workspaces, one
 * click from switching into any of them.
 *
 * The layout mounts it only for a member account, never while viewing as somebody, and only while the
 * platform's switch is on. The list itself is asked for when the panel first opens and then kept —
 * every page in the app renders this header, and almost none of them is opened to switch.
 *
 * The panel holds no text field: `AnchoredPopover` keeps focus on its anchor by cancelling mousedown,
 * so "Add a workspace" closes it and opens a dialog instead.
 */
export function WorkspaceSwitcher({
  current,
  domain,
}: {
  /** This workspace as its header shows it: the branding's name, initials and logo. */
  current: { name: string; initials: string; logoDataUrl: string | null };
  /** PLATFORM_DOMAIN, for the add-a-workspace dialog's address field. */
  domain: string;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  // Only the newest request may answer: "Try again" pressed twice must not let the slower one win.
  const requestRef = useRef(0);
  const panelId = useId();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<List>({ status: "idle" });
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (anchorRef.current?.contains(target)) return;
      // The panel is portalled to <body>, so it is not inside the anchor — without this, mousedown on
      // a row would close the panel and the click would never reach it.
      if (target?.closest?.("[data-workspace-panel]")) return;
      // Focus inside the panel would be lost with it; the click itself still moves focus wherever it
      // lands, if that is somewhere focusable.
      if (document.activeElement?.closest?.("[data-workspace-panel]")) anchorRef.current?.focus();
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Escape should leave the keyboard where it started, not adrift at the top of the document.
      anchorRef.current?.focus();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Into the panel as it appears, so the keyboard can reach it at all: portalled to the end of <body>,
  // it is otherwise the last thing on the page in tab order. Stable, so it runs once per opening.
  const focusPanel = useCallback((node: HTMLDivElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  /** `quiet` keeps what is on screen while it asks — after a refused switch, whose row may have changed. */
  async function load(quiet = false) {
    const request = ++requestRef.current;
    if (!quiet) setList({ status: "loading" });
    try {
      const data = await myLinkedWorkspaces();
      if (request === requestRef.current) setList({ status: "ready", data });
    } catch {
      if (request === requestRef.current && !quiet) setList({ status: "error" });
    }
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setSwitchError(null);
    setOpen(true);
    if (list.status === "idle" || list.status === "error") void load();
  }

  async function switchTo(workspace: LinkedWorkspaceView) {
    if (switching) return;
    setSwitchError(null);
    setSwitching(workspace.memberId);
    try {
      const result = await switchToWorkspace(workspace.memberId);
      if (result.ok) {
        // "Switching…" stays up while the browser leaves for the other workspace.
        window.location.assign(result.url);
        return;
      }
      setSwitchError(result.error);
      void load(true);
    } catch {
      setSwitchError(FAILED);
    }
    setSwitching(null);
  }

  function addWorkspace() {
    // Onto the trigger first, so the dialog hands focus back here when it closes rather than to <body>.
    anchorRef.current?.focus();
    setOpen(false);
    setAdding(true);
  }

  /**
   * Arrows, Home and End move between the panel's rows and buttons. Tab off either end closes it and
   * hands the keyboard back to the trigger, rather than running on past the end of <body>, where the
   * portal puts it, into the browser's own controls.
   */
  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["Tab", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Tab") {
      if (items.length === 0 || (e.shiftKey ? at <= 0 : at === items.length - 1)) {
        e.preventDefault();
        setOpen(false);
        anchorRef.current?.focus();
      }
      return;
    }
    if (items.length === 0) return;
    e.preventDefault();
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
    items[next]?.focus();
  }

  const data = list.status === "ready" ? list.data : null;
  const others = data?.items.filter((w) => !w.current) ?? [];
  const here = data?.items.find((w) => w.current) ?? null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={toggle}
        aria-label={`Workspaces: ${current.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-base p-1 transition-colors hover:bg-surface-sunken lg:px-1.5"
      >
        <WorkspaceMark name={current.name} initials={current.initials} src={current.logoDataUrl} />
        {/* The name only where the header has room for it; on a phone the mark carries the button. */}
        <span className="hidden max-w-[10rem] truncate text-[13px] font-medium text-text lg:block">{current.name}</span>
        <ChevronDown aria-hidden="true" className={`hidden h-3.5 w-3.5 shrink-0 text-subtle transition-transform sm:block ${open ? "rotate-180" : ""}`} />
      </button>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={320} maxHeight={460} align="end">
        <div
          ref={focusPanel}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          data-workspace-panel
          onKeyDown={onPanelKeyDown}
          className="p-1.5 outline-none"
        >
          <h2 id={headingId} className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-subtle">
            Your workspaces
          </h2>

          {(list.status === "idle" || list.status === "loading") && (
            <div aria-busy="true">
              <div aria-hidden="true" className="space-y-0.5">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-2.5 px-2 py-1.5">
                    <span className="h-7 w-7 shrink-0 animate-pulse rounded-lg bg-surface-sunken" />
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="block h-3 w-2/3 animate-pulse rounded bg-surface-sunken" />
                      <span className="block h-2.5 w-5/6 animate-pulse rounded bg-surface-sunken" />
                    </span>
                  </div>
                ))}
              </div>
              <p role="status" className="sr-only">
                Loading your workspaces…
              </p>
            </div>
          )}

          {list.status === "error" && (
            <div className="space-y-2 px-2 py-2">
              <p className="text-sm text-text">Couldn&apos;t load your workspaces.</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          )}

          {data && !data.enabled && (
            <p className="px-2 py-2 text-sm text-muted">Switching between workspaces is paused. Sign in to each workspace directly.</p>
          )}

          {data?.enabled && others.length === 0 && (
            <p className="px-2 py-2 text-sm text-muted">
              Work in more than one workspace? Link your accounts to switch between them without signing in each time.
            </p>
          )}

          {data?.enabled && others.length > 0 && (
            <ul className="space-y-0.5">
              {here && (
                <li className="flex items-center gap-2.5 rounded-base px-2 py-1.5">
                  <WorkspaceMark name={here.name} initials={current.initials} src={current.logoDataUrl} />
                  <RowText workspace={here} />
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted">
                    <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                    Current
                  </span>
                </li>
              )}
              {others.map((workspace) => (
                <li key={workspace.memberId}>
                  {workspace.state === "available" ? (
                    <button
                      type="button"
                      aria-label={`Switch to ${workspace.name}`}
                      // The chosen row stays enabled, so focus is not dropped while its answer is awaited.
                      disabled={switching !== null && switching !== workspace.memberId}
                      aria-busy={switching === workspace.memberId || undefined}
                      onClick={() => void switchTo(workspace)}
                      className="flex w-full items-center gap-2.5 rounded-base px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken disabled:opacity-50"
                    >
                      <WorkspaceMark name={workspace.name} initials={initialsOf(workspace.name)} src={workspace.markUrl} />
                      <RowText workspace={workspace} />
                      <span aria-live="polite" className="shrink-0 text-[11px] font-medium text-brand">
                        {switching === workspace.memberId ? "Switching…" : ""}
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-start gap-2.5 rounded-base px-2 py-1.5">
                      <WorkspaceMark name={workspace.name} initials={initialsOf(workspace.name)} src={workspace.markUrl} />
                      <span className="min-w-0 flex-1">
                        <RowText workspace={workspace} />
                        <Unavailable workspace={workspace} />
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {switchError && (
            <p role="alert" className="mx-2 mt-1.5 rounded-base bg-danger-bg px-2.5 py-1.5 text-xs text-danger">
              {switchError}
            </p>
          )}

          <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line px-1 pt-1.5">
            {data?.enabled ? (
              <button
                type="button"
                onClick={addWorkspace}
                className="flex items-center gap-1.5 rounded-base px-1.5 py-1 text-[13px] font-medium text-brand transition-colors hover:bg-surface-sunken"
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Add a workspace
              </button>
            ) : (
              <span />
            )}
            <Link
              href="/profile#linked-workspaces"
              onClick={() => setOpen(false)}
              className="rounded-base px-1.5 py-1 text-[13px] text-muted transition-colors hover:bg-surface-sunken hover:text-text"
            >
              Manage
            </Link>
          </div>
        </div>
      </AnchoredPopover>

      <AddWorkspaceDialog
        open={adding}
        onClose={() => setAdding(false)}
        domain={domain}
        reauth={data?.reauth ?? "password"}
        ssoName={data?.ssoName}
        currentName={here?.name ?? current.name}
      />
    </>
  );
}

/** Name, then where it is and which address the account there has. */
function RowText({ workspace }: { workspace: LinkedWorkspaceView }) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="block truncate text-sm text-text">{workspace.name}</span>
      <span className="block truncate text-[11px] text-subtle">
        {workspace.host} · {workspace.email}
      </span>
    </span>
  );
}

/**
 * Why a row can't be switched into, and a plain link to that workspace's own sign-in where one helps.
 * Same tab: this is going there, not keeping a copy of here (the proxy's `Referrer-Policy: no-referrer`
 * keeps this page's address to itself).
 */
function Unavailable({ workspace }: { workspace: LinkedWorkspaceView }) {
  const linkClass = "font-medium text-brand hover:underline";
  if (workspace.state === "switching-off") {
    return (
      <span className="mt-0.5 block text-[11px] text-muted">
        Switching in is turned off by its administrators.{" "}
        <a href={workspace.loginUrl} className={linkClass}>
          Sign in to {workspace.name}
        </a>
      </span>
    );
  }
  if (workspace.state === "billing-hold") {
    return (
      <span className="mt-0.5 block text-[11px] text-muted">
        On hold for billing.{" "}
        <a href={workspace.loginUrl} className={linkClass}>
          Sign in to pay
        </a>
      </span>
    );
  }
  return <span className="mt-0.5 block text-[11px] text-muted">Unavailable right now.</span>;
}
