import { partnerWithdrawRequest } from "@/actions/partners/profile";
import { ActionButton } from "@/components/console/kit/action-button";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { MoneyStack } from "@/components/partners/common/money";
import { PartnerStatusPill } from "@/components/partners/common/pills";
import { dayMonthYear, when } from "@/lib/console-shared/format";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { ResellerRequestRow, ResellerRow } from "@/lib/partners/portal-data";
import { countryName } from "@/components/partners/profile/details";

/**
 * A distributor's resellers, and the resellers it has proposed that are waiting for platform staff.
 * Only aggregates — how many customers, on what standing, what they pay — never a reseller's own
 * rates, commission, statements, users or payout (spec §8.5). Server-safe.
 */

const num = (n: number) => n.toLocaleString("en-IN");

/** Territory codes as they are ("IN, KE"), the names in the hover title. */
function Territories({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="block max-w-[14rem] truncate font-mono text-xs" title={codes.map(countryName).join(", ")}>
      {codes.join(", ")}
    </span>
  );
}

export function ResellersTable({ rows }: { rows: ResellerRow[] }) {
  return (
    <DataTable caption="Your resellers" minWidth={880}>
      <THead>
        <Th>Reseller</Th>
        <Th>Status</Th>
        <Th>Territories</Th>
        <Th numeric>Customers</Th>
        <Th numeric>Attributed MRR</Th>
        <Th numeric>New this month</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.slug} interactive>
            <Td>
              <RowLink href={PARTNER_ROUTES.reseller(row.slug)}>{row.displayName}</RowLink>
            </Td>
            <Td>
              <PartnerStatusPill status={row.status} />
            </Td>
            <Td>
              <Territories codes={row.territories} />
            </Td>
            <Td numeric>
              <span className="block font-medium">{num(row.customers)}</span>
              <span className="block text-[11px] text-muted">{`${num(row.active)} active · ${num(row.trial)} on trial`}</span>
            </Td>
            <Td numeric>
              <MoneyStack items={row.mrr} className="inline-block text-right" />
            </Td>
            <Td numeric>{num(row.newThisMonth)}</Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}

/** Proposed resellers waiting for review; an ADMIN may withdraw one. */
export function ResellerRequestsTable({ rows, canWithdraw }: { rows: ResellerRequestRow[]; canWithdraw: boolean }) {
  return (
    <DataTable caption="Proposed resellers waiting for review" minWidth={720}>
      <THead>
        <Th>Proposed reseller</Th>
        <Th>Country</Th>
        <Th>Territories</Th>
        <Th>Sent</Th>
        {canWithdraw && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id}>
            <Td>
              <span className="block font-medium">{row.displayName || "—"}</span>
              {row.legalName && row.legalName !== row.displayName && <span className="block text-xs text-muted">{row.legalName}</span>}
            </Td>
            <Td>{countryName(row.country)}</Td>
            <Td>
              <Territories codes={row.territories} />
            </Td>
            <Td muted nowrap>
              <time dateTime={row.createdAt.toISOString()} title={when(row.createdAt)}>
                {dayMonthYear(row.createdAt)}
              </time>
            </Td>
            {canWithdraw && (
              <RowActionsCell>
                <ActionButton
                  action={partnerWithdrawRequest.bind(null, row.id)}
                  label="Withdraw…"
                  variant="ghost"
                  confirm={{ title: `Withdraw the proposal for ${row.displayName || "this reseller"}`, body: "Platform staff will no longer review it. You can propose the company again later.", confirmLabel: "Withdraw proposal" }}
                  success="Proposal withdrawn."
                />
              </RowActionsCell>
            )}
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
