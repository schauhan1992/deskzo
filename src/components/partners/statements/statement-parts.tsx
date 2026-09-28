import type { ReactNode } from "react";
import { DefinitionList } from "@/components/console/kit/panel";
import { Amount } from "@/components/partners/common/money";
import { AddressBlock, PayoutMaskList, countryName } from "@/components/partners/profile/details";
import type { StatementDetail } from "@/lib/partners/portal-data";
import { bpToPercent } from "@/lib/partners/types";
import { cn } from "@/lib/utils";

/**
 * A statement's own page, in parts: its sums down to the net payable, and the partner's details as
 * the statement recorded them (a later profile change does not rewrite a statement). Server-safe.
 */

function Line({ label, hint, children, strong }: { label: string; hint?: string; children: ReactNode; strong?: boolean }) {
  return (
    <tr className={cn(strong && "border-t border-line-strong")}>
      <th scope="row" className={cn("py-2 pr-4 text-left align-top font-normal", strong ? "font-medium text-text" : "text-muted")}>
        {label}
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </th>
      <td className={cn("py-2 text-right align-top tabular-nums", strong ? "font-semibold text-text" : "text-text")}>{children}</td>
    </tr>
  );
}

/**
 * Earned, clawed back and adjusted, the total, each tax line the platform entered (added or withheld),
 * and what is paid: the net payable. All in the statement's one currency.
 */
export function StatementTotals({ statement }: { statement: StatementDetail }) {
  const currency = statement.currency;
  return (
    <table className="w-full max-w-md text-sm">
      <caption className="sr-only">{`Totals of statement ${statement.number}, in ${currency}`}</caption>
      <tbody className="divide-y divide-line">
        <Line label="Earned" hint="Direct and override commission">
          <Amount minor={statement.earned} currency={currency} />
        </Line>
        <Line label="Clawed back" hint="Refunds, credit notes and cancelled invoices">
          <Amount minor={statement.reversed} currency={currency} />
        </Line>
        <Line label="Adjustments" hint="Corrections by the platform">
          <Amount minor={statement.adjustments} currency={currency} signed />
        </Line>
        <Line label="Total" strong>
          <Amount minor={statement.total} currency={currency} />
        </Line>
        {statement.taxLines.map((line, i) => (
          <Line
            key={`${i}-${line.label}`}
            label={`${line.label}${line.rateBp !== null ? ` (${bpToPercent(line.rateBp)})` : ""}`}
            hint={line.kind === "WITHHOLD" ? "Withheld" : "Added"}
          >
            <Amount minor={line.kind === "WITHHOLD" ? -line.amount : line.amount} currency={currency} signed />
          </Line>
        ))}
        <Line label="Net payable" hint="What is paid to you" strong>
          <Amount minor={statement.netPayable} currency={currency} className="text-base" />
        </Line>
      </tbody>
    </table>
  );
}

/** The partner as this statement recorded it: names, country, address, tax ids, and the payout details' mask. */
export function RecordedDetails({ snapshot }: { snapshot: StatementDetail["snapshot"] }) {
  return (
    <div className="space-y-4">
      <DefinitionList
        items={[
          { term: "Legal name", value: snapshot.legalName || "—" },
          { term: "Shown as", value: snapshot.displayName || "—" },
          { term: "Country", value: countryName(snapshot.country) },
          {
            term: "Tax ids",
            value:
              snapshot.taxIds.length > 0 ? (
                <span className="block">
                  {snapshot.taxIds.map((t) => (
                    <span key={`${t.kind}-${t.value}`} className="block">
                      <span className="text-muted">{`${t.kind} `}</span>
                      <span className="font-mono">{t.value}</span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted">None recorded</span>
              ),
          },
          { term: "Address", value: <AddressBlock address={snapshot.address} />, wide: true },
        ]}
      />
      <div className="border-t border-line pt-4">
        <h3 className="mb-3 text-[13px] font-medium text-text">Paid to</h3>
        {snapshot.payout ? <PayoutMaskList mask={snapshot.payout} /> : <p className="text-sm text-muted">No payout details were recorded on this statement.</p>}
      </div>
    </div>
  );
}
