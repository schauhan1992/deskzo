"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CircleCheck } from "lucide-react";
import { consoleDeprovision } from "@/actions/platform/console";
import { ConfirmBody } from "@/components/console/kit/confirm-dialog";
import { CopyButton } from "@/components/console/kit/copy-field";
import { ImpactList } from "@/components/console/kit/impact";
import { InsetBlock } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * Closing a workspace for good (T3, owners only): the operator types its address, and the server
 * checks that word again before it takes a final backup, drops the database and lets its domains
 * and terminals go. The same dialog then shows the final backup's file name — the one thing worth
 * writing down — and the page refreshes only on "Done", so the answer is not swept away by the page
 * redrawing as closed underneath it.
 */

type Closed = { backup: string | null };

export function CloseWorkspaceButton({ tenant }: { tenant: { id: string; slug: string; name: string } }) {
  const router = useRouter();
  const { pending, error, run, reset } = useConsoleAction<Closed>();
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState<Closed | null>(null);

  const focusDone = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);

  function start() {
    reset();
    setClosed(null);
    setOpen(true);
  }

  function dismiss() {
    if (pending) return;
    setOpen(false);
    reset();
    if (closed) {
      setClosed(null);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={start} className="border-danger/40 text-danger hover:bg-danger-bg">
        <Archive aria-hidden="true" className="h-4 w-4" />
        Close workspace…
      </Button>
      <Dialog open={open} onClose={dismiss} title={closed ? "Workspace closed" : "Close workspace"}>
        {closed ? (
          <div className="space-y-4 text-sm text-text">
            <p className="flex items-start gap-2">
              <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>{`${tenant.name} is closed. Its database is dropped and its domains and terminals are let go.`}</span>
            </p>
            {closed.backup ? (
              <InsetBlock className="space-y-1">
                <p className="text-xs text-muted">Final backup</p>
                <div className="flex items-center gap-1">
                  <span className="min-w-0 font-mono text-xs break-all text-text">{closed.backup}</span>
                  <CopyButton value={closed.backup} label="Copy backup file name" />
                </div>
              </InsetBlock>
            ) : (
              <p className="text-muted">No final backup was taken — it had no database of its own.</p>
            )}
            <p className="text-xs text-muted">Its keys are kept for 90 days, so the backup can still be read; after that it can be purged on the server.</p>
            <div className="flex justify-end">
              <Button ref={focusDone} type="button" onClick={dismiss}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <ConfirmBody
            confirmLabel="Close workspace"
            tone="danger"
            typed={tenant.slug}
            pending={pending}
            error={error}
            onCancel={dismiss}
            onConfirm={({ typed }) =>
              run(() => consoleDeprovision(tenant.id, typed), {
                refresh: false,
                success: `${tenant.name} is closed.`,
                onDone: (data) => setClosed({ backup: data?.backup ?? null }),
              })
            }
          >
            <p>Takes a final backup, drops its database and removes its domains and terminals. Keys are kept 90 days, then it can be purged on the server.</p>
            <ImpactList
              items={[
                { label: "Its people", value: "Locked out for good", tone: "danger" },
                { label: "Its database", value: "Backed up, then dropped", tone: "danger" },
                { label: "Domains and terminals", value: "Let go" },
                { label: "Undo", value: "Not possible" },
              ]}
            />
          </ConfirmBody>
        )}
      </Dialog>
    </>
  );
}
