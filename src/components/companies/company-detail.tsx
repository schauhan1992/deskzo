import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, listAssignableUsers, listVendorOptions, listClientCompanyNameOptions, listEndCustomers } from "@/actions/company";
import {
  listLinkedCompanies,
  listCommissionPartyAccounts,
  listCompanyCommissionParties,
  listCompanyCommissions,
  listCommissionPartyOptions,
  listCommissionPartyEarnings,
} from "@/actions/commission-party";
import { listCompanyDocuments } from "@/actions/trade-document";
import { listCompanyVisits } from "@/actions/visit";
import { customerStatement } from "@/actions/receivable";
import { expenseSummary } from "@/actions/expense";
import { listCompanyPayments, companyPaymentSummary } from "@/actions/payment";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { NO_DIRECT_CONTACT_NOTICE } from "@/lib/reseller";
import { getResellerOnboarding, getResellerCreditSummary, listResellerItemPrices } from "@/actions/reseller";
import { onboardingChecklist, isOnboardingComplete } from "@/lib/reseller-onboarding";
import { ResellerOnboardingPanel } from "@/components/companies/reseller-onboarding-panel";
import { ResellerPricingManager } from "@/components/companies/reseller-pricing-manager";
import { Lock } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { canBroadcastNotes } from "@/actions/note";
import { RecordNotes } from "@/components/notes/record-notes";
import { listItemOptions } from "@/actions/item";
import { listTickets } from "@/actions/ticket";
import { estateCount } from "@/actions/it-asset";
import { listTasks } from "@/actions/task";
import { listProjects } from "@/actions/project";
import { CompanyProjects } from "@/components/companies/company-projects";
import { getCreditProfile } from "@/actions/credit";
import { CompanyCredit } from "@/components/credit/company-credit";
import { CreditBadge } from "@/components/credit/credit-badge";
import { getSupportLoad } from "@/actions/support-load";
import { companyMailSummary, listMailLog } from "@/actions/mail-log";
import { CompanyEmails } from "@/components/mail-log/company-emails";
import { CompanyForms } from "@/components/forms/company-forms";
import { companyFormResponses } from "@/actions/forms";
import { SupportLevelBadge, SupportLoadPanel } from "@/components/support/support-load-panel";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { mayChangeAccountManager, mayChangeCaller, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/ui/tab-nav";
import { CompanyPortalPanel } from "@/components/portal/company-portal-panel";
import { portalLogins, portalStatusFor } from "@/actions/portal";
import { formatDate, formatCurrency } from "@/lib/utils";
import { ContactsList } from "@/components/companies/contacts-list";
import { ActivityPanelButton } from "@/components/companies/activity-panel-button";
import { CompanyProductsList } from "@/components/companies/company-products-list";
import { LocationsManager } from "@/components/companies/locations-manager";
import { AccountManagerButton } from "@/components/companies/account-manager-button";
import { CallerButton } from "@/components/companies/caller-button";
import { CallButton } from "@/components/calls/call-button";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { CompanyLinks } from "@/components/companies/company-links";
import { CompanyStageBadge } from "@/components/companies/company-stage-badge";
import { CategoryChip, CategoryGuidance } from "@/components/customers/category-chip";
import { CategoryPicker } from "@/components/customers/category-picker";
import { listCustomerCategories } from "@/actions/customer-category";
import { LeadStatusBadge } from "@/components/leads/lead-status-badge";
import { CallList } from "@/components/calls/call-list";
import { DomainPanel } from "@/components/domains/domain-panel";
import { getDomainBriefing } from "@/actions/domain";
import { listCompanyCalls } from "@/actions/call";
import { VendorStatusControl } from "@/components/companies/vendor-status-control";
import { VendorCodeButton } from "@/components/companies/vendor-code-button";
import { PayoutDetailsButton } from "@/components/companies/payout-details-button";
import { LinkedCompaniesManager } from "@/components/companies/linked-companies-manager";
import { CommissionPartyAccountsManager } from "@/components/companies/commission-party-accounts-manager";
import { CompanyDocuments } from "@/components/companies/company-documents";
import { CompanyPayments } from "@/components/companies/company-payments";
import { CompanyCommission } from "@/components/companies/company-commission";
import { CommissionPartyEarnings } from "@/components/companies/commission-party-earnings";
import { CompanyVisits } from "@/components/companies/company-visits";
import { CompanyStatement } from "@/components/companies/company-statement";
import { CompanyEstate } from "@/components/companies/company-estate";
import { CompanyFeedback } from "@/components/companies/company-feedback";
import { CompanyMarketing } from "@/components/companies/company-marketing";
import { TicketsTable } from "@/components/tickets/tickets-table";
import { TaskList } from "@/components/tasks/task-list";
import { getRenewalStatus } from "@/lib/renewals";
import { formatOrderId } from "@/lib/order-id";
import { paymentTermsLabels } from "@/lib/gst";
import { relationshipTypeLabels, vendorStatusLabels } from "@/lib/validation/company";
import { headcountLabel } from "@/lib/company-size";
import { isModuleEntitled } from "@/lib/modules-access";

const CLOSED_STATUSES = ["WON", "LOST", "DISQUALIFIED"];

/**
 * A company's 360 view. Rendered on its own page and again inside the split view on any of the
 * lists that are really companies — Companies, Customers, Vendors, Resellers, Commission parties —
 * so the five of them can't drift apart.
 *
 * `basePath` and `linkParams` are what let the tabs stay put when embedded: a tab link has to go
 * back to the list with the record still open, not navigate off to /companies/<id>.
 */
export async function CompanyDetail({
  id,
  tab,
  basePath,
  linkParams = {},
}: {
  id: string;
  tab?: string;
  /** Where the tab links point. Defaults to this company's own page. */
  basePath?: string;
  /** Query params a tab link must preserve — the list's filters and which record is open. */
  linkParams?: Record<string, string | undefined>;
}) {
  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [
    itemsEnabled,
    renewalsEnabled,
    helpdeskEnabled,
    tasksEnabled,
    canEditProducts,
    canDeleteProducts,
    canRecordPayments,
    canDeletePayments,
    canCreateTickets,
    canDeleteAnyTask,
    salesDocsEnabled,
    purchaseDocsEnabled,
    paymentsEnabled,
    visitsEnabled,
    receivablesEnabled,
    callsEnabled,
    domainsEnabled,
    itAssetsEnabled,
    canManageAssets,
    canViewAssets,
    feedbackEnabled,
    marketingEnabled,
    canViewMarketing,
    notesEnabled,
    canBroadcastNote,
    canManagePortal,
    canSeeContacts,
    canSeeLeads,
    canSeeOrders,
    projectsEnabled,
    canManageProjects,
    canMerge,
  ] = await Promise.all([
    isModuleEnabled("items"),
    isModuleEnabled("renewals"),
    isModuleEnabled("helpdesk"),
    isModuleEnabled("tasks"),
    hasEffectivePermission(userId, "products.edit"),
    hasEffectivePermission(userId, "products.delete"),
    hasEffectivePermission(userId, "payments.record"),
    hasEffectivePermission(userId, "payments.delete"),
    hasEffectivePermission(userId, "tickets.create"),
    hasEffectivePermission(userId, "tasks.delete"),
    isModuleEnabled("sales_documents"),
    isModuleEnabled("purchase_documents"),
    isModuleEnabled("payments"),
    isModuleEnabled("visits"),
    isModuleEnabled("receivables"),
    isModuleEnabled("calls"),
    isModuleEnabled("domains"),
    isModuleEnabled("it_assets"),
    hasEffectivePermission(userId, "assets.manage"),
    hasEffectivePermission(userId, "assets.viewAll"),
    isModuleEnabled("feedback"),
    isModuleEnabled("marketing"),
    hasEffectivePermission(userId, "marketing.viewAll"),
    isModuleEnabled("notes"),
    canBroadcastNotes(),
    hasEffectivePermission(userId, "portal.manage"),
    // The `*.view` permissions. The module-shaped ones (documents, payments, visits, calls,
    // tickets, renewals, projects) are already inside `isModuleEnabled` above; these three have no
    // module of their own to ride on, so they are asked for directly.
    hasEffectivePermission(userId, "contacts.view"),
    hasEffectivePermission(userId, "leads.view"),
    hasEffectivePermission(userId, "orders.view"),
    isModuleEnabled("projects"),
    hasEffectivePermission(userId, "projects.manage"),
    hasEffectivePermission(userId, "companies.merge"),
  ]);
  const [company, itemOptions, companyTickets, companyTasks, assignableUsers, vendorOptions, companyCalls, domainBriefing, companyProjects, customerCategories] = await Promise.all([
    getCompany(id),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    helpdeskEnabled ? listTickets({ companyId: id }) : Promise.resolve([]),
    tasksEnabled ? listTasks({ companyId: id }) : Promise.resolve([]),
    listAssignableUsers(),
    itemsEnabled ? listVendorOptions() : Promise.resolve([]),
    callsEnabled ? listCompanyCalls(id) : Promise.resolve([]),
    domainsEnabled ? getDomainBriefing(id) : Promise.resolve(null),
    projectsEnabled ? listProjects({ companyId: id }) : Promise.resolve([]),
    listCustomerCategories(),
  ]);
  if (!company) notFound();

  // A vendor is who we buy from, not who we sell to — the sales-pipeline-shaped tabs (Products &
  // Subscriptions, Leads, Renewals) track what a company has bought from Wroffy, which doesn't
  // apply. Resellers are on the buying side, so they keep those tabs: their orders are real orders.
  const isVendor = !isCustomerRelationshipType(company.relationshipType);
  // Who may move this account, decided by the same rules the actions enforce — see
  // src/lib/authz/reassign.ts — so the buttons below are shown only to people they will work for.
  const reassign = await reassignRights(userId);
  const holders = { ownerUserId: company.owner?.id ?? null, assignedToUserId: company.assignedTo?.id ?? null };
  const canChangeManager = mayChangeAccountManager(reassign, userId, holders);
  const canChangeCaller = mayChangeCaller(reassign, userId, holders);
  const canUnassign = mayLeaveUnassigned(reassign);
  const isCommissionParty = company.relationshipType === "COMMISSION_PARTY";
  const isReseller = company.relationshipType === "RESELLER";
  const managedByReseller = company.managedByReseller;
  // Modules this page borrows from without a switch of their own here: each only where the plan has it.
  const [commissionsInPlan, expensesInPlan, resellersInPlan, portalInPlan] = await Promise.all([
    isModuleEntitled("commission_parties"),
    isModuleEntitled("expenses"),
    isModuleEntitled("resellers"),
    isModuleEntitled("customer_portal"),
  ]);
  const resellerTools = isReseller && resellersInPlan;

  // The estate tab earns its place when there is an estate to show, or when this is somebody we
  // actually serve and whoever manages assets needs a way in to record their first machine. A
  // prospect nobody has shipped a laptop to shouldn't carry an empty tab around.
  const assetsVisible = itAssetsEnabled && (canViewAssets || canManageAssets);
  const showEstateTab =
    assetsVisible &&
    ((canManageAssets && !isVendor && company.stage === "CUSTOMER") || (await estateCount(company.id)) > 0);

  const [linkedCompanies, commissionPartyAccounts, clientCompanyOptions, commissionEarnings] = isCommissionParty && commissionsInPlan
    ? await Promise.all([
        listLinkedCompanies(company.id),
        listCommissionPartyAccounts(company.id),
        listClientCompanyNameOptions(),
        listCommissionPartyEarnings(company.id),
      ])
    : [[], [], [], []];

  // The 360 view: everything raised for, received from, or paid out on this account. Loaded here
  // rather than per-tab because the header counts need them regardless of which tab is open.
  const documentsEnabled = isVendor ? purchaseDocsEnabled : salesDocsEnabled;
  const [visits, visitExpenses] = visitsEnabled
    ? await Promise.all([listCompanyVisits(company.id), expensesInPlan ? expenseSummary({ companyId: company.id }) : null])
    : [[], null];

  // The statement is a customer-side view; a vendor has no receivable against us.
  const showStatement = receivablesEnabled && !isVendor;
  const statement = showStatement ? await customerStatement(company.id) : null;

  // Credit is money about the account, so it rides on the payments view like the billed figures do.
  const [documents, companyPayments, paymentSummary, creditProfile, supportLoad, mailSummary, companyForms] = await Promise.all([
    documentsEnabled ? listCompanyDocuments(company.id) : Promise.resolve([]),
    paymentsEnabled ? listCompanyPayments(company.id) : Promise.resolve([]),
    paymentsEnabled ? companyPaymentSummary(company.id) : Promise.resolve(null),
    // The credit engine is Receivables': a plan with payments and without it has no profile to show.
    paymentsEnabled && !isVendor && (await isModuleEntitled("receivables")) ? getCreditProfile(company.id) : Promise.resolve(null),
    // How much support they take against what they pay — beside their tickets, where it is judged.
    helpdeskEnabled && !isVendor ? getSupportLoad(company.id) : Promise.resolve(null),
    // Null without `emails.view` or outside the account scope — and then there is no Emails tab.
    !isVendor ? companyMailSummary(company.id) : Promise.resolve(null),
    // Only the forms whose answers are shared with this viewer — and no tab when there are none.
    !isVendor && (await isModuleEntitled("forms")) ? companyFormResponses(company.id) : Promise.resolve(null),
  ]);
  const showFormsTab = Boolean(companyForms && (companyForms.responses.length > 0 || companyForms.waiting.length > 0));

  // Commission is paid on a customer's business, so it's a customer-side view; a commission party
  // sees the mirror of it (what they earned) on their own Details tab instead.
  const showCommissionTab = !isVendor && commissionsInPlan;
  const [commissionParties, commissions, commissionPartyOptions] = showCommissionTab
    ? await Promise.all([
        listCompanyCommissionParties(company.id),
        listCompanyCommissions(company.id),
        listCommissionPartyOptions(),
      ])
    : [[], [], []];
  const endCustomers = isReseller ? await listEndCustomers(company.id) : [];
  const [resellerOnboarding, resellerCredit, resellerPrices] = resellerTools
    ? await Promise.all([
        getResellerOnboarding(company.id),
        getResellerCreditSummary(company.id),
        listResellerItemPrices(company.id),
      ])
    : [null, null, []];
  const resellerChecklist = resellerOnboarding ? onboardingChecklist(resellerOnboarding.inputs) : [];
  // The order is billed to the reseller, but the product/subscription belongs to the end customer —
  // their seats, their expiry, their support — so it shows in *their* Products & Subscriptions.
  // A normal client has no `ordersAsEndCustomer`, so this is just `products` for everyone else.
  const productRows = [...company.products, ...company.ordersAsEndCustomer];
  // A won deal only counts as a real Customer once it has at least one order on file (even an
  // expired one) — otherwise it's shown as "Awaiting Order" rather than a misleading "CUSTOMER".
  // Only said to someone who can see the orders — without `orders.view` the list is empty because it
  // was left out, not because there are none.
  const isAwaitingOrder = canSeeOrders && company.stage === "CUSTOMER" && productRows.length === 0;

  const tabs = [
    { key: "details", label: "Details" },
    ...(!isVendor && itemsEnabled && canSeeOrders ? [{ key: "products", label: "Products & Subscriptions" }] : []),
    ...(documentsEnabled ? [{ key: "documents", label: "Documents" }] : []),
    ...(paymentsEnabled && !isVendor ? [{ key: "payments", label: "Payments" }] : []),
    ...(creditProfile ? [{ key: "credit", label: "Credit" }] : []),
    ...(showStatement ? [{ key: "statement", label: "Statement" }] : []),
    ...(showCommissionTab ? [{ key: "commission", label: "Commission" }] : []),
    ...(visitsEnabled ? [{ key: "visits", label: "Visits" }] : []),
    ...(callsEnabled ? [{ key: "calls", label: "Calls" }] : []),
    ...(!isVendor && canSeeLeads ? [{ key: "leads", label: "Leads" }] : []),
    ...(!isVendor && projectsEnabled ? [{ key: "projects", label: "Projects" }] : []),
    ...(!isVendor && itemsEnabled && renewalsEnabled ? [{ key: "renewals", label: "Renewals" }] : []),
    { key: "locations", label: "Locations" },
    ...(canSeeContacts ? [{ key: "contacts", label: "Contacts" }] : []),
    ...(showEstateTab ? [{ key: "assets", label: "IT Assets" }] : []),
    ...(feedbackEnabled && !isVendor ? [{ key: "feedback", label: "Feedback" }] : []),
    ...(marketingEnabled && canViewMarketing && !isVendor ? [{ key: "marketing", label: "Marketing" }] : []),
    ...(helpdeskEnabled ? [{ key: "tickets", label: "Tickets" }] : []),
    ...(mailSummary ? [{ key: "emails", label: "Emails" }] : []),
    ...(showFormsTab ? [{ key: "forms", label: "Forms" }] : []),
    ...(tasksEnabled ? [{ key: "tasks", label: "Tasks" }] : []),
    ...(canManagePortal && portalInPlan && !isVendor ? [{ key: "portal", label: "Portal" }] : []),
  ];
  /** A link to one of the tabs below, keeping the list filters when embedded — as `TabNav` builds them. */
  const tabHref = (key: string) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(linkParams)) if (v) query.set(k, v);
    query.set("tab", key);
    return `${basePath ?? `/companies/${company.id}`}?${query}`;
  };
  const primaryLocation = company.locations.find((l) => l.isPrimary) ?? company.locations[0];
  const activeTab = tabs.some((t) => t.key === tab) ? tab! : "details";
  // The rows only when the tab is open; the counts above are cheap and always there.
  const recentMail = activeTab === "emails" && mailSummary ? await listMailLog({ companyId: company.id, page: 1, pageSize: 50 }) : null;

  // Renewals follow the subscription, so an end customer sees the expiries bought for them too.
  //
  // Parents only, exactly as the renewals page does it: an addon co-terminates with the
  // subscription it was added to and comes back with it, so listing it separately would turn one
  // renewal conversation into four — and offer a Renew button that renews part of a term.
  const subscriptionProducts = productRows
    .filter((p) => p.item.type === "SUBSCRIPTION" && p.parentId === null)
    .sort((a, b) => {
      if (!a.endDate && !b.endDate) return 0;
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

  /** Seats added part-way through a term, which come back with the parent at renewal. */
  const addedSeats = (p: { addons?: { quantity: number }[] }) =>
    (p.addons ?? []).reduce((total, a) => total + a.quantity, 0);
  /** Whoever the call button should open on, rather than making somebody pick. */
  const callableContact = company.contacts.find((c) => c.phone) ?? undefined;

  const wonLeads = company.leads.filter((l) => l.status === "WON");
  const lostLeads = company.leads.filter((l) => l.status === "LOST" || l.status === "DISQUALIFIED");
  const openLeads = company.leads.filter((l) => !CLOSED_STATUSES.includes(l.status));
  const wonValue = wonLeads.reduce((sum, l) => sum + Number(l.estimatedValue ?? 0), 0);
  const openValue = openLeads.reduce((sum, l) => sum + Number(l.estimatedValue ?? 0), 0);

  const timeline = company.leads
    .flatMap((l) => l.activities.map((a) => ({ ...a, leadId: l.id, leadTitle: l.title })))
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  return (
    <div className="@container space-y-6">
      {managedByReseller && (
        <div className="rounded-md border border-warning bg-warning-bg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning">
            <Lock className="h-4 w-4" />
            Reseller-managed customer — do not contact directly
          </div>
          <p className="mt-1 text-sm text-warning">
            {company.name} is a customer of{" "}
            <Link href={`/companies/${managedByReseller.id}`} className="font-medium underline">
              {managedByReseller.name}
            </Link>
            . {NO_DIRECT_CONTACT_NOTICE} They&apos;re excluded from the Companies and Customer lists and from
            marketing sends, and their contact details are hidden unless you have the &ldquo;View reseller-managed
            contact details&rdquo; permission.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{company.name}</h1>
            {/* Who this customer is, before anything else on the page. Whoever can open the account can
                edit it, so whoever can see this can change it. */}
            <CategoryPicker companyId={company.id} current={company.customerCategory} categories={customerCategories} canEdit />
            {managedByReseller && <Badge tone="amber">Reseller-managed</Badge>}
            {isReseller && <Badge tone="blue">Reseller</Badge>}
            {!isVendor && <CompanyStageBadge stage={company.stage} awaitingOrder={isAwaitingOrder} />}
            {isVendor && (
              <Badge tone="amber">{relationshipTypeLabels[company.relationshipType]}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {[company.industry?.name, primaryLocation?.city, primaryLocation?.state, primaryLocation?.country]
              .filter(Boolean)
              .join(" · ") || "No details yet"}
          </p>
          <CompanyLinks website={company.website} linkedinUrl={company.linkedinUrl} />
          {company.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {company.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
          <CategoryGuidance category={company.customerCategory} className="mt-3 max-w-3xl" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Not for a reseller's end customer: the same rule that stops us emailing them stops us
              ringing them (src/lib/reseller.ts). The banner above says who to go through. */}
          {callsEnabled && !managedByReseller && (
            <CallButton companyId={company.id} companyName={company.name} />
          )}
          {isVendor && company.vendorStatus && (
            <VendorStatusControl companyId={company.id} status={company.vendorStatus} />
          )}
          <AccountManagerButton
            companyId={company.id}
            owner={company.owner}
            users={assignableUsers}
            canChange={canChangeManager}
            canUnassign={canUnassign}
          />
          {!isVendor && (
            <CallerButton
              companyId={company.id}
              caller={company.assignedTo}
              users={assignableUsers}
              canChange={canChangeCaller}
              canUnassign={canUnassign}
            />
          )}
          {isVendor && <VendorCodeButton companyId={company.id} vendorCode={company.vendorCode} />}
          {/* Resellers need this for the PAN their onboarding KYC step checks. */}
          {(isReseller || (isVendor && !isCommissionParty)) && (
            <PayoutDetailsButton
              companyId={company.id}
              details={{
                panNumber: company.panNumber,
                bankAccountName: company.bankAccountName,
                bankAccountNumber: company.bankAccountNumber,
                bankIfsc: company.bankIfsc,
                bankName: company.bankName,
              }}
            />
          )}
          {!isVendor && canSeeLeads && <ActivityPanelButton timeline={timeline} />}
          <Link href={`/companies/${company.id}/edit`}>
            <Button variant="secondary">Edit</Button>
          </Link>
          {canMerge && (
            <Link href={`/companies/merge?keep=${company.id}`} title="This company stays; pick the duplicate to fold into it">
              <Button variant="ghost">Merge a duplicate</Button>
            </Link>
          )}
          {!isVendor && canSeeLeads && (
            <Link href={`/leads/new?companyId=${company.id}`}>
              <Button>New lead</Button>
            </Link>
          )}
        </div>
      </div>

      {isVendor ? (
        <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-4">
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-subtle">Status</div>
            <div className="mt-1 text-xl font-semibold text-text">
              {company.vendorStatus ? vendorStatusLabels[company.vendorStatus] : "—"}
            </div>
            <div className="mt-0.5 text-xs text-muted">{relationshipTypeLabels[company.relationshipType]}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-subtle">Locations</div>
            <div className="mt-1 text-xl font-semibold text-text">{company.locations.length}</div>
          </Card>
          {canSeeContacts && (
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wide text-subtle">Contacts</div>
              <div className="mt-1 text-xl font-semibold text-text">{company.contacts.length}</div>
            </Card>
          )}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-subtle">Added on</div>
            <div className="mt-1 text-xl font-semibold text-text">{formatDate(company.createdAt)}</div>
          </Card>
        </div>
      ) : (
        // Pipeline on the left, real money in the middle, recency on the right — the whole account
        // in one row, which is the point of a 360 view.
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @5xl:grid-cols-6">
          {/* Each card only for someone who may see what it counts — a figure with its source
              withheld is still the thing withheld. */}
          {canSeeLeads && (
            <>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-wide text-subtle">Leads</div>
                <div className="mt-1 text-lg font-semibold text-text">{company.leads.length}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {openLeads.length} open · {wonLeads.length} won · {lostLeads.length} lost
                </div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-wide text-subtle">Open pipeline</div>
                <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(openValue)}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {formatCurrency(wonValue)} won across {wonLeads.length} lead(s)
                </div>
              </Card>
            </>
          )}
          {documentsEnabled && (
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wide text-subtle">Documents</div>
              <div className="mt-1 text-lg font-semibold text-text">{documents.length}</div>
              <div className="mt-0.5 text-xs text-muted">
                {documents.filter((d) => d.docType === "INVOICE").length} invoice(s)
              </div>
            </Card>
          )}
          {paymentSummary && (
            <>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-wide text-subtle">Billed</div>
                <div className="mt-1 text-lg font-semibold text-text">{formatCurrency(paymentSummary.billed)}</div>
                <div className="mt-0.5 text-xs text-muted">{formatCurrency(paymentSummary.received)} received</div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-wide text-subtle">Outstanding</div>
                <div
                  className={`mt-1 text-lg font-semibold ${paymentSummary.outstanding > 0 ? "text-danger" : "text-text"}`}
                >
                  {formatCurrency(paymentSummary.outstanding)}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {paymentSummary.credit > 0
                    ? `${formatCurrency(paymentSummary.credit)} in credit`
                    : paymentSummary.unallocated > 0
                      ? `${formatCurrency(paymentSummary.unallocated)} unallocated`
                      : "Fully allocated"}
                </div>
              </Card>
            </>
          )}
          {creditProfile && (
            <Link href={tabHref("credit")} className="block">
              <Card className="h-full p-4 transition hover:border-line-strong">
                <div className="text-xs uppercase tracking-wide text-subtle">Credit</div>
                <div className="mt-1.5">
                  <CreditBadge rating={creditProfile.rating} score={creditProfile.score} />
                </div>
                <div className={`mt-1 text-xs ${creditProfile.termsBeyond ? "text-warning" : "text-muted"}`}>
                  Up to {paymentTermsLabels[creditProfile.recommendedTerms]} · limit {formatCurrency(creditProfile.limit)}
                </div>
              </Card>
            </Link>
          )}
          {supportLoad && (
            <Link href={tabHref("tickets")} className="block">
              <Card className="h-full p-4 transition hover:border-line-strong">
                <div className="text-xs uppercase tracking-wide text-subtle">Support</div>
                <div className="mt-1 text-lg font-semibold text-text">{supportLoad.tickets} ticket(s)</div>
                <div className="mt-0.5">
                  <SupportLevelBadge level={supportLoad.level} multiple={supportLoad.multiple} />
                </div>
              </Card>
            </Link>
          )}
          {canSeeLeads && (
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wide text-subtle">Last activity</div>
              <div className="mt-1 text-lg font-semibold text-text">{formatDate(timeline[0]?.occurredAt ?? null)}</div>
              <div className="mt-0.5 text-xs text-muted">{timeline.length} logged total</div>
            </Card>
          )}
        </div>
      )}

      <TabNav
        tabs={tabs}
        activeKey={activeTab}
        basePath={basePath ?? `/companies/${company.id}`}
        otherParams={linkParams}
      />

      <div className="space-y-6">
        {activeTab === "details" && (
          <>
            {/* First, not last: a note on an account ("they always order in March", "never ring
                before 11") is a heads-up, and a heads-up below eight cards of profile data is a
                note nobody reads. */}
            {notesEnabled && <RecordNotes companyId={company.id} canBroadcast={canBroadcastNote} />}

            {/* Billing and shipping, on the profile rather than only under Locations.

                These are the two addresses anybody raising a document needs, and having to open
                another tab to read them is how they end up being typed from memory. Shown even
                when neither is marked, because an account with no billing address on file is
                something to fix rather than something to hide. */}
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                Addresses
                <Link href={`?tab=locations`} className="text-xs font-medium text-muted hover:text-text hover:underline">
                  All {company.locations.length}
                </Link>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <AddressBlock
                  title="Billing"
                  locations={company.locations.filter((l) => l.isBilling)}
                  empty="No billing address marked. Tick one under Locations and documents will default to it."
                />
                <AddressBlock
                  title="Shipping"
                  locations={company.locations.filter((l) => l.isShipping)}
                  empty="No shipping address marked."
                />
              </CardContent>
            </Card>
            {isReseller && resellerOnboarding && resellerCredit && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Reseller onboarding</CardHeader>
                <CardContent>
                  <ResellerOnboardingPanel
                    companyId={company.id}
                    profile={resellerOnboarding.profile}
                    checklist={resellerChecklist}
                    credit={resellerCredit}
                    users={assignableUsers}
                    complete={isOnboardingComplete(resellerOnboarding.inputs)}
                  />
                </CardContent>
              </Card>
            )}

            {resellerTools && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Special reseller pricing</CardHeader>
                <CardContent>
                  <ResellerPricingManager
                    resellerId={company.id}
                    prices={resellerPrices}
                    items={itemOptions}
                    discountPercent={
                      resellerOnboarding?.profile.discountPercent != null
                        ? Number(resellerOnboarding.profile.discountPercent)
                        : null
                    }
                  />
                </CardContent>
              </Card>
            )}

            {isReseller && (
              <Card>
                <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                  <span>End customers</span>
                  <Link href={`/resellers/${company.id}/end-customers/new`}>
                    <Button variant="secondary" size="sm">
                      + Add end customer
                    </Button>
                  </Link>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-xs text-muted">
                    Customers {company.name} buys for. We never contact them directly — they&apos;re kept out of the
                    Companies and Customer lists and excluded from marketing.
                  </p>
                  {endCustomers.length === 0 && (
                    <p className="text-subtle">No end customers recorded yet.</p>
                  )}
                  {endCustomers.map((ec) => (
                    <div key={ec.id} className="flex items-center justify-between border-t border-line pt-2">
                      <Link href={`/companies/${ec.id}`} className="font-medium text-text hover:underline">
                        {ec.name}
                      </Link>
                      <span className="text-muted">
                        {ec._count.ordersAsEndCustomer} order(s)
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {isVendor && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">
                  {isCommissionParty ? "Commission party details" : "Vendor details"}
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Type</span>
                    <span className="text-text">{relationshipTypeLabels[company.relationshipType]}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Onboarding status</span>
                    <span className="text-text">
                      {company.vendorStatus ? vendorStatusLabels[company.vendorStatus] : "—"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">{isCommissionParty ? "Reference code" : "Vendor code"}</span>
                    <span className="text-text">{company.vendorCode ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Payment terms (from us to them)</span>
                    <span className="text-text">{paymentTermsLabels[company.paymentTerms]}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {(isReseller || (isVendor && !isCommissionParty)) && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">
                  {isReseller ? "PAN & bank details" : "Payout details"}
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">PAN</span>
                    <span className="text-text">{company.panNumber ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Bank</span>
                    <span className="text-text">{company.bankName ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Account holder</span>
                    <span className="text-text">{company.bankAccountName ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Account number</span>
                    <span className="text-text">{company.bankAccountNumber ?? "—"}</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">IFSC</span>
                    <span className="text-text">{company.bankIfsc ?? "—"}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {isCommissionParty && commissionsInPlan && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Linked companies</CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted">
                    The customer companies this commission party refers business from — commission on their orders gets
                    paid out to this party.
                  </p>
                  <LinkedCompaniesManager
                    ownerId={company.id}
                    side="commissionParty"
                    links={linkedCompanies}
                    companyOptions={clientCompanyOptions}
                  />
                </CardContent>
              </Card>
            )}

            {isCommissionParty && commissionsInPlan && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Commission earned</CardHeader>
                <CardContent>
                  <CommissionPartyEarnings earnings={commissionEarnings} />
                </CardContent>
              </Card>
            )}

            {isCommissionParty && commissionsInPlan && (
              <Card>
                <CardHeader className="text-sm font-medium text-text">Related parties (payee accounts)</CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted">
                    This commission party may want to be paid into different accounts — their own, a firm, or a family
                    member&apos;s — for different deals. Add one entry per account.
                  </p>
                  <CommissionPartyAccountsManager commissionPartyId={company.id} accounts={commissionPartyAccounts} />
                </CardContent>
              </Card>
            )}

            {domainsEnabled && domainBriefing && (
              <DomainPanel companyId={company.id} briefing={domainBriefing} />
            )}

            <Card>
              <CardHeader className="text-sm font-medium text-text">Company profile</CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Industry</span>
                  <span className="text-text">{company.industry?.name ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Company type</span>
                  <span className="text-text">{company.companyType?.replaceAll("_", " ") ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Relationship</span>
                  <span className="text-text">{relationshipTypeLabels[company.relationshipType]}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Category</span>
                  {company.customerCategory ? <CategoryChip category={company.customerCategory} /> : <span className="text-text">—</span>}
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Employees</span>
                  <span className="text-text">{headcountLabel(company.employeeCount) ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Website</span>
                  <span className="text-text">{company.website ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">LinkedIn</span>
                  <span className="text-text">{company.linkedinUrl ?? "—"}</span>
                </div>
                {!isVendor && (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Payment terms</span>
                    <span className="text-text">{paymentTermsLabels[company.paymentTerms]}</span>
                  </div>
                )}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">D-U-N-S number</span>
                  <span className="text-text">{company.dunsNumber ?? "—"}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="text-sm font-medium text-text">Record info</CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Source</span>
                  <span className="text-text">{company.source}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Account manager</span>
                  <span className="text-text">{company.owner?.name ?? "—"}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Caller</span>
                  <span className="text-text">{company.assignedTo?.name ?? "Unassigned"}</span>
                </div>
                {company.assignedBy && (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-muted">Caller assigned by</span>
                    <span className="text-text">
                      {company.assignedBy.name} · {formatDate(company.assignedAt)}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Added by</span>
                  <span className="text-text">{company.createdBy.name}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-muted">Added on</span>
                  <span className="text-text">{formatDate(company.createdAt)}</span>
                </div>
              </CardContent>
            </Card>
          </>
        )}

          {activeTab === "products" && itemsEnabled && canSeeOrders && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">
                {isReseller ? "Orders placed (billed to this reseller)" : "Products & Subscriptions"}
              </CardHeader>
              <CardContent>
                {managedByReseller && (
                  <p className="mb-3 text-xs text-muted">
                    Bought for them by {managedByReseller.name}. The subscription and support are this customer&apos;s;
                    the invoice sits with the reseller.
                  </p>
                )}
                {isReseller && (
                  <p className="mb-3 text-xs text-muted">
                    What this reseller has ordered and owes us. Anything bought for an end customer also appears in
                    that customer&apos;s own Products &amp; Subscriptions.
                  </p>
                )}
                <CompanyProductsList
                  companyId={company.id}
                  companyName={company.name}
                  products={productRows}
                  items={itemOptions}
                  locations={company.locations}
                  vendors={vendorOptions}
                  canEdit={canEditProducts}
                  canDelete={canDeleteProducts}
                  // Payments against an order are the Payments module's; seats added mid-term, Renewals'.
                  canRecordPayments={canRecordPayments && paymentsEnabled}
                  canDeletePayments={canDeletePayments && paymentsEnabled}
                  canAddSeats={await isModuleEntitled("renewals")}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "documents" && documentsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">
                {isVendor ? "Purchase documents" : "Sales documents"}
              </CardHeader>
              <CardContent>
                <CompanyDocuments
                  companyId={company.id}
                  documents={documents}
                  isVendor={isVendor}
                  managedByResellerName={managedByReseller?.name}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "payments" && paymentsEnabled && paymentSummary && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Payments</CardHeader>
              <CardContent>
                <CompanyPayments
                  companyId={company.id}
                  companyName={company.name}
                  payments={companyPayments}
                  summary={paymentSummary}
                  canRecord={canRecordPayments}
                  canDelete={canDeletePayments}
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "calls" && callsEnabled && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>Call history</span>
                <CallButton companyId={company.id} companyName={company.name} size="sm" />
              </CardHeader>
              <CardContent>
                <CallList
                  calls={companyCalls}
                  showCompany={false}
                  emptyMessage="Nobody has logged a call to this company yet."
                />
              </CardContent>
            </Card>
          )}

          {activeTab === "visits" && visitsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Field visits</CardHeader>
              <CardContent>
                <CompanyVisits companyId={company.id} visits={visits} expenseTotal={visitExpenses?.total ?? 0} />
              </CardContent>
            </Card>
          )}

          {activeTab === "statement" && statement && <CompanyStatement statement={statement} />}

          {activeTab === "credit" && creditProfile && <CompanyCredit companyId={company.id} profile={creditProfile} />}

          {activeTab === "commission" && showCommissionTab && (
            <CompanyCommission
              companyId={company.id}
              commissionParties={commissionParties}
              commissions={commissions}
              partyOptions={commissionPartyOptions}
            />
          )}

          {activeTab === "leads" && canSeeLeads && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Leads</CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Title</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Value</th>
                      <th className="px-4 py-2.5">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {company.leads.map((l) => (
                      <tr key={l.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                        <td className="px-4 py-2.5">
                          <Link href={`/leads/${l.id}`} className="font-medium text-text hover:underline">
                            {l.title}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <LeadStatusBadge status={l.status} lostReason={l.lostReason} />
                        </td>
                        <td className="px-4 py-2.5 text-muted">{formatCurrency(l.estimatedValue?.toString())}</td>
                        <td className="px-4 py-2.5 text-muted">{l.owner?.name ?? "Unassigned"}</td>
                      </tr>
                    ))}
                    {company.leads.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-subtle">
                          No leads yet for this company.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {activeTab === "projects" && projectsEnabled && (
            <CompanyProjects
              companyId={company.id}
              projects={companyProjects}
              canCreate={canManageProjects}
              asOf={new Date()}
            />
          )}

          {activeTab === "renewals" && itemsEnabled && renewalsEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Renewals</CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Order ID</th>
                      <th className="px-4 py-2.5">Subscription</th>
                      <th className="px-4 py-2.5">Qty</th>
                      <th className="px-4 py-2.5">PO / Invoice #</th>
                      <th className="px-4 py-2.5">Start date</th>
                      <th className="px-4 py-2.5">Expiry date</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptionProducts.map((p) => {
                      const status = getRenewalStatus(p.endDate);
                      return (
                        <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                          <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(p.orderSeq)}</td>
                          <td className="px-4 py-2.5 font-medium text-text">{p.item.name}</td>
                          <td className="px-4 py-2.5 text-muted">
                            {p.quantity + addedSeats(p)}
                            {addedSeats(p) > 0 && (
                              <span className="block text-[11px] text-subtle">
                                {p.quantity} + {addedSeats(p)} added
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-muted">{p.poNumber ?? "—"}</td>
                          <td className="px-4 py-2.5 text-muted">{formatDate(p.startDate)}</td>
                          <td className="px-4 py-2.5 text-muted">{formatDate(p.endDate)}</td>
                          <td className="px-4 py-2.5">
                            <Badge tone={status.tone}>{status.label}</Badge>
                            {p.renewedBy && (
                              <span className="mt-0.5 block text-[11px] text-success">
                                Renewed — {formatOrderId(p.renewedBy.orderSeq)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1">
                              {callsEnabled && !managedByReseller && (
                                <CallButton
                                  companyId={company.id}
                                  companyName={company.name}
                                  companyProductId={p.id}
                                  preferContact={callableContact}
                                  size="icon"
                                  variant="ghost"
                                />
                              )}
                              <CustomerNoticeButton companyProductId={p.id} companyName={company.name} />
                              <RenewButton companyProductId={p.id} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {subscriptionProducts.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-subtle">
                          No subscription products added directly to this company yet. Add one from the Products &
                          Subscriptions tab.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {activeTab === "locations" && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Locations</CardHeader>
              <CardContent>
                <p className="mb-3 text-sm text-muted">
                  Each location has its own address and GST registration — useful when this company has offices in
                  more than one state. New orders default to the primary location but can be assigned to any of them.
                </p>
                <LocationsManager companyId={company.id} locations={company.locations} />
              </CardContent>
            </Card>
          )}

          {activeTab === "contacts" && canSeeContacts && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Contacts</CardHeader>
              <CardContent>
                <ContactsList companyId={company.id} companyName={company.name} contacts={company.contacts} />
              </CardContent>
            </Card>
          )}

          {activeTab === "assets" && showEstateTab && (
            <CompanyEstate companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "feedback" && feedbackEnabled && (
            <CompanyFeedback companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "portal" && canManagePortal && portalInPlan && !isVendor && (
            <CompanyPortalTab companyId={company.id} contacts={company.contacts} />
          )}

          {activeTab === "marketing" && marketingEnabled && canViewMarketing && (
            <CompanyMarketing companyId={company.id} companyName={company.name} />
          )}

          {activeTab === "tickets" && helpdeskEnabled && supportLoad && <SupportLoadPanel load={supportLoad} />}

          {activeTab === "tickets" && helpdeskEnabled && (
            <Card className="overflow-x-auto p-0">
              <div className="flex items-center justify-between border-b border-line px-5 py-4">
                <span className="text-sm font-medium text-text">Tickets</span>
                {canCreateTickets && (
                  <Link href={`/tickets/new?companyId=${company.id}`}>
                    <Button size="sm">+ New ticket</Button>
                  </Link>
                )}
              </div>
              <TicketsTable tickets={companyTickets} showCompany={false} />
            </Card>
          )}

          {activeTab === "emails" && mailSummary && recentMail && (
            <CompanyEmails companyId={company.id} summary={mailSummary} recent={recentMail} />
          )}

          {activeTab === "forms" && showFormsTab && companyForms && <CompanyForms data={companyForms} />}

          {activeTab === "tasks" && tasksEnabled && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Tasks</CardHeader>
              <CardContent>
                <TaskList
                  tasks={companyTasks}
                  users={assignableUsers}
                  currentUserId={userId}
                  canDeleteAny={canDeleteAnyTask}
                  context={{ companyId: company.id }}
                />
              </CardContent>
            </Card>
          )}
      </div>
    </div>
  );
}

/**
 * One role's addresses.
 *
 * A list rather than a single address: a customer with three warehouses has three shipping
 * addresses, and picking one to show would make the other two invisible on the screen somebody
 * checks before raising a delivery note.
 */
function AddressBlock({
  title,
  locations,
  empty,
}: {
  title: string;
  locations: { id: string; label: string; address: string | null; city: string | null; state: string | null; pincode: string | null; gstNumber: string | null }[];
  empty: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-subtle">{title}</p>
      {locations.length === 0 ? (
        <p className="mt-1 text-sm text-subtle">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-2.5">
          {locations.map((l) => (
            <li key={l.id} className="text-sm">
              <p className="font-medium text-text">{l.label}</p>
              <p className="whitespace-pre-line text-muted">
                {[l.address, [l.city, l.state].filter(Boolean).join(", "), l.pincode].filter(Boolean).join("\n") ||
                  "No address recorded"}
              </p>
              {/* The GSTIN belongs with the address it is registered at — it is the one thing on
                  an invoice that has to match the place of supply. */}
              {l.gstNumber && <p className="mt-0.5 font-mono text-xs text-subtle">{l.gstNumber}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Loads the portal panel's starting state.
 *
 * Its own component so the fetch happens only when the tab is open — this is two queries plus a
 * settings read, and running them on every company page view to fill a tab nobody clicked would be
 * three round trips for nothing.
 */
async function CompanyPortalTab({
  companyId,
  contacts,
}: {
  companyId: string;
  contacts: { id: string; name: string; email: string | null }[];
}) {
  const [status, logins] = await Promise.all([portalStatusFor(companyId), portalLogins(companyId)]);
  if (!status.ok) return <p className="text-sm text-muted">{status.error}</p>;

  return (
    <CompanyPortalPanel
      companyId={companyId}
      initialOverride={status.data.override}
      initialStatus={{ allowed: status.data.allowed, because: status.data.because }}
      initialLogins={logins.ok ? logins.data : []}
      contacts={contacts.map((c) => ({ id: c.id, name: c.name, email: c.email ?? null }))}
    />
  );
}
