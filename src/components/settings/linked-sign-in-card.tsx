"use client";

import { useId, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLinkedSwitchIn, unlinkAllMembers, unlinkMemberAccount, type LinkedSignInAdminState } from "@/actions/linked-sign-in-admin";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

/** The switch's own failure line (spec §2.5). */
const SAVE_FAILED = "Couldn't save. Try again.";
/** For a throw that is not one of the actions' own answers — the network, or the server falling over. */
const FAILED = "That didn't work. Try again.";

type Person = LinkedSignInAdminState["people"][number];
type Confirming = { kind: "one"; person: Person } | { kind: "all"; count: number };

const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/**
 * Settings → Security → Linked sign-in (spec §2.5): whether people may switch into this workspace from
 * their linked accounts elsewhere — on until an admin here turns it off (owner decision 1) — and which
 * of this workspace's people are linked, so an admin can unlink them (owner decision 9).
 *
 * Yes or no only. The card is given this workspace's own people and nothing else, and never says which
 * or how many other workspaces an account is linked with.
 *
 * The switch saves the moment it is flipped and shows the new position at once; a failure puts it
 * back and says so.
 */
export function LinkedSignInCard({ state }: { state: LinkedSignInAdminState }) {
  const router = useRouter();
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  // The saved position, or the one just chosen while it is being saved — and the saved one again if that fails.
  const [allow, showAllow] = useOptimistic(state.allowSwitchIn);
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const count = state.people.length;

  function toggle() {
    // Not disabled while saving — a disabled button drops the keyboard's focus — so a second press waits here.
    if (saving) return;
    const next = !allow;
    setSaveError(null);
    startSaving(async () => {
      showAllow(next);
      try {
        const result = await setLinkedSwitchIn(next);
        if (!result.ok) {
          setSaveError(`Couldn't save. ${result.error}`);
          return;
        }
      } catch {
        setSaveError(SAVE_FAILED);
        return;
      }
      router.refresh();
    });
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
      let message: string;
      try {
        if (what.kind === "one") {
          const result = await unlinkMemberAccount(what.person.userId);
          if (!result.ok) {
            setConfirmError(result.error);
            return;
          }
          message = `Unlinked ${what.person.name}. They'll sign in here directly.`;
        } else {
          const result = await unlinkAllMembers();
          if (!result.ok) {
            setConfirmError(result.error);
            return;
          }
          message = result.count > 0 ? `Unlinked ${people(result.count)}.` : "Nobody here was linked any more.";
        }
      } catch {
        setConfirmError(FAILED);
        return;
      }
      setConfirming(null);
      // Said out loud: the rows it was about are about to disappear.
      setNotice({ tone: "success", message });
      router.refresh();
    });
  }

  return (
    <div className="text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id={labelId} className="font-medium text-text">
            Allow switching into this workspace from linked accounts
          </p>
          <p id={helpId} className="mt-0.5 text-muted">
            People who have linked their account here with accounts in other workspaces can switch in without signing in again. This
            workspace&apos;s two-factor, Microsoft sign-in, network, device and lock rules still apply to every switch. Turning this off stops
            switching in; people can still sign in here directly.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allow}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          aria-busy={saving || undefined}
          onClick={toggle}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${allow ? "bg-brand" : "bg-line-strong"}`}
        >
          <span
            aria-hidden="true"
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform ${allow ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>
      {state.updatedAtText && (
        <p className="mt-2 text-xs text-subtle">
          Last changed {state.updatedByName ? `by ${state.updatedByName}, ` : ""}
          {state.updatedAtText}
        </p>
      )}
      <ActionNoticeRegion notice={saveError ? { tone: "error", message: saveError } : null} className="mt-2 empty:mt-0" />

      <div className="mt-5 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-medium text-text">
            Linked accounts here
            <Badge>{count}</Badge>
          </h3>
          {count > 0 && (
            <Button type="button" variant="secondary" size="sm" onClick={() => ask({ kind: "all", count })}>
              Unlink everyone
            </Button>
          )}
        </div>

        {count === 0 ? (
          <p className="mt-2 text-muted">Nobody here has linked their account with another workspace.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">People here who have linked their account with another workspace</caption>
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Email
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Linked since
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Last switched in
                  </th>
                  <th scope="col" className="py-2">
                    <span className="sr-only">Unlink</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.people.map((person) => (
                  <tr key={person.userId} className="border-b border-line last:border-0">
                    <td className="py-2 pr-4 font-medium text-text">{person.name}</td>
                    <td className="break-all py-2 pr-4 text-muted">{person.email}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-muted">{person.linkedAtText}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-muted">{person.lastSwitchedInText ?? "Never"}</td>
                    <td className="py-2 text-right">
                      <Button type="button" variant="ghost" size="sm" aria-label={`Unlink ${person.name}`} onClick={() => ask({ kind: "one", person })}>
                        Unlink
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ActionNoticeRegion notice={notice} className="mt-3 empty:mt-0" />
      </div>

      <Dialog open={confirming !== null} onClose={close} title={confirming?.kind === "one" ? `Unlink ${confirming.person.name}?` : "Unlink everyone?"}>
        {confirming && (
          <div className="space-y-4 text-sm">
            <p className="text-muted">
              {confirming.kind === "one"
                ? "They'll sign in here directly until they link it again."
                : `${confirming.count === 1 ? "1 person here is" : `${confirming.count} people here are`} linked. They'll sign in here directly until they link their accounts again.`}
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
                {pending ? "Unlinking…" : confirming.kind === "one" ? "Unlink" : `Unlink ${people(confirming.count)}`}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
