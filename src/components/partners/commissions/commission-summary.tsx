import { CircleCheck, Clock, HandCoins } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import type { PortalCommissions } from "@/lib/partners/portal-data";
import type { Money } from "@/lib/partners/types";

/**
 * The top of the commissions page: what the entries below add up to, and how an entry comes to be.
 * Server-safe: no hooks, no directive.
 */

type Totals = PortalCommissions["totals"];

/** One status's sums, one line per currency, never added across currencies; a currency at zero is left out. */
const amountsFor = (totals: Totals, key: "pending" | "approved" | "paid"): Money[] => totals.map((t) => ({ currency: t.currency, minor: t[key] })).filter((m) => m.minor !== 0);

/** Totals per currency per status, over every entry the filters match (the status filter aside), void entries left out. */
export function CommissionTotals({ totals }: { totals: Totals }) {
  return (
    <KpiGrid columns={3}>
      <KpiTile label="Pending" value={<MoneyList amounts={amountsFor(totals, "pending")} />} icon={<Clock className="h-4 w-4" />} secondary="Earned, waiting for the next monthly statement" />
      <KpiTile
        label="Approved — to pay"
        value={<MoneyList amounts={amountsFor(totals, "approved")} />}
        icon={<HandCoins className="h-4 w-4" />}
        tone="info"
        secondary="On an approved statement, being paid"
      />
      <KpiTile label="Paid" value={<MoneyList amounts={amountsFor(totals, "paid")} />} icon={<CircleCheck className="h-4 w-4" />} tone="success" secondary="Paid out on a statement" />
    </KpiGrid>
  );
}

/** How commission is earned and taken back, in four lines. The override line only for a distributor. */
export function CommissionExplainer({ distributor }: { distributor: boolean }) {
  const lines: { term: string; text: string }[] = [
    { term: "Direct", text: "Earned when a customer's invoice is paid, on the amount before tax, at the rate your terms set for it." },
    ...(distributor ? [{ term: "Override", text: "Your share of your resellers' customers' paid invoices, on top of the reseller's own commission." }] : []),
    { term: "Clawback", text: "A refund, credit note or cancelled invoice is taken back as a negative entry, on a later statement." },
    { term: "Adjustment", text: "A correction made by the platform, with a note saying why." },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {lines.map((line) => (
        <div key={line.term} className="min-w-0">
          <dt className="inline font-medium text-text">{`${line.term}: `}</dt>
          <dd className="inline text-muted">{line.text}</dd>
        </div>
      ))}
    </dl>
  );
}
