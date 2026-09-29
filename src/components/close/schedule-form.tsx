"use client";

import { useState, useTransition } from "react";
import { Search } from "lucide-react";
import type { billsForPrepaid, scheduleFormOptions } from "@/actions/accounting-schedules";
import { billsForPrepaid as searchBills, createSchedule, editSchedule } from "@/actions/accounting-schedules";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { planLines, replanUnposted } from "@/lib/close/plan";
import { monthLabel, parseMonthKey } from "@/lib/close/months";
import { dayLong, rupees } from "@/components/close/format";

export type ScheduleFormOptions = NonNullable<Awaited<ReturnType<typeof scheduleFormOptions>>>;
export type BillOption = Awaited<ReturnType<typeof billsForPrepaid>>[number];

/** What the form starts from: blank, or a schedule being changed. */
export type ScheduleFormValues = {
  id?: string;
  kind: "PREPAID" | "ACCRUAL";
  name: string;
  vendorCompanyId: string;
  expenseAccountId: string;
  balanceAccountId: string;
  amount: string;
  startMonth: string;
  months: string;
  sourceDocumentId: string;
  branchId: string;
  departmentId: string;
  note: string;
};

export const BLANK_SCHEDULE = (startMonth: string): ScheduleFormValues => ({
  kind: "PREPAID",
  name: "",
  vendorCompanyId: "",
  expenseAccountId: "",
  balanceAccountId: "",
  amount: "",
  startMonth,
  months: "12",
  sourceDocumentId: "",
  branchId: "",
  departmentId: "",
  note: "",
});

const MAX_MONTHS = 60;

/**
 * Making or changing a prepaid or an accrual — with the months it will post, worked out as it is typed,
 * before anything is saved.
 *
 * Changing one re-plans only the months not yet posted; the posted ones are shown as they stand. A
 * prepaid's accounts are fixed once its opening reclass is posted, and a schedule's start once any
 * month is.
 */
