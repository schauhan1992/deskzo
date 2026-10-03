"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ExpenseCategory, ExpensePaymentMode, ExpenseStatus } from "@prisma/client";
import { reimburseExpenses, decideExpense } from "@/actions/expense";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import {
  expenseCategoryLabels,
  expensePaymentModeLabels,
  expenseStatusLabels,
  expenseStatusTone,
  formatExpenseId,
  isPayable,
} from "@/lib/expenses";
import { formatVisitId } from "@/lib/visits";
import { companyPath, expensePath, visitPath } from "@/lib/record-links";

type ExpenseRow = {
  id: string;
  expenseSeq: number;
  category: ExpenseCategory;
  amount: number;
  spentOn: Date | string;
  description: string;
  paymentMode: ExpensePaymentMode;
  reimbursable: boolean;
  status: ExpenseStatus;
  receiptDataUrl: string | null;
  approverUserId: string | null;
  user: { id: string; name: string };
  approver: { id: string; name: string } | null;
  company: { id: string; name: string; companySeq: number } | null;
  visit: { id: string; visitSeq: number; company: { name: string } } | null;
};

export function ExpensesTable({
  expenses,
  currentUserId,
  canReimburse,
}: {
  expenses: ExpenseRow[];
  currentUserId: string;
  canReimburse: boolean;
}) {
  const router = useRouter();
  const selection = useRowSelection(expenses);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState("");

  const selected = expenses.filter((e) => selection.isSelected(e.id));
  const payableSelected = selected.filter((e) => isPayable(e.status, e.reimbursable));
  const payableTotal = payableSelected.reduce((sum, e) => sum + e.amount, 0);
  // Claims sitting in the current user's queue — bulk approve is only offered for these.
  const decidableSelected = selected.filter(
    (e) => e.status === "SUBMITTED" && e.approverUserId === currentUserId && e.user.id !== currentUserId,
  );

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setNotice(message);
      setReference("");
      selection.clear();
      router.refresh();
    });
  }

  function approveSelected() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      for (const expense of decidableSelected) {
        const result = await decideExpense({ id: expense.id, approved: true });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      setNotice(`Approved ${decidableSelected.length} claim(s).`);
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {decidableSelected.length > 0 && (
          <Button size="sm" disabled={isPending} onClick={approveSelected}>
            Approve {decidableSelected.length}
          </Button>
        )}
        {canReimburse && (
          <>
            <span className="text-sm text-muted">{formatCurrency(payableTotal)} payable</span>
            {/* Sits in the bulk bar with no caption of its own, so the name is spoken. */}
            <Input
              aria-label="Payment reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Payment reference"
              className="h-9 w-48"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending || payableSelected.length === 0}
              onClick={() =>
                run(
                  () => reimburseExpenses({ expenseIds: selection.ids, reimbursementRef: reference }),
                  `Marked ${payableSelected.length} claim(s) reimbursed.`,
                )
              }
            >
              Mark reimbursed
            </Button>
          </>
        )}
        {decidableSelected.length === 0 && !canReimburse && (
          <span className="text-sm text-subtle">Nothing you can act on in this selection.</span>
        )}
      </BulkBar>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-10 px-4 py-2.5">
                <Checkbox
                  checked={selection.allSelected}
                  onChange={selection.toggleAll}
                  aria-label="Select all expenses on this page"
                />
              </th>
              <th className="px-4 py-2.5">Claim</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Category</th>
              <th className="px-4 py-2.5">Spent on</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              <th className="px-4 py-2.5">Against</th>
              <th className="px-4 py-2.5">Paid by</th>
              <th className="px-4 py-2.5">Claimant</th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0 align-top hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Checkbox
                    checked={selection.isSelected(e.id)}
                    onChange={() => selection.toggle(e.id)}
                    aria-label={`Select ${formatExpenseId(e.expenseSeq)}`}
                  />
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  <Link href={expensePath(e.expenseSeq)} className="text-text hover:underline">
                    {formatExpenseId(e.expenseSeq)}
                  </Link>
                  <div className="max-w-xs truncate font-sans text-xs text-subtle">{e.description}</div>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={expenseStatusTone[e.status]}>{expenseStatusLabels[e.status]}</Badge>
                  {!e.reimbursable && (
                    <div className="mt-0.5 text-xs text-subtle">Not reimbursable</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{expenseCategoryLabels[e.category]}</td>
                {/* The day it was spent, as typed — held as midnight UTC. */}
                <td className="px-4 py-2.5 text-muted">{formatCalendarDay(e.spentOn)}</td>
                <td className="px-4 py-2.5 text-right font-medium text-text">{formatCurrency(e.amount)}</td>
                <td className="px-4 py-2.5 text-muted">
                  {e.visit ? (
                    <Link href={visitPath(e.visit.visitSeq)} className="text-text hover:underline">
                      {formatVisitId(e.visit.visitSeq)}
                    </Link>
                  ) : e.company ? (
                    <Link href={companyPath(e.company.companySeq)} className="text-text hover:underline">
                      {e.company.name}
                    </Link>
                  ) : (
                    <span className="text-subtle">General</span>
                  )}
                  {e.visit && <div className="text-xs text-subtle">{e.visit.company.name}</div>}
                </td>
                <td className="px-4 py-2.5 text-muted">{expensePaymentModeLabels[e.paymentMode]}</td>
                <td className="px-4 py-2.5 text-muted">
                  {e.user.name}
                  {e.approver && <div className="text-xs text-subtle">via {e.approver.name}</div>}
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-subtle">
                  No expenses match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
