"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Ban, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { consoleApproveStatement, consoleMarkStatementPaid, consoleVoidStatement } from "@/actions/platform/console-commissions";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatMoney } from "@/lib/billing/money";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";
import { TAX_NOTE, bpText, minorDigits, percentToBp, rateAmount, toMinor } from "./format";

/**
 * A statement's money actions, for PAYERS only (OWNER, BILLING; spec §6.2–§6.4): approve it with
 * its tax lines, record its payment, void it. The page draws them only for those roles and the
 * server refuses everybody else. Each lives in a dialog; the outcome goes to the page notice.
 */

/** What the dialogs need of a statement. */
export type StatementTarget = {
  id: string;
  number: string;
  partner: string;
  currency: string;
  total: number;
  netPayable: number;
};

const noSubscribe = () => () => {};
const useIsClient = () => useSyncExternalStore(noSubscribe, () => true, () => false);

/** A disabled button with its reason beside it — a control that vanishes teaches nobody why. */
function Blocked({ label, reason }: { label: string; reason: string }) {
  const id = useId();
  return (
    <span className="inline-flex max-w-72 flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal">
      <Button type="button" variant="primary" size="sm" disabled aria-describedby={id}>
        {label}
      </Button>
      <span id={id} className="text-[11px] leading-4 text-muted">
        {reason}
      </span>
    </span>
  );
}

