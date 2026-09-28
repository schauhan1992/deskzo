import Link from "next/link";
import { HandCoins } from "lucide-react";
import { consoleExportCommissions } from "@/actions/platform/console-commissions";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { DateRangeFilter, SearchField, SelectFilter, ToggleFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { COMMISSION_KIND, COMMISSION_STATUS } from "@/lib/console-shared/labels";
import { COMMISSION_KINDS, parseCommissionFilters } from "@/lib/console-shared/partner-params";
import type { Caps } from "@/lib/console-shared/roles";
import type { CommissionReview } from "@/lib/partners/commission-data";
import { AddAdjustmentButton } from "./adjustment-dialog";
import { COMMISSIONS_PATH, currencyOptions, hrefWith } from "./format";
import { EntriesTable } from "./entries-table";
import { Pager } from "./pager";

/**
 * The Review tab (spec §9.2): commission entries across partners — PENDING unless the filters say
 * otherwise — with the ones worth a second look first, each with its reason; totals per currency
 * over every match; Void per entry, Add adjustment, and the same list as CSV.
 */

const KIND_OPTIONS = COMMISSION_KINDS.map((k) => ({ value: k, label: COMMISSION_KIND[k].label }));
/** The list is PENDING with no status chosen, so "All" would be a lie: the empty choice is Pending. */
const STATUS_OPTIONS = (["APPROVED", "PAID", "VOID"] as const).map((s) => ({ value: s, label: COMMISSION_STATUS[s].label }));

function rangeText(from: string | undefined, to: string | undefined): string {
  if (from && to) return from === to ? dayKeyLabel(from) : `${dayKeyLabel(from)} – ${dayKeyLabel(to)}`;
  return from ? `from ${dayKeyLabel(from)}` : `until ${dayKeyLabel(to ?? "")}`;
}

export function ReviewTab({
  data,
  params,
  exportArgs,
  caps,
  todayKey,
}: {
  data: CommissionReview;
  /** The Review tab's own query string (empty while another tab is the one open). */
  params: Record<string, string>;
  /** The same, as `exportParams` gives it, for the CSV. */
  exportArgs: Record<string, string>;
  caps: Caps;
  todayKey: string;
}) {
  const f = parseCommissionFilters(params);
  const base = { ...params };
  delete base.tab;
  delete base.statement;
  const remove = (...keys: string[]) => hrefWith(COMMISSIONS_PATH, base, Object.fromEntries([...keys, "page"].map((k) => [k, null])));
  const chips = [
    ...(f.partner ? [{ key: "partner", label: `Partner: ${f.partner}`, removeHref: remove("partner") }] : []),
    ...(f.status ? [{ key: "status", label: `Status: ${COMMISSION_STATUS[f.status].label}`, removeHref: remove("status") }] : []),
    ...(f.currency ? [{ key: "currency", label: `Currency: ${f.currency}`, removeHref: remove("currency") }] : []),
    ...(f.kind ? [{ key: "kind", label: `Kind: ${COMMISSION_KIND[f.kind].label}`, removeHref: remove("kind") }] : []),
    ...(f.from || f.to ? [{ key: "earned", label: `Earned ${rangeText(f.from, f.to)}`, removeHref: remove("from", "to") }] : []),
    ...(f.flagged ? [{ key: "flagged", label: "Flagged only", removeHref: remove("flagged") }] : []),
  ];
  const currencies = currencyOptions(data.totals.map((t) => t.currency), [f.currency]);
  const statusWord = COMMISSION_STATUS[data.status].label.toLowerCase();

  return (
    <div>
      <FilterBar
        trailing={
          caps.partnerMoney ? (
            <>
              <AddAdjustmentButton currencies={currencies} defaultCurrency={f.currency} todayKey={todayKey} suggest={f.partner} />
              <ExportCsvButton action={consoleExportCommissions.bind(null, exportArgs, "review")} />
            </>
          ) : undefined
        }
      >
        <SearchField param="partner" label="Partner slug" placeholder="Partner slug, e.g. acme" />
        <SelectFilter param="status" label="Status" options={STATUS_OPTIONS} allLabel="Pending" />
        <SelectFilter param="currency" label="Currency" options={currencies.map((c) => ({ value: c, label: c }))} />
        <SelectFilter param="kind" label="Kind" options={KIND_OPTIONS} />
        <DateRangeFilter label="Earned" />
        <ToggleFilter param="flagged" label="Flagged only" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={chips.length > 0 ? COMMISSIONS_PATH : undefined} />

      {data.flaggedCount > 0 && !f.flagged && (
        <Banner
          tone="warning"
          className="mb-4"
          title={`${plural(data.flaggedCount, "entry", "entries")} worth a second look — listed first`}
          action={
            <Link href={hrefWith(COMMISSIONS_PATH, base, { flagged: "1", page: null })} scroll={false} className="text-sm font-medium underline">
              Show only these
            </Link>
          }
        >
          Their customer&apos;s attribution was flagged and not reviewed yet, or the amount is over five times the partner&apos;s usual.
        </Banner>
      )}

      <Panel
        padded={false}
        footer={
          data.rows.length > 0
            ? `Totals cover every ${statusWord} entry the filters match, one line per currency — never added across currencies. A statement takes pending entries once a month.`
            : undefined
        }
      >
        {data.rows.length === 0 ? (
          chips.length > 0 ? (
            <EmptyState variant="filtered" title="No entries match these filters" body="Try another status, currency or date range." clearHref={COMMISSIONS_PATH} />
          ) : (
            <EmptyState
              icon={<HandCoins className="h-5 w-5" />}
              title="Nothing waiting for review"
              body="Commission appears here as partners' customers pay their invoices, and waits until a statement takes it."
            />
          )
        ) : (
          <EntriesTable rows={data.rows} caps={caps} showPartner totals={data.totals} statementParams={f.partner ? { partner: f.partner } : {}} />
        )}
      </Panel>
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} noun="entry" nouns="entries" path={COMMISSIONS_PATH} params={base} />
    </div>
  );
}
