"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { consoleRemovePinKey, consoleSavePinKey, consoleStartSync } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The Reference data page's controls (spec §3.15), for managers only — the page draws them for
 * nobody else. Nothing here deletes reference data: a sync loads a fresh copy, and removing the
 * data.gov.in key only stops the next sync.
 */

const noSubscribe = () => () => {};

const SYNC: Record<"pin" | "world", { title: string; body: string; success: string }> = {
  pin: {
    title: "Sync PIN directory",
    body: "Fetches India Post's directory from data.gov.in and loads it for every workspace's PIN lookups. It takes a few minutes; this page follows its progress.",
    success: "PIN directory sync started.",
  },
  world: {
    title: "Sync world places",
    body: "Downloads the GeoNames files again and reloads the states, cities and postal codes every workspace looks up. It takes several minutes; this page follows its progress.",
    success: "World places sync started.",
  },
};

/**
 * "Sync now" for one dataset (T1). With `disabledReason` the button stays in place, switched off, and
 * the reason is printed beside it ("Save an API key first").
 *
 * It also opens from the address — `?sync=pin` from the command palette — once the page has hydrated
 * (a dialog is drawn into `<body>`, which the server does not have), and drops the param when it
 * closes so a reload does not ask again. A dataset that cannot sync right now does not open: its
 * reason is already on the page.
 */
export function SyncButton({ which, disabledReason }: { which: "pin" | "world"; disabledReason?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<null>();
  const reasonId = useId();
  const copy = SYNC[which];

  const asked = searchParams.get("sync") === which;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  // Opened by the address: adjusted while rendering, so it is open on the first paint after the
  // param arrives rather than one effect later.
  if (asked !== seen) {
    setSeen(asked);
    if (asked && !disabledReason) setOpen(true);
  }

  /** The param that opened the dialog must not open it again; read from the address as it is now. */
  function dropParam() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sync") !== which) return;
    params.delete("sync");
    const query = params.toString();
    router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    dropParam();
  }

  function start() {
    action.run(() => consoleStartSync(which), {
      success: copy.success,
      onDone: () => {
        setOpen(false);
        dropParam();
      },
    });
  }

  if (disabledReason) {
    return (
      <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
        <Button type="button" variant="secondary" size="sm" disabled aria-describedby={reasonId}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          Sync now
        </Button>
        <span id={reasonId} className="text-xs text-muted">
          {disabledReason}
        </span>
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <RefreshCw aria-hidden="true" className="h-4 w-4" />
        Sync now
      </Button>
      <ConfirmDialog
        open={open && isClient}
        onClose={close}
        title={copy.title}
        confirmLabel="Sync now"
        pending={action.pending}
        error={action.error}
        onConfirm={start}
      >
        <p>{copy.body}</p>
      </ConfirmDialog>
    </>
  );
}

/**
 * The data.gov.in key: "Add key…" or "Replace key…" (a dialog with one password field, never
 * filled in — the saved key is sealed and never comes back to a browser), and "Remove key…" (T1).
 */
export function PinKeyButtons({ hasKey }: { hasKey: boolean }) {
  const save = useConsoleAction<null>();
  const remove = useConsoleAction<null>();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  function closeEditor() {
    if (save.pending) return;
    save.reset();
    setEditing(false);
  }

  function closeRemove() {
    if (remove.pending) return;
    remove.reset();
    setRemoving(false);
  }

  return (
    <>
      <Button
        type="button"
        variant={hasKey ? "secondary" : "primary"}
        size="sm"
        onClick={() => {
          save.reset();
          setEditing(true);
        }}
      >
        <KeyRound aria-hidden="true" className="h-4 w-4" />
        {hasKey ? "Replace key…" : "Add key…"}
      </Button>
      {hasKey && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            remove.reset();
            setRemoving(true);
          }}
        >
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          Remove key…
        </Button>
      )}

      <Dialog open={editing} onClose={closeEditor} title={hasKey ? "Replace the data.gov.in key" : "Add a data.gov.in key"}>
        <PinKeyForm replacing={hasKey} action={save} onClose={closeEditor} onSaved={() => setEditing(false)} />
      </Dialog>

      {hasKey && (
        <ConfirmDialog
          open={removing}
          onClose={closeRemove}
          title="Remove the data.gov.in key"
          confirmLabel="Remove key"
          tone="danger"
          pending={remove.pending}
          error={remove.error}
          onConfirm={() => remove.run(() => consoleRemovePinKey(), { success: "data.gov.in key removed.", onDone: () => setRemoving(false) })}
        >
          <p>The PIN directory can&apos;t be synced again until a key is saved. The directory already loaded stays as it is, for every workspace.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The key field. Mounted only while its dialog is open, so it always starts empty and whatever was
 * typed is gone the moment the dialog closes; on success it is cleared before closing as well.
 */
function PinKeyForm({
  replacing,
  action,
  onClose,
  onSaved,
}: {
  replacing: boolean;
  action: ReturnType<typeof useConsoleAction<null>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    // The dialog puts focus on its close button in its own effect, which runs after this one — wait
    // a frame, then put it where the typing starts.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const value = key.trim();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!value || action.pending) return;
    action.run(() => consoleSavePinKey(value), {
      success: replacing ? "data.gov.in key replaced." : "data.gov.in key saved.",
      onDone: () => {
        setKey("");
        onSaved();
      },
    });
  }

  const fieldId = `${id}-key`;
  const hintId = `${id}-hint`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} autoComplete="off" className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        The PIN directory is read from data.gov.in with an API key from your account there.
        {replacing ? " The new key takes the place of the one saved now." : ""}
      </p>

      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>data.gov.in API key</Label>
        {/*
          * new-password rather than off: browsers ignore "off" on a password field and would offer
          * the console's own saved sign-in here.
          */}
        <Input
          ref={inputRef}
          id={fieldId}
          name="data-gov-in-api-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          maxLength={200}
          readOnly={action.pending}
          aria-describedby={hintId}
          className="font-mono"
        />
        <p id={hintId} className="text-xs text-muted">
          Paste it exactly as data.gov.in shows it. It is sealed when saved and never shown again — not even here.
        </p>
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        {/* Inert rather than disabled while pending, so focus stays inside the dialog. */}
        <Button
          type="submit"
          disabled={!value}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
          className={cn(action.pending && "cursor-wait opacity-70")}
        >
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save key
        </Button>
      </div>
    </form>
  );
}
