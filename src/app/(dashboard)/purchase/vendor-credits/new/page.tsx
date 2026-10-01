import { vendorCreditIssuers } from "@/actions/vendor-credit";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { VendorCreditForm } from "@/components/rebates/vendor-credit-form";
import { istTodayKey } from "@/lib/orders/handoff-rules";

/** Recording a credit note or a payout from a distributor or an OEM — `rebates.manage`. */
export default async function NewVendorCreditPage() {
  const enabled = await isModuleEnabled("payables");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payables" />;
  if (!(await viewerHas("rebates.manage"))) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Record a credit</h1>
        <p className="mt-2 text-sm text-muted">Recording vendor credits is for whoever manages rebates.</p>
      </div>
    );
  }
  const issuers = await vendorCreditIssuers();
  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-semibold text-text">Record a credit</h1>
      <p className="mt-1 text-sm text-muted">
        A credit note a distributor or an OEM sent, or a rebate they paid into the bank. It posts to the books as soon as
        it is recorded: what we owe them goes down (or the bank up), and Purchase Rebates &amp; Discounts goes up.
      </p>
      <div className="mt-5">
        <VendorCreditForm issuers={issuers.map((c) => ({ id: c.id, name: c.name }))} today={istTodayKey(new Date())} />
      </div>
    </div>
  );
}
