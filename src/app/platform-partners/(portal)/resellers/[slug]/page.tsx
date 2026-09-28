import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Building2, CalendarPlus, CircleCheck, Hourglass, Sparkles } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { CommissionTable } from "@/components/partners/commissions/commission-table";
import { PortalPage } from "@/components/partners/common/page";
import { PartnerStatusPill } from "@/components/partners/common/pills";
import { countryName } from "@/components/partners/profile/details";
import { plural } from "@/lib/console-shared/format";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES } from "@/lib/partners/nav";
import { portalReseller } from "@/lib/partners/portal-data";
import { partnerCapsFor, type Money } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Reseller" };

const num = (n: number) => n.toLocaleString("en-IN");

/**
 * One reseller of this distributor: its customers by standing, their attributed MRR per currency and
 * new customers this month, and — for the money roles only — this distributor's own override entries
 * on that reseller's customers (clawbacks included). Nothing of the reseller's own commission,
 * rates, users or payout. Another distributor's reseller, or none, is "not found"; so is the page for
 * a reseller signed in (src/lib/partners/portal-data.ts portalReseller).
 */
export default async function PartnerResellerPage({ params }: PageProps<"/platform-partners/resellers/[slug]">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.resellers, { distributorOnly: true });
  const { slug } = await params;
  const now = new Date();
  const reseller = await portalReseller(session.user, slug, now);
  if (!reseller) notFound();
  const money = partnerCapsFor(session.user).money;

  // Net override per currency over the entries shown — void ones left out, currencies never added together.
  const net: Money[] = [];
  for (const row of reseller.overrides) {
    if (row.status === "VOID") continue;
    const same = net.find((m) => m.currency === row.currency);
    if (same) same.minor += row.amount;
    else net.push({ currency: row.currency, minor: row.amount });
  }

  return (
    <PortalPage
      title={reseller.displayName}
      crumbs={[{ label: "Resellers", href: PARTNER_ROUTES.resellers }]}
      chips={<PartnerStatusPill status={reseller.status} />}
      subtitle="A reseller selling under your company."
      asOf={now}
    >
      <KpiGrid columns={5}>
        <KpiTile label="Customers" value={num(reseller.customers)} icon={<Building2 className="h-4 w-4" />} secondary="Current, not closed" />
        <KpiTile label="Active" value={num(reseller.active)} icon={<CircleCheck className="h-4 w-4" />} secondary="Paying and paid up" />
        <KpiTile label="On trial" value={num(reseller.trial)} icon={<Hourglass className="h-4 w-4" />} />
        <KpiTile label="Attributed MRR" value={<MoneyList amounts={reseller.mrr} />} icon={<Sparkles className="h-4 w-4" />} secondary="Monthly, at list prices" />
        <KpiTile label="New this month" value={num(reseller.newThisMonth)} icon={<CalendarPlus className="h-4 w-4" />} secondary="India time" />
      </KpiGrid>

      <Panel title="Territories">
        <DefinitionList columns={1} items={[{ term: "Sells in", value: reseller.territories.length ? reseller.territories.map((c) => `${countryName(c)} (${c})`).join(", ") : "—" }]} />
      </Panel>

      {money && (
        <Panel
          title="Your override on its customers"
          description={
            reseller.overrides.length > 0 ? (
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span>{`${plural(reseller.overrides.length, "entry", "entries")}, newest first. Net, void entries left out:`}</span>
                <MoneyList amounts={net} size="sm" />
              </div>
            ) : (
              "What you earn on top of the reseller's own commission, on each of its customers' paid invoices."
            )
          }
          padded={reseller.overrides.length === 0}
        >
          {reseller.overrides.length === 0 ? (
            <EmptyState title="No override entries yet" body="An entry appears here each time one of this reseller's customers pays an invoice while your terms include an override." />
          ) : (
            <CommissionTable rows={reseller.overrides} caption={`Your override entries on ${reseller.displayName}'s customers`} />
          )}
        </Panel>
      )}
    </PortalPage>
  );
}
