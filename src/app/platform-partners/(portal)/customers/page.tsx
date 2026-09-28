import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { CustomersTable } from "@/components/partners/customers/customers-table";
import { PagePager } from "@/components/partners/customers/page-pager";
import { STANDING_KIND_LABEL, TENANT_STATUS } from "@/lib/console-shared/labels";
import { one, withParams, type RawParams } from "@/lib/console-shared/params";
import type { StandingKind, TenantStatusKey } from "@/lib/console-shared/types";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES, canOpenPartnerPage } from "@/lib/partners/nav";
import { portalCustomers } from "@/lib/partners/portal-data";
import { workspaceSuffix } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Customers" };

const PATH = PARTNER_ROUTES.customers;
const LINK = "inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken";

/** The address's filters, whitelisted: a search, a workspace status, a billing standing, a page. Anything else is dropped. */
function parseFilters(sp: RawParams) {
  const q = one(sp, "q", 100);
  const statusRaw = one(sp, "status", 20)?.toUpperCase();
  const status = statusRaw && Object.hasOwn(TENANT_STATUS, statusRaw) ? (statusRaw as TenantStatusKey) : undefined;
  const standingRaw = one(sp, "standing", 20)?.toLowerCase();
  const standing = standingRaw && Object.hasOwn(STANDING_KIND_LABEL, standingRaw) ? (standingRaw as StandingKind) : undefined;
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp, "page", 6))) || 1));
  return { q, status, standing, page };
}

/**
 * Customers (every role): the workspaces credited to the partner now, by name, fifty a page —
 * searched by name or address and filtered by status and billing standing, all in the address
 * (src/lib/partners/portal-data.ts portalCustomers). A workspace no longer credited to the partner is
 * not here, and nothing from inside any workspace ever is.
 */
export default async function PartnerCustomersPage({ searchParams }: PageProps<"/platform-partners/customers">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.customers);
  const me = session.user;
  const sp = await searchParams;
  const f = parseFilters(sp);
  const list = await portalCustomers(me, { q: f.q, status: f.status, standing: f.standing, page: f.page }, new Date());
  const suffix = workspaceSuffix();

  const chips = [
    ...(f.q ? [{ key: "q", label: `Search: ${f.q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
    ...(f.status ? [{ key: "status", label: `Status: ${TENANT_STATUS[f.status].label}`, removeHref: withParams(PATH, sp, { status: null }) }] : []),
    ...(f.standing ? [{ key: "standing", label: `Standing: ${STANDING_KIND_LABEL[f.standing]}`, removeHref: withParams(PATH, sp, { standing: null }) }] : []),
  ];
  const filtered = chips.length > 0;
  const pages = Math.max(1, Math.ceil(list.total / Math.max(1, list.pageSize)));

  return (
    <PortalPage
      title="Customers"
      subtitle="Workspaces credited to you now — their plans, where they stand with paying and what they bring in. Never anything from inside a workspace."
      asOf={list.asOf}
    >
      <section aria-label="Customer list">
        <FilterBar>
          <SearchField label="Search customers" placeholder="Name or address" />
          <SelectFilter param="status" label="Status" allLabel="Any status" options={Object.entries(TENANT_STATUS).map(([value, { label }]) => ({ value, label }))} />
          <SelectFilter param="standing" label="Standing" allLabel="Any standing" options={Object.entries(STANDING_KIND_LABEL).map(([value, label]) => ({ value, label }))} />
        </FilterBar>
        <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

        <Panel padded={list.rows.length === 0}>
          {list.rows.length === 0 ? (
            filtered ? (
              <EmptyState variant="filtered" title="No customers match those filters" body="Try part of a name or an address, or another status or standing." clearHref={PATH} />
            ) : (
              <EmptyState
                icon={<Building2 className="h-5 w-5" />}
                title="No customers yet"
                body="Share an invitation code or your referral link to bring your first customer. Every workspace signed up with one is credited to you."
                action={
                  canOpenPartnerPage(me.role, me.partner.kind, "invitations") ? (
                    <Link href={PARTNER_ROUTES.invitations} className={LINK}>
                      Go to Invitations
                    </Link>
                  ) : undefined
                }
              />
            )
          ) : (
            <CustomersTable rows={list.rows} asOf={list.asOf} suffix={suffix} />
          )}
        </Panel>

        <PagePager
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          noun="customer"
          previousHref={list.page > 1 ? withParams(PATH, sp, { page: list.page - 1 === 1 ? null : list.page - 1 }) : null}
          nextHref={list.page < pages ? withParams(PATH, sp, { page: list.page + 1 }) : null}
        />
      </section>
    </PortalPage>
  );
}
