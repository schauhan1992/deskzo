import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getExpense } from "@/actions/expense";
import { listCompanyOptions } from "@/actions/company";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { isExpenseEditable } from "@/lib/expenses";
import { expensePath } from "@/lib/record-links";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function EditExpensePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("expenses"))) return <ModuleDisabledNotice moduleKey="expenses" />;
  const { id } = await params;
  const [expense, session] = await Promise.all([getExpense(id), auth()]);
  if (!expense) notFound();

  if (expense.userId !== session!.user.id || !isExpenseEditable(expense.status)) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">This claim can&apos;t be edited</h1>
        <p className="mt-2 text-sm text-muted">
          A claim is only editable by the person who raised it, and only while it&apos;s a draft or has come back
          rejected — otherwise editing would move the goalposts mid-review.
        </p>
        <Link href={expensePath(expense.expenseSeq)} className="mt-3 inline-block text-sm text-brand hover:underline">
          ← Back to the claim
        </Link>
      </div>
    );
  }

  const companies = await listCompanyOptions();

  return (
    <div>
      <div className="mb-5">
        <Link href={expensePath(expense.expenseSeq)} className="text-sm text-muted hover:text-text">
          ← Back to the claim
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Edit expense</h1>
      </div>

      <ExpenseForm
        companies={companies}
        visit={
          expense.visit
            ? { id: expense.visit.id, visitSeq: expense.visit.visitSeq, companyName: expense.visit.company.name }
            : null
        }
        defaults={{
          id: expense.id,
          expenseSeq: expense.expenseSeq,
          category: expense.category,
          amount: String(expense.amount),
          taxAmount: expense.taxAmount !== null ? String(expense.taxAmount) : "",
          // A calendar day held at UTC midnight (src/actions/expense.ts): the day it holds, in any zone.
          spentOn: new Date(expense.spentOn).toISOString().slice(0, 10),
          description: expense.description,
          paymentMode: expense.paymentMode,
          reimbursable: expense.reimbursable,
          visitId: expense.visitId ?? "",
          companyId: expense.companyId ?? "",
          leadId: expense.leadId ?? "",
          receiptName: expense.receiptName ?? "",
        }}
      />
    </div>
  );
}
