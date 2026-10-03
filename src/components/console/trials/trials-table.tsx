"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Check } from "lucide-react";
import type { ConsoleResult } from "@/actions/platform/console";
import { consoleGiveTrialPlans, consoleSetTrialEnd } from "@/actions/platform/console";
import { consoleBulkExtendTrial, consoleExtendTrial, consolePreviewExtendTrial } from "@/actions/platform/console-directory";
import { BulkRunDialog } from "@/components/console/kit/bulk-run-dialog";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { AffectedList, ImpactList } from "@/components/console/kit/impact";
import { Panel, SubHeading } from "@/components/console/kit/panel";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { Tone } from "@/lib/console-shared/types";
import type { ExtendTrialPreview } from "@/lib/platform/bulk";
import type { TrialRow } from "@/lib/platform/trials";
import type { Clock } from "@/lib/time/zone";

/**
 * The trials board's table (spec §3.5): each workspace on a free trial, when it ends, how far into it
 * the reminders have got, and — for the staff who sell — the ways to give it more time.
 *
 * Every date here is counted from the loader's `asOf`, never the reader's now, in the console's days
 * (`useClock()`), so "in 2 days" is the same on the server render and after hydration. `caps` only
 * chooses what is drawn; each action checks the role again on the server, and a control a role cannot
 * use is not drawn at all.
 *
 * Extending is always from the trial's own end, or from today for one that has ended — and extending
 * an ended trial reopens it, lifting a billing hold. The confirmations say so before anything runs.
 */

const DAY_MS = 86_400_000;
/** The lengths a trial is extended by from its menu (EXTEND_DAYS on the server). */
const EXTEND = [7, 14, 30] as const;
/** The bulk bar's one length (spec §3.5), and its cap (BULK_CAPS.extendTrial). */
const BULK_DAYS = 14;
const BULK_CAP = 50;
/** The reminder steps billing sends before a trial ends. */
const STEPS = [7, 3, 1] as const;
const UNREACHABLE = "Couldn't work out what would change — check the connection and try again.";

type RowAction = { kind: "extend"; row: TrialRow; days: (typeof EXTEND)[number] } | { kind: "give"; row: TrialRow };

/** The bulk dialog's snapshot: the rows as they were when it opened, and the server's preview once it answers. */
type BulkState = { rows: TrialRow[]; result: ConsoleResult<ExtendTrialPreview> | null };

const ended = (row: TrialRow, asOf: Date) => new Date(row.trialEndsAt).getTime() <= new Date(asOf).getTime();

