import Link from "next/link";
import { MoneyList } from "@/components/console/charts/money-list";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { dayMonthYear } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { PartnerDirectoryRow } from "@/lib/partners/console-data";
import { partnerPath, territoriesText } from "./format";

/**
 * The /partners directory (spec §9.2): one row a partner, the whole row a link to its 360. Money
 * columns — its customers' MRR and the commission not yet on a statement — only for SELLERS
 * (`withMoney`); the loader does not even read them otherwise. Server-safe.
 */
export function PartnerDirectoryTable({ rows, withMoney }: { rows: PartnerDirectoryRow[]; withMoney: boolean }) {
  return (
    <DataTable caption="Partners" minWidth={withMoney ? 1080 : 880}>
      <THead>
        <Th>Partner</Th>
        <Th>Kind</Th>
        <Th>Status</Th>
        <Th>Territories</Th>
        <Th>Distributor</Th>
        <Th numeric>Customers</Th>
        {withMoney && <Th numeric>MRR</Th>}
        {withMoney && <Th numeric>Pending commission</Th>}
        <Th numeric>Users</Th>
        <Th>Created</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id} interactive>
            <Td>
              <RowLink href={partnerPath(row.slug)}>{row.displayName}</RowLink>
              <span className="block text-xs text-muted">{row.legalName !== row.displayName ? row.legalName : row.slug}</span>
            </Td>
            <Td>
              <LabelPill map={PARTNER_KIND} value={row.kind} />
            </Td>
            <Td>
              <LabelPill map={PARTNER_STATUS} value={row.status} />
            </Td>
            <Td mono nowrap>
              <span title={row.territories.join(", ")}>{territoriesText(row.territories)}</span>
            </Td>
            <Td>
              {row.parent ? (
                <Link href={partnerPath(row.parent.slug)} className="text-sm text-text hover:text-brand">
                  {row.parent.displayName}
                </Link>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Td>
            <Td numeric>{row.customers}</Td>
            {withMoney && (
              <Td numeric>
                <MoneyList amounts={row.mrr ?? []} size="sm" />
              </Td>
            )}
            {withMoney && (
              <Td numeric>
                <MoneyList amounts={row.pending ?? []} size="sm" />
              </Td>
            )}
            <Td numeric>{row.users}</Td>
            <Td nowrap muted>
              {dayMonthYear(row.createdAt)}
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
