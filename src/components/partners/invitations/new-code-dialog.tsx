"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, MessageSquareText, Ticket } from "lucide-react";
import { partnerCreateInvite } from "@/actions/partners/invitations";
import { CopyField } from "@/components/console/kit/copy-field";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";

/**
 * "New invitation code": who it is for, the plan a workspace made with it starts on, how many
 * workspaces it may make and for how many days. Once made, the code is shown here exactly once — with
 * a copy button and the signup address to send with it — and never again: the portal keeps only its
 * hash and its last four characters. Nothing is kept on the client once the dialog closes.
 *
 * Rendered only for a role that may make codes while the partner account is active; the server
 * refuses anybody else anyway.
 */

type Created = { code: string; codeHint: string; note: string; uses: number; days: number; planName: string | null };
type CreateAction = ReturnType<typeof useConsoleAction<{ code: string; codeHint: string }>>;

const NOTE_MAX = 200;
const USES = { min: 1, max: 100, start: "1" };
const DAYS = { min: 1, max: 90, start: "14" };

/** A whole number within bounds, or null — the field's text as typed, checked before it is sent. */
function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

export function NewInviteCodeButton({ plans, signupUrl }: { plans: { key: string; name: string }[]; signupUrl: string }) {
  const action = useConsoleAction<{ code: string; codeHint: string }>();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    setCreated(null);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          action.reset();
          setCreated(null);
          setOpen(true);
        }}
      >
        <Ticket aria-hidden="true" className="h-4 w-4" />
        New invitation code
      </Button>
      <Dialog open={open} onClose={close} title={created ? "Your invitation code" : "New invitation code"}>
        {created ? <CreatedCode created={created} signupUrl={signupUrl} onDone={close} /> : <NewCodeForm plans={plans} action={action} onCreated={setCreated} onCancel={close} />}
      </Dialog>
    </>
  );
}

function NewCodeForm({
  plans,
  action,
  onCreated,
  onCancel,
}: {
  plans: { key: string; name: string }[];
  action: CreateAction;
  onCreated: (created: Created) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const noteRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [uses, setUses] = useState(USES.start);
  const [days, setDays] = useState(DAYS.start);

  useEffect(() => {
    // The dialog focuses its close button in its own effect, which runs after this one — wait a frame.
    const frame = window.requestAnimationFrame(() => noteRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanNote = note.trim();
  const noteOk = cleanNote.length <= NOTE_MAX;
  const usesN = wholeIn(uses, USES.min, USES.max);
  const daysN = wholeIn(days, DAYS.min, DAYS.max);
  const ready = noteOk && usesN !== null && daysN !== null;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || usesN === null || daysN === null || action.pending) return;
    const planName = plans.find((p) => p.key === planKey)?.name ?? null;
    action.run(() => partnerCreateInvite({ note: cleanNote || null, uses: usesN, days: daysN, planKey: planKey || null }), {
      success: "Invitation code created.",
      onDone: (data) => onCreated({ code: data.code, codeHint: data.codeHint, note: cleanNote, uses: usesN, days: daysN, planName }),
    });
  }

  const planId = `${id}-plan`;
  const planHint = `${id}-plan-hint`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">
        A company signs up with the code, and the workspace it makes is credited to you. The code is shown once, when you make it — copy it then.
      </p>
      <TextField
        inputRef={noteRef}
        label="For"
        value={note}
        onChange={setNote}
        max={NOTE_MAX}
        placeholder="Acme Traders — Priya"
        readOnly={action.pending}
        hint="Who it's for, so you can tell it apart in your list. Optional."
        error={noteOk ? null : `Keep it to ${NOTE_MAX} characters.`}
      />
      <div className="space-y-1.5">
        <Label htmlFor={planId}>Plan</Label>
        <Select id={planId} value={planKey} onChange={(e) => setPlanKey(e.target.value)} disabled={action.pending} aria-describedby={planHint}>
          <option value="">Default plan</option>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
        <p id={planHint} className="text-xs text-muted">
          The plan a workspace made with this code starts its trial on. Optional.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Uses"
          value={uses}
          onChange={setUses}
          inputMode="numeric"
          required
          readOnly={action.pending}
          hint={usesN === null ? undefined : `Makes up to ${plural(usesN, "workspace")}.`}
          error={usesN === null ? `A whole number from ${USES.min} to ${USES.max}.` : null}
        />
        <TextField
          label="Valid for (days)"
          value={days}
          onChange={setDays}
          inputMode="numeric"
          required
          readOnly={action.pending}
          hint={daysN === null ? undefined : `Stops working ${plural(daysN, "day")} from now.`}
          error={daysN === null ? `A whole number from ${DAYS.min} to ${DAYS.max}.` : null}
        />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Create code
        </Button>
      </div>
    </form>
  );
}

/** The one time the code is shown: the code, the signup address, and a message with both, ready to paste. */
function CreatedCode({ created, signupUrl, onDone }: { created: Created; signupUrl: string; onDone: () => void }) {
  const message = [
    `You're invited to set up a workspace${created.planName ? ` on the ${created.planName} plan` : ""}.`,
    `Sign up at ${signupUrl} and enter this invitation code: ${created.code}`,
    `The code works for ${plural(created.days, "day")}${created.uses > 1 ? ` and for up to ${plural(created.uses, "workspace")}` : ""}.`,
  ].join("\n");

  return (
    <div className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        {created.note ? (
          <>
            The code for <strong className="font-medium">{created.note}</strong> is ready.
          </>
        ) : (
          "The code is ready."
        )}{" "}
        Send it with the signup address below.
      </p>
      <OnceSecret
        label="Invitation code"
        value={created.code}
        copyLabel="Copy invitation code"
        note={`This code won't be shown again — copy it now. Your list keeps only its last four characters (…${created.codeHint}).`}
        onDone={onDone}
        extra={
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">Signup address to send with it</p>
              <CopyField value={signupUrl} label="signup address" />
            </div>
            <CopyMessageButton text={message} />
          </div>
        }
      />
    </div>
  );
}

/** Copies the whole message — address and code — in the click itself, where the browser allows it. */
function CopyMessageButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="space-y-1">
      <Button type="button" variant="secondary" size="sm" onClick={copy}>
        {state === "copied" ? <Check aria-hidden="true" className="h-4 w-4 text-success" /> : <MessageSquareText aria-hidden="true" className="h-4 w-4" />}
        {state === "copied" ? "Copied" : "Copy invitation message"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Invitation message copied" : state === "failed" ? "Couldn't copy — copy the code and the address above instead" : ""}
      </span>
      {state === "failed" && <p className="text-xs text-danger">Couldn&apos;t copy — copy the code and the address above instead.</p>}
    </div>
  );
}
