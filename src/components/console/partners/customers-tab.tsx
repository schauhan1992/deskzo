import { Building2 } from "lucide-react";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { LabelPill, StandingPill, StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { plural } from "@/lib/console-shared/format";
import { ATTRIBUTION_SOURCE } from "@/lib/console-shared/labels";
import type { PartnerCustomers } from "@/lib/partners/console-data";
import { consoleClock } from "@/lib/platform/console-clock";
import { AttributionFlags } from "./flags";
import { workspacePath } from "./format";

/**
 * Partner 360 › Customers (spec §9.2): the workspaces attributed to it now, the latest first — their
 * standing, plans, how they came (source) and since when, whether they earn commission, and any
 * flag. Each row opens the workspace's 360, whose Partner panel is where a customer is reassigned.
 * MRR only for SELLERS (the loader reads no money otherwise). A server component: its days are on the
 * console's clock.
 */
export async function PartnerCustomersTab({ data, withMoney, partnerName }: { data: PartnerCustomers; withMoney: boolean; partnerName: string }) {
  if (data.rows.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon={<Building2 className="h-5 w-5" />}
          title="No customers yet"
          body={`Workspaces appear here when they sign up with ${partnerName}'s code, link or registered deal, or when staff assign one to it.`}
        />
      </Panel>
    );
  }
  const clock = await consoleClock();
  return (
    <div className="space-y-3">
      <Panel
        padded={false}
        title="Customers"
        description="Attributed now. Open a workspace to change its partner — with a reason, from now on."
        footer={data.total > data.rows.length ? `Showing the latest ${data.rows.length} of ${plural(data.total, "customer")}.` : plural(data.total, "customer")}
      >
        <DataTable caption="Customers" minWidth={withMoney ? 1100 : 960}>
          <THead>
            <Th>Workspace</Th>
            <Th>Status</Th>
            <Th>Plans</Th>
            {withMoney && <Th numeric>MRR</Th>}
            <Th>Source</Th>
            <Th>Since</Th>
            <Th>Commission</Th>
            <Th>Flags</Th>
          </THead>
          <TBody>
            {data.rows.map((row) => (
              <Tr key={row.attributionId} interactive>
                <Td>
                  <RowLink href={workspacePath(row.slug)}>{row.name}</RowLink>
                  <span className="block font-mono text-xs text-muted">{`${row.slug} · ${row.country}`}</span>
                </Td>
                <Td>
                  <span className="flex flex-wrap items-center gap-1">
                    <TenantStatusPill status={row.status} />
                    {row.status !== "DEPROVISIONED" && <StandingPill kind={row.standing.kind} at={row.standing.at} asOf={data.asOf} />}
                  </span>
                </Td>
                <Td>
                  {row.plans.length === 0 ? (
                    <span className="text-muted">No plan</span>
                  ) : (
                    <span className="text-sm text-text">{row.plans.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join(", ")}</span>
                  )}
                </Td>
                {withMoney && (
                  <Td numeric>
                    <MoneyList amounts={row.mrr ?? []} size="sm" />
                  </Td>
                )}
                <Td>
                  <LabelPill map={ATTRIBUTION_SOURCE} value={row.source} />
                </Td>
                <Td nowrap muted>
                  {clock.date(row.since)}
                </Td>
                <Td>{row.commissionable ? <span className="text-sm text-text">Earns</span> : <StatusPill tone="neutral">No commission</StatusPill>}</Td>
                <Td>
                  <AttributionFlags flags={row.flags} reviewed={row.reviewedAt !== null} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </DataTable>
      </Panel>
    </div>
  );
}
