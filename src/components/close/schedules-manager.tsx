"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Hourglass, Play, Plus, X } from "lucide-react";
import type { getSchedule, listSchedules } from "@/actions/accounting-schedules";
import { runSchedules, stopSchedule } from "@/actions/accounting-schedules";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { monthKeyOf, monthLabel } from "@/lib/close/months";
import { dayLong, monthOfKey, rupees } from "@/components/close/format";
import {
  BLANK_SCHEDULE,
  ScheduleForm,
  type BillOption,
  type ScheduleFormOptions,
  type ScheduleFormValues,
} from "@/components/close/schedule-form";

type ScheduleRow = Awaited<ReturnType<typeof listSchedules>>[number];
export type ScheduleDetail = NonNullable<Awaited<ReturnType<typeof getSchedule>>>;

const STATUS_LABEL = { ACTIVE: "Running", COMPLETED: "Finished", CANCELLED: "Stopped" } as const;
const STATUS_TONE = { ACTIVE: "blue", COMPLETED: "green", CANCELLED: "default" } as const;
const KIND_LABEL = { PREPAID: "Prepaid", ACCRUAL: "Accrual" } as const;

const journalHref = (entryNumber: string) => `/accounting/journal?q=${encodeURIComponent(entryNumber)}`;

/**
 * Prepaids & accruals: the list, one schedule's months, making and changing one, stopping one, and
 * posting the months that have ended.
 *
 * Reading and posting a month is `close.work`; making, changing and stopping one is `close.manage`.
 * The nightly job posts the same months as the Automation account when automatic posting is on.
 */
