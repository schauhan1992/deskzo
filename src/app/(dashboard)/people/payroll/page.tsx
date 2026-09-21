import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listPayrollRuns, myPayslips } from "@/actions/payroll";
import { Card } from "@/components/ui/card";
import { PayrollRuns } from "@/components/hr/payroll-runs";
import { MyPayslips } from "@/components/hr/my-payslips";

export default async function PayrollPage() {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const caps = await hrCapabilities();
  const [runs, mine] = await Promise.all([listPayrollRuns(), myPayslips()]);

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">Payroll</h1>
        <p className="mt-1 text-sm text-muted">
          {caps.payroll
            ? "PF, ESI and professional tax are computed from the Indian rules. Income tax is entered by you."
            : "Your payslips. Only payroll can see anybody else's."}
        </p>
      </div>

      {caps.payroll ? (
        <div className="mt-5 space-y-5">
          <PayrollRuns runs={runs} />
          {mine.length > 0 && <MyPayslips payslips={mine} />}
        </div>
      ) : (
        <div className="mt-5">
          {mine.length > 0 ? (
            <MyPayslips payslips={mine} />
          ) : (
            <Card className="px-4 py-12 text-center text-sm text-subtle">
              You have no payslips yet. They appear here once payroll locks the month.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