function FormButtons({ pending, ready, label, onCancel }: { pending: boolean; ready: boolean; label: string; onCancel: () => void }) {
  return (
    <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button type="submit" disabled={!ready} aria-busy={pending || undefined}>
        {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
        {label}
      </Button>
    </div>
  );
}

// ─── Approve ─────────────────────────────────────────────────────────────────────────────────────

type LineDraft = { key: number; label: string; kind: "ADD" | "WITHHOLD"; rate: string; amount: string };
type LineWorked = { ok: boolean; problem: string | null; rateBp: number | null; minor: number | null; amount: number };

const MAX_LINES = 6;

/** One tax line as the engine will price it: its amount, or its rate of the total (floored). */
function workLine(line: LineDraft, total: number, currency: string): LineWorked {
  const label = line.label.trim();
  const rateText = line.rate.trim();
  const amountText = line.amount.trim();
  const rateBp = rateText ? percentToBp(rateText) : null;
  const minor = amountText ? toMinor(amountText, currency) : null;
  let problem: string | null = null;
  if (label.length < 2 || label.length > 60) problem = "Give it a label of 2 to 60 characters.";
  else if (rateText && rateBp === null) problem = "The rate is a percentage from 0 to 100, with at most two decimals.";
  else if (amountText && minor === null) problem = `The amount is in ${currency}, zero or more, with at most ${minorDigits(currency)} decimal places.`;
  else if (!rateText && !amountText) problem = "Give a rate or an amount.";
  const amount = minor ?? (rateBp !== null ? rateAmount(total, rateBp) : 0);
  return { ok: problem === null, problem, rateBp, minor, amount };
}

/** "Approve" a DRAFT with its tax lines. `blockedReason` (no payout details on file) keeps it, switched off, with the reason. */
export function ApproveStatementButton({ statement, blockedReason }: { statement: StatementTarget; blockedReason?: string | null }) {
  const isClient = useIsClient();
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<{ number: string; total: number; netPayable: number }>();
  if (blockedReason) return <Blocked label="Approve" reason={blockedReason} />;
  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }
  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        Approve
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Approve statement ${statement.number}`} wide>
        <ApproveForm statement={statement} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function ApproveForm({
  statement,
  action,
  onClose,
}: {
  statement: StatementTarget;
  action: ReturnType<typeof useConsoleAction<{ number: string; total: number; netPayable: number }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [lines, setLines] = useState<LineDraft[]>([]);
  const nextKey = useRef(1);
  const { currency, total } = statement;
  const worked = lines.map((line) => workLine(line, total, currency));
  const net = worked.reduce((sum, w, i) => (lines[i]!.kind === "ADD" ? sum + w.amount : sum - w.amount), total);
  const ready = worked.every((w) => w.ok) && net > 0 && !action.pending;

  function change(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function add() {
    if (lines.length >= MAX_LINES) return;
    const key = nextKey.current++;
    setLines((prev) => [...prev, { key, label: "", kind: "WITHHOLD", rate: "", amount: "" }]);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const taxLines = lines.map((line, i) => ({
      label: line.label.trim(),
      kind: line.kind,
      rate: line.rate.trim() || null,
      amount: worked[i]!.minor,
    }));
    action.run(() => consoleApproveStatement(statement.id, { taxLines }), {
      success: (d) => `Statement ${d.number} approved — ${formatMoney(d.netPayable, currency)} to pay. The partner has been emailed.`,
      onDone: onClose,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-text">
        {`Approving shows the statement to ${statement.partner} with its tax lines and net payable, and emails their admin and finance users. Its entries become approved; nothing more can be added to it.`}
      </p>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-text">Tax lines</h3>
          <Button type="button" variant="secondary" size="sm" onClick={add} disabled={lines.length >= MAX_LINES || action.pending}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add a tax line
          </Button>
        </div>
        {lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">No tax lines — the partner is paid the commission total. Add TDS withheld, or GST added, as your accountant says.</p>
        ) : (
          <ul className="space-y-3">
            {lines.map((line, i) => {
              const w = worked[i]!;
              const base = `${id}-line-${line.key}`;
              return (
                <li key={line.key} className="rounded-lg border border-line bg-surface-sunken px-3 py-3">
                  <div className="grid gap-3 sm:grid-cols-[1fr_11rem_7rem_9rem_auto] sm:items-end">
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-label`}>Label</Label>
                      <Input id={`${base}-label`} value={line.label} maxLength={60} onChange={(e) => change(line.key, { label: e.target.value })} placeholder="TDS (194H)" autoComplete="off" readOnly={action.pending} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-kind`}>Effect</Label>
                      <Select id={`${base}-kind`} value={line.kind} onChange={(e) => change(line.key, { kind: e.target.value === "ADD" ? "ADD" : "WITHHOLD" })} disabled={action.pending}>
                        <option value="WITHHOLD">Withheld from it</option>
                        <option value="ADD">Added to it</option>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-rate`}>Rate %</Label>
                      <Input id={`${base}-rate`} inputMode="decimal" value={line.rate} maxLength={8} onChange={(e) => change(line.key, { rate: e.target.value })} placeholder="5" autoComplete="off" readOnly={action.pending} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${base}-amount`}>{`Amount (${currency})`}</Label>
                      <Input id={`${base}-amount`} inputMode="decimal" value={line.amount} maxLength={20} onChange={(e) => change(line.key, { amount: e.target.value })} placeholder="From the rate" autoComplete="off" readOnly={action.pending} />
                    </div>
                    <IconButton icon={Trash2} label={`Remove tax line ${i + 1}`} tone="danger" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))} disabled={action.pending} />
                  </div>
                  <p className={cn("mt-2 text-xs", w.ok ? "text-muted" : "text-danger")}>
                    {w.ok
                      ? `${line.kind === "ADD" ? "Adds" : "Withholds"} ${formatMoney(w.amount, currency)}${w.minor === null && w.rateBp !== null ? ` (${bpText(w.rateBp)} of the total, rounded down)` : ""}.`
                      : w.problem}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ImpactList
        items={[
          { label: "Commission (total)", value: formatMoney(total, currency) },
          ...lines.map((line, i) => ({
            label: `${line.label.trim() || `Tax line ${i + 1}`} (${line.kind === "ADD" ? "added" : "withheld"})`,
            value: `${line.kind === "ADD" ? "+" : "−"}${formatMoney(worked[i]!.amount, currency)}`,
          })),
          { label: "Net payable", value: formatMoney(net, currency), tone: net > 0 ? undefined : ("danger" as const) },
        ]}
      />
      {net <= 0 && <p className="text-xs text-danger">The net payable must be more than zero.</p>}
      <p className="rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-xs text-info">{TAX_NOTE}</p>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <FormButtons pending={action.pending} ready={ready} label="Approve statement" onCancel={onClose} />
    </form>
  );
}

// ─── Mark paid ───────────────────────────────────────────────────────────────────────────────────

const REFERENCE = { min: 3, max: 120 };
const NOTE_MAX = 500;

/**
 * "Mark paid": records a transfer made outside the platform — its reference and the IST day it went.
 * `blockedReason` keeps the button, switched off, with the reason printed (owner decision O4: with
 * the two-person rule on, whoever approved a statement does not also record its payment).
 */
export function MarkPaidButton({
  statement,
  approvedDayKey,
  todayKey,
  blockedReason,
}: {
  statement: StatementTarget;
  /** The IST day it was approved: payment can't be recorded before it. */
  approvedDayKey: string | null;
  todayKey: string;
  blockedReason?: string | null;
}) {
  const isClient = useIsClient();
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<{ number: string; paidOn: string }>();
  if (blockedReason) return <Blocked label="Mark paid" reason={blockedReason} />;
  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }
  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        Mark paid
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Record the payment of ${statement.number}`}>
        <MarkPaidForm statement={statement} approvedDayKey={approvedDayKey} todayKey={todayKey} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function MarkPaidForm({
  statement,
  approvedDayKey,
  todayKey,
  action,
  onClose,
}: {
  statement: StatementTarget;
  approvedDayKey: string | null;
  todayKey: string;
  action: ReturnType<typeof useConsoleAction<{ number: string; paidOn: string }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(todayKey);
  const [note, setNote] = useState("");
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => firstRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const referenceOk = reference.trim().length >= REFERENCE.min && reference.trim().length <= REFERENCE.max;
  const dayShape = /^\d{4}-\d{2}-\d{2}$/.test(paidOn);
  const dayProblem = !dayShape
    ? "Give the day it was paid."
    : paidOn > todayKey
      ? "It can't be in the future."
      : approvedDayKey && paidOn < approvedDayKey
        ? `It can't be before the day it was approved (${dayKeyLabel(approvedDayKey)}).`
        : null;
  const ready = referenceOk && dayProblem === null && note.length <= NOTE_MAX && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleMarkStatementPaid(statement.id, { reference: reference.trim(), paidOn, note: note.trim() || null }), {
      success: (d) => `Statement ${d.number} marked paid on ${dayKeyLabel(d.paidOn)}. The partner has been emailed the reference.`,
      onDone: onClose,
    });
  }

  const refId = `${id}-reference`;
  const refHint = `${id}-reference-hint`;
  const dayId = `${id}-day`;
  const dayHint = `${id}-day-hint`;
  const noteId = `${id}-note`;

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-text">
        {`Records a bank transfer you have made to ${statement.partner}. Its entries become paid, and the partner's admin and finance users are emailed the reference. A paid statement is final.`}
      </p>
      <ImpactList items={[{ label: "Net payable", value: formatMoney(statement.netPayable, statement.currency) }]} />
      <div className="space-y-1.5">
        <Label htmlFor={refId}>Payment reference</Label>
        <Input
          id={refId}
          ref={firstRef}
          value={reference}
          maxLength={REFERENCE.max}
          onChange={(e) => setReference(e.target.value)}
          placeholder="UTR or transfer reference"
          autoComplete="off"
          aria-describedby={refHint}
          aria-required="true"
          readOnly={action.pending}
        />
        <p id={refHint} className="text-xs text-muted">{`${REFERENCE.min} to ${REFERENCE.max} characters. The partner sees it.`}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={dayId}>Paid on</Label>
        <Input
          id={dayId}
          type="date"
          value={paidOn}
          min={approvedDayKey ?? undefined}
          max={todayKey}
          onChange={(e) => setPaidOn(e.target.value)}
          aria-invalid={dayProblem !== null || undefined}
          aria-describedby={dayHint}
          readOnly={action.pending}
          className="w-48"
        />
        <p id={dayHint} className={cn("text-xs", dayProblem ? "text-danger" : "text-muted")}>
          {dayProblem ?? "The day on India's calendar."}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Textarea id={noteId} value={note} maxLength={NOTE_MAX} rows={2} onChange={(e) => setNote(e.target.value)} readOnly={action.pending} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <FormButtons pending={action.pending} ready={ready} label="Mark paid" onCancel={onClose} />
    </form>
  );
}