export function SchedulesManager({
  rows,
  filters,
  selected,
  options,
  bills,
  vendors,
  canWork,
  canManage,
  runMonths,
}: {
  rows: ScheduleRow[];
  filters: { kind: string; status: string };
  selected: ScheduleDetail | null;
  options: ScheduleFormOptions | null;
  bills: BillOption[];
  vendors: { id: string; name: string }[];
  canWork: boolean;
  canManage: boolean;
  /** Months that have ended, newest first — what "Post through" offers. */
  runMonths: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<{ values: ScheduleFormValues; posted: { month: string; amount: number }[]; accountsFixed: boolean } | null>(null);

  function setFilter(key: "kind" | "status", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("schedule");
    router.push(`${pathname}?${params.toString()}`);
  }

  function hrefFor(id: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("schedule", id);
    else params.delete("schedule");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function startNew() {
    setMessage(null);
    setForm({ values: BLANK_SCHEDULE(runMonths[0] ?? monthKeyOf(new Date())), posted: [], accountsFixed: false });
  }

  function startEdit(s: ScheduleDetail) {
    setMessage(null);
    setForm({
      values: {
        id: s.id,
        kind: s.kind,
        name: s.name,
        vendorCompanyId: s.vendorCompanyId ?? "",
        expenseAccountId: s.expenseAccountId,
        balanceAccountId: s.balanceAccountId,
        amount: String(s.amount),
        startMonth: monthKeyOf(new Date(s.startMonth)),
        months: String(s.months),
        sourceDocumentId: s.sourceDocumentId ?? "",
        branchId: s.branchId ?? "",
        departmentId: s.departmentId ?? "",
        note: s.note ?? "",
      },
      posted: s.lines.filter((l) => l.entry).map((l) => ({ month: monthKeyOf(new Date(l.month)), amount: Number(l.amount) })),
      accountsFixed: s.kind === "PREPAID" && !!s.reclassEntry,
    });
  }

  const filtered = !!filters.kind || !!filters.status;

  return (
    <div className="space-y-4">
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      {canWork && runMonths.length > 0 && <RunPanel runMonths={runMonths} onMessage={setMessage} />}

      {selected && (
        <ScheduleDetailCard
          schedule={selected}
          canManage={canManage && !!options}
          closeHref={hrefFor(null)}
          onEdit={() => startEdit(selected)}
          onMessage={setMessage}
        />
      )}

      <Card className="overflow-hidden p-0">
        <CardHeader className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="schedules-kind">Kind</Label>
              <Select id="schedules-kind" value={filters.kind} onChange={(e) => setFilter("kind", e.target.value)} className="w-40">
                <option value="">All</option>
                <option value="PREPAID">Prepaids</option>
                <option value="ACCRUAL">Accruals</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedules-status">Status</Label>
              <Select id="schedules-status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)} className="w-40">
                <option value="">All</option>
                <option value="ACTIVE">Running</option>
                <option value="COMPLETED">Finished</option>
                <option value="CANCELLED">Stopped</option>
              </Select>
            </div>
          </div>
          {canManage && options && (
            <Button size="sm" onClick={startNew}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New schedule
            </Button>
          )}
        </CardHeader>
        {rows.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted">
            {filtered ? (
              "Nothing matches these filters."
            ) : (
              <>
                No prepaids or accruals yet. A <span className="text-text">prepaid</span> spreads a cost paid ahead — a
                year&apos;s insurance, an annual licence — over the months it covers; an <span className="text-text">accrual</span>{" "}
                books a cost each month before its bill arrives, and reverses it on the 1st so the bill books normally.{" "}
                {canManage ? "Start with “New schedule”." : "Somebody who manages the close can set one up."}
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Schedule</th>
                  <th scope="col" className="px-4 py-2.5">Expense</th>
                  <th scope="col" className="px-4 py-2.5">Months</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Posted</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Left</th>
                  <th scope="col" className="px-4 py-2.5">Next</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-line last:border-0 hover:bg-surface-sunken ${selected?.id === r.id ? "bg-brand-subtle/40" : ""}`}>
                    <td className="px-4 py-2.5">
                      <Link href={hrefFor(r.id)} className="font-medium text-brand hover:underline">
                        {r.name}
                      </Link>
                      <span className="block text-xs text-subtle">
                        {KIND_LABEL[r.kind]}
                        {r.vendorCompany ? ` · ${r.vendorCompany.name}` : ""}
                        {r.sourceDocument ? ` · ${r.sourceDocument.docNumber}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      <span className="font-mono text-xs text-subtle">{r.expenseAccount.code}</span> {r.expenseAccount.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {r.postedMonths} of {r.months}
                      <span className="block text-xs text-subtle">from {monthLabel(new Date(r.startMonth), "short")}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-text">{rupees(r.amount)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted">{rupees(r.posted)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-text">{rupees(r.remaining)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{r.nextMonth ? monthOfKey(r.nextMonth) : "—"}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {options && (
        <Dialog
          open={!!form}
          onClose={() => setForm(null)}
          title={form?.values.id ? `Change ${form.values.name}` : "New prepaid or accrual"}
          large
        >
          {form && (
            <ScheduleForm
              key={form.values.id ?? "new"}
              initial={form.values}
              options={options}
              bills={bills}
              vendors={vendors}
              posted={form.posted}
              accountsFixed={form.accountsFixed}
              onCancel={() => setForm(null)}
              onDone={(text, id) => {
                setForm(null);
                setMessage(text);
                router.push(hrefFor(id));
                router.refresh();
              }}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}

/** "Post through Sep 2026": every schedule month that has ended and isn't posted yet. */
function RunPanel({ runMonths, onMessage }: { runMonths: string[]; onMessage: (text: string) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [through, setThrough] = useState(runMonths[0]!);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await runSchedules({ throughMonth: through });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const posted = result.data.months;
      onMessage(
        posted.length === 0
          ? `Nothing was due through ${monthOfKey(through)} — every month that has ended is already posted.`
          : `Posted ${posted.length} entr${posted.length === 1 ? "y" : "ies"}: ${posted
              .map((m) => `${m.entryNumber} (${KIND_LABEL[m.kind].toLowerCase()}, ${monthOfKey(m.month)}, ${rupees(m.amount)}${m.catchUp ? ", caught up" : ""})`)
              .join("; ")}.${result.data.completed ? ` ${result.data.completed} schedule${result.data.completed === 1 ? "" : "s"} finished.` : ""}`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-xl space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-text">
            <Hourglass className="h-3.5 w-3.5 text-subtle" aria-hidden />
            Post the months that have ended
          </p>
          <p className="text-xs text-subtle">
            Safe to press twice: each month posts once. A month the books are locked for is caught up in the first open one.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="schedules-through">Through</Label>
            <Select id="schedules-through" value={through} onChange={(e) => setThrough(e.target.value)} className="w-40">
              {runMonths.map((m) => (
                <option key={m} value={m}>
                  {monthOfKey(m)}
                </option>
              ))}
            </Select>
          </div>
          <Button disabled={pending} onClick={run}>
            <Play className="h-3.5 w-3.5" aria-hidden />
            {pending ? "Posting…" : `Post through ${monthOfKey(through)}`}
          </Button>
        </div>
        {error && (
          <p role="alert" className="w-full text-sm text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** One schedule: what it is, its months with the entries that posted (and reversed) them, and its actions. */
function ScheduleDetailCard({
  schedule: s,
  canManage,
  closeHref,
  onEdit,
  onMessage,
}: {
  schedule: ScheduleDetail;
  canManage: boolean;
  closeHref: string;
  onEdit: () => void;
  onMessage: (text: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepaid = s.kind === "PREPAID";
  const postedAmount = s.lines.filter((l) => l.entry).reduce((t, l) => t + Number(l.amount), 0);
  const stopId = `schedule-${s.id}-stop`;

  function stop() {
    setError(null);
    startTransition(async () => {
      const result = await stopSchedule(s.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStopping(false);
      onMessage(
        result.data.entryNumber
          ? `Stopped. The ${rupees(result.data.expensedNow)} not yet expensed is expensed now by ${result.data.entryNumber}.`
          : "Stopped. Its months not yet posted are gone.",
      );
      router.refresh();
    });
  }

  return (
    <Card aria-label={`${s.name}: schedule detail`}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
            {s.name}
            <Badge tone={prepaid ? "brand" : "amber"}>{KIND_LABEL[s.kind]}</Badge>
            <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
          </h2>
          <p className="mt-0.5 text-xs text-subtle">
            Made by {s.createdBy?.name ?? "somebody"} on {dayLong(s.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && s.status === "ACTIVE" && (
            <>
              <Button size="sm" variant="secondary" onClick={onEdit}>
                Change
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setStopping((v) => !v)} aria-expanded={stopping} aria-controls={stopId}>
                Stop…
              </Button>
            </>
          )}
          <Link href={closeHref} aria-label="Close the schedule" className="rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-text">
            <X className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Amount">{rupees(Number(s.amount))}</Fact>
          <Fact label="Posted so far">
            {rupees(postedAmount)} · {s.lines.filter((l) => l.entry).length} of {s.months} months
          </Fact>
          <Fact label="Months">
            {monthLabel(new Date(s.startMonth), "short")} for {s.months}
          </Fact>
          <Fact label="Expense">
            {s.expenseAccount.code} {s.expenseAccount.name}
          </Fact>
          <Fact label={prepaid ? "Held in" : "Owed in"}>
            {s.balanceAccount.code} {s.balanceAccount.name}
          </Fact>
          {s.vendorCompany && <Fact label="Vendor">{s.vendorCompany.name}</Fact>}
          {s.sourceDocument && (
            <Fact label="Bill">
              <Link href={`/documents/${s.sourceDocument.id}`} className="text-brand hover:underline">
                {s.sourceDocument.docNumber}
              </Link>
            </Fact>
          )}
          {s.branch && <Fact label="Branch">{s.branch.name}</Fact>}
          {s.department && <Fact label="Department">{s.department.name}</Fact>}
          {prepaid && (
            <Fact label="Opening reclass">
              {s.reclassEntry ? (
                <>
                  <Link href={journalHref(s.reclassEntry.entryNumber)} className="font-mono text-xs text-brand hover:underline">
                    {s.reclassEntry.entryNumber}
                  </Link>{" "}
                  <span className="text-subtle">· {dayLong(s.reclassEntry.date)} · Dr {s.balanceAccount.name} / Cr {s.expenseAccount.name}</span>
                </>
              ) : (
                <span className="text-warning">Not posted</span>
              )}
            </Fact>
          )}
        </dl>
        {s.note && <p className="whitespace-pre-wrap break-words text-sm text-muted">{s.note}</p>}

        <section
          id={stopId}
          hidden={!stopping}
          aria-label={`Stop ${s.name}`}
          className="space-y-3 rounded-base border border-warning/40 bg-warning-bg p-3 text-sm text-warning"
        >
          <p>
            Stopping removes the months not yet posted; posted months stay as they are.{" "}
            {prepaid && s.reclassEntry
              ? `The ${rupees(Number(s.amount) - postedAmount)} still held in ${s.balanceAccount.name} is expensed today, so nothing is left on the balance sheet.`
              : "Nothing else is posted."}{" "}
            It can&apos;t be started again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="danger" disabled={pending} onClick={stop}>
              {pending ? "Stopping…" : "Stop the schedule"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setStopping(false)}>
              Keep it running
            </Button>
          </div>
        </section>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">Months of {s.name}</caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4">Month</th>
                <th scope="col" className="py-2 pr-4 text-right">Amount</th>
                <th scope="col" className="py-2 pr-4">Entry</th>
                {!prepaid && <th scope="col" className="py-2 pr-4">Reversal</th>}
                <th scope="col" className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4 text-text">{monthLabel(new Date(l.month), "short")}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-text">{rupees(Number(l.amount))}</td>
                  <td className="py-2 pr-4">
                    {l.entry ? (
                      <Link href={journalHref(l.entry.entryNumber)} className="font-mono text-xs text-brand hover:underline">
                        {l.entry.entryNumber}
                      </Link>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                    {l.entry && <span className="ml-1 text-xs text-subtle">{dayLong(l.entry.date)}</span>}
                  </td>
                  {!prepaid && (
                    <td className="py-2 pr-4">
                      {l.reversalEntry ? (
                        <>
                          <Link href={journalHref(l.reversalEntry.entryNumber)} className="font-mono text-xs text-brand hover:underline">
                            {l.reversalEntry.entryNumber}
                          </Link>
                          <span className="ml-1 text-xs text-subtle">{dayLong(l.reversalEntry.date)}</span>
                        </>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  )}
                  <td className="py-2 text-xs">
                    {l.entry ? (
                      <span className="text-success">Posted{l.catchUp ? " · caught up from a closed month" : ""}</span>
                    ) : l.postedAt ? (
                      <span className="text-subtle">Nothing to post</span>
                    ) : (
                      <span className="text-muted">Planned</span>
                    )}
                  </td>
                </tr>
              ))}
              {s.lines.length === 0 && (
                <tr>
                  <td colSpan={prepaid ? 4 : 5} className="py-4 text-center text-subtle">
                    No months — it was stopped before any was posted.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-subtle">{label}</dt>
      <dd className="break-words text-text">{children}</dd>
    </div>
  );
}
