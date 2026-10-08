import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { billsForPrepaid, getSchedule, listSchedules, scheduleFormOptions } from "@/actions/accounting-schedules";
import { listVendorOptions } from "@/actions/company";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { addMonths, lastCompletedMonth, monthKeyOf } from "@/lib/close/months";
import { SchedulesManager } from "@/components/close/schedules-manager";

const KINDS = ["PREPAID", "ACCRUAL"] as const;
const STATUSES = ["ACTIVE", "COMPLETED", "CANCELLED"] as const;

/**
 * Prepaids & accruals (Revenue & Close, spec §4.3): costs spread over the months they belong to.
 * Reading and posting is `close.work`; making, changing and stopping a schedule is `close.manage`.
 */
export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; schedule?: string }>;
}) {
  if (!(await isModuleEnabled("revenue_close"))) return <ModuleDisabledNotice moduleKey="revenue_close" />;

  const viewer = await currentUser();
  const [work, manage] = viewer ? await Promise.all([can(viewer.id, "close.work"), can(viewer.id, "close.manage")]) : [false, false];
  if (!work && !manage) notFound();

  const params = await searchParams;
  const kind = KINDS.find((k) => k === params.kind);
  const status = STATUSES.find((s) => s === params.status);

  const [rows, selected, options, bills, vendors, org] = await Promise.all([
    listSchedules({ kind, status }),
    params.schedule ? getSchedule(params.schedule) : Promise.resolve(null),
    manage ? scheduleFormOptions() : Promise.resolve(null),
    manage ? billsForPrepaid() : Promise.resolve([]),
    manage ? listVendorOptions().then((all) => all.map((v) => ({ id: v.id, name: v.name }))) : Promise.resolve([]),
    getOrganisation(),
  ]);

  // "Post through": the months that have ended, newest first — a month is posted once it is over.
  const last = lastCompletedMonth(new Date());
  const runMonths = Array.from({ length: 12 }, (_, i) => monthKeyOf(addMonths(last, -i)));

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Prepaids & accruals"
        subtitle="Costs paid ahead or incurred before their bill, spread over the months they belong to"
        organisation={org.legalName}
      />
      <div className="mt-5 space-y-4">
        {params.schedule && !selected && (
          <Card className="px-4 py-3 text-sm text-muted">That schedule no longer exists.</Card>
        )}
        <SchedulesManager
          rows={rows}
          filters={{ kind: kind ?? "", status: status ?? "" }}
          selected={selected}
          options={options}
          bills={bills}
          vendors={vendors}
          canWork={work}
          canManage={manage}
          runMonths={runMonths}
        />
      </div>
    </div>
  );
}
