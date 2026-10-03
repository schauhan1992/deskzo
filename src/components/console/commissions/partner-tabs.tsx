import Link from "next/link";
import { CircleCheck, Clock as ClockIcon, FileText, HandCoins, Wallet } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { formatMoney } from "@/lib/billing/money";
import { monthLabel, plural } from "@/lib/console-shared/format";
import { COMMISSION_KIND, COMMISSION_STATUS } from "@/lib/console-shared/labels";
import { COMMISSION_KINDS, COMMISSION_STATUSES } from "@/lib/console-shared/partner-params";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerCommissionsTab as PartnerCommissionsData, PartnerStatementsTab as PartnerStatementsData } from "@/lib/partners/commission-data";
import { indiaClock, type Clock } from "@/lib/time/zone";
import { AddAdjustmentButton } from "./adjustment-dialog";
import { COMMISSIONS_PATH, currencyOptions, hrefWith, partnerHref } from "./format";
import { EntriesTable } from "./entries-table";
import { LivePager } from "./live-pager";
import { PartnerCommissionsExport } from "./partner-export";
import { GenerateStatementsButton } from "./run-buttons";
import { StatementsTable } from "./statements-table";

/**
 * A partner's Commissions and Statements tabs, for the partner 360 (/partners/<slug>; spec §9.2).
 * Server-renderable with no async inside: the 360 page loads `partnerCommissionsTab(id, filters)` and
 * `partnerStatementsTab(id)` and hands them in, with the console's clock. The same tables as
 * /commissions, narrowed to one partner: void and adjust for SELLERS, approve, pay and void for
 * PAYERS, Generate statements for it. An adjustment's and a payment's day are India's, as the server
 * checks them (src/lib/partners/terms.ts), whatever zone the console keeps.
 *
 * The Commissions tab's filters live in the 360's address, unprefixed: `status`, `currency`,
 * `kind`, `from`, `to` and `page` (the 360's activity filters carry their own prefix).
 *
 * Money is SELLERS' only (D14): anybody else is told where it is, and shown none of it.
 */

type PartnerProp = { id: string; slug: string; displayName: string };

const STATUS_OPTIONS = COMMISSION_STATUSES.map((s) => ({ value: s, label: COMMISSION_STATUS[s].label }));
const KIND_OPTIONS = COMMISSION_KINDS.map((k) => ({ value: k, label: COMMISSION_KIND[k].label }));

function MoneyHidden({ what }: { what: string }) {
  return (
    <Panel>
      <p className="text-sm text-muted">{`${what} are visible to billing staff.`}</p>
    </Panel>
  );
}

const nonZero = (list: { currency: string; minor: number }[]) => list.filter((m) => m.minor !== 0);

