"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, LoaderCircle, MessageSquareText, Plus } from "lucide-react";
import { consoleCreateInvite } from "@/actions/platform/console";
import { CopyField } from "@/components/console/kit/copy-field";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";
import { MIN_SIGNUP_NAME, PLATFORM_HOSTS, SLUG_PATTERN } from "@/lib/workspace-names";

/**
 * "New invitation" (spec §3.7): the button, and the dialog it opens — who it is for, the plan the new
 * workspace starts on, how many sign-ups it allows and for how long, and — optionally — an address
 * held for that customer: nobody else may take it while the invitation is open, and their signup gets
 * exactly it, without the signup rules. Owners and admins may tick that it may be a reserved word or a
 * blocked name. An invitation that holds an address signs up one workspace. Once made, the code is
 * shown exactly once, with the signup link and a ready-to-send message; nothing is kept on the client
 * after the dialog closes.
 *
 * The dialog also opens from the address — `?new=1`, with `?note=` filled in (the command palette,
 * and the workspace directory's "New invitation" after a search that found nobody). Those params are
 * dropped when it closes, so a reload does not open it again. It opens only after hydration: a
 * dialog is drawn into `<body>`, which the server does not have.
 */

type Created = { code: string; note: string; uses: number; days: number; planName: string | null; heldSlug: string | null };
type Props = { plans: { key: string; name: string }[]; signupUrl: string; workspaceSuffix: string; mayHoldReserved: boolean };

const NOTE_MAX = 200;
const USES = { min: 1, max: 100, start: "1" };
const DAYS = { min: 1, max: 90, start: "14" };

const noSubscribe = () => () => {};

/** Why an address can't be held, as far as the browser can tell (the server checks the rest); null when it may be. */
function heldShapeProblem(slug: string): string | null {
  if (!slug) return null;
  if (!SLUG_PATTERN.test(slug)) return "3–40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.";
  if (PLATFORM_HOSTS.has(slug)) return "One of the platform's own addresses — it can never be a workspace's.";
  return null;
}

/** A whole number within bounds, or null — the field's text as typed, checked before it is sent. */
function wholeIn(text: string, min: number, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= min && n <= max ? n : null;
}

