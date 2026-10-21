"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExpenseCategory, ExpenseStatus } from "@prisma/client";
import { reimburseExpenses, type ExpenseClaimsView } from "@/actions/expense";
import { useClock } from "@/components/time/clock-provider";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { expenseCategoryLabels, formatExpenseId } from "@/lib/expenses";
import { expensePath } from "@/lib/record-links";

type ClaimRow = {
  id: string;
  expenseSeq: number;
  category: ExpenseCategory;
  amount: number;
  spentOn: Date | string;
  description: string;
  status: ExpenseStatus;
  decidedAt: Date | string | null;
  reimbursedAt: Date | string | null;
  reimbursementRef: string | null;
  user: { id: string; name: string };
  approver: { id: string; name: string } | null;
  managerApprover: { id: string; name: string } | null;
  journalEntries: { id: string; entryNumber: string; source: string }[];
};

/**
 * Approved expense claims as Accounts works them: who is owed what, who approved it, and the ledger
 * entries behind it. On To pay, whoever pays claims ticks them and marks them paid in one go, with the
 * payment's reference and day — the batch a reimbursement run is.
 */
export function ExpenseClaimsTable({ rows, view, mayPay }: { rows: ClaimRow[]; view: ExpenseClaimsView; mayPay: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const selection = useRowSelection(rows);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const selectable = view === "to-pay" && mayPay;
  const selectedTotal = rows.filter((r) => selection.isSelected(r.id)).reduce((sum, r) => sum + r.amount, 0);

  function markPaid() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await reimburseExpenses({ expenseIds: selection.ids, reimbursementRef: reference, reimbursedOn: paidOn });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Marked ${result.data.count} claim(s) paid${result.data.skipped ? ` — ${result.data.skipped} skipped, no longer waiting` : ""}.`);
      setReference("");
      setPaidOn("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      {selectable && (
        <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
          <span className="text-sm text-muted">{formatCurrency(selectedTotal)} to pay</span>
          <Input
            aria-label="Payment reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR / cheque no."
            className="h-9 w-44"
          />
          <Input aria-label="Paid on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className="h-9 w-40" />
          <Button size="sm" disabled={pending || selection.count === 0} onClick={markPaid}>
            Mark {selection.count} paid
          </Button>
        </BulkBar>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {selectable && (
                <th className="w-10 px-4 py-2.5">
                  <Checkbox checked={selection.allSelected} onChange={selection.toggleAll} aria-label="Select every claim on this page" />
                </th>
              )}
              <th className="px-4 py-2.5">Claim</th>
              <th className="px-4 py-2.5">Claimant</th>
              <th className="px-4 py-2.5">Category</th>
              <th className="px-4 py-2.5">Spent on</th>
              <th className="px-4 py-2.5">Approved</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              <th className="px-4 py-2.5">Ledger</th>
              {view === "paid" && <th className="px-4 py-2.5">Paid</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0 hover:bg-surface-sunken">
                {selectable && (
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(r.id)}
                      onChange={() => selection.toggle(r.id)}
                      aria-label={`Select ${formatExpenseId(r.expenseSeq)}`}
                    />
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <Link href={expensePath(r.expenseSeq)} className="font-mono text-xs text-text hover:underline">
                    {formatExpenseId(r.expenseSeq)}
                  </Link>
                  <div className="max-w-xs truncate text-xs text-subtle">{r.description}</div>
                </td>
                <td className="px-4 py-2.5 text-text">{r.user.name}</td>
                <td className="px-4 py-2.5 text-muted">{expenseCategoryLabels[r.category]}</td>
                {/* The day it was spent, as typed — held as midnight UTC. */}
                <td className="px-4 py-2.5 text-muted">{formatCalendarDay(r.spentOn)}</td>
                <td className="px-4 py-2.5 text-muted">
                  {r.approver?.name ?? "—"}
                  {r.decidedAt && <div className="text-xs text-subtle">{clock.date(r.decidedAt)}</div>}
                  {r.managerApprover && <div className="text-xs text-subtle">after {r.managerApprover.name}</div>}
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-text">{formatCurrency(r.amount)}</td>
                <td className="px-4 py-2.5">
                  {r.journalEntries.length === 0 ? (
                    <span className="text-xs text-warning">Not in the ledger yet</span>
                  ) : (
                    r.journalEntries.map((j) => (
                      <Link
                        key={j.id}
                        href={`/accounting/journal?q=${encodeURIComponent(j.entryNumber)}`}
                        className="block text-xs text-brand hover:underline"
                      >
                        {j.entryNumber}
                        <span className="text-subtle"> · {j.source === "PAYMENT" ? "paid" : "booked"}</span>
                      </Link>
                    ))
                  )}
                </td>
                {view === "paid" && (
                  <td className="px-4 py-2.5 text-muted">
                    {r.reimbursedAt ? formatCalendarDay(r.reimbursedAt) : "—"}
                    {r.reimbursementRef && <div className="text-xs text-subtle">Ref {r.reimbursementRef}</div>}
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={selectable ? 8 : view === "paid" ? 8 : 7} className="px-4 py-10 text-center text-subtle">
                  {view === "to-pay"
                    ? "Nothing to pay back — no approved claim is waiting."
                    : view === "paid"
                      ? "No claims paid back in this range."
                      : "No company-paid spend in this range."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
