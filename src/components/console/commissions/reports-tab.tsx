import Link from "next/link";
import { Banknote, Building2, HandCoins, Wallet } from "lucide-react";
import { consoleExportPartnerReport } from "@/actions/platform/console-commissions";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter } from "@/components/console/kit/filter-controls";
import { FilterBar } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, TBody, TFoot, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { formatMoney } from "@/lib/billing/money";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerReport } from "@/lib/partners/commission-data";
import { partnerHref } from "./format";

/**
 * The Reports tab (spec §9.2): what the programme brought in over an IST window — the current year
 * to date unless the filter says — per partner and per country, partner-sold against direct.
 * Customers and MRR are as of now; invoiced, earned and paid fall in the window. Money is one line
 * per currency, never added across currencies. The same figures are in the CSV.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function ReportsTab({ report, exportArgs, caps }: { report: PartnerReport; exportArgs: Record<string, string>; caps: Caps }) {
  const span = report.from === report.to ? dayKeyLabel(report.from) : `${dayKeyLabel(report.from)} – ${dayKeyLabel(report.to)}`;
  const { totals } = report;
  const customers = totals.partnerCustomers + totals.directCustomers;

  return (
    <div className="space-y-6">
      <div>
        <FilterBar trailing={caps.partnerMoney ? <ExportCsvButton action={consoleExportPartnerReport.bind(null, exportArgs)} /> : undefined}>
          <DateRangeFilter label="Window" />
          <span className="text-sm text-muted">{`${span} (India time)`}</span>
        </FilterBar>
        <p className="text-xs text-muted">Customers and MRR are as of now. Net invoiced, commission earned and commission paid fall in the window.</p>
      </div>

      <KpiGrid>
        <KpiTile
          label="Partner customers"
          icon={<Building2 className="h-4 w-4" />}
          value={INTEGER.format(totals.partnerCustomers)}
          secondary={customers > 0 ? `${INTEGER.format(totals.directCustomers)} direct · ${Math.round((totals.partnerCustomers / customers) * 100)}% through partners` : "No live workspaces yet"}
        />
        <KpiTile
          label="Partner MRR"
          icon={<Banknote className="h-4 w-4" />}
          value={<MoneyList amounts={totals.partnerMrr} />}
          secondary={`Direct: ${totals.directMrr.length ? totals.directMrr.map((m) => formatMoney(m.minor, m.currency)).join(" · ") : "none"}`}
        />
        <KpiTile label="Commission earned" icon={<HandCoins className="h-4 w-4" />} value={<MoneyList amounts={totals.earned} />} secondary="In the window, after reversals and adjustments" />
        <KpiTile label="Commission paid" icon={<Wallet className="h-4 w-4" />} value={<MoneyList amounts={totals.paid} />} secondary="Statements marked paid in the window, before tax lines" />
      </KpiGrid>

      <Panel title="By partner" description="Every partner, with customers and MRR now and the money of the window." padded={false}>
        {report.partners.length === 0 ? (
          <EmptyState icon={<HandCoins className="h-5 w-5" />} title="No partners yet" body="Partners appear here once they are added under Partners." />
        ) : (
          <DataTable caption="Revenue by partner" minWidth={980}>
            <THead>
              <Th>Partner</Th>
              <Th numeric>Customers</Th>
              <Th numeric>MRR</Th>
              <Th numeric>Net invoiced</Th>
              <Th numeric>Commission earned</Th>
              <Th numeric>Commission paid</Th>
            </THead>
            <TBody>
              {report.partners.map((row) => (
                <Tr key={row.partner.slug}>
                  <Td>
                    <Link href={partnerHref(row.partner.slug)} className="font-medium text-text hover:text-brand hover:underline">
                      {row.partner.displayName}
                    </Link>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      <LabelPill map={PARTNER_KIND} value={row.partner.kind} />
                      {row.partner.status !== "ACTIVE" && <LabelPill map={PARTNER_STATUS} value={row.partner.status} />}
                    </span>
                  </Td>
                  <Td numeric>{INTEGER.format(row.customers)}</Td>
                  <Td numeric>
                    <MoneyList amounts={row.mrr} size="sm" />
                  </Td>
                  <Td numeric>
                    <MoneyList amounts={row.netInvoiced} size="sm" />
                  </Td>
                  <Td numeric>
                    <MoneyList amounts={row.earned} size="sm" />
                  </Td>
                  <Td numeric>
                    <MoneyList amounts={row.paid} size="sm" />
                  </Td>
                </Tr>
              ))}
            </TBody>
            <TFoot>
              <Td>{`All partners · ${plural(report.partners.length, "partner")}`}</Td>
              <Td numeric>{INTEGER.format(totals.partnerCustomers)}</Td>
              <Td numeric>
                <MoneyList amounts={totals.partnerMrr} size="sm" />
              </Td>
              <Td numeric>
                <MoneyList amounts={totals.netInvoiced} size="sm" />
              </Td>
              <Td numeric>
                <MoneyList amounts={totals.earned} size="sm" />
              </Td>
              <Td numeric>
                <MoneyList amounts={totals.paid} size="sm" />
              </Td>
            </TFoot>
          </DataTable>
        )}
      </Panel>

      <Panel title="By country" description="Live workspaces now, sold through partners or signed up directly." padded={false}>
        {report.countries.length === 0 ? (
          <EmptyState title="No live workspaces yet" />
        ) : (
          <DataTable caption="Partner and direct customers by country" minWidth={820}>
            <THead>
              <Th>Country</Th>
              <Th numeric>Partner customers</Th>
              <Th numeric>Direct customers</Th>
              <Th numeric>Partner MRR</Th>
              <Th numeric>Direct MRR</Th>
            </THead>
            <TBody>
              {report.countries.map((row) => (
                <Tr key={row.country}>
                  <Td>
                    {row.name}
                    <span className="ml-1.5 font-mono text-[11px] text-subtle">{row.country}</span>
                  </Td>
                  <Td numeric>{INTEGER.format(row.partnerCustomers)}</Td>
                  <Td numeric>{INTEGER.format(row.directCustomers)}</Td>
                  <Td numeric>
                    <MoneyList amounts={row.partnerMrr} size="sm" />
                  </Td>
                  <Td numeric>
                    <MoneyList amounts={row.directMrr} size="sm" />
                  </Td>
                </Tr>
              ))}
            </TBody>
            <TFoot>
              <Td>All countries</Td>
              <Td numeric>{INTEGER.format(totals.partnerCustomers)}</Td>
              <Td numeric>{INTEGER.format(totals.directCustomers)}</Td>
              <Td numeric>
                <MoneyList amounts={totals.partnerMrr} size="sm" />
              </Td>
              <Td numeric>
                <MoneyList amounts={totals.directMrr} size="sm" />
              </Td>
            </TFoot>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