export function NewInviteButton({ plans, signupUrl, workspaceSuffix, mayHoldReserved }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ code: string }>();

  const asked = searchParams.get("new") === "1";
  const askedNote = (searchParams.get("note") ?? "").trim().slice(0, NOTE_MAX);
  const [open, setOpen] = useState(false);
  const [initialNote, setInitialNote] = useState("");
  const [seen, setSeen] = useState(false);
  // Opened by the address: adjusted while rendering, so it is open on the first paint after the
  // params arrive rather than one effect later.
  if (asked !== seen) {
    setSeen(asked);
    if (asked) {
      setInitialNote(askedNote);
      setOpen(true);
    }
  }

  function openFresh() {
    action.reset();
    setInitialNote("");
    setOpen(true);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    // Read from the address as it is now: the params that opened it must not open it again.
    const params = new URLSearchParams(window.location.search);
    if (params.has("new") || params.has("note")) {
      params.delete("new");
      params.delete("note");
      const query = params.toString();
      router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={openFresh}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        New invitation
      </Button>
      <Dialog open={open && isClient} onClose={close} title="New invitation">
        <NewInviteForm plans={plans} signupUrl={signupUrl} workspaceSuffix={workspaceSuffix} mayHoldReserved={mayHoldReserved} initialNote={initialNote} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

/**
 * The form, then the code. Mounted only while the dialog is open, so its fields and the code it
 * showed are gone the moment it closes.
 */
function NewInviteForm({
  plans,
  signupUrl,
  workspaceSuffix,
  mayHoldReserved,
  initialNote,
  action,
  onClose,
}: Props & {
  initialNote: string;
  action: ReturnType<typeof useConsoleAction<{ code: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState(initialNote);
  const [planKey, setPlanKey] = useState("");
  const [uses, setUses] = useState(USES.start);
  const [days, setDays] = useState(DAYS.start);
  const [held, setHeld] = useState("");
  const [heldMayBeReserved, setHeldMayBeReserved] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The dialog puts focus on its first control (the close button) in its own effect, which runs
    // after this one — so wait a frame, then put it where the typing starts.
    const frame = window.requestAnimationFrame(() => noteRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const heldSlug = held.trim().toLowerCase();
  const heldProblem = heldShapeProblem(heldSlug);
  // An invitation that holds an address signs up one workspace: the address can only be had once.
  const usesN = heldSlug ? 1 : wholeIn(uses, USES.min, USES.max);
  const daysN = wholeIn(days, DAYS.min, DAYS.max);
  const ready = usesN !== null && daysN !== null && !heldProblem && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || usesN === null || daysN === null) return;
    const planName = plans.find((p) => p.key === planKey)?.name ?? null;
    const sent = note.trim();
    const hold = heldSlug || null;
    action.run(() => consoleCreateInvite({ note: sent, uses: usesN, days: daysN, planKey: planKey || null, holdSlug: hold, holdSkipsReserved: !!hold && mayHoldReserved && heldMayBeReserved }), {
      success: "Invitation created.",
      onDone: (data) => setCreated({ code: data.code, note: sent, uses: usesN, days: daysN, planName, heldSlug: hold }),
    });
  }

  if (created) return <CreatedInvite created={created} signupUrl={signupUrl} workspaceSuffix={workspaceSuffix} onDone={onClose} />;

  const noteId = `${id}-note`;
  const planId = `${id}-plan`;
  const usesId = `${id}-uses`;
  const usesHint = `${id}-uses-hint`;
  const daysId = `${id}-days`;
  const daysHint = `${id}-days-hint`;
  const heldId = `${id}-held`;
  const heldHint = `${id}-held-hint`;
  const reservedId = `${id}-held-reserved`;

  return (
    // p-0.5: the dialog body scrolls, and a scroll box clips the focus ring of a field at its edge.
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={noteId}>For</Label>
        <Input
          id={noteId}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Acme Pvt Ltd — Priya"
          autoComplete="off"
          readOnly={action.pending}
          ref={noteRef}
        />
        <p className="text-xs text-muted">Who it is for — it names the invitation in this list.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={planId}>Plan</Label>
        <Select id={planId} value={planKey} onChange={(e) => setPlanKey(e.target.value)} disabled={action.pending}>
          <option value="">Default plan</option>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">The plan a workspace made with this code starts its trial on.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={heldId}>Hold an address for this customer (optional)</Label>
        <div className="flex items-center rounded-base border border-line-strong bg-surface pr-3 text-sm shadow-sm">
          <Input
            id={heldId}
            value={held}
            maxLength={40}
            onChange={(e) => setHeld(e.target.value)}
            placeholder="acme"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="border-0 bg-transparent font-mono shadow-none"
            aria-invalid={heldProblem ? true : undefined}
            aria-describedby={heldHint}
            readOnly={action.pending}
          />
          <span className="whitespace-nowrap text-muted">{workspaceSuffix}</span>
        </div>
        <p id={heldHint} className={cn("text-xs", heldProblem ? "text-danger" : "text-muted")}>
          {heldProblem ??
            (heldSlug
              ? `Nobody else may take it while this invitation is open. Their signup gets exactly it — without the ${MIN_SIGNUP_NAME}-letter and registered-name rules.`
              : "Leave it empty to let them choose, under the signup rules.")}
        </p>
        {mayHoldReserved && heldSlug && (
          <div className="flex items-start gap-2.5 pt-1">
            <Checkbox id={reservedId} checked={heldMayBeReserved} onChange={(e) => setHeldMayBeReserved(e.target.checked)} disabled={action.pending} className="mt-0.5 shrink-0" />
            <label htmlFor={reservedId} className="cursor-pointer text-sm text-text">
              It may be a reserved word or a blocked name
              <span className="block text-xs text-muted">Never one of the platform&apos;s own addresses, or one a workspace has.</span>
            </label>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={usesId}>Uses</Label>
          <Input
            id={usesId}
            type="number"
            inputMode="numeric"
            min={USES.min}
            max={USES.max}
            step={1}
            value={heldSlug ? "1" : uses}
            onChange={(e) => setUses(e.target.value)}
            aria-invalid={usesN === null || undefined}
            aria-describedby={usesHint}
            readOnly={action.pending || !!heldSlug}
          />
          <p id={usesHint} className={cn("text-xs", usesN === null ? "text-danger" : "text-muted")}>
            {heldSlug
              ? "One workspace: the address it holds can only be had once."
              : usesN === null
                ? `A whole number from ${USES.min} to ${USES.max}.`
                : `Signs up ${plural(usesN, "workspace")}.`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={daysId}>Valid for (days)</Label>
          <Input
            id={daysId}
            type="number"
            inputMode="numeric"
            min={DAYS.min}
            max={DAYS.max}
            step={1}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-invalid={daysN === null || undefined}
            aria-describedby={daysHint}
            readOnly={action.pending}
          />
          <p id={daysHint} className={cn("text-xs", daysN === null ? "text-danger" : "text-muted")}>
            {daysN === null ? `A whole number from ${DAYS.min} to ${DAYS.max}.` : `Stops working ${plural(daysN, "day")} from now.`}
          </p>
        </div>
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Create invitation
        </Button>
      </div>
    </form>
  );
}

/**
 * The one time the code is shown: the code, the signup link, and a message with both, ready to paste.
 * An invitation that holds an address says so, and its link carries the code (`?invite=`), so the
 * signup form opens with the address filled in and locked.
 */
function CreatedInvite({ created, signupUrl, workspaceSuffix, onDone }: { created: Created; signupUrl: string; workspaceSuffix: string; onDone: () => void }) {
  const link = created.heldSlug ? `${signupUrl}?invite=${encodeURIComponent(created.code)}` : signupUrl;
  const message = [
    `You're invited to set up a workspace${created.planName ? ` on the ${created.planName} plan` : ""}.`,
    ...(created.heldSlug ? [`Your address is set up for you: ${created.heldSlug}${workspaceSuffix}`] : []),
    `Sign up at ${link} and enter this invitation code: ${created.code}`,
    `The code works for ${plural(created.days, "day")}${created.uses > 1 ? ` and for up to ${plural(created.uses, "workspace")}` : ""}.`,
  ].join("\n");

  return (
    <div className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        {created.note ? (
          <>
            The invitation for <strong className="font-medium">{created.note}</strong> is ready.
          </>
        ) : (
          "The invitation is ready."
        )}{" "}
        Send them the code and the signup link — or copy the whole message.
        {created.heldSlug && (
          <>
            {" "}
            It holds <span className="font-mono">{created.heldSlug}</span> for them.
          </>
        )}
      </p>
      <OnceSecret
        label="Invitation code"
        value={created.code}
        copyLabel="Copy invitation code"
        onDone={onDone}
        extra={
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted">Signup link</p>
              <CopyField value={link} label="signup link" />
            </div>
            <CopyMessageButton text={message} />
          </div>
        }
      />
    </div>
  );
}

/** Copies the whole message — link and code — in the click itself, where the browser allows it. */
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
        {state === "copied" ? "Invitation message copied" : state === "failed" ? "Couldn't copy — copy the code and the link above instead" : ""}
      </span>
      {state === "failed" && <p className="text-xs text-danger">Couldn&apos;t copy — copy the code and the link above instead.</p>}
    </div>
  );
}