export function ScheduleForm({
  initial,
  options,
  bills: initialBills,
  vendors,
  posted = [],
  accountsFixed = false,
  onDone,
  onCancel,
}: {
  initial: ScheduleFormValues;
  options: ScheduleFormOptions;
  bills: BillOption[];
  vendors: { id: string; name: string }[];
  /** A schedule being changed: the months already posted. */
  posted?: { month: string; amount: number }[];
  /** A prepaid whose opening reclass is posted. */
  accountsFixed?: boolean;
  onDone: (message: string, id: string) => void;
  onCancel: () => void;
}) {
  const editing = !!initial.id;
  const [v, setV] = useState(initial);
  const [bills, setBills] = useState(initialBills);
  const [billQuery, setBillQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ScheduleFormValues>(key: K, value: ScheduleFormValues[K]) => setV((cur) => ({ ...cur, [key]: value }));
  const f = (name: string) => `schedule-${initial.id ?? "new"}-${name}`;

  const prepaid = v.kind === "PREPAID";
  const balanceChoices = prepaid ? options.prepaidAccounts : options.accrualAccounts;
  const defaultBalance = balanceChoices.find((a) => a.systemKey === (prepaid ? "PREPAID_EXPENSES" : "ACCRUED_EXPENSES"));
  const startFixed = editing && posted.length > 0;
  const bill = bills.find((b) => b.id === v.sourceDocumentId);

  // The months, as they would be saved.
  const amount = Number(v.amount);
  const months = Number(v.months);
  const start = parseMonthKey(v.startMonth);
  const valid = Number.isFinite(amount) && amount > 0 && Number.isInteger(months) && months >= 1 && months <= MAX_MONTHS && !!start;
  let preview: { month: Date; amount: number; posted: boolean }[] = [];
  let previewProblem: string | null = null;
  if (valid) {
    if (editing) {
      const plan = replanUnposted({
        amount,
        startMonth: start!,
        months,
        posted: posted.map((p) => ({ month: parseMonthKey(p.month)!, amount: p.amount })),
      });
      if (plan.ok) {
        preview = [
          ...posted.map((p) => ({ month: parseMonthKey(p.month)!, amount: p.amount, posted: true })),
          ...plan.lines.map((l) => ({ ...l, posted: false })),
        ].sort((a, b) => a.month.getTime() - b.month.getTime());
      } else {
        previewProblem = plan.error;
      }
    } else {
      preview = planLines(amount, start!, months).map((l) => ({ ...l, posted: false }));
    }
  }
  const monthly = preview.filter((p) => !p.posted);
  const last = preview[preview.length - 1];

  function findBills() {
    startTransition(async () => setBills(await searchBills(billQuery)));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      if (editing) {
        const result = await editSchedule(initial.id!, {
          name: v.name,
          vendorCompanyId: v.vendorCompanyId || null,
          ...(accountsFixed ? {} : { expenseAccountId: v.expenseAccountId, balanceAccountId: v.balanceAccountId || null }),
          amount,
          ...(startFixed ? {} : { startMonth: v.startMonth }),
          months,
          branchId: v.branchId || null,
          departmentId: v.departmentId || null,
          note: v.note,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onDone(
          `Saved. ${result.data.adjustmentEntryNumber ? `The change in amount is posted by ${result.data.adjustmentEntryNumber}.` : "Only the months not yet posted were re-planned."}`,
          initial.id!,
        );
      } else {
        const result = await createSchedule({
          kind: v.kind,
          name: v.name,
          vendorCompanyId: v.vendorCompanyId || null,
          expenseAccountId: v.expenseAccountId,
          balanceAccountId: v.balanceAccountId || null,
          amount,
          startMonth: v.startMonth,
          months,
          sourceDocumentId: prepaid ? v.sourceDocumentId || null : null,
          branchId: v.branchId || null,
          departmentId: v.departmentId || null,
          note: v.note || null,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onDone(
          result.data.reclassEntryNumber
            ? `Made. The amount moved to the balance sheet by ${result.data.reclassEntryNumber}, and is expensed month by month from here.`
            : "Made. Its months post as they end.",
          result.data.id,
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      {!editing && (
        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-medium text-muted">Kind</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name={f("kind")} checked={prepaid} onChange={() => setV((c) => ({ ...c, kind: "PREPAID", balanceAccountId: "" }))} />
              Prepaid — paid ahead, expensed over the months
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={f("kind")}
                checked={!prepaid}
                onChange={() => setV((c) => ({ ...c, kind: "ACCRUAL", balanceAccountId: "", sourceDocumentId: "" }))}
              />
              Accrual — incurred before its bill arrives
            </label>
          </div>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={f("name")}>Name</Label>
          <Input id={f("name")} value={v.name} maxLength={200} onChange={(e) => set("name", e.target.value)} placeholder={prepaid ? "Office insurance 2026-27" : "Statutory audit fee"} />
        </div>

        {prepaid && !editing && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={f("bill")}>From a vendor bill (optional)</Label>
            <div className="flex flex-wrap gap-2">
              <Select id={f("bill")} value={v.sourceDocumentId} onChange={(e) => set("sourceDocumentId", e.target.value)} className="min-w-0 flex-1">
                <option value="">No bill — entered by hand</option>
                {bills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.docNumber} · {b.company.name} · {dayLong(b.issueDate)} · {rupees(Math.round(Number(b.total) * Number(b.exchangeRate) * 100) / 100)}
                    {b._count.accountingSchedules > 0 ? " (already has a schedule)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search bills by number, reference or vendor"
                value={billQuery}
                onChange={(e) => setBillQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    findBills();
                  }
                }}
                placeholder="Search bills"
                className="min-w-0 flex-1 sm:max-w-xs"
              />
              <Button size="sm" variant="secondary" disabled={pending} onClick={findBills}>
                <Search className="h-3.5 w-3.5" aria-hidden />
                Find
              </Button>
            </div>
            <p className="text-xs text-subtle">
              {bill
                ? `The reclass is dated the bill's date. Its total, with tax, is ${rupees(Math.round(Number(bill.total) * Number(bill.exchangeRate) * 100) / 100)} — enter the part that is paid ahead.`
                : "Without a bill, the reclass is dated the first month's 1st (or today, if that is still to come)."}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={f("vendor")}>Vendor (optional)</Label>
          <CompanyCombobox
            id={f("vendor")}
            companies={vendors}
            value={v.vendorCompanyId}
            onSelect={(c) => set("vendorCompanyId", c?.id ?? "")}
            placeholder={bill ? `From the bill: ${bill.company.name}` : "Type to search vendors…"}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("expense")}>Expense account</Label>
          <Select id={f("expense")} value={v.expenseAccountId} disabled={accountsFixed} onChange={(e) => set("expenseAccountId", e.target.value)}>
            <option value="">Choose…</option>
            {options.expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("balance")}>{prepaid ? "Held in" : "Owed in"}</Label>
          <Select id={f("balance")} value={v.balanceAccountId} disabled={accountsFixed} onChange={(e) => set("balanceAccountId", e.target.value)}>
            <option value="">{defaultBalance ? `${defaultBalance.code} ${defaultBalance.name} (the default)` : prepaid ? "Prepaid Expenses (the default)" : "Accrued Expenses (the default)"}</option>
            {balanceChoices
              .filter((a) => a.id !== defaultBalance?.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
          </Select>
          {accountsFixed && <p className="text-xs text-subtle">Fixed once the opening reclass is posted. Stop it and make a new one to move it.</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("amount")}>Amount (₹)</Label>
          <Input id={f("amount")} type="number" inputMode="decimal" min="0.01" step="0.01" value={v.amount} onChange={(e) => set("amount", e.target.value)} placeholder="1,20,000" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("start")}>First month</Label>
          <Input id={f("start")} type="month" value={v.startMonth} disabled={startFixed} onChange={(e) => set("startMonth", e.target.value)} />
          {startFixed && <p className="text-xs text-subtle">Months are already posted, so the start can&apos;t move.</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("months")}>Months (1–{MAX_MONTHS})</Label>
          <Input id={f("months")} type="number" inputMode="numeric" min={1} max={MAX_MONTHS} step={1} value={v.months} onChange={(e) => set("months", e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("branch")}>Branch (optional)</Label>
          <Select id={f("branch")} value={v.branchId} onChange={(e) => set("branchId", e.target.value)}>
            <option value="">None</option>
            {options.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={f("department")}>Department (optional)</Label>
          <Select id={f("department")} value={v.departmentId} onChange={(e) => set("departmentId", e.target.value)}>
            <option value="">None</option>
            {options.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={f("note")}>Note (optional)</Label>
          <Textarea id={f("note")} value={v.note} maxLength={2000} onChange={(e) => set("note", e.target.value)} />
        </div>
      </div>

      <section aria-label="The months it will post" className="space-y-2 rounded-base border border-line bg-surface-sunken/60 p-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">The months it will post</h3>
        {!valid ? (
          <p className="text-sm text-subtle">Enter an amount, a first month and 1 to {MAX_MONTHS} months to see them.</p>
        ) : previewProblem ? (
          <p className="text-sm text-danger">{previewProblem}</p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {monthly.length > 0 ? (
                <>
                  {monthly.length} month{monthly.length === 1 ? "" : "s"} of about <span className="text-text">{rupees(monthly[0]!.amount)}</span>
                  {last && <> to {monthLabel(last.month, "short")}</>}, each {prepaid ? "Dr the expense, Cr the prepaid" : "Dr the expense, Cr the accrual (reversed on the 1st)"}.
                </>
              ) : (
                "Every month is already posted."
              )}
            </p>
            <div className="max-h-60 overflow-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Months and amounts</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-1 pr-4">Month</th>
                    <th scope="col" className="py-1 pr-4 text-right">Amount</th>
                    <th scope="col" className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {preview.map((p) => (
                    <tr key={p.month.toISOString()} className="border-t border-line">
                      <td className="py-1 pr-4 text-text">{monthLabel(p.month, "short")}</td>
                      <td className="py-1 pr-4 text-right tabular-nums text-text">{rupees(p.amount)}</td>
                      <td className="py-1 text-xs text-subtle">{p.posted ? "posted" : ""}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line-strong">
                    <td className="py-1 pr-4 font-medium text-text">Total</td>
                    <td className="py-1 pr-4 text-right font-medium tabular-nums text-text">{rupees(preview.reduce((t, p) => t + p.amount, 0))}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !valid || !!previewProblem || !v.name.trim() || (!editing && !v.expenseAccountId)} onClick={submit}>
          {pending ? "Saving…" : editing ? "Save changes" : prepaid ? "Make the prepaid" : "Make the accrual"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
