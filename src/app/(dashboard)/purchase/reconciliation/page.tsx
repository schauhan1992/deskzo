import Link from "next/link";
import { notFound } from "next/navigation";
import { ScanSearch } from "lucide-react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { reconcilableVendors } from "@/actions/reconcile";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { UploadStatement } from "@/components/reconcile/upload-statement";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  if (!(await isModuleEnabled("purchase_documents"))) return <ModuleDisabledNotice moduleKey="purchase_documents" />;
  const user = await requireUser();
  if (!(await can(user.id, "purchase.reconcile"))) notFound();

  const [statements, vendors] = await Promise.all([
    db.vendorStatement.findMany({
      orderBy: { periodStart: "desc" },
      take: 50,
      include: {
        vendor: { select: { name: true } },
        lines: { select: { state: true, variance: true, resolvedAt: true } },
      },
    }),
    reconcilableVendors(),
  ]);

  const rows = statements.map((s) => {
    const open = s.lines.filter((l) => l.state !== "MATCHED" && !l.resolvedAt);
    return {
      id: s.id,
      label: s.label,
      vendor: s.vendor.name,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      lineCount: s.lineCount,
      totalBilled: Number(s.totalBilled),
      matched: s.lines.filter((l) => l.state === "MATCHED").length,
      open: open.length,
      // Only what is still open, and only the direction that costs money — a page that keeps
      // counting resolved exceptions is one nobody can ever finish.
      atRisk: open.reduce((sum, l) => sum + Math.max(0, Number(l.variance ?? 0)), 0),
    };
  });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Vendor reconciliation</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What the distributor billed us against what we actually sold. Seat counts that drifted, subscriptions
            still being charged for after they lapsed, and orders live on our side that never reached the vendor.
          </p>
        </div>
        {vendors.ok && <UploadStatement vendors={vendors.data} />}
      </div>

      {rows.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ScanSearch className="h-8 w-8 text-subtle" />
            <p className="text-sm font-medium text-text">No statement has been reconciled yet.</p>
            <p className="max-w-md text-sm text-muted">
              Upload the monthly file your distributor sends — a CSV or Excel export, whose columns are worked out for
              you and remembered. Or type the lines in, for the supplier who sends a PDF or four lines in an email.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2 font-medium">Statement</th>
                    <th className="px-5 py-2 font-medium">Period</th>
                    <th className="px-5 py-2 font-medium">Lines</th>
                    <th className="px-5 py-2 font-medium">Billed</th>
                    <th className="px-5 py-2 font-medium">Open</th>
                    <th className="px-5 py-2 font-medium">Worth checking</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                      <td className="px-5 py-2.5">
                        <Link href={`/purchase/reconciliation/${r.id}`} className="font-medium text-brand hover:underline">
                          {r.label}
                        </Link>
                        <div className="text-xs text-muted">{r.vendor}</div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                        {/* Typed days, held at UTC midnight: the days themselves. */}
                        {formatCalendarDay(r.periodStart)} – {formatCalendarDay(r.periodEnd)}
                      </td>
                      <td className="px-5 py-2.5 text-muted">
                        {r.matched}/{r.lineCount} matched
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-text">{formatCurrency(r.totalBilled)}</td>
                      <td className="px-5 py-2.5">
                        {r.open === 0 ? (
                          <Badge tone="green">All clear</Badge>
                        ) : (
                          <Badge tone="red">{r.open}</Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 font-medium text-text">
                        {r.atRisk > 0 ? formatCurrency(r.atRisk) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
