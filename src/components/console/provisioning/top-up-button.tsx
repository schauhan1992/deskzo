"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PackagePlus } from "lucide-react";
import { consoleTopUpWarmPool } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";

/**
 * "Top up warm pool" (spec §3.12, T1): starts the platform worker, which fills the warm pool to its
 * target and takes any setups waiting in the queue. The page renders it for managers only; the action
 * checks the role again.
 *
 * It also opens from the address — `?topup=1`, the command palette's "Top up warm pool" — and drops
 * that param when it closes, so a reload does not ask again. The dialog is drawn into `<body>`, which
 * the server does not have, so it opens only after hydration.
 */

const noSubscribe = () => () => {};

export function TopUpButton({ target }: { target: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<null>();

  const asked = searchParams.get("topup") === "1";
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  // Opened by the address: adjusted while rendering, so it is open on the first paint after the
  // param arrives — and again if the palette asks a second time on this page.
  if (asked !== seen) {
    setSeen(asked);
    if (asked) setOpen(true);
  }

  /** Read from the address as it is now: the param that opened the dialog must not open it again. */
  function dropParam() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("topup")) return;
    params.delete("topup");
    const query = params.toString();
    router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    dropParam();
  }

  function confirm() {
    action.run(() => consoleTopUpWarmPool(), {
      success: "The worker has been started — it fills the warm pool and takes any waiting setups.",
      onDone: () => {
        setOpen(false);
        dropParam();
      },
    });
  }

  const body =
    target > 0
      ? `Starts the worker to fill the pool to ${plural(target, "ready database")} and take waiting jobs.`
      : "The warm pool is off, so this starts the worker only to take waiting jobs.";

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <PackagePlus aria-hidden="true" className="h-4 w-4" />
        Top up warm pool
      </Button>
      <ConfirmDialog
        open={open && isClient}
        onClose={close}
        title="Top up warm pool"
        confirmLabel="Top up"
        pending={action.pending}
        error={action.error}
        onConfirm={confirm}
      >
        <p>{body}</p>
        <p className="text-xs text-muted">Safe to press more than once: each setup goes to exactly one worker, and the pool is filled under a lease, so nothing is made twice. The worker stops when there is nothing left to do.</p>
      </ConfirmDialog>
    </>
  );
}
