"use client";

import { useId, useState, type ReactNode } from "react";
import { CalendarClock, Gift, PencilLine, RefreshCw, Unlink } from "lucide-react";
import { consoleGiveTrialPlans, consoleSetTrialEnd } from "@/actions/platform/console";
import { consoleResyncSubscription } from "@/actions/platform/console-billing";
import { consoleExtendTrial } from "@/actions/platform/console-directory";
import { consoleEndManualPlan, consoleSetBillingDetails } from "@/actions/platform/console-workspace";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label } from "@/components/ui/input";
import { dayKeyLabel, dayMonthYear, istDayKey, istDaysBetween, plural } from "@/lib/console-shared/format";
import { SUBSCRIPTION_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import { istDateParts, istMidnight } from "@/lib/india-time";
import type { BillingPanel } from "@/lib/platform/workspace-data";

/**
 * The Billing tab's own controls: the trial (extend, set a date, keep its plan free), the billing
 * profile, the "exempt while paying" remedy, and reading a gateway subscription back. Every one of
 * them asks first and says what it will do; the server works out anything that depends on the
 * clock and the page refreshes from what it did.
 */

const DAY = 86_400_000;
const EXTEND_DAYS = [7, 14, 30] as const;
type ExtendDays = (typeof EXTEND_DAYS)[number];

const asDate = (at: Date | string) => (at instanceof Date ? at : new Date(at));

/** The last second, India time, of the day `days` after `base` — as the server extends a trial (src/lib/platform/bulk.ts). */
function trialEndAfter(base: Date, days: number): Date {
  const { year, month, day } = istDateParts(new Date(base.getTime() + days * DAY));
  return new Date(istMidnight(year, month, day + 1).getTime() - 1000);
}

/** "today", "in 5 days", "3 days ago" — counted in India's days from the page's own clock. */
function dayDistance(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${plural(days, "day")}` : `${plural(-days, "day")} ago`;
}

// ─── Trial ───────────────────────────────────────────────────────────────────────────────────────

type TrialMode = { kind: "extend"; days: ExtendDays } | { kind: "date" } | { kind: "give" } | null;

/**
 * Its trial — running, or ended and reopenable. Extending counts from the later of now and its end,
 * on the server; a new end date is the end of that day in India. Managers can instead keep its
 * trial's plans with no end (a pilot, a partner).
 */
export function TrialCard({ tenantId, trial, caps, asOf }: { tenantId: string; trial: NonNullable<BillingPanel["trial"]>; caps: Caps; asOf: Date }) {
  const [mode, setMode] = useState<TrialMode>(null);
  const [dateText, setDateText] = useState("");
  const extend = useConsoleAction<{ endsAt: string; action: "none" | "held" | "lifted" | "closed" }>();
  const plain = useConsoleAction<null>();
  const dateId = useId();
  const dateHintId = useId();

  const now = asDate(asOf);
  const ends = trial.endsAt ? asDate(trial.endsAt) : null;
  const days = ends ? istDaysBetween(now, ends) : null;
  const running = trial.status === "TRIALING";
  const over = !running || (days !== null && days < 0);
  const todayKey = istDayKey(now);
  const pending = extend.pending || plain.pending;
  const error = mode?.kind === "extend" ? extend.error : plain.error;

  function open(next: NonNullable<TrialMode>) {
    extend.reset();
    plain.reset();
    if (next.kind === "date") setDateText(ends && days !== null && days >= 0 ? istDayKey(ends) : todayKey);
    setMode(next);
  }

  function close() {
    setMode(null);
    extend.reset();
    plain.reset();
  }

  const done = () => setMode(null);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dateText) && dateText >= todayKey;

  function confirm() {
    if (!mode) return;
    if (mode.kind === "extend") {
      extend.run(() => consoleExtendTrial(tenantId, mode.days), {
        success: (d) => `Trial extended — it ends ${dayMonthYear(d.endsAt)}.${d.action === "lifted" ? " Its billing hold is lifted." : ""}`,
        onDone: done,
      });
    } else if (mode.kind === "date") {
      if (!dateOk) return;
      const day = dateText;
      plain.run(() => consoleSetTrialEnd(tenantId, day), { success: `The trial ends ${dayKeyLabel(day)}.`, onDone: done });
    } else {
      plain.run(() => consoleGiveTrialPlans(tenantId), { success: "Its trial's plans are now given by hand, free.", onDone: done });
    }
  }

  let title = "";
  let confirmLabel = "";
  let body: ReactNode = null;
  if (mode?.kind === "extend") {
    const next = trialEndAfter(ends && ends.getTime() > now.getTime() ? ends : now, mode.days);
    title = `Extend the trial by ${mode.days} days`;
    confirmLabel = "Extend trial";
    body = (
      <>
        <p>{`It ends ${dayMonthYear(next)}${ends ? ` instead of ${dayMonthYear(ends)}` : ""} — ${plural(mode.days, "day")} from ${over ? "today" : "its current end"}.`}</p>
        <p className="text-muted">Extending can reopen an ended trial and lift a billing hold: its billing rules are applied at once.</p>
      </>
    );
  } else if (mode?.kind === "date") {
    title = "Set the trial's end";
    confirmLabel = "Set end date";
    body = (
      <div className="space-y-1.5">
        <Label htmlFor={dateId}>Last day of the trial</Label>
        <Input id={dateId} type="date" min={todayKey} value={dateText} onChange={(e) => setDateText(e.target.value)} aria-describedby={dateHintId} className="w-48" />
        <p id={dateHintId} className="text-xs text-muted">
          It ends at the end of that day, India time. Setting a date can reopen an ended trial and lift a billing hold.
        </p>
      </div>
    );
  } else if (mode?.kind === "give") {
    title = "Keep its plan without charging";
    confirmLabel = "Keep its plan";
    body = (
      <>
        <p>Its trial&apos;s plans become a plan given by hand, with no end date.</p>
        <p className="text-muted">Billing leaves it alone from then on — it is never held for payment. For a pilot or a partner.</p>
      </>
    );
  }

  return (
    <Panel
      title="Trial"
      description={ends ? `${over ? "Ended" : "Ends"} ${dayMonthYear(ends)} (${dayDistance(days ?? 0)})` : "No end date"}
      actions={<StatusPill tone={running ? (over ? "warning" : "info") : "neutral"}>{running ? (over ? "Over" : "Running") : "Ended"}</StatusPill>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">Extend by</span>
          {EXTEND_DAYS.map((d) => (
            <Button key={d} type="button" size="sm" variant="secondary" onClick={() => open({ kind: "extend", days: d })}>
              {`+${d} days`}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => open({ kind: "date" })}>
            <CalendarClock aria-hidden="true" className="h-4 w-4" />
            Set date…
          </Button>
        </div>
        <p className="text-xs text-muted">Extending can reopen an ended trial and lift a billing hold.</p>
        {caps.manage && running && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <p className="min-w-0 text-xs text-muted">Or keep its trial&apos;s plans with no end, and no charge.</p>
            <Button type="button" size="sm" variant="secondary" onClick={() => open({ kind: "give" })}>
              <Gift aria-hidden="true" className="h-4 w-4" />
              Keep its plan without charging
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={mode !== null}
        onClose={close}
        title={title || "Trial"}
        confirmLabel={confirmLabel || "Confirm"}
        pending={pending}
        error={error}
        confirmDisabled={mode?.kind === "date" && !dateOk}
        onConfirm={confirm}
      >
        {body}
      </ConfirmDialog>
    </Panel>
  );
}

// ─── Billing profile ─────────────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The billing email and tax ID, as the workspace's own billing page would save them — with a reason, recorded. */
export function BillingProfileButton({ tenantId, billingEmail, taxId }: { tenantId: string; billingEmail: string | null; taxId: string | null }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [tax, setTax] = useState("");
  const { pending, error, run, reset } = useConsoleAction<null>();
  const emailId = useId();
  const taxIdField = useId();

  const nextEmail = email.trim().toLowerCase() || null;
  const nextTax = tax.trim().toUpperCase().slice(0, 40) || null;
  const emailOk = nextEmail === null || (nextEmail.length <= 254 && EMAIL.test(nextEmail));
  const changes = [
    ...(nextEmail !== (billingEmail ?? null) ? [{ label: "Billing email", value: `${billingEmail ?? "none"} → ${nextEmail ?? "none"}` }] : []),
    ...(nextTax !== (taxId ?? null) ? [{ label: "Tax ID", value: `${taxId ?? "none"} → ${nextTax ?? "none"}` }] : []),
  ];

  function start() {
    reset();
    setEmail(billingEmail ?? "");
    setTax(taxId ?? "");
    setOpen(true);
  }

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={start}>
        <PencilLine aria-hidden="true" className="h-4 w-4" />
        Edit…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Edit billing details"
        confirmLabel="Save details"
        reason={{ label: "Why", minLength: 5, maxLength: 300, placeholder: "Kept with the change — e.g. the customer asked by email" }}
        pending={pending}
        error={error}
        confirmDisabled={!emailOk || changes.length === 0}
        onConfirm={({ reason }) => run(() => consoleSetBillingDetails(tenantId, { billingEmail: email, taxId: tax, reason }), { success: "Billing details saved.", onDone: () => setOpen(false) })}
      >
        <p className="text-muted">
          Where reminders go and what new checkouts use. This does not change the customer record at Stripe or Razorpay.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={emailId}>Billing email</Label>
            <Input id={emailId} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Owner's email if empty" aria-invalid={!emailOk || undefined} maxLength={254} />
            {!emailOk && <p className="text-xs text-danger">That doesn&apos;t look like an email address.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={taxIdField}>Tax ID</Label>
            <Input id={taxIdField} autoComplete="off" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="GSTIN, VAT number…" maxLength={40} className="uppercase" />
          </div>
        </div>
        {changes.length > 0 ? <ImpactList items={changes} /> : <p className="text-xs text-muted">Nothing changed yet.</p>}
      </ConfirmDialog>
    </>
  );
}

// ─── Exempt while paying ─────────────────────────────────────────────────────────────────────────

/**
 * The remedy for a workspace that pays at a gateway and also has a plan given by hand: the plan by
 * hand ends, and the gateway's subscription decides from then on — so a failed payment holds it
 * again, as it should.
 */
export function EndManualPlanButton({ tenantId, subscriptionId, plans }: { tenantId: string; subscriptionId: string; plans: string[] }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<null>();

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Unlink aria-hidden="true" className="h-4 w-4" />
        End the hand-given plan…
      </Button>
      <ConfirmDialog
        open={open}
        onClose={close}
        title="End the hand-given plan"
        confirmLabel="End the plan"
        tone="danger"
        checks={["It keeps only what its gateway subscription pays for."]}
        pending={pending}
        error={error}
        onConfirm={() => run(() => consoleEndManualPlan(tenantId, subscriptionId), { success: "The hand-given plan has ended — billing follows its gateway subscription.", onDone: () => setOpen(false) })}
      >
        <p>While a plan given by hand is live, billing leaves this workspace alone — a failed payment would never hold it.</p>
        <ImpactList
          items={[
            { label: "Plans ending", value: plans.length > 0 ? plans.join(", ") : "none listed", tone: "warning" },
            { label: "Billed and held by", value: "its gateway subscription" },
          ]}
        />
      </ConfirmDialog>
    </>
  );
}

// ─── Resync ──────────────────────────────────────────────────────────────────────────────────────

const statusName = (s: string) => (Object.prototype.hasOwnProperty.call(SUBSCRIPTION_STATUS, s) ? SUBSCRIPTION_STATUS[s as keyof typeof SUBSCRIPTION_STATUS].label : s);

/** A gateway subscription read back from its gateway now — for a webhook that never arrived (T1). */
export function ResyncButton({ subscriptionId, externalId }: { subscriptionId: string; externalId: string }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<{ before: string; after: string }>();

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <>
      <IconButton
        icon={RefreshCw}
        label={`Resync ${externalId}`}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      />
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Resync subscription"
        confirmLabel="Resync"
        pending={pending}
        error={error}
        onConfirm={() =>
          run(() => consoleResyncSubscription(subscriptionId), {
            success: (d) => (d.before === d.after ? `Resynced — still ${statusName(d.after)}.` : `Resynced — ${statusName(d.before)} → ${statusName(d.after)}.`),
            onDone: () => setOpen(false),
          })
        }
      >
        <p>
          Reads <span className="font-mono text-xs break-all">{externalId}</span> back from the gateway and updates its status, period and plans here. The
          workspace&apos;s standing follows.
        </p>
      </ConfirmDialog>
    </>
  );
}
