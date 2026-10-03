import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { STATE_LABELS, type ReconcileState } from "@/lib/reconcile/match";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { ExceptionList, type ExceptionRow } from "@/components/reconcile/exception-list";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

export const dynamic = "force-dynamic";

const BILLING_LABEL = { MONTHLY: "monthly", ANNUAL: "annually", ONE_OFF: "one-off" } as const;

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!(await can(user.id, "purchase.reconcile"))) {
    return <p className="text-sm text-muted">You don&rsquo;t have access to vendor reconciliation.</p>;
  }

  const statement = await db.vendorStatement.findUnique({
    where: { id },
    include: {
      vendor: { select: { name: true } },
      uploadedBy: { select: { name: true } },
      lines: {
        include: {
          matchedCompany: { select: { id: true, companySeq: true, name: true } },
          resolvedBy: { select: { name: true } },
          matchedOrder: { select: { orderSeq: true, quantity: true, item: { select: { name: true } } } },
        },
      },
    },
  });
  if (!statement) notFound();

  const rows: ExceptionRow[] = statement.lines
    .filter((l) => l.state !== "MATCHED")
    .map((l) => ({
      id: l.id,
      state: l.state as ReconcileState,
      source: l.source,
      rowNumber: l.rowNumber,
      sku: l.sku,
      description: l.description,
      customerRef: l.customerRef,
      quantity: l.quantity,
      unitCost: Number(l.unitCost),
      lineTotal: Number(l.lineTotal),
      variance: Number(l.variance ?? 0),
      note: l.note,
      matchedCompanyId: l.matchedCompany?.id ?? null,
      matchedCompanySeq: l.matchedCompany?.companySeq ?? null,
      matchedCompanyName: l.matchedCompany?.name ?? null,
      orderLabel: l.matchedOrder ? `#${l.matchedOrder.orderSeq} · ${l.matchedOrder.item.name}` : null,
      orderQuantity: l.matchedOrder?.quantity ?? null,
      resolvedAt: l.resolvedAt,
      resolvedByName: l.resolvedBy?.name ?? null,
      resolutionNote: l.resolutionNote,
    }))
    // Biggest first. A list in file order is a file; a list in value order is a morning's work.
    .sort((a, b) => b.variance - a.variance);

  const matched = statement.lines.filter((l) => l.state === "MATCHED").length;
  const openRows = rows.filter((r) => !r.resolvedAt);
  const atRisk = openRows.reduce((sum, r) => sum + Math.max(0, r.variance), 0);

  const tally = new Map<ReconcileState, number>();
  for (const r of openRows) tally.set(r.state, (tally.get(r.state) ?? 0) + 1);

  return (
    <div>
      <Link
        href="/purchase/reconciliation"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" />
        All statements
      </Link>

      <div className="mt-3">
        <h1 className="text-xl font-semibold text-text">{statement.label}</h1>
        <p className="mt-1 text-sm text-muted">
          {/* Typed days, held at UTC midnight (src/actions/reconcile.ts): the days themselves. */}
          {statement.vendor.name} · {formatCalendarDay(statement.periodStart)} – {formatCalendarDay(statement.periodEnd)} · billed{" "}
          {BILLING_LABEL[statement.billing]} · {statement.lineCount} lines,{" "}
          {formatCurrency(Number(statement.totalBilled))}
          {statement.filename ? "" : " · entered by hand"}
          {statement.complete ? "" : " · spot check"}
          {statement.uploadedBy ? ` · by ${statement.uploadedBy.name}` : ""}
        </p>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">Worth checking</div>
            <div className={`mt-0.5 text-2xl font-semibold ${atRisk > 0 ? "text-danger" : "text-text"}`}>
              {formatCurrency(atRisk)}
            </div>
            <div className="mt-0.5 text-xs text-muted">across {openRows.length} open line{openRows.length === 1 ? "" : "s"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">Agreed</div>
            <div className="mt-0.5 text-2xl font-semibold text-text">
              {matched}
              <span className="text-base font-normal text-muted">/{statement.lineCount}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted">lines that need nobody&rsquo;s attention</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <div className="text-xs text-muted">What kind</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tally.size === 0 ? (
                <Badge tone="green">All clear</Badge>
              ) : (
                [...tally.entries()].map(([state, count]) => (
                  <Badge key={state} tone={STATE_LABELS[state].tone} title={STATE_LABELS[state].blurb}>
                    {count} · {STATE_LABELS[state].label}
                  </Badge>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5">
        <ExceptionList rows={rows} />
      </div>
    </div>
  );
}
