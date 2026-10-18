import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listPayrollRuns, myPayslips } from "@/actions/payroll";
import { Card } from "@/components/ui/card";
import { PayrollRuns } from "@/components/hr/payroll-runs";
import { MyPayslips } from "@/components/hr/my-payslips";
import { PayrollImport } from "@/components/hr/payroll-import";

export default async function PayrollPage() {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const caps = await hrCapabilities();
  const [runs, mine] = await Promise.all([listPayrollRuns(), myPayslips()]);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Payroll</h1>
          <p className="mt-1 text-sm text-muted">
            {caps.payroll
              ? "PF, ESI, professional tax and income tax (TDS) are worked out from the Indian rules. TDS follows each person's tax declaration, and a figure you type on a payslip is kept."
              : "Your payslips. Only payroll can see anybody else's."}
          </p>
        </div>
        {/* Moving from another HRMS: salaries, bank and statutory numbers, pay so far (owner, 18 Oct 2026). */}
        {caps.payroll && <PayrollImport />}
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
