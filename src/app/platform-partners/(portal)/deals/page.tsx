import type { Metadata } from "next";
import { Handshake } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { countryNames } from "@/components/partners/customers/country";
import { PagePager } from "@/components/partners/customers/page-pager";
import { DealsTable } from "@/components/partners/deals/deals-table";
import { RegisterDealButton } from "@/components/partners/deals/register-dialog";
import { DEAL_STATUS } from "@/lib/console-shared/labels";
import { one, withParams } from "@/lib/console-shared/params";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES } from "@/lib/partners/nav";
import { portalDeals } from "@/lib/partners/portal-data";
import { PARTNER_LIMITS, PARTNER_SELLERS, type DealStatus } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Deal registrations" };

const PATH = PARTNER_ROUTES.deals;
/** The status tabs, in the order a registration moves through them. */
const STATUSES: DealStatus[] = ["PENDING", "APPROVED", "WON", "DECLINED", "EXPIRED", "WITHDRAWN"];

/**
 * Deal registrations (admin, sales, viewer; spec §4.3): a partner's claim on a company it is working
 * with, by the domain its people's email addresses are on. Staff approve or decline each one; an
 * approved registration protects the company for the configured number of days — a workspace signed
 * up from that domain is credited to the partner ahead of any invitation code or referral link — and
 * becomes "Won" when it signs up.
 *
 * Registering needs a selling role (admin, sales) and an ACTIVE partner account; withdrawing only
 * gives something up, so the selling roles may withdraw whatever the account's status. Fifty a page,
 * newest first, filtered by status in the address.
 */
export default async function PartnerDealsPage({ searchParams }: PageProps<"/platform-partners/deals">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.deals);
  const me = session.user;
  const sp = await searchParams;
  const statusRaw = one(sp, "status", 20)?.toUpperCase();
  const status = STATUSES.find((s) => s === statusRaw);
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp, "page", 6))) || 1));
  const data = await portalDeals(me, { status, page }, new Date());
  const seller = PARTNER_SELLERS.includes(me.role);
  const all = STATUSES.reduce((sum, s) => sum + (data.counts[s] ?? 0), 0);
  const pages = Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));
  const names = countryNames([...data.territories, ...data.rows.map((r) => r.country)]);
  const territories = data.territories.map((code) => ({ code, name: names[code] ?? code }));

  return (
    <PortalPage
      title="Deal registrations"
      subtitle={`Once staff approve a registration, the company is protected for you for ${data.dealDays} days: a workspace signed up from an address on its domain is credited to you, ahead of any code or link.`}
      actions={data.canSell ? <RegisterDealButton territories={territories} plans={data.plans} dealDays={data.dealDays} /> : undefined}
      asOf={data.asOf}
    >
      {seller && !data.canSell && (
        <Banner tone="neutral" title="Registering a company needs an active partner account.">
          You can still withdraw the registrations you have.
        </Banner>
      )}
      {!seller && <Banner tone="neutral" title="Your role can see registrations. An admin or a sales user registers companies and withdraws them." />}

      <section aria-label="Registrations">
        <FilterBar>
          <ViewTabs
            label="Registration status"
            items={[
              { key: "all", label: "All", href: withParams(PATH, sp, { status: null }), active: !status, count: all },
              ...STATUSES.map((s) => ({ key: s, label: DEAL_STATUS[s].label, href: withParams(PATH, sp, { status: s }), active: status === s, count: data.counts[s] ?? 0 })),
            ]}
          />
        </FilterBar>

        <Panel padded={data.rows.length === 0}>
          {data.rows.length === 0 ? (
            status ? (
              <EmptyState variant="filtered" title={`No ${DEAL_STATUS[status].label.toLowerCase()} registrations`} body="Pick another status to see the rest." clearHref={PATH} />
            ) : (
              <EmptyState
                icon={<Handshake className="h-5 w-5" />}
                title="No registrations yet"
                body={
                  data.canSell
                    ? `Register a company you are working with, so a signup from its domain is credited to you. Up to ${PARTNER_LIMITS.dealsPerDay} a day.`
                    : "Companies your team registers appear here."
                }
              />
            )
          ) : (
            <DealsTable rows={data.rows} asOf={data.asOf} canWithdraw={seller} countryNames={names} />
          )}
        </Panel>

        <PagePager
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          noun="registration"
          previousHref={data.page > 1 ? withParams(PATH, sp, { page: data.page - 1 === 1 ? null : data.page - 1 }) : null}
          nextHref={data.page < pages ? withParams(PATH, sp, { page: data.page + 1 }) : null}
        />
      </section>
    </PortalPage>
  );
}
