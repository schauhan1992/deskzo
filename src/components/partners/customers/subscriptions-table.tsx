import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { INTERVAL_WORD } from "@/components/partners/customers/customers-table";
import { formatMoney } from "@/lib/billing/money";
import { dayMonthYear } from "@/lib/console-shared/format";
import { ENDS_AT_PERIOD_END, SUBSCRIPTION_STATUS } from "@/lib/console-shared/labels";
import type { CustomerSubscription } from "@/lib/partners/portal-data";

const PER: Record<"MONTH" | "YEAR", string> = { MONTH: "month", YEAR: "year" };

/**
 * A customer's live subscriptions, one row per plan on them: the plan, how many, how often it is
 * charged, its list price, when the current period ends, and the subscription's state — with "Ends at
 * period end" when it is set to cancel. A plan with no gateway price (a trial, a plan given by hand)
 * says it is not charged rather than showing a price nobody pays.
 *
 * Server-safe: no hooks, no directive.
 */
export function SubscriptionsTable({ subscriptions }: { subscriptions: CustomerSubscription[] }) {
  const rows = subscriptions.flatMap((sub, s) => sub.items.map((item, i) => ({ key: `${s}-${i}-${item.key}`, sub, item })));
  return (
    <DataTable caption="Subscriptions" minWidth={820}>
      <THead>
        <Th>Plan</Th>
        <Th numeric>Quantity</Th>
        <Th>Interval</Th>
        <Th numeric>List price</Th>
        <Th>Period end</Th>
        <Th>State</Th>
      </THead>
      <TBody>
        {rows.map(({ key, sub, item }) => {
          const interval = item.interval ?? sub.interval;
          const priced = item.unitAmount !== null && Boolean(item.currency);
          const periodEnd = sub.currentPeriodEnd ?? (sub.status === "TRIALING" ? sub.trialEndsAt : null);
          return (
            <Tr key={key}>
              <Td>
                <span className="font-medium">{item.name}</span>
              </Td>
              <Td numeric>{item.quantity.toLocaleString("en-IN")}</Td>
              <Td nowrap>{interval ? INTERVAL_WORD[interval] : <span className="text-muted">—</span>}</Td>
              <Td numeric>
                {priced ? (
                  <>
                    {formatMoney(item.unitAmount ?? 0, item.currency ?? "")}
                    {interval && <span className="text-xs text-muted">{` / ${PER[interval]}`}</span>}
                  </>
                ) : (
                  <span className="text-muted">Not charged</span>
                )}
              </Td>
              <Td muted nowrap>
                {periodEnd ? (
                  <>
                    {dayMonthYear(periodEnd)}
                    {sub.status === "TRIALING" && !sub.currentPeriodEnd && <span className="block text-[11px] text-subtle">Trial ends</span>}
                  </>
                ) : (
                  "—"
                )}
              </Td>
              <Td nowrap>
                <span className="flex flex-wrap items-center gap-1">
                  <LabelPill map={SUBSCRIPTION_STATUS} value={sub.status} />
                  {sub.cancelAtPeriodEnd && <StatusPill tone={ENDS_AT_PERIOD_END.tone}>{ENDS_AT_PERIOD_END.label}</StatusPill>}
                </span>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
