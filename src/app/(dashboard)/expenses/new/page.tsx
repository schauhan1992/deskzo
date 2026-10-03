import Link from "next/link";
import { listCompanyOptions } from "@/actions/company";
import { getVisit } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { isModuleEntitled } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { visitPath } from "@/lib/record-links";

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ visitId?: string; companyId?: string }>;
}) {
  const enabled = await isModuleEnabled("expenses");
  if (!enabled) return <ModuleDisabledNotice moduleKey="expenses" />;

  const params = await searchParams;
  const [companies, visit, clock] = await Promise.all([
    listCompanyOptions(),
    params.visitId && (await isModuleEntitled("visits")) ? getVisit(params.visitId) : Promise.resolve(null),
    workspaceClock(),
  ]);

  return (
    <div>
      <div className="mb-5">
        <Link href={visit ? visitPath(visit.visitSeq) : "/expenses"} className="text-sm text-muted hover:text-text">
          ← {visit ? "Back to the visit" : "Expenses"}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">New expense</h1>
        <p className="mt-1 text-sm text-muted">
          Submit it to send it to your manager, or save it as a draft and submit a batch later.
        </p>
      </div>

      <ExpenseForm
        companies={companies}
        visit={visit ? { id: visit.id, visitSeq: visit.visitSeq, companyName: visit.company.name } : null}
        defaults={{
          category: visit ? "TRAVEL" : "OTHER",
          amount: "",
          taxAmount: "",
          spentOn: clock.today(),
          description: "",
          paymentMode: "CASH",
          reimbursable: true,
          visitId: params.visitId ?? "",
          companyId: params.companyId ?? "",
          leadId: "",
          receiptName: "",
        }}
      />
    </div>
  );
}
