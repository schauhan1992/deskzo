import type { Metadata } from "next";
import { FileSpreadsheet } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { StatementsTable } from "@/components/partners/statements/statements-table";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES } from "@/lib/partners/nav";
import { portalStatements } from "@/lib/partners/portal-data";

export const metadata: Metadata = { title: "Statements" };

/**
 * Statements (ADMIN and FINANCE; anybody else gets "not found"): one a month per currency, made
 * early in the month from the previous month's entries. The partner sees a statement once the
 * platform has approved it — with its total, any tax lines and the net payable — and when it has
 * been paid, the date and the payment reference. Drafts and voided statements are the platform's
 * and never appear here (src/lib/partners/portal-data.ts portalStatements).
 */
export default async function PartnerStatementsPage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.statements);
  const rows = await portalStatements(session.user);

  return (
    <PortalPage title="Statements" subtitle="One statement a month for each currency you earn in, listing that month's entries and what is paid to you.">
      <Panel padded={rows.length === 0}>
        {rows.length === 0 ? (
          <EmptyState icon={<FileSpreadsheet className="h-5 w-5" />} title="No statements yet" body="Statements appear here once the platform has approved them, early each month." />
        ) : (
          <StatementsTable rows={rows} />
        )}
      </Panel>
    </PortalPage>
  );
}
