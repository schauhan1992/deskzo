import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { getExpense } from "@/actions/expense";
import { hasEffectivePermission } from "@/actions/permission";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ExpenseActions } from "@/components/expenses/expense-actions";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  expenseCategoryLabels,
  expensePaymentModeLabels,
  expenseStatusLabels,
  expenseStatusTone,
  formatExpenseId,
} from "@/lib/expenses";
import { formatVisitId } from "@/lib/visits";

export default async function ExpenseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  /**
   * The sequence resolves to the cuid before the action runs, so every check that action already
   * made still happens — this translates the reference, it does not bypass anything. A sequence
   * matching nothing falls through as the original segment and the action answers null, which is
   * the same refusal a bad cuid gets.
   */
  const ref = parseRecordRef(id);
  const resolved =
    ref.kind === "seq"
      ? ((await db.expense.findUnique({ where: { expenseSeq: ref.seq }, select: { id: true } }))?.id ?? id)
      : ref.id;

  const [expense, session] = await Promise.all([getExpense(resolved), auth()]);
  if (!expense) notFound();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/expenses", formatExpenseId(expense.expenseSeq), query);

  const userId = session!.user.id;
  const isMine = expense.userId === userId;
  const [canOverride, canReimburse] = await Promise.all([
    hasEffectivePermission(userId, "expenses.approve"),
    hasEffectivePermission(userId, "expenses.reimburse"),
  ]);
  // Never your own claim, whatever permissions you hold.
  const canDecide = !isMine && (expense.approverUserId === userId || canOverride);

  return (
    <div className="animate-fade-rise">
      <Link href="/expenses" className="text-sm text-muted hover:text-text">
        ← Expenses
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{formatExpenseId(expense.expenseSeq)}</h1>
            <Badge tone={expenseStatusTone[expense.status]}>{expenseStatusLabels[expense.status]}</Badge>
            {!expense.reimbursable && <Badge tone="default">Not reimbursable</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {expenseCategoryLabels[expense.category]} · {expense.user.name} · {formatDate(expense.spentOn)}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-text">{formatCurrency(expense.amount)}</div>
          {expense.taxAmount !== null && (
            <div className="text-xs text-subtle">incl. {formatCurrency(expense.taxAmount)} tax</div>
          )}
        </div>
      </div>

      <Card className="mt-5">
        <CardContent>
          <ExpenseActions
            id={expense.id}
            status={expense.status}
            reimbursable={expense.reimbursable}
            isMine={isMine}
            canDecide={canDecide}
            canReimburse={canReimburse}
            approverName={expense.approver?.name ?? null}
          />
        </CardContent>
      </Card>

      {expense.status === "REJECTED" && expense.decisionNote && (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <span className="font-medium">Rejected by {expense.approver?.name ?? "your manager"}:</span>{" "}
          {expense.decisionNote}
        </Card>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Claim</CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-subtle">What it was for</div>
                <p className="mt-1 whitespace-pre-wrap text-muted">{expense.description}</p>
              </div>
              <Row label="Paid by" value={expensePaymentModeLabels[expense.paymentMode]} />
              <Row label="Reimbursable" value={expense.reimbursable ? "Yes" : "No — company paid"} />
            </CardContent>
          </Card>

          {expense.receiptDataUrl && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>Receipt</span>
                <a
                  href={expense.receiptDataUrl}
                  download={expense.receiptName ?? "receipt"}
                  className="text-sm text-brand hover:underline"
                >
                  Download
                </a>
              </CardHeader>
              <CardContent>
                {expense.receiptDataUrl.startsWith("data:application/pdf") ? (
                  <p className="text-sm text-muted">{expense.receiptName ?? "receipt.pdf"} — download to view.</p>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={expense.receiptDataUrl}
                    alt="Receipt"
                    className="max-h-96 w-auto rounded-base border border-line bg-white object-contain"
                  />
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Against</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {expense.visit ? (
                <div className="flex items-start justify-between gap-3 text-muted">
                  <span>Visit</span>
                  <Link href={`/visits/${expense.visit.id}`} className="text-right text-text hover:underline">
                    {formatVisitId(expense.visit.visitSeq)}
                    <div className="text-xs text-subtle">{expense.visit.company.name}</div>
                  </Link>
                </div>
              ) : expense.company ? (
                <div className="flex items-start justify-between gap-3 text-muted">
                  <span>Company</span>
                  <Link href={`/companies/${expense.company.id}`} className="text-right text-text hover:underline">
                    {expense.company.name}
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-subtle">General business spend — not tied to an account.</p>
              )}
              {expense.lead && (
                <div className="flex items-start justify-between gap-3 text-muted">
                  <span>Lead</span>
                  <Link href={`/leads/${expense.lead.id}`} className="text-right text-text hover:underline">
                    {expense.lead.title}
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Approval</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Claimant" value={expense.user.name} />
              <Row label="Submitted" value={expense.submittedAt ? formatDate(expense.submittedAt) : "Not yet"} />
              <Row
                label={expense.status === "REJECTED" ? "Rejected by" : "Approver"}
                value={expense.approver?.name ?? "Not routed yet"}
              />
              <Row label="Decided" value={expense.decidedAt ? formatDate(expense.decidedAt) : "—"} />
              {expense.status === "APPROVED" && expense.decisionNote && (
                <p className="text-xs text-subtle">{expense.decisionNote}</p>
              )}
              <Row label="Reimbursed" value={expense.reimbursedAt ? formatDate(expense.reimbursedAt) : "—"} />
              {expense.reimbursementRef && <Row label="Reference" value={expense.reimbursementRef} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-muted">
      <span className="shrink-0">{label}</span>
      <span className="text-right text-text">{value}</span>
    </div>
  );
}
