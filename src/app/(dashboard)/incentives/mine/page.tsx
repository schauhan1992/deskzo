import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { myEarnings } from "@/actions/incentive";
import { Badge, Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { statusLabels, statusTone } from "@/lib/incentives/compute";
import { metricByKey } from "@/lib/targets/metrics";

export default async function MyIncentivesPage() {
  const enabled = await isModuleEnabled("incentives");
  if (!enabled) return <ModuleDisabledNotice moduleKey="incentives" />;

  const [earnings, clock] = await Promise.all([myEarnings(), workspaceClock()]);
  const paid = earnings.filter((e) => e.status === "PAID").reduce((t, e) => t + Number(e.amount), 0);
  const coming = earnings
    .filter((e) => e.status === "DUE" || e.status === "APPROVED")
    .reduce((t, e) => t + Number(e.amount), 0);

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">My incentives</h1>
      <p className="mt-1 text-sm text-muted">
        What you&apos;ve earned, how it was worked out, and where it is. Anything approved goes out with your salary
        as a taxable earning — it appears on your payslip rather than being paid separately.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Paid so far</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-text">{formatCurrency(paid)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Still to come</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-text">{formatCurrency(coming)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Periods</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-text">{earnings.length}</div>
        </Card>
      </div>

      <div className="mt-5 space-y-3">
        {earnings.map((e) => (
          <Card key={e.id} className="px-4 py-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text">
                    {e.metric ? metricByKey[e.metric].label : e.label}
                  </span>
                  <Badge tone={statusTone[e.status]}>{statusLabels[e.status]}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-subtle">
                  {e.label}
                  {e.scheme && ` · ${e.scheme.name}`}
                  {e.paidAt && ` · paid ${clock.date(e.paidAt)}`}
                </p>
              </div>
              <div className="text-lg font-semibold tabular-nums text-text">{formatCurrency(Number(e.amount))}</div>
            </div>

            {/* The explanation, in the same words whoever approved it read. */}
            <p className="mt-2 text-sm text-muted">{e.workings}</p>

            {e.heldReason && <p className="mt-1 text-sm text-warning">{e.heldReason}</p>}

            {e.status === "APPROVED" && !e.payable.payable && (
              <p className="mt-1 text-xs text-subtle">{e.payable.reason}</p>
            )}
            {e.payslip && (
              <p className="mt-1 text-xs text-subtle">
                Went out on your {e.payslip.run.month}/{e.payslip.run.year} payslip.
              </p>
            )}
          </Card>
        ))}

        {earnings.length === 0 && (
          <Card className="px-6 py-10 text-center text-sm text-subtle">
            Nothing yet. Incentives appear here once a target period has finished and been worked out.
          </Card>
        )}
      </div>
    </div>
  );
}
