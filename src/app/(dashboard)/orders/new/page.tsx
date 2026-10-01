import Link from "next/link";
import { listCompanyOptions, listAssignableUsers, listCommissionPartyOptions, listVendorOptions } from "@/actions/company";
import { listItemOptions } from "@/actions/item";
import { punchCustomerContext } from "@/actions/order-punch";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewOrderForm } from "@/components/orders/new-order-form";
import { customerRelationshipTypeValues, isCustomerRelationshipType } from "@/lib/validation/company";

/**
 * How many customers and products the page sends with the form. Each list is asked for one row more:
 * when that row comes back the list is incomplete, and the picker searches the server instead of
 * filtering what it was given. The pickers show a handful of matches at a time, so a book of
 * thousands only made the page slow to arrive.
 */
const CUSTOMERS_SENT = 300;
const ITEMS_SENT = 500;

/**
 * The customer the URL names (`?companyId=`, from a company's Products tab), as the picker shows it,
 * with what the form loads once a customer is chosen — or null.
 *
 * The prefill names a company in the URL, so it is checked rather than filtered: it is a lookup keyed
 * on an id a caller chose. Left unchecked it hands out that account's offices, its open proposals,
 * its end customers and which commission parties it is tied to, to anybody who can guess an id.
 *
 * Treated as absent rather than refused: this is a blank order form, not somebody's record, and an
 * unusable prefill is not a reason to deny the page. Only a company the customer picker itself would
 * offer is taken — in scope, a customer, not disqualified, not a reseller's end customer — so the
 * form opens either with that customer chosen or with nothing chosen.
 */
async function prefillFor(userId: string, companyId: unknown) {
  // A repeated query parameter arrives as an array; that is no id.
  if (typeof companyId !== "string" || !companyId) return null;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      customerCategory: { select: CATEGORY_SELECT },
      ownerUserId: true,
      stage: true,
      managedByResellerId: true,
    },
  });
  if (!company || !isCustomerRelationshipType(company.relationshipType)) return null;
  if (company.stage === "DISQUALIFIED" || company.managedByResellerId !== null) return null;
  if (!(await canSeeCompany(userId, company.ownerUserId))) return null;
  const context = await punchCustomerContext(company.id);
  if (!context) return null;
  const { id, name, relationshipType, customerCategory } = company;
  return { option: { id, name, relationshipType, customerCategory }, context };
}

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  // None of these waits on another, so they are asked together rather than one after the next.
  const [ordersEnabled, itemsEnabled, user, creditInPlan, resellersInPlan, canSeeRebates, { companyId }] = await Promise.all([
    isModuleEnabled("orders"),
    isModuleEnabled("items"),
    requireUser(),
    isModuleEntitled("receivables"),
    isModuleEntitled("resellers"),
    viewerHas("rebates.view"),
    searchParams,
  ]);
  if (!ordersEnabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }
  if (!itemsEnabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  // The prefill's lookups run beside the lists rather than before them.
  const [customerRows, itemRows, users, commissionParties, vendors, prefill] = await Promise.all([
    listCompanyOptions({ relationshipTypes: [...customerRelationshipTypeValues], withContacts: false, take: CUSTOMERS_SENT + 1 }),
    listItemOptions({ take: ITEMS_SENT + 1 }),
    listAssignableUsers(),
    // Every party, unflagged: which of them are tied to the customer comes with the customer's context.
    listCommissionPartyOptions(),
    // The distributors a salesperson may have a price from — the purchase side's vendors.
    listVendorOptions(),
    prefillFor(user.id, companyId),
  ]);

  const customerSearch = customerRows.length > CUSTOMERS_SENT;
  const sentCustomers = customerRows.slice(0, CUSTOMERS_SENT);
  // The prefilled customer is always in the list, wherever it falls in the alphabet, so the picker can name it.
  const companies =
    prefill && !sentCustomers.some((c) => c.id === prefill.option.id) ? [prefill.option, ...sentCustomers] : sentCustomers;
  const itemSearch = itemRows.length > ITEMS_SENT;

  return (
    <div>
      <div className="mb-5">
        <Link href="/orders" className="text-sm text-muted hover:text-text">
          ← Orders
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Punch order</h1>
        <p className="mt-1 text-sm text-muted">
          Log an order you received — Accounts approves its payment terms, then it goes to Purchasing.
        </p>
      </div>
      <NewOrderForm
        companies={companies}
        items={itemRows.slice(0, ITEMS_SENT)}
        // Only what the form shows: the people's email and phone stay on the server.
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        commissionParties={commissionParties.map((p) => ({ id: p.id, name: p.name }))}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        initialCompanyId={prefill?.option.id}
        initialContext={prefill?.context ?? null}
        customerSearch={customerSearch}
        itemSearch={itemSearch}
        creditInPlan={creditInPlan}
        resellersInPlan={resellersInPlan}
        canSeeRebates={canSeeRebates}
      />
    </div>
  );
}
