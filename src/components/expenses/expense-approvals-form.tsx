"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ExpenseApprovalFlow } from "@prisma/client";
import { setExpenseApprovalFlow } from "@/actions/expense";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EXPENSE_APPROVAL_FLOWS, expenseApprovalFlowHints, expenseApprovalFlowLabels } from "@/lib/expense-approval";
import { cn } from "@/lib/utils";

/** The company's rule for who approves expense claims: one of three, saved with a button. */
export function ExpenseApprovalsForm({ approvalFlow }: { approvalFlow: ExpenseApprovalFlow }) {
  const router = useRouter();
  const [picked, setPicked] = useState(approvalFlow);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await setExpenseApprovalFlow(picked);
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: "Saved. Claims submitted from now on follow it." });
      router.refresh();
    });
  }

  return (
    <Card className="mt-5 max-w-2xl p-5">
      <fieldset>
        <legend className="text-sm font-medium text-text">Expense claims are approved by</legend>
        <div className="mt-3 space-y-2">
          {EXPENSE_APPROVAL_FLOWS.map((flow) => (
            <label
              key={flow}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-base border px-3 py-2.5 transition-colors",
                picked === flow ? "border-brand bg-brand-subtle/40" : "border-line hover:bg-surface-sunken",
              )}
            >
              <input
                type="radio"
                name="approvalFlow"
                value={flow}
                checked={picked === flow}
                onChange={() => setPicked(flow)}
                className="mt-1 accent-brand"
              />
              <span>
                <span className="block text-sm font-medium text-text">{expenseApprovalFlowLabels[flow]}</span>
                <span className="mt-0.5 block text-xs text-muted">{expenseApprovalFlowHints[flow]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-subtle">
        HR is everybody whose role holds “Approve expense claims (HR)” — the HR roles and Management to begin with
        (Settings › Roles &amp; Permissions). Nobody approves their own claim.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={pending || picked === approvalFlow}>
          Save
        </Button>
        {message && <span className={cn("text-sm", message.ok ? "text-success" : "text-danger")}>{message.text}</span>}
      </div>
    </Card>
  );
}
