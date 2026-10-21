import { salarySetupForSettings } from "@/actions/payroll";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { SalaryStructureSettings } from "@/components/hr/salary-structure-settings";
import { Card } from "@/components/ui/card";

/** How a CTC is split, and the company's own salary components (owner, 21 Oct 2026) — payroll's to set. */
export default async function SalaryStructureSettingsPage() {
  const gate = await planGate("payroll", "Payroll");
  if (gate) return gate;
  const setup = await salarySetupForSettings();

  return (
    <SettingsPage
      settingsKey="salary-structure"
      description="When someone's salary is set from a CTC, it's split by these rules: basic as a share of the CTC, HRA as a share of basic, the fixed allowances and your own components at what they're set to, and the special allowance taking up the rest. Every split can still be changed person by person."
    >
      {setup ? (
        <SalaryStructureSettings rules={setup.rules} components={setup.components} />
      ) : (
        <Card className="max-w-2xl p-5 text-sm text-muted">
          This workspace&apos;s database hasn&apos;t been brought up to date yet, so CTCs are split at basic 40% and HRA 50% of basic for now.
        </Card>
      )}
    </SettingsPage>
  );
}
