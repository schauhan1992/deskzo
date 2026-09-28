import { FileText } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { monthLabel } from "@/lib/console-shared/format";
import { STATEMENT_STATUS } from "@/lib/console-shared/labels";
import { STATEMENT_STATUSES, parseStatementFilters } from "@/lib/console-shared/partner-params";
import type { Caps } from "@/lib/console-shared/roles";
import type { StatementsBoard } from "@/lib/partners/commission-data";
import { COMMISSIONS_PATH, currencyOptions, hrefWith, recentPeriods } from "./format";
import { Pager } from "./pager";
import { StatementsTable } from "./statements-table";

/**
 * The Statements tab (spec §9.2): every statement, by status with counts, filtered by partner,
 * currency and month. A row opens the statement's drawer; payers approve, record payment and void
 * from the row. Drafts are made by "Generate statements" (the page header) or by the tick on the
 * programme's statement day.
 */

export function StatementsTab({
  board,
  params,
  caps,
  viewerId,
  todayKey,
}: {
  board: StatementsBoard;
  /** The Statements tab's own query string (empty while another tab is the one open). */
  params: Record<string, string>;
  caps: Caps;
  viewerId: string;
  todayKey: string;
}) {
  const f = parseStatementFilters(params);
  const base: Record<string, string> = { ...params, tab: "statements" };
  delete base.statement;
  const change = (changes: Record<string, string | null>) => hrefWith(COMMISSIONS_PATH, base, { ...changes, page: null });
  const clearHref = `${COMMISSIONS_PATH}?tab=statements`;
  const chips = [
    ...(f.partner ? [{ key: "partner", label: `Partner: ${f.partner}`, removeHref: change({ partner: null }) }] : []),
    ...(f.currency ? [{ key: "currency", label: `Currency: ${f.currency}`, removeHref: change({ currency: null }) }] : []),
    ...(f.period ? [{ key: "period", label: `Month: ${monthLabel(f.period)}`, removeHref: change({ period: null }) }] : []),
  ];
  const all = STATEMENT_STATUSES.reduce((sum, s) => sum + board.counts[s], 0);
  const periods = recentPeriods(board.nextPeriod, 12);
  if (f.period && !periods.includes(f.period)) periods.push(f.period);
  const currencies = currencyOptions(board.rows.map((r) => r.currency), [f.currency]);
  const listParams: Record<string, string> = { ...base };
  delete listParams.tab;

  return (
    <div>
      <div className="mb-4">
        <ViewTabs
          label="Statements by status"
          items={[
            { key: "all", label: "All", href: change({ status: null }), active: !f.status, count: all },
            ...STATEMENT_STATUSES.map((s) => ({ key: s, label: STATEMENT_STATUS[s].label, href: change({ status: s }), active: f.status === s, count: board.counts[s] })),
          ]}
        />
      </div>
      <FilterBar>
        <SearchField param="partner" label="Partner slug" placeholder="Partner slug, e.g. acme" />
        <SelectFilter param="currency" label="Currency" options={currencies.map((c) => ({ value: c, label: c }))} />
        <SelectFilter param="period" label="Month" options={periods.map((p) => ({ value: p, label: monthLabel(p) }))} />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 || f.status ? clearHref : undefined} />

      <div className="mb-4 space-y-3">
        {caps.payPartners && board.twoPersonPayout && (
          <Banner tone="info" title="The two-person rule is on">
            Whoever approves a statement can&apos;t also record its payment — another payer does.
          </Banner>
        )}
        {!caps.payPartners && (
          <Banner tone="neutral" title="Approving and paying statements is for owners and billing staff">
            You can generate drafts, open a statement and export it.
          </Banner>
        )}
      </div>

      <Panel padded={false} footer={board.rows.length > 0 ? `Statements are per partner, per currency, per month — ${monthLabel(board.nextPeriod)} is the next to draft.` : undefined}>
        {board.rows.length === 0 ? (
          chips.length > 0 || f.status ? (
            <EmptyState variant="filtered" title="No statements match these filters" body="Try another status, month or currency." clearHref={clearHref} />
          ) : (
            <EmptyState
              icon={<FileText className="h-5 w-5" />}
              title="No statements yet"
              body={`Statements are drafted once a month from pending commission. ${monthLabel(board.nextPeriod)}'s can be generated now from the page header.`}
            />
          )
        ) : (
          <StatementsTable rows={board.rows} caps={caps} viewerId={viewerId} twoPersonPayout={board.twoPersonPayout} todayKey={todayKey} showPartner listParams={listParams} />
        )}
      </Panel>
      <Pager page={board.page} pageSize={board.pageSize} total={board.total} noun="statement" path={COMMISSIONS_PATH} params={base} />
    </div>
  );
}
