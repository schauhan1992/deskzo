import Link from "next/link";
import type { CreditRating } from "@prisma/client";
import { isModuleEnabled } from "@/actions/module";
import { listCreditRisks } from "@/actions/credit";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CreditBadge } from "@/components/credit/credit-badge";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { Card } from "@/components/ui/card";
import { paymentTermsLabels } from "@/lib/gst";
import { RATING_LABELS } from "@/lib/credit/engine";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { formatCurrency } from "@/lib/utils";

const FILTERS: (CreditRating | undefined)[] = [undefined, "RISKY", "FAIR", "NEW", "RELIABLE"];

/**
 * Every customer with a payment history, riskiest first — the credit controller's list.
 *
 * Who to chase, who not to give terms to, and whose standing terms have outgrown their record. Each
 * row opens the customer's Credit tab, where the rating is explained bill by bill.
 */
export default async function CustomerCreditPage({
  searchParams,
}: {
  searchParams: Promise<{ rating?: string; q?: string; page?: string; pageSize?: string }>;
}) {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;

  const params = await searchParams;
  const rating = FILTERS.find((f) => f === params.rating);
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const result = await listCreditRisks({ rating, q: params.q?.trim() || undefined, page, pageSize });
  const all = Object.values(result.counts).reduce((t, n) => t + (n ?? 0), 0);

  const hrefFor = (r: CreditRating | undefined) => {
    const query = new URLSearchParams();
    if (r) query.set("rating", r);
    if (params.q) query.set("q", params.q);
    if (params.pageSize) query.set("pageSize", params.pageSize);
    const s = query.toString();
    return s ? `/receivables/credit?${s}` : "/receivables/credit";
  };

  return (
    <div>
      <Link href="/receivables" className="text-sm text-muted hover:text-text">
        ← Receivables
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">Customer credit</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Every customer we have billed, rated on how they have actually paid — riskiest first. The rating decides the longest terms
        and the credit limit anyone can give without a credit override.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f ?? "all"}
            href={hrefFor(f)}
            className={`rounded-full px-3 py-1 text-sm ${
              rating === f ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"
            }`}
          >
            {f ? RATING_LABELS[f].replace(" — no history", "") : "All"} · {f ? (result.counts[f] ?? 0) : all}
          </Link>
        ))}
        <SearchParamInput paramName="q" placeholder="Search customer…" className="ml-auto w-64" />
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Customer</th>
              <th className="px-4 py-2.5">Rating</th>
              <th className="px-4 py-2.5 text-right">Owes</th>
              <th className="px-4 py-2.5 text-right">Overdue</th>
              <th className="px-4 py-2.5 text-right">Credit limit</th>
              <th className="px-4 py-2.5">Terms</th>
              <th className="px-4 py-2.5">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => {
              const used = r.limit > 0 ? Math.round((r.outstanding / r.limit) * 100) : null;
              return (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`/companies/${r.id}?tab=credit`} className="font-medium text-text hover:underline">
                      {r.name}
                    </Link>
                    {r.isReseller && <span className="ml-1.5 text-xs text-subtle">reseller</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <CreditBadge rating={r.rating} score={r.score} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-text">{formatCurrency(r.outstanding)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {r.overdue > 0 ? (
                      <span className="text-danger">
                        {formatCurrency(r.overdue)}
                        <span className="block text-[11px]">oldest {r.oldestOverdueDays} days</span>
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="text-text">{formatCurrency(r.limit)}</span>
                    <span className={`block text-[11px] ${used !== null && used > 100 ? "text-danger" : "text-subtle"}`}>
                      {r.limitSource === "manual" ? "set by hand" : "suggested"}
                      {used !== null ? ` · ${used}% used` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={r.termsBeyond ? "text-warning" : "text-text"}>{paymentTermsLabels[r.defaultTerms]}</span>
                    <span className="block text-[11px] text-subtle">
                      {r.termsBeyond ? "longer than " : "up to "}
                      {paymentTermsLabels[r.recommendedTerms]}
                      {r.termsBeyond ? " suggested" : ""}
                    </span>
                  </td>
                  <td className="max-w-xs px-4 py-2.5 text-xs text-muted">{r.reasons[0]?.text ?? "—"}</td>
                </tr>
              );
            })}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-subtle">
                  {rating ? `No customers rated ${RATING_LABELS[rating].toLowerCase()}.` : "No billed customers yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
        label="customers"
      />
    </div>
  );
}
