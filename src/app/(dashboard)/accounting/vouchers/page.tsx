import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { listVouchers, voucherCapabilities } from "@/actions/vouchers";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { Amount } from "@/components/accounting/report-chrome";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { voucherStatusLabels, voucherStatusTone, voucherTypeLabels } from "@/lib/accounts/vouchers";
import { formatCalendarDay } from "@/lib/time/zone";

const TYPES = ["PAYMENT", "RECEIPT", "CONTRA", "JOURNAL"] as const;

/**
 * Payment, receipt, contra and journal vouchers (owner, 22 Oct 2026) — every one written, by kind, with what
 * is waiting for a second person a click away. Nothing here posts by itself: a voucher is written, approved
 * where Accounts settings ask for it, then posted; a posted one is reversed, never edited.
 */
export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string; q?: string; from?: string; to?: string; page?: string; pageSize?: string }>;
}) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const caps = await voucherCapabilities();
  if (!caps.read) notFound();

  const params = await searchParams;
  const type = (TYPES as readonly string[]).includes(params.type ?? "") ? params.type! : "ALL";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const result = caps.migrated
    ? await listVouchers({ type: type === "ALL" ? undefined : type, status: params.status, search: params.q, from: params.from, to: params.to, page, pageSize })
    : null;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Vouchers</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Money paid and received, moved between your own bank and cash accounts, and every other entry —
            written as a voucher, {caps.approvalRequired ? "approved by a second person, " : ""}then posted to the books.
            A posted voucher is never edited; it is reversed, and both stay on record.
          </p>
        </div>
        {caps.create && caps.migrated && (
          <Link
            href={type === "ALL" ? "/accounting/vouchers/new" : `/accounting/vouchers/new?type=${type}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            New voucher
          </Link>
        )}
      </div>

      {!result ? (
        <Card className="mt-5 px-5 py-8 text-center text-sm text-muted">
          This workspace&apos;s database hasn&apos;t been brought up to date for vouchers yet. Once it has, they&apos;re written here.
        </Card>
      ) : (
        <>
          {result.pending > 0 && (
            <Card className="mt-5 flex flex-wrap items-center justify-between gap-3 border-warning/40 bg-warning-bg px-4 py-3">
              <p className="text-sm text-text">
                <span className="font-semibold">{result.pending}</span> voucher{result.pending === 1 ? "" : "s"} waiting for approval.
              </p>
              {params.status !== "PENDING_APPROVAL" && (
                <Link href="/accounting/vouchers?status=PENDING_APPROVAL" className="text-sm font-medium text-brand hover:underline">
                  Show them
                </Link>
              )}
            </Card>
          )}

          <div className="mt-5">
            <TabNav
              basePath="/accounting/vouchers"
              paramName="type"
              activeKey={type}
              defaultKey="ALL"
              otherParams={{ status: params.status, q: params.q, from: params.from, to: params.to }}
              tabs={[{ key: "ALL", label: "All" }, ...TYPES.map((t) => ({ key: t, label: voucherTypeLabels[t] }))]}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <SearchParamInput paramName="q" placeholder="Search number, narration or reference…" className="w-72" />
            <SelectParamFilter
              paramName="status"
              label="Status"
              allLabel="Any status"
              options={(Object.keys(voucherStatusLabels) as (keyof typeof voucherStatusLabels)[]).map((s) => ({ value: s, label: voucherStatusLabels[s] }))}
            />
            <DateRangePicker fromParam="from" toParam="to" label="Dated" />
          </div>

          <Card className="mt-4 overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Number</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Kind</th>
                  <th className="px-4 py-2.5">Narration</th>
                  <th className="px-4 py-2.5">Bank / cash</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((v) => (
                  <tr key={v.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="whitespace-nowrap px-4 py-2">
                      <Link href={`/accounting/vouchers/${v.id}`} className="font-mono text-xs text-brand hover:underline">
                        {v.number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-muted">{formatCalendarDay(v.date)}</td>
                    <td className="px-4 py-2 text-muted">{voucherTypeLabels[v.type]}</td>
                    <td className="max-w-md px-4 py-2">
                      <span className="line-clamp-1 text-text">{v.narration}</span>
                      {(v.company || v.reference) && (
                        <span className="block text-xs text-subtle">
                          {[v.company?.name, v.reference ? `Ref ${v.reference}` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted">{v.moneyAccount?.name ?? "—"}</td>
                    <td className="px-4 py-2 text-right">
                      <Amount value={v.amount} />
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={voucherStatusTone[v.status]}>{voucherStatusLabels[v.status]}</Badge>
                    </td>
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-subtle">
                      {params.q || params.status || params.from || params.to || type !== "ALL"
                        ? "No voucher matches these filters."
                        : "No vouchers yet. Write one for money paid or received that no invoice or bill accounts for."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={totalPages(result.total, result.pageSize)}
            pageSizes={PAGE_SIZES.filter((s) => s <= 100)}
            label="vouchers"
          />
        </>
      )}
    </div>
  );
}