export function TrialsTable({ rows, caps, asOf }: { rows: TrialRow[]; caps: Caps; asOf: Date }) {
  const clock = useClock();
  const items = rows.map((row) => ({ id: row.tenant.id, row }));
  const selection = useRowSelection(items);
  const action = useConsoleAction<unknown>();
  const [pendingAction, setPendingAction] = useState<RowAction | null>(null);
  const [dateFor, setDateFor] = useState<TrialRow | null>(null);
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const request = useRef(0);

  // Only the staff who sell extend trials, so only they get the selection column.
  const selectable = caps.sell;
  const overCap = selection.count > BULK_CAP;
  const someSelected = selection.count > 0 && !selection.allSelected;

  /**
   * Asks the server what extending the selection would do. Called from the click, not an effect: the
   * answer is kept only if it answers the latest request, so closing and reopening never shows the
   * previous selection's preview.
   */
  function loadPreview(picked: TrialRow[]) {
    const token = ++request.current;
    setBulk({ rows: picked, result: null });
    const settle = (result: ConsoleResult<ExtendTrialPreview>) => {
      if (request.current === token) setBulk((b) => (b ? { ...b, result } : b));
    };
    consolePreviewExtendTrial(picked.map((r) => r.tenant.id), BULK_DAYS).then(
      (result) => settle(result && typeof result === "object" ? result : { ok: false, error: UNREACHABLE }),
      () => settle({ ok: false, error: UNREACHABLE }),
    );
  }

  function closeBulk() {
    request.current += 1;
    setBulk(null);
  }

  function closeRowAction() {
    if (action.pending) return;
    setPendingAction(null);
    action.reset();
  }

  function confirmRowAction() {
    const current = pendingAction;
    if (!current) return;
    const { row } = current;
    const done = { onDone: () => setPendingAction(null) };
    if (current.kind === "extend") {
      action.run(() => consoleExtendTrial(row.tenant.id, current.days), {
        ...done,
        success: (data) => {
          const d = data as { endsAt?: string; action?: string } | null;
          const end = d?.endsAt ? ` — it now ends ${clock.date(d.endsAt)}` : "";
          return `${row.tenant.name}'s trial is extended${end}${d?.action === "lifted" ? ", and its hold is lifted" : ""}.`;
        },
      });
    } else {
      action.run(() => consoleGiveTrialPlans(row.tenant.id), { ...done, success: `${row.tenant.name} keeps its plan without charge.` });
    }
  }

  function menuFor(row: TrialRow): RowMenuItem[] {
    const menu: RowMenuItem[] = [{ key: "heading-extend", heading: "Extend trial" }];
    for (const days of EXTEND) menu.push({ key: `extend-${days}`, label: `+${days} days`, onSelect: () => setPendingAction({ kind: "extend", row, days }) });
    menu.push({ key: "set-date", label: "Set end date…", onSelect: () => setDateFor(row) });
    // Only a trial still running can be kept as a plan given by hand (giveTrialPlans).
    if (caps.manage && row.subscriptionStatus === "TRIALING") {
      menu.push({ key: "sep-give", separator: true }, { key: "give", label: "Keep its plan without charging…", onSelect: () => setPendingAction({ kind: "give", row }) });
    }
    menu.push({ key: "sep-open", separator: true }, { key: "open", label: "Open workspace", href: `/workspaces/${row.tenant.slug}` });
    return menu;
  }

  return (
    <div>
      {selectable && selection.count > 0 && (
        // Stays in reach while scrolling a long list; the top bar is h-14.
        <div className="sticky top-16 z-10">
          <BulkBar count={selection.count} onClear={selection.clear}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={overCap}
              onClick={() => loadPreview(rows.filter((r) => selection.isSelected(r.tenant.id)))}
            >
              <CalendarPlus aria-hidden="true" className="h-4 w-4" />
              Extend +{BULK_DAYS} days
            </Button>
            {overCap && <span className="text-xs text-muted">Trials are extended at most {BULK_CAP} at a time.</span>}
          </BulkBar>
        </div>
      )}

      <Panel padded={false}>
        <DataTable caption="Trials" minWidth={selectable ? 1060 : 1000}>
          <THead>
            {selectable && (
              <Th className="w-10 pr-0">
                {/* A plain input rather than Checkbox: the header box needs a ref for its "some selected" state. */}
                <input
                  type="checkbox"
                  aria-label="Select every trial on this page"
                  checked={selection.allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={selection.toggleAll}
                  className="h-4 w-4 cursor-pointer rounded-sm accent-[var(--brand)]"
                />
              </Th>
            )}
            <Th>Workspace</Th>
            <Th>Plan</Th>
            <Th>Ends</Th>
            <Th numeric>Seats used</Th>
            <Th>Reminders</Th>
            <Th>Owner email</Th>
            {selectable && <Th srOnly>Actions</Th>}
          </THead>
          <TBody>
            {rows.map((row) => {
              const t = row.tenant;
              const isSelected = selection.isSelected(t.id);
              return (
                <Tr key={t.id} interactive selected={isSelected}>
                  {selectable && (
                    <Td className="w-10 pr-0">
                      <Checkbox label={`Select ${t.slug}`} checked={isSelected} onChange={() => selection.toggle(t.id)} />
                    </Td>
                  )}
                  <Td>
                    <div className="max-w-[18rem] min-w-40">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <RowLink href={`/workspaces/${t.slug}`} className="truncate">
                          {t.name}
                        </RowLink>
                        {t.status !== "ACTIVE" && row.bucket !== "held" && <TenantStatusPill status={t.status} suspendedFor={t.suspendedFor} />}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <span className="shrink-0 font-mono">{t.slug}</span>
                        <span aria-hidden="true" className="text-subtle">
                          ·
                        </span>
                        <span className="font-mono">{t.country}</span>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {row.plans.length > 0 ? (
                      <span className="block max-w-[14rem] truncate text-text" title={row.plans.join(", ")}>
                        {row.plans.join(", ")}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <Td nowrap>
                    <EndsCell row={row} asOf={asOf} />
                  </Td>
                  <Td numeric muted={row.seatsUsed === null}>
                    {row.seatsUsed === null ? "—" : row.seatsUsed.toLocaleString("en-IN")}
                  </Td>
                  <Td nowrap>
                    <Reminders row={row} />
                  </Td>
                  <Td muted>
                    {t.ownerEmail ? (
                      <span className="block max-w-[16rem] truncate" title={t.ownerEmail}>
                        {t.ownerEmail}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  {selectable && (
                    <RowActionsCell>
                      <RowMenu label={`Actions for ${t.name}`} items={menuFor(row)} />
                    </RowActionsCell>
                  )}
                </Tr>
              );
            })}
          </TBody>
        </DataTable>
      </Panel>

      {selectable && (
        <>
          <RowActionDialog action={pendingAction} asOf={asOf} pending={action.pending} error={action.error} onClose={closeRowAction} onConfirm={confirmRowAction} />
          {/* Keyed by the workspace, so each opening starts from that trial's own date. */}
          {dateFor && <SetDateDialog key={dateFor.tenant.id} row={dateFor} asOf={asOf} onClose={() => setDateFor(null)} />}
          {bulk && <BulkExtendDialog state={bulk} asOf={asOf} onClose={closeBulk} onRetry={() => loadPreview(bulk.rows)} onFinished={selection.clear} />}
        </>
      )}
    </div>
  );
}

/**
 * The end date, with how far away it is in the console's calendar days: "in 2 days" (amber from three
 * days out), "Ended 3 days ago" with the day the hold falls, or "Held for billing".
 */
function EndsCell({ row, asOf }: { row: TrialRow; asOf: Date }) {
  const clock = useClock();
  const end = new Date(row.trialEndsAt);
  const days = clock.daysBetween(new Date(asOf), end);
  let chip: { label: string; tone: Tone };
  let note: string | null = null;
  if (row.bucket === "held") {
    chip = { label: "Held for billing", tone: "danger" };
    note = "Extending reopens it";
  } else if (ended(row, asOf)) {
    chip = { label: days === 0 ? "Ended today" : days === -1 ? "Ended yesterday" : `Ended ${plural(-days, "day")} ago`, tone: "warning" };
    note = row.holdAt ? `Held on ${clock.dayMonth(row.holdAt)} unless it pays` : null;
  } else {
    chip = { label: days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${plural(days, "day")}`, tone: days <= 3 ? "warning" : days <= 7 ? "info" : "neutral" };
  }
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="tabular-nums text-text">{clock.date(end)}</span>
        <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
      </div>
      {note && <p className="mt-0.5 text-[11px] text-muted">{note}</p>}
    </div>
  );
}

/**
 * The 7-, 3- and 1-day reminders for the trial's current end, each ticked once sent. Reminders about
 * an earlier end — the trial has been extended since — are counted beside them.
 */
function Reminders({ row }: { row: TrialRow }) {
  const clock = useClock();
  const earlier = row.reminders.filter((r) => r.step === null);
  return (
    <div className="flex items-center gap-1.5">
      <ul aria-label="Reminders" className="flex items-center gap-1">
        {STEPS.map((step) => {
          const sent = row.reminders.find((r) => r.step === step);
          const title = sent ? `${sent.label} — sent ${clock.dateTime(sent.sentAt)}` : `${step}-day reminder not sent yet`;
          return (
            <li key={step}>
              <StatusPill tone={sent ? "success" : "neutral"} title={title} icon={sent ? <Check className="h-3 w-3" /> : undefined} className={sent ? undefined : "opacity-70"}>
                {step}d<span className="sr-only">{sent ? ` reminder sent ${clock.dateTime(sent.sentAt)}` : " reminder not sent yet"}</span>
              </StatusPill>
            </li>
          );
        })}
      </ul>
      {earlier.length > 0 && (
        <span className="text-[11px] text-subtle tabular-nums" title={earlier.map((r) => r.label).join(", ")}>
          +{earlier.length} earlier
        </span>
      )}
    </div>
  );
}

/** What an extension does to one trial, in the console's days — worked out from the row itself, never from the reader's now. */
function extensionImpact(row: TrialRow, days: number, asOf: Date, clock: Clock) {
  const isEnded = ended(row, asOf);
  const end = new Date(row.trialEndsAt);
  const impact: { label: string; value: string; tone?: Tone }[] = [
    { label: isEnded ? "Ended" : "Ends now", value: clock.date(end) },
    // A running trial moves from its own end; one that has ended starts again from today.
    { label: "Will end", value: isEnded ? `${plural(days, "day")} from today` : clock.date(new Date(end.getTime() + days * DAY_MS)), tone: "success" },
  ];
  if (row.bucket === "held") impact.push({ label: "Billing hold", value: "Lifted — it reopens", tone: "success" });
  else if (isEnded && row.holdAt) impact.push({ label: `Hold due ${clock.dayMonth(row.holdAt)}`, value: "Called off", tone: "success" });
  return impact;
}

/** One row's action, confirmed (spec §1.12, T1): the verb as the title, the consequence, Cancel and the verb. */
function RowActionDialog({
  action,
  asOf,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  action: RowAction | null;
  asOf: Date;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const clock = useClock();
  let title = "";
  let confirmLabel = "";
  let body: ReactNode = null;
  if (action?.kind === "extend") {
    const { row, days } = action;
    const isEnded = ended(row, asOf);
    title = `Extend trial by ${days} days`;
    confirmLabel = `Extend by ${days} days`;
    body = (
      <>
        <p>
          <strong className="font-medium">{row.tenant.name}</strong>&apos;s trial is extended by {days} days
          {isEnded ? " from today, since it has already ended." : " from its current end."}
          {isEnded && " Extending an ended trial reopens it, and lifts a billing hold if it has one."}
        </p>
        <ImpactList items={extensionImpact(row, days, asOf, clock)} />
      </>
    );
  } else if (action?.kind === "give") {
    const { row } = action;
    title = "Keep its plan without charging";
    confirmLabel = "Keep without charging";
    body = (
      <>
        <p>
          <strong className="font-medium">{row.tenant.name}</strong> keeps the plans it is trying as a plan given by hand. Its trial ends here: no more
          reminders, no hold, and billing leaves it alone from now on.
        </p>
        <ImpactList
          items={[
            { label: "Plans", value: row.plans.length > 0 ? row.plans.join(", ") : "—" },
            { label: "Charged", value: "Nothing", tone: "warning" },
          ]}
        />
      </>
    );
  }

  return (
    <ConfirmDialog open={action !== null} onClose={onClose} title={title} confirmLabel={confirmLabel} pending={pending} error={error} onConfirm={onConfirm}>
      <div className="space-y-3">{body}</div>
    </ConfirmDialog>
  );
}

/**
 * A trial's last day, picked (T1), on the console's calendar. The trial ends at 23:59 on that day in
 * the console's time zone (`consoleSetTrialEnd`); a day before today is refused by the server. Setting
 * a date on an ended trial reopens it, like an extension.
 */
function SetDateDialog({ row, asOf, onClose }: { row: TrialRow; asOf: Date; onClose: () => void }) {
  const clock = useClock();
  const action = useConsoleAction<null>();
  const dateId = useId();
  const today = clock.dateKey(new Date(asOf));
  const current = clock.dateKey(new Date(row.trialEndsAt));
  const [day, setDay] = useState(current > today ? current : today);
  const isEnded = ended(row, asOf);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= today;

  function close() {
    if (!action.pending) onClose();
  }

  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Set trial end date"
      confirmLabel="Set end date"
      pending={action.pending}
      error={action.error}
      confirmDisabled={!valid}
      onConfirm={() => action.run(() => consoleSetTrialEnd(row.tenant.id, day), { success: `${row.tenant.name}'s trial now ends ${dayKeyLabel(day)}.`, onDone: onClose })}
    >
      <p>
        <strong className="font-medium">{row.tenant.name}</strong>&apos;s trial {isEnded ? "ended" : "ends"} on {clock.date(row.trialEndsAt)}. Pick
        its new last day — it ends at 23:59 that day, in the console&apos;s time zone.
        {isEnded && " Setting a date reopens it, and lifts a billing hold if it has one."}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={dateId}>New last day</Label>
        <Input id={dateId} type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} readOnly={action.pending} className="w-48" />
        {!valid && day !== "" && <p className="text-xs text-danger">Pick today or a later day.</p>}
      </div>
    </ConfirmDialog>
  );
}

/**
 * Extend the selected trials by 14 days (T2). The server's preview comes first — what each trial's
 * new end is, and which ones it reopens — and the run cannot start until it is on screen. A preview
 * that failed, or found nothing it could extend, shows why and never runs anything.
 */
function BulkExtendDialog({
  state,
  asOf,
  onClose,
  onRetry,
  onFinished,
}: {
  state: BulkState;
  asOf: Date;
  onClose: () => void;
  onRetry: () => void;
  onFinished: () => void;
}) {
  const clock = useClock();
  const title = `Extend trials by ${BULK_DAYS} days`;
  const confirmLabel = `Extend by ${BULK_DAYS} days`;
  const description = `Each selected trial is extended by ${BULK_DAYS} days from its current end — or from today, for one that has already ended. Extending an ended trial reopens it and lifts its billing hold.`;
  const ids = state.rows.map((r) => r.tenant.id);
  const result = state.result;

  if (result && !result.ok) {
    return (
      <ConfirmDialog open onClose={onClose} title={title} confirmLabel="Try again" pending={false} error={result.error || UNREACHABLE} onConfirm={onRetry}>
        <p>{description}</p>
        <Selected rows={state.rows.map((r) => ({ id: r.tenant.id, label: r.tenant.name }))} />
      </ConfirmDialog>
    );
  }

  const data = result?.ok ? result.data : null;
  const planned = new Map((data?.items ?? []).map((i) => [i.tenantId, i]));
  const listed = state.rows
    .map((r, index) => {
      const item = planned.get(r.tenant.id);
      if (!data) return { id: r.tenant.id, label: r.tenant.name, order: 0, index };
      if (!item) return { id: r.tenant.id, label: r.tenant.name, note: "No longer exists", order: 2, index };
      if (!item.eligible || !item.to) return { id: r.tenant.id, label: r.tenant.name, note: item.why ?? "No trial to extend", order: 1, index };
      const dates = `${clock.dayMonth(item.from)} → ${clock.dayMonth(item.to)}`;
      return {
        id: r.tenant.id,
        label: r.tenant.name,
        note: item.liftsHold ? `${dates} · reopens` : dates,
        tone: item.liftsHold ? ("success" as const) : undefined,
        order: 0,
        index,
      };
    })
    // The ones that change first, so the ten rows shown are the ones worth reading.
    .sort((a, b) => a.order - b.order || a.index - b.index);

  const eligible = data?.items.filter((i) => i.eligible) ?? [];
  const reopens = eligible.filter((i) => i.liftsHold).length;
  const skipped = state.rows.length - eligible.length;
  // Of the ones that will be extended, those that have already ended.
  const endedCount = state.rows.filter((r) => eligible.some((i) => i.tenantId === r.tenant.id) && ended(r, asOf)).length;

  if (data && eligible.length === 0) {
    return (
      <ConfirmDialog open onClose={onClose} title={title} confirmLabel={confirmLabel} pending={false} error={null} confirmDisabled onConfirm={() => {}}>
        <p>None of the selected workspaces has a trial that can be extended — one paying at a gateway, closed, or never on a trial is left as it is.</p>
        <Selected rows={listed} />
      </ConfirmDialog>
    );
  }

  const impact = data ? (
    <ImpactList
      items={[
        { label: "Extended", value: plural(eligible.length, "trial"), tone: "success" },
        ...(endedCount > 0 ? [{ label: "Already ended — restarted from today", value: plural(endedCount, "trial") }] : []),
        ...(reopens > 0 ? [{ label: "Billing hold lifted", value: plural(reopens, "workspace"), tone: "success" as const }] : []),
        ...(skipped > 0 ? [{ label: "Skipped", value: plural(skipped, "workspace") }] : []),
      ]}
    />
  ) : undefined;

  return (
    <BulkRunDialog
      open
      onClose={onClose}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      rows={listed}
      preview={impact}
      previewPending={!data}
      run={() => consoleBulkExtendTrial(ids, BULK_DAYS)}
      onFinished={onFinished}
    />
  );
}

function Selected({ rows }: { rows: { id: string; label: string; note?: string; tone?: Tone }[] }) {
  return (
    <div className="space-y-2">
      <SubHeading>Selected ({rows.length})</SubHeading>
      <AffectedList rows={rows.map((r) => ({ key: r.id, label: r.label, note: r.note, tone: r.tone }))} />
    </div>
  );
}
