import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { listSupportLoad, type SupportSort } from "@/actions/support-load";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SupportLevelBadge } from "@/components/support/support-load-panel";
import { Pagination } from "@/components/ui/pagination";
import { Card } from "@/components/ui/card";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { formatCurrency } from "@/lib/utils";
import { companyPath } from "@/lib/record-links";

const PERIODS = [3, 6, 12, 24];
const SORTS: { key: SupportSort; label: string }[] = [
  { key: "tickets", label: "Most tickets" },
  { key: "intensity", label: "Most support per rupee" },
  { key: "hours", label: "Most recorded time" },
];

/**
 * Which customers take the most support — and whether what they pay covers it.
 *
 * "Most tickets" finds the busy accounts; "most support per rupee" finds the ones to have a
 * conversation with: a lot of support against little billing, with anything supported and not
 * billed at all at the very top.
 */
export default async function SupportLoadPage({
  searchParams,
}: {
  searchParams: Promise<{ months?: string; sort?: string; page?: string; pageSize?: string }>;
}) {
  if (!(await isModuleEnabled("helpdesk"))) return <ModuleDisabledNotice moduleKey="helpdesk" />;

  const params = await searchParams;
  const months = PERIODS.includes(Number(params.months)) ? Number(params.months) : 12;
  const sort = SORTS.find((s) => s.key === params.sort)?.key ?? "tickets";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const result = await listSupportLoad({ months, sort, page, pageSize });

  const href = (overrides: Record<string, string>) => {
    const query = new URLSearchParams({ months: String(months), sort, ...(params.pageSize ? { pageSize: params.pageSize } : {}), ...overrides });
    return `/tickets/load?${query}`;
  };
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-sm ${active ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"}`;

  return (
    <div>
      <Link href="/tickets" className="text-sm text-muted hover:text-text">
        ← Tickets
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">Support load</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        How much support each customer took, set against what they were billed over the same months. Heavy means at least twice the
        typical customer&apos;s tickets per ₹1 lakh billed.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {PERIODS.map((m) => (
          <Link key={m} href={href({ months: String(m) })} className={chip(m === months)}>
            {m} months
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {SORTS.map((s) => (
          <Link key={s.key} href={href({ sort: s.key })} className={chip(s.key === sort)}>
            {s.label}
          </Link>
        ))}
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Customer</th>
              <th className="px-4 py-2.5">Load</th>
              <th className="px-4 py-2.5 text-right">Tickets</th>
              <th className="px-4 py-2.5 text-right">Open</th>
              <th className="px-4 py-2.5 text-right">Calls / visits</th>
              <th className="px-4 py-2.5 text-right">Recorded time</th>
              {result.canSeeMoney && <th className="px-4 py-2.5 text-right">Billed</th>}
              {result.canSeeMoney && <th className="px-4 py-2.5 text-right">Tickets per ₹1L</th>}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <Link href={`${companyPath(r.companySeq)}?tab=tickets`} className="font-medium text-text hover:underline">
                    {r.name}
                  </Link>
                  {r.isReseller && <span className="ml-1.5 text-xs text-subtle">reseller</span>}
                </td>
                <td className="px-4 py-2.5">
                  <SupportLevelBadge level={r.level} multiple={r.multiple} />
                </td>
                <td className="px-4 py-2.5 text-right text-text">
                  {r.tickets}
                  {r.urgent + r.high > 0 && <span className="block text-[11px] text-danger">{r.urgent + r.high} urgent/high</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.open}
                  {r.openPastDue > 0 && <span className="block text-[11px] text-danger">{r.openPastDue} late</span>}
                </td>
                <td className="px-4 py-2.5 text-right text-muted">
                  {r.calls ?? "—"} / {r.visits ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right text-muted">{r.recordedHours === null ? "—" : `${r.recordedHours} h`}</td>
                {result.canSeeMoney && <td className="px-4 py-2.5 text-right text-text">{formatCurrency(r.billed ?? 0)}</td>}
                {result.canSeeMoney && (
                  <td className="px-4 py-2.5 text-right">
                    {r.ticketsPerLakh === null ? <span className="text-warning">nothing billed</span> : r.ticketsPerLakh}
                  </td>
                )}
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-subtle">
                  No customer of yours took support in the last {months} months.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} label="customers" />
    </div>
  );
}
