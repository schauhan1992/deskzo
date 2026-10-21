import { getExpenseApprovalFlow } from "@/actions/expense";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { ExpenseApprovalsForm } from "@/components/expenses/expense-approvals-form";

/** Who approves expense claims (owner, 19 Oct 2026: HR does) — HR's to set (`hr.manage`). */
export default async function ExpenseApprovalsSettingsPage() {
  const gate = await planGate("expenses", "Expenses");
  if (gate) return gate;
  const approvalFlow = await getExpenseApprovalFlow();

  return (
    <SettingsPage
      settingsKey="expense-approvals"
      description="Who signs off the expense claims people submit. An approved claim goes to the books and to Accounting › Expense claims for Accounts to pay back. A claim already submitted keeps the rule it was submitted under."
    >
      <ExpenseApprovalsForm approvalFlow={approvalFlow} />
    </SettingsPage>
  );
}
