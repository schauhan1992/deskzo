import type { Metadata } from "next";
import { HandCoins } from "lucide-react";
import { partnerExportCommissions } from "@/actions/partners/commissions";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter, SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { CommissionExplainer, CommissionTotals } from "@/components/partners/commissions/commission-summary";
import { CommissionTable } from "@/components/partners/commissions/commission-table";
import { ListPager } from "@/components/partners/commissions/list-pager";
import { PortalPage } from "@/components/partners/common/page";
import { dayKeyLabel } from "@/lib/console-shared/format";
import { COMMISSION_STATUS } from "@/lib/console-shared/labels";
import { isoDateOrUndefined, one, parseCurrency, withParams, type RawParams } from "@/lib/console-shared/params";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES } from "@/lib/partners/nav";
import { portalCommissions, type CommissionFilters } from "@/lib/partners/portal-data";
import type { CommissionStatus } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Commissions" };

const PATH = PARTNER_ROUTES.commissions;
const STATUSES = Object.keys(COMMISSION_STATUS) as CommissionStatus[];
const STATUS_OPTIONS = STATUSES.map((key) => ({ value: key, label: COMMISSION_STATUS[key].label }));
/** Offered in the currency filter even before any entry is in them; any other the totals hold is added. */
const COMMON_CURRENCIES = ["INR", "USD"];

/** The address's filters, whitelisted: a status, a three-letter currency, India days, a customer's name or address, a page. */
function parseFilters(sp: RawParams) {
  const statusRaw = one(sp, "status", 20)?.toUpperCase();
  const status = statusRaw && (STATUSES as string[]).includes(statusRaw) ? (statusRaw as CommissionStatus) : undefined;
  const currency = parseCurrency(sp);
  const from = isoDateOrUndefined(one(sp, "from", 20));
  const to = isoDateOrUndefined(one(sp, "to", 20));
  const customer = one(sp, "customer", 100);
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp, "page", 10)) || 1)));
  // Exactly what the export is given, so the CSV holds the entries on screen (every page of them).
  const filters: CommissionFilters = { ...(status ? { status } : {}), ...(currency ? { currency } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(customer ? { customer } : {}) };
  return { status, currency, from, to, customer, page, filters };
}

function rangeLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return from === to ? dayKeyLabel(from) : `${dayKeyLabel(from)} – ${dayKeyLabel(to)}`;
  if (from) return `from ${dayKeyLabel(from)}`;
  return `until ${dayKeyLabel(to ?? "")}`;
}

/**
 * Commissions (ADMIN and FINANCE; anybody else gets "not found", and the loader reads nothing for
 * them either): every entry of this partner's — earned, clawed back and adjusted — newest first,
 * 100 a page, filtered from the address, with the totals per currency per status over the whole
 * filtered set, and the same set as CSV (src/actions/partners/commissions.ts, 20 exports an hour
 * each; a refusal appears in the page notice as the server words it).
 */
export default async function PartnerCommissionsPage({ searchParams }: PageProps<"/platform-partners/commissions">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.commissions);
  const me = session.user;
  const sp = await searchParams;
  const f = parseFilters(sp);
  const list = await portalCommissions(me, { ...f.filters, page: f.page }, new Date());

  const remove = (...keys: string[]) => withParams(PATH, sp, Object.fromEntries(keys.map((k) => [k, null])));
  const chips = [
    ...(f.status ? [{ key: "status", label: `Status: ${COMMISSION_STATUS[f.status].label}`, removeHref: remove("status") }] : []),
    ...(f.currency ? [{ key: "currency", label: `Currency: ${f.currency}`, removeHref: remove("currency") }] : []),
    ...(f.customer ? [{ key: "customer", label: `Customer: ${f.customer}`, removeHref: remove("customer") }] : []),
    ...(f.from || f.to ? [{ key: "dates", label: `Earned ${rangeLabel(f.from, f.to)}`, removeHref: remove("from", "to") }] : []),
  ];
  const filtered = chips.length > 0;
  const currencies = [...new Set([...COMMON_CURRENCIES, ...list.totals.map((t) => t.currency), ...(f.currency ? [f.currency] : [])])].sort();

  return (
    <PortalPage title="Commissions" subtitle="What you have earned on your customers' paid invoices, and what was taken back. Dates are India time.">
      <Panel title="How commission works">
        <CommissionExplainer distributor={me.partner.kind === "DISTRIBUTOR"} />
      </Panel>

      <section aria-label="Totals">
        <CommissionTotals totals={list.totals} />
        <p className="mt-2 text-xs text-muted">Totals cover every entry the other filters match, of any status; void entries are left out. One line per currency — amounts in different currencies are never added together.</p>
      </section>

      <section aria-label="Commission entries">
        <FilterBar trailing={<ExportCsvButton action={partnerExportCommissions.bind(null, f.filters)} />}>
          <SearchField param="customer" label="Customer" placeholder="Customer name or address" />
          <SelectFilter param="status" label="Status" options={STATUS_OPTIONS} />
          <SelectFilter param="currency" label="Currency" options={currencies.map((c) => ({ value: c, label: c }))} />
          <DateRangeFilter label="Earned" />
        </FilterBar>
        <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

        <Panel padded={list.rows.length === 0}>
          {list.rows.length === 0 ? (
            filtered ? (
              <EmptyState variant="filtered" title="No entries match these filters" body="Widen the dates, or pick another status, currency or customer." clearHref={PATH} />
            ) : (
              <EmptyState icon={<HandCoins className="h-5 w-5" />} title="No commission yet" body="An entry appears here each time one of your customers pays an invoice." />
            )
          ) : (
            <CommissionTable rows={list.rows} caption="Commission entries, newest first" />
          )}
        </Panel>
        <ListPager path={PATH} params={sp} page={list.page} pageSize={list.pageSize} total={list.total} noun="entry" nounPlural="entries" />
      </section>
    </PortalPage>
  );
}
