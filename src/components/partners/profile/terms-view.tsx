import type { ReactNode } from "react";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { dayMonthYear, plural } from "@/lib/console-shared/format";
import type { TermsView } from "@/lib/partners/portal-data";
import { countryName } from "@/components/partners/profile/details";

/**
 * A partner's commission terms, as rates in percent (src/lib/partners/portal-data.ts TermsView): the
 * rate for a new customer and for renewals, the default, how long a customer earns, a distributor's
 * override on its resellers' customers and its territory rate, and any rate set for a plan or a
 * country. Only ever rendered for the money roles; the loader reads no terms for anyone else.
 * Server-safe.
 */

function Rate({ label, rate, note }: { label: string; rate: string; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-text">
        <span className="font-semibold tabular-nums">{rate}</span>
        {note && <span className="text-muted">{" "}{note}</span>}
      </dd>
    </div>
  );
}

const duration = (months: number | null) =>
  months === null ? "For as long as the customer stays with you" : `For ${plural(months, "month")} from the customer's first payment (or from when it became yours, if later)`;

/** One version of the terms: its rates and, when set, its plan and country rates. */
export function TermsBlock({ terms }: { terms: TermsView }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {terms.newRate && <Rate label="New customers" rate={terms.newRate} note={`for their first ${plural(terms.newMonths, "month")}`} />}
        {terms.renewalRate && <Rate label="Renewals" rate={terms.renewalRate} note={`after the first ${plural(terms.newMonths, "month")}`} />}
        <Rate label="Default rate" rate={terms.defaultRate} note="when no other rate applies" />
        {terms.overrideRate && <Rate label="Override on your resellers' customers" rate={terms.overrideRate} note="on top of the reseller's own commission" />}
        {terms.territoryRate && <Rate label="Customers credited to you by territory" rate={terms.territoryRate} />}
        <div className="min-w-0 sm:col-span-full">
          <dt className="text-xs text-muted">How long a customer earns</dt>
          <dd className="mt-0.5 text-sm text-text">{duration(terms.durationMonths)}</dd>
        </div>
      </dl>

      {(terms.planRates.length > 0 || terms.countryRates.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {terms.planRates.length > 0 && (
            <div className="min-w-0 rounded-lg border border-line">
              <DataTable caption="Rates for particular plans" minWidth={280}>
                <THead>
                  <Th>Plan</Th>
                  <Th numeric>Rate</Th>
                </THead>
                <TBody>
                  {terms.planRates.map((r) => (
                    <Tr key={`plan-${r.planName}`}>
                      <Td>{r.planName}</Td>
                      <Td numeric>{r.rate}</Td>
                    </Tr>
                  ))}
                </TBody>
              </DataTable>
            </div>
          )}
          {terms.countryRates.length > 0 && (
            <div className="min-w-0 rounded-lg border border-line">
              <DataTable caption="Rates for customers in particular countries" minWidth={280}>
                <THead>
                  <Th>{"Customer's country"}</Th>
                  <Th numeric>Rate</Th>
                </THead>
                <TBody>
                  {terms.countryRates.map((r) => (
                    <Tr key={`country-${r.country}`}>
                      <Td>{countryName(r.country)}</Td>
                      <Td numeric>{r.rate}</Td>
                    </Tr>
                  ))}
                </TBody>
              </DataTable>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The terms in force now, then any that start later — each with the day it takes effect. */
export function TermsSection({ inForce, scheduled, distributor }: { inForce: TermsView | null; scheduled: TermsView[]; distributor: boolean }) {
  return (
    <div className="space-y-6">
      {inForce ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{`In force since ${dayMonthYear(inForce.effectiveFrom)}.`}</p>
          <TermsBlock terms={inForce} />
        </div>
      ) : (
        <p className="text-sm text-muted">No commission terms are in force yet. Your partner manager sets them; nothing is earned until they do.</p>
      )}
      {scheduled.map((terms) => (
        <div key={terms.effectiveFrom.toISOString()} className="space-y-3 border-t border-line pt-4">
          <h3 className="text-[13px] font-medium text-text">{`From ${dayMonthYear(terms.effectiveFrom)}`}</h3>
          <TermsBlock terms={terms} />
        </div>
      ))}
      <p className="text-xs text-muted">
        {`Which rate an invoice earns: ${distributor ? "a customer credited to you by territory takes the territory rate; otherwise " : ""}a plan's rate, then the customer's country's, then the new-customer or renewal rate, then the default. Commission is worked out on the invoice before tax.`}
      </p>
    </div>
  );
}