// ─── Void ────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Void" a DRAFT (tier 2: a reason) or an APPROVED statement (tier 3: the reason and its number
 * typed — the partner has seen it). Its entries go back to pending for the next statement. A PAID
 * statement is final and gets no button.
 */
export function VoidStatementButton({ statement, approved }: { statement: StatementTarget; approved: boolean }) {
  const [open, setOpen] = useState(false);
  const action = useConsoleAction<{ number: string; entries: number }>();
  return (
    <>
      <IconButton
        icon={Ban}
        label={`Void statement ${statement.number}`}
        tone="danger"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      />
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          action.reset();
        }}
        title={`Void statement ${statement.number}`}
        confirmLabel="Void statement"
        tone="danger"
        typed={approved ? statement.number : undefined}
        reason={{ label: "Reason", minLength: 3, maxLength: 500, placeholder: "Generated before a late refund was recorded" }}
        pending={action.pending}
        error={action.error}
        onConfirm={({ reason }) =>
          action.run(() => consoleVoidStatement(statement.id, reason), {
            success: (d) => `Statement ${d.number} voided — ${plural(d.entries, "entry", "entries")} back to pending for the next statement.`,
            onDone: () => setOpen(false),
          })
        }
      >
        <p>
          {approved
            ? `${statement.partner} has seen this statement. Its entries go back to pending and roll into the next statement, and the partner sees that this one was voided.`
            : "Its entries go back to pending and roll into the next statement. The partner never saw this draft."}
        </p>
        <ImpactList
          items={[
            { label: "Partner", value: statement.partner },
            { label: "Commission (total)", value: formatMoney(statement.total, statement.currency) },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}
