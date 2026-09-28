"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { leaveLinkedWorkspaces, switchToWorkspace, unlinkWorkspace, type LinkedWorkspaceView, type MyLinkedWorkspaces } from "@/actions/linked-sign-in";
import { AddWorkspaceDialog } from "@/components/linked/add-workspace-dialog";
import { WorkspaceMark } from "@/components/linked/workspace-mark";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { initialsOf } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

/** For a throw that is not one of the actions' own answers — the network, or the server falling over. */
const FAILED = "That didn't work. Try again.";

type Confirming = { kind: "one"; workspace: LinkedWorkspaceView } | { kind: "all" };

/**
 * Profile → Linked workspaces (spec §2.4): the person's own accounts in other workspaces, this one
 * first — switch into one, unlink one, or take this account out of all of them — and "Add a workspace".
 *
 * `initial` is `myLinkedWorkspaces()` as the page rendered it. Every change is a server action and then
 * `router.refresh()`, so the list is never edited in place: what shows is what the control plane holds.
 *
 * `openWith` is Profile's `?link=`, where "Sign in with Microsoft again" comes back to: the add dialog
 * opens on the first render with the address typed before it — from state, not an effect, so there is
 * no closed frame first. The address is only shown; the action resolves it through the registry.
 */
export function LinkedWorkspacesCard({
  initial,
  domain,
  openWith,
  currentName,
}: {
  initial: MyLinkedWorkspaces;
  /** PLATFORM_DOMAIN, for the add dialog's address field. */
  domain: string;
  openWith: { workspace: string; sso: boolean } | null;
  /** This workspace's registry name, for the add dialog before anything is linked (the list names it after). */
  currentName?: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(() => openWith !== null && initial.enabled);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const here = initial.items.find((w) => w.current) ?? null;
  const others = initial.items.filter((w) => !w.current);
  const hereName = here?.name ?? (currentName?.trim() || "this workspace");
  // In a group at all — even one whose other workspaces have all closed, which still has this account to take out.
  const linked = initial.items.length > 0;

  async function switchTo(workspace: LinkedWorkspaceView) {
    if (switching) return;
    setNotice(null);
    setSwitching(workspace.memberId);
    try {
      const result = await switchToWorkspace(workspace.memberId);
      if (result.ok) {
        // "Switching…" stays up while the browser leaves for the other workspace.
        window.location.assign(result.url);
        return;
      }
      setNotice({ tone: "error", message: result.error });
      // A refusal can be news about that workspace — switched off, on hold — so the list is asked again.
      router.refresh();
    } catch {
      setNotice({ tone: "error", message: FAILED });
    }
    setSwitching(null);
  }

  function ask(what: Confirming) {
    setNotice(null);
    setConfirmError(null);
    setConfirming(what);
  }

  function close() {
    if (!pending) setConfirming(null);
  }

  function unlink() {
    const what = confirming;
    if (!what || pending) return;
    setConfirmError(null);
    startTransition(async () => {
      let result: { ok: true } | { ok: false; error: string };
      try {
        result = what.kind === "one" ? await unlinkWorkspace(what.workspace.memberId) : await leaveLinkedWorkspaces();
      } catch {
        setConfirmError(FAILED);
        return;
      }
      if (!result.ok) {
        setConfirmError(result.error);
        return;
      }
      setConfirming(null);
      // Said out loud: the row it was about is about to disappear.
      setNotice({ tone: "success", message: what.kind === "one" ? `Unlinked ${what.workspace.name}.` : `Unlinked ${hereName} from your linked workspaces.` });
      router.refresh();
    });
  }

  return (
    <div className="text-sm">
      {!initial.enabled && (
        <p className="mb-4 rounded-base border border-line bg-surface-sunken px-3 py-2 text-muted">
          Switching between workspaces is paused. Sign in to each workspace directly.
        </p>
      )}

      {linked ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {initial.items.map((workspace) => (
            <WorkspaceRow
              key={workspace.memberId}
              workspace={workspace}
              canSwitch={initial.enabled}
              switching={switching}
              onSwitch={() => void switchTo(workspace)}
              onUnlink={() => ask({ kind: "one", workspace })}
            />
          ))}
        </ul>
      ) : (
        initial.enabled && (
          <p className="text-muted">
            Link your accounts in other workspaces to switch between them from the header without signing in each time. Each workspace keeps
            its own password, two-factor and rules.
          </p>
        )
      )}

      <ActionNoticeRegion notice={notice} className="mt-3 empty:mt-0" />

      {(initial.enabled || linked) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          {initial.enabled ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={switching !== null}>
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
              Add a workspace
            </Button>
          ) : (
            <span />
          )}
          {linked && (
            <Button type="button" variant="ghost" size="sm" onClick={() => ask({ kind: "all" })} disabled={switching !== null} className="text-danger hover:text-danger">
              Unlink {hereName} from all
            </Button>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-subtle">
        Changing your password or email in any linked workspace unlinks that account — link it again afterwards. So does an administrator switching
        the account off or resetting its two-factor.
      </p>

      {initial.enabled && (
        <AddWorkspaceDialog
          open={adding}
          onClose={() => setAdding(false)}
          domain={domain}
          reauth={initial.reauth}
          initialWorkspace={openWith?.workspace}
          sso={openWith?.sso}
          currentName={hereName}
        />
      )}

      <Dialog
        open={confirming !== null}
        onClose={close}
        title={confirming?.kind === "one" ? `Unlink ${confirming.workspace.name}?` : `Unlink ${hereName} from all?`}
      >
        {confirming && (
          <div className="space-y-4 text-sm">
            <p className="text-muted">
              {confirming.kind === "one"
                ? "You'll need to sign in there to link it again."
                : `Switching into and out of ${hereName} stops, and you'll sign in to each workspace directly until you link them again.${
                    others.length > 1 ? " Your other workspaces stay linked with each other." : ""
                  }`}
            </p>
            {confirmError && (
              <p role="alert" className="rounded-base border border-danger/30 bg-danger-bg px-3 py-2 text-danger">
                {confirmError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" variant="danger" size="sm" onClick={unlink} disabled={pending}>
                {pending ? "Unlinking…" : "Unlink"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** One workspace: its mark, where it is, the account's address there, when it was linked and last switched into. */
function WorkspaceRow({
  workspace,
  canSwitch,
  switching,
  onSwitch,
  onUnlink,
}: {
  workspace: LinkedWorkspaceView;
  /** False while paused: the list still shows, and unlinking still works, but nothing switches. */
  canSwitch: boolean;
  switching: string | null;
  onSwitch: () => void;
  onUnlink: () => void;
}) {
  const chosen = switching === workspace.memberId;
  return (
    <li className="flex flex-wrap items-start gap-3 px-3 py-3 sm:flex-nowrap">
      <WorkspaceMark name={workspace.name} initials={initialsOf(workspace.name)} src={workspace.markUrl} size="md" />
      <div className="min-w-0 flex-1 basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-text">{workspace.name}</span>
          {workspace.current && <Badge tone="brand">This workspace</Badge>}
        </p>
        <p className="truncate text-xs text-subtle">
          {workspace.host} · {workspace.email}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Linked {workspace.linkedAtText}
          {workspace.lastSwitchedInText && ` · Last switched in ${workspace.lastSwitchedInText}`}
        </p>
        {!workspace.current && <Status workspace={workspace} />}
      </div>
      {!workspace.current && (
        <div className="flex shrink-0 items-center gap-1.5">
          <span aria-live="polite" className="sr-only">
            {chosen ? `Switching to ${workspace.name}…` : ""}
          </span>
          {canSwitch && workspace.state === "available" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Switch to ${workspace.name}`}
              // The chosen one stays enabled, so focus is not dropped while its answer is awaited.
              disabled={switching !== null && !chosen}
              aria-busy={chosen || undefined}
              onClick={onSwitch}
            >
              {chosen ? "Switching…" : "Switch"}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" aria-label={`Unlink ${workspace.name}`} disabled={switching !== null} onClick={onUnlink}>
            Unlink
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Why a workspace can't be switched into right now (the switcher's wording, §2.1), with a plain link to
 * its own sign-in where one helps. Nothing for one that is available.
 */
function Status({ workspace }: { workspace: LinkedWorkspaceView }) {
  const linkClass = "font-medium text-brand hover:underline";
  if (workspace.state === "switching-off") {
    return (
      <p className="mt-0.5 text-xs text-muted">
        Switching in is turned off by its administrators.{" "}
        <a href={workspace.loginUrl} className={linkClass}>
          Sign in to {workspace.name}
        </a>
      </p>
    );
  }
  if (workspace.state === "billing-hold") {
    return (
      <p className="mt-0.5 text-xs text-muted">
        On hold for billing.{" "}
        <a href={workspace.loginUrl} className={linkClass}>
          Sign in to pay
        </a>
      </p>
    );
  }
  if (workspace.state === "unavailable") return <p className="mt-0.5 text-xs text-muted">Unavailable right now.</p>;
  return null;
}
