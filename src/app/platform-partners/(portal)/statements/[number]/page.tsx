import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { partnerExportStatement } from "@/actions/partners/commissions";
import { Banner } from "@/components/console/kit/banner";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { CommissionTable } from "@/components/partners/commissions/commission-table";
import { PortalPage } from "@/components/partners/common/page";
import { StatementStatusPill } from "@/components/partners/common/pills";
import { InvoiceNumberForm } from "@/components/partners/statements/invoice-number-form";
import { RecordedDetails, StatementTotals } from "@/components/partners/statements/statement-parts";
import { dayMonthYear, monthLabel, plural } from "@/lib/console-shared/format";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES } from "@/lib/partners/nav";
import { portalStatement } from "@/lib/partners/portal-data";

export const metadata: Metadata = { title: "Statement" };

/**
 * One statement (ADMIN and FINANCE): its month and currency, the partner's details as it recorded
 * them, the sums down to the net payable (with the tax lines the platform entered), its entries, the
 * partner's own invoice number while it is approved, and the payment once it is paid. A draft, a
 * voided statement, another partner's, or a number that does not exist is "not found" — the same
 * answer for each (src/lib/partners/portal-data.ts portalStatement).
 */
export default async function PartnerStatementPage({ params }: PageProps<"/platform-partners/statements/[number]">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.statements);
  const { number } = await params;
  const statement = await portalStatement(session.user, number);
  if (!statement) notFound();

  const month = monthLabel(statement.period);
  const paid = statement.status === "PAID";
  const shown = statement.entries.length;

  return (
    <PortalPage
      title={statement.number}
      crumbs={[{ label: "Statements", href: PARTNER_ROUTES.statements }]}
      chips={<StatementStatusPill status={statement.status} />}
      subtitle={`Commission for ${month}, in ${statement.currency}.`}
      actions={<ExportCsvButton action={partnerExportStatement.bind(null, statement.number)} />}
    >
      {paid ? (
        <Banner tone="success" title={`Paid on ${dayMonthYear(statement.paidAt)}`}>
          {statement.paymentReference ? `Payment reference ${statement.paymentReference}.` : "The platform recorded the payment without a reference."}
        </Banner>
      ) : (
        <Banner tone="info" title="Approved — being paid">
          The platform has approved this statement and pays the net payable to the account shown below. Add your invoice number if you invoice the platform for it.
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Totals" description={`In ${statement.currency}. Amounts in other currencies are on their own statements.`}>
          <StatementTotals statement={statement} />
        </Panel>

        <Panel title="Your invoice" description={paid ? "Recorded when the statement was paid." : undefined}>
          {paid ? (
            <DefinitionList
              columns={1}
              items={[
                { term: "Your invoice number", value: statement.partnerInvoiceNumber ? <span className="font-mono">{statement.partnerInvoiceNumber}</span> : <span className="text-muted">None given</span> },
                { term: "Paid on", value: dayMonthYear(statement.paidAt) },
                { term: "Payment reference", value: statement.paymentReference ? <span className="font-mono break-all">{statement.paymentReference}</span> : <span className="text-muted">—</span> },
              ]}
            />
          ) : (
            <InvoiceNumberForm number={statement.number} current={statement.partnerInvoiceNumber} />
          )}
        </Panel>
      </div>

      <Panel title="Your details on this statement" description="As they were when the statement was made. Later changes to your company profile don't alter it.">
        <RecordedDetails snapshot={statement.snapshot} />
      </Panel>

      <section aria-label="Entries on this statement">
        <Panel
          title="Entries"
          description={statement.entryCount > shown ? `Showing the first ${shown.toLocaleString("en-IN")} of ${plural(statement.entryCount, "entry", "entries")} — the CSV has them all.` : plural(statement.entryCount, "entry", "entries")}
          padded={shown === 0}
        >
          {shown === 0 ? <p className="text-sm text-muted">No entries.</p> : <CommissionTable rows={statement.entries} caption={`Entries on statement ${statement.number}`} showStatement={false} />}
        </Panel>
      </section>
    </PortalPage>
  );
}
