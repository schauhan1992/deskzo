import {
  listCompanyOptions,
  listAssignableUsers,
  listCommissionPartyOptions,
  listEndCustomers,
  listVendorOptions,
} from "@/actions/company";
import { listItemOptions } from "@/actions/item";
import { listCompanyLocationOptions } from "@/actions/company-location";
import { listProposalOptions } from "@/actions/order";
import { isModuleEnabled } from "@/actions/module";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewOrderForm } from "@/components/orders/new-order-form";
import { customerRelationshipTypeValues } from "@/lib/validation/company";

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  const [ordersEnabled, itemsEnabled] = await Promise.all([isModuleEnabled("orders"), isModuleEnabled("items")]);
  if (!ordersEnabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }
  if (!itemsEnabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const { companyId } = await searchParams;

  /**
   * The prefill names a company in the URL, so it is checked rather than filtered — nothing here
   * is a list the scope could narrow, they are four per-company lookups keyed on an id a caller
   * chose. Left unchecked they hand out that account's offices and addresses, its open proposals,
   * its end customers and which commission parties it is tied to, to anybody who can guess an id.
   *
   * Treated as absent rather than refused: this is a blank order form, not somebody's record, and
   * an unusable prefill is not a reason to deny the page. The company picker below is already
   * scoped, so the form simply opens with nothing chosen.
   */
  const user = await requireUser();
  const owner = companyId
    ? await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } })
    : null;
  const prefillId = owner && (await canSeeCompany(user.id, owner.ownerUserId)) ? companyId : undefined;

  const [companies, items, users, commissionParties, initialLocations, initialProposals, initialEndCustomers, vendors] =
    await Promise.all([
      listCompanyOptions({ relationshipTypes: [...customerRelationshipTypeValues] }),
      listItemOptions(),
      listAssignableUsers(),
      listCommissionPartyOptions(prefillId),
      prefillId ? listCompanyLocationOptions(prefillId) : Promise.resolve([]),
      prefillId ? listProposalOptions(prefillId) : Promise.resolve([]),
      prefillId ? listEndCustomers(prefillId) : Promise.resolve([]),
      // The distributors a salesperson may have a price from — the purchase side's vendors.
      listVendorOptions(),
    ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Punch order</h1>
      <p className="mt-1 text-sm text-muted">
        Log an order you received — it goes to Accounts for payment-terms approval, then to Purchasing before
        it&apos;s fulfilled. An in-hand order can be held back from Purchasing until you say, or scheduled for a day.
      </p>
      <div className="mt-6">
        <NewOrderForm
          companies={companies}
          items={items}
          users={users}
          commissionParties={commissionParties}
          vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
          initialCompanyId={prefillId}
          initialLocations={initialLocations}
          initialProposals={initialProposals}
          initialEndCustomers={initialEndCustomers}
          creditInPlan={await isModuleEntitled("receivables")}
          resellersInPlan={await isModuleEntitled("resellers")}
        />
      </div>
    </div>
  );
}
