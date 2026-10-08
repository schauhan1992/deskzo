import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listBankAccounts, reconciliationView, unclearedCheques } from "@/actions/bank";
import { getOrganisation } from "@/lib/organisation";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { BankingManager } from "@/components/accounting/banking-manager";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";

export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; to?: string; balance?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;
  // The finance function's (`payments.manage`), like every action behind the page: without it the
  // page is not there, the same as its link (owner, 8 Oct 2026 — pages you can't open are a 404).
  if (!(await viewerHas("payments.manage"))) notFound();

  const params = await searchParams;
  const [accounts, cheques, org] = await Promise.all([listBankAccounts(), unclearedCheques(), getOrganisation()]);

  // Defaults to the account marked default, so the page is useful without a click.
  const selectedId = params.account ?? accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id;
  const view = selectedId
    ? await reconciliationView({
        bankAccountId: selectedId,
        to: params.to,
        statementBalance: params.balance ? Number(params.balance) : undefined,
      })
    : null;

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Banking"
        subtitle="Accounts, cheques that haven't cleared, and agreeing the books with the statement"
        organisation={org.legalName}
      />
      <div className="mt-5">
        <BankingManager accounts={accounts} cheques={cheques} view={view} />
      </div>
    </div>
  );
}
