import { StandingPill, StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { MoneyStack } from "@/components/partners/common/money";
import { SourceLabel } from "@/components/partners/common/pills";
import { countryName } from "@/components/partners/customers/country";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { CustomerRow } from "@/lib/partners/portal-data";
import { consoleClock } from "@/lib/platform/console-clock";

/** How often a plan is charged, in the words the portal uses. */
export const INTERVAL_WORD: Record<"MONTH" | "YEAR", string> = { MONTH: "Monthly", YEAR: "Yearly" };

/**
 * The customers list (spec §8.5): each workspace credited to the partner now — its name (a link to
 * its page), its address, country, plans, where it stands with paying (counted from the loader's
 * `asOf`), its MRR at list prices per currency, its next renewal, and since when and how it came to
 * the partner. A workspace staff set not to earn commission says "No commission"; a workspace that is
 * not simply active (setting up, held, closed) carries its status beside the name.
 *
 * Only the control plane's facts: never an owner or billing address, never anything from inside the
 * workspace. A server component: its days are the console's clock's (Settings › Time zone), which the
 * portal keeps.
 */
export async function CustomersTable({ rows, asOf, suffix }: { rows: CustomerRow[]; asOf: Date; suffix: string }) {
  const clock = await consoleClock();
  return (
    <DataTable caption="Customers credited to you" minWidth={1120}>
      <THead>
        <Th>Customer</Th>
        <Th>Address</Th>
        <Th>Country</Th>
        <Th>Plans</Th>
        <Th>Standing</Th>
        <Th numeric>MRR</Th>
        <Th>Renews</Th>
        <Th>Since</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.tenantId} interactive={Boolean(row.slug)}>
            <Td>
              <div className="flex min-w-40 flex-col items-start gap-1">
                {row.slug ? (
                  <RowLink href={PARTNER_ROUTES.customer(row.slug)} className="block max-w-[16rem] truncate">
                    {row.name}
                  </RowLink>
                ) : (
                  <span className="block max-w-[16rem] truncate font-medium text-text">{row.name}</span>
                )}
                {(row.status !== "ACTIVE" || !row.commissionable) && (
                  <span className="flex flex-wrap items-center gap-1">
                    {row.status !== "ACTIVE" && <TenantStatusPill status={row.status} />}
                    {!row.commissionable && <StatusPill tone="neutral">No commission</StatusPill>}
                  </span>
                )}
              </div>
            </Td>
            <Td mono muted nowrap>
              <span translate="no">{`${row.slug}${suffix}`}</span>
            </Td>
            <Td nowrap>
              <span title={countryName(row.country)}>{row.country}</span>
            </Td>
            <Td>
              {row.plans.length === 0 ? (
                <span className="text-muted">No plan</span>
              ) : (
                <ul className="space-y-0.5">
                  {row.plans.map((plan, i) => (
                    <li key={`${i}-${plan.key}`} className="whitespace-nowrap">
                      {plan.name}
                      {plan.quantity > 1 && <span className="text-muted tabular-nums">{` × ${plan.quantity.toLocaleString("en-IN")}`}</span>}
                      {plan.interval && <span className="text-xs text-muted">{` · ${INTERVAL_WORD[plan.interval]}`}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Td>
            <Td nowrap>
              <StandingPill kind={row.standing.kind} at={row.standing.at} asOf={asOf} />
            </Td>
            <Td numeric>
              <MoneyStack items={row.mrr} />
            </Td>
            <Td muted nowrap>
              {row.renewsAt ? clock.date(row.renewsAt) : "—"}
            </Td>
            <Td nowrap>
              <span className="block text-text">{clock.date(row.since)}</span>
              <SourceLabel source={row.source} className="block text-xs" />
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
