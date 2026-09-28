import type { Metadata } from "next";
import { Building2, Network, Sparkles } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { RequestResellerButton } from "@/components/partners/resellers/request-reseller-dialog";
import { ResellerRequestsTable, ResellersTable } from "@/components/partners/resellers/resellers-table";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES } from "@/lib/partners/nav";
import { portalResellers } from "@/lib/partners/portal-data";

export const metadata: Metadata = { title: "Resellers" };

const num = (n: number) => n.toLocaleString("en-IN");

/**
 * Resellers (a distributor's page — a reseller signed in gets "not found", and the loader reads
 * nothing for it): the resellers under this distributor with their customers, standing, attributed
 * MRR per currency and new customers this month; the ones it has proposed that wait for platform
 * staff; and, for an ADMIN, "Request a new reseller" (src/actions/partners/resellers.ts). Never a
 * reseller's own rates, commission, statements, users or payout (spec §8.5).
 */
export default async function PartnerResellersPage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.resellers, { distributorOnly: true });
  const data = await portalResellers(session.user, new Date());
  const customers = data.resellers.reduce((sum, r) => sum + r.customers, 0);
  const newThisMonth = data.resellers.reduce((sum, r) => sum + r.newThisMonth, 0);
  const live = data.resellers.filter((r) => r.status !== "TERMINATED").length;

  return (
    <PortalPage
      title="Resellers"
      subtitle="The companies selling under yours, and the customers they bring in."
      asOf={data.asOf}
      actions={data.canRequest ? <RequestResellerButton territories={data.territories} /> : undefined}
    >
      <KpiGrid columns={3}>
        <KpiTile label="Resellers" value={num(live)} icon={<Network className="h-4 w-4" />} secondary={live === data.resellers.length ? "Under your company" : `${num(data.resellers.length - live)} terminated not counted`} />
        <KpiTile label="Their customers" value={num(customers)} icon={<Building2 className="h-4 w-4" />} secondary={`${num(newThisMonth)} new this month`} />
        <KpiTile
          label="Attributed MRR"
          value={<MoneyList amounts={data.resellers.flatMap((r) => r.mrr)} />}
          icon={<Sparkles className="h-4 w-4" />}
          secondary="Monthly, at list prices, per currency"
        />
      </KpiGrid>

      <Panel title="Your resellers" padded={data.resellers.length === 0}>
        {data.resellers.length === 0 ? (
          <EmptyState
            icon={<Network className="h-5 w-5" />}
            title="No resellers yet"
            body={data.canRequest ? "Propose a company with Request a new reseller. Platform staff review it and set it up under yours." : "Your company's admins can propose resellers for platform staff to set up."}
          />
        ) : (
          <ResellersTable rows={data.resellers} />
        )}
      </Panel>

      {data.requests.length > 0 && (
        <Panel title="Waiting for review" description="Resellers you have proposed. Platform staff set each one up once they approve it." padded={false}>
          <ResellerRequestsTable rows={data.requests} canWithdraw={data.canRequest} />
        </Panel>
      )}
    </PortalPage>
  );
}