export function PartnerCommissionsTab({ partner, data, caps, clock }: { partner: PartnerProp; data: PartnerCommissionsData; caps: Caps; clock: Clock }) {
  if (!caps.partnerMoney) return <MoneyHidden what="Commissions" />;
  const base = partnerHref(partner.slug);
  const todayKey = indiaClock.dateKey(data.asOf);
  const currencies = currencyOptions(data.currencies);
  const anything = data.totals.length > 0;
  const balance = (pick: "pending" | "approved" | "paid") => nonZero(data.totals.map((t) => ({ currency: t.currency, minor: t[pick] })));

  return (
    <div className="space-y-6">
      <KpiGrid columns={3}>
        <KpiTile label="Pending" icon={<ClockIcon className="h-4 w-4" />} value={<MoneyList amounts={balance("pending")} />} secondary="Not on an approved statement yet" />
        <KpiTile label="Approved — to pay" icon={<Wallet className="h-4 w-4" />} value={<MoneyList amounts={balance("approved")} />} secondary="On approved statements" />
        <KpiTile label="Paid" icon={<CircleCheck className="h-4 w-4" />} value={<MoneyList amounts={balance("paid")} />} secondary="Every statement paid so far" />
      </KpiGrid>

      <div>
        <FilterBar
          trailing={
            <>
              <AddAdjustmentButton partner={{ slug: partner.slug, displayName: partner.displayName }} currencies={currencies} defaultCurrency={data.currencies[0]} todayKey={todayKey} />
              <PartnerCommissionsExport slug={partner.slug} />
            </>
          }
        >
          <SelectFilter param="status" label="Status" options={STATUS_OPTIONS} />
          <SelectFilter param="currency" label="Currency" options={currencies.map((c) => ({ value: c, label: c }))} />
          <SelectFilter param="kind" label="Kind" options={KIND_OPTIONS} />
          <DateRangeFilter label="Earned" />
        </FilterBar>

        <Panel padded={false} footer={data.rows.length > 0 ? "Every status, the latest earned first. A statement takes the pending entries once a month." : undefined}>
          {data.rows.length === 0 ? (
            anything ? (
              <EmptyState variant="filtered" title="No entries match these filters" body="Try another status, currency or date range." clearHref={`${base}?tab=commissions`} />
            ) : (
              <EmptyState
                icon={<HandCoins className="h-5 w-5" />}
                title="No commission yet"
                body={`Commission appears here as ${partner.displayName}'s customers pay their invoices, or when staff add an adjustment.`}
              />
            )
          ) : (
            <EntriesTable rows={data.rows} caps={caps} showPartner={false} statementParams={{ partner: partner.slug }} clock={clock} />
          )}
        </Panel>
        <LivePager path={base} tab="commissions" page={data.page} pageSize={data.pageSize} total={data.total} noun="entry" nouns="entries" />
      </div>

      <p className="text-xs text-muted">
        {"Flagged entries across every partner are on "}
        <Link href={hrefWith(COMMISSIONS_PATH, { partner: partner.slug })} className="font-medium text-brand hover:underline">
          Commissions › Review
        </Link>
        .
      </p>
    </div>
  );
}

export function PartnerStatementsTab({
  partner,
  data,
  caps,
  viewerId = null,
  clock,
}: {
  partner: PartnerProp;
  data: PartnerStatementsData;
  caps: Caps;
  /**
   * Optional: the staff member looking (`staff.id`). With the two-person rule on, their own approvals
   * get a switched-off "Mark paid" and the reason; without it the server still refuses, in the dialog.
   */
  viewerId?: string | null;
  clock: Clock;
}) {
  if (!caps.partnerMoney) return <MoneyHidden what="Statements" />;
  const todayKey = indiaClock.dateKey(data.asOf);
  const waiting = nonZero(data.awaitingStatement);

  return (
    <div className="space-y-6">
      {!data.payoutOnFile && (
        <Banner tone="warning" title="No payout details on file">
          {caps.payPartners
            ? "Statements can be drafted, but not approved until the partner's bank details are set — use Set payout details on the Overview tab."
            : "Statements can be drafted, but not approved until an owner or billing staff member sets the partner's bank details."}
        </Banner>
      )}
      {caps.payPartners && data.twoPersonPayout && (
        <Banner tone="info" title="The two-person rule is on">
          Whoever approves a statement can&apos;t also record its payment — another payer does.
        </Banner>
      )}

      <Panel
        title="Statements"
        description={
          waiting.length > 0
            ? `Waiting for a statement: ${waiting.map((m) => formatMoney(m.minor, m.currency)).join(" · ")}. ${monthLabel(data.nextPeriod)} is the next month to draft.`
            : `Nothing is waiting for a statement. ${monthLabel(data.nextPeriod)} is the next month to draft.`
        }
        actions={<GenerateStatementsButton nextPeriod={data.nextPeriod} partner={{ slug: partner.slug, displayName: partner.displayName }} />}
        padded={false}
      >
        {data.rows.length === 0 ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="No statements yet" body="A statement is drafted once a month from the partner's pending commission." />
        ) : (
          <StatementsTable
            rows={data.rows}
            caps={caps}
            viewerId={viewerId}
            twoPersonPayout={data.twoPersonPayout}
            todayKey={todayKey}
            showPartner={false}
            listParams={{ partner: partner.slug }}
            clock={clock}
          />
        )}
      </Panel>

      {data.total > data.rows.length && (
        <p className="text-xs text-muted">
          {`Showing the latest ${data.rows.length} of ${plural(data.total, "statement")}. `}
          <Link href={hrefWith(COMMISSIONS_PATH, { tab: "statements", partner: partner.slug })} className="font-medium text-brand hover:underline">
            See every one under Commissions
          </Link>
        </p>
      )}
    </div>
  );
}
