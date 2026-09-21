import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getPayrollRun, payrollRunTotals } from "@/actions/payroll";
import { listDepartmentOptions } from "@/actions/hr";
import { PayrollRegister } from "@/components/hr/payroll-register";

export default async function PayrollRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ search?: string; departmentId?: string; sort?: string; flag?: string }>;
}) {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const [{ id }, filters] = await Promise.all([params, searchParams]);
  const [run, totals, departments] = await Promise.all([
    getPayrollRun(id, filters),
    payrollRunTotals(id),
    listDepartmentOptions(),
  ]);
  if (!run) notFound();

  return (
    <div className="animate-fade-rise">
      <PayrollRegister run={run} totals={totals} departments={departments} />
    </div>
  );
}
