import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HandCoins, Layers } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { StandingPill, StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { MoneyStack } from "@/components/partners/common/money";
import { PortalPage } from "@/components/partners/common/page";
import { SourceLabel } from "@/components/partners/common/pills";
import { CommissionEntriesTable } from "@/components/partners/customers/commission-entries";
import { countryName } from "@/components/partners/customers/country";
import { SubscriptionsTable } from "@/components/partners/customers/subscriptions-table";
import { dayMonthYear } from "@/lib/console-shared/format";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES, canOpenPartnerPage } from "@/lib/partners/nav";
import { portalCustomer } from "@/lib/partners/portal-data";
import { workspaceSuffix } from "@/lib/platform/site-content";

export const metadata: Metadata = { title: "Customer" };

/**
 * One customer (every role), only while its workspace is credited to this partner — another
 * partner's, a former customer's, or no such address all answer "not found", the same for each
 * (portalCustomer returns null). The page shows the control plane's facts (spec §8.5): the workspace's
 * name, address, country, when it was made, its status and billing standing, its live subscriptions
 * at list prices, and how and since when it came to the partner. The money roles also see the
 * commission earned from it.
 *
 * Nothing else: no owner or billing contact, no tax id or address, no invoice links, no seats or
 * usage, and nothing from inside the workspace.
 */
export default async function PartnerCustomerPage({ params }: PageProps<"/platform-partners/customers/[slug]">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.customers);
  const me = session.user;
  const { slug } = await params;
  const customer = await portalCustomer(me, slug, new Date());
  if (!customer) notFound();

  const address = `${customer.slug}${workspaceSuffix()}`;
  const ends = customer.standing.kind === "ending" || customer.standing.kind === "trial" ? customer.endsAt : null;

  return (
    <PortalPage
      title={customer.name}
      crumbs={[{ label: "Customers", href: PARTNER_ROUTES.customers }]}
      chips={
        <>
          <TenantStatusPill status={customer.status} />
          <StandingPill kind={customer.standing.kind} at={customer.standing.at} asOf={customer.asOf} />
          {!customer.commissionable && <StatusPill tone="neutral">No commission</StatusPill>}
        </>
      }
      subtitle={
        <span translate="no" className="font-mono text-xs">
          {address}
        </span>
      }
      asOf={customer.asOf}
    >
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Workspace" className="lg:col-span-2">
          <DefinitionList
            items={[
              { term: "Name", value: customer.name },
              { term: "Address", value: <span className="font-mono text-xs">{address}</span> },
              { term: "Country", value: `${countryName(customer.country)} (${customer.country})` },
              { term: "Created", value: dayMonthYear(customer.createdAt) },
              { term: "Status", value: <TenantStatusPill status={customer.status} /> },
              { term: "Billing standing", value: <StandingPill kind={customer.standing.kind} at={customer.standing.at} asOf={customer.asOf} /> },
              { term: "Pays in", value: customer.currency ?? "—" },
              { term: "MRR at list prices", value: <MoneyStack items={customer.mrr} /> },
              { term: "Renews", value: customer.renewsAt ? dayMonthYear(customer.renewsAt) : "—" },
              ...(ends ? [{ term: customer.standing.kind === "trial" ? "Trial ends" : "Ends", value: dayMonthYear(ends) }] : []),
            ]}
          />
        </Panel>

        <Panel title="Attribution" description="How this workspace came to you.">
          <DefinitionList
            columns={1}
            items={[
              { term: "Credited through", value: <SourceLabel source={customer.source} className="text-text" /> },
              { term: "Yours since", value: dayMonthYear(customer.since) },
              {
                term: "Commission",
                value: customer.commissionable ? (
                  "Its paid invoices earn commission under your terms."
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <StatusPill tone="neutral">No commission</StatusPill>
                    <span className="text-muted">Its invoices earn nothing.</span>
                  </span>
                ),
              },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Subscriptions" description="Live subscriptions, at list prices." padded={customer.subscriptions.length === 0}>
        {customer.subscriptions.length === 0 ? (
          <EmptyState icon={<Layers className="h-5 w-5" />} title="No live subscription" body="It has no trial or paid plan running right now." />
        ) : (
          <SubscriptionsTable subscriptions={customer.subscriptions} />
        )}
      </Panel>

      {customer.commission && (
        <Panel
          title="Commission from this customer"
          description="Net of clawbacks, in the currency each invoice was paid in."
          padded={customer.commission.entries.length === 0}
          actions={
            <div className="text-right">
              <p className="text-xs text-muted">Earned so far</p>
              <MoneyStack items={customer.commission.earned} empty="Nothing yet" className="text-sm font-medium text-text" />
            </div>
          }
        >
          {customer.commission.entries.length === 0 ? (
            <EmptyState icon={<HandCoins className="h-5 w-5" />} title="Nothing earned yet" body="Commission is worked out when one of its invoices is paid." />
          ) : (
            <CommissionEntriesTable entries={customer.commission.entries} canOpenStatements={canOpenPartnerPage(me.role, me.partner.kind, "statements")} />
          )}
        </Panel>
      )}
    </PortalPage>
  );
}
