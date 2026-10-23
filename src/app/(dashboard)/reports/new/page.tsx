import { isModuleEnabled } from "@/actions/module";
import { reportingSetup } from "@/actions/reporting";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CreateWizard } from "@/components/reporting/create-wizard";
import { workspaceClock } from "@/lib/time/workspace";

/** Create report (design 1b) — `?template=` starts from a template, its source already chosen. */
export default async function NewReportPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const [{ template }, setup, clock] = await Promise.all([searchParams, reportingSetup(), workspaceClock()]);
  if (!setup.ok) return <ModuleDisabledNotice moduleKey="reports" />;
  return (
    <CreateWizard
      sources={setup.data.sources}
      templates={setup.data.templates}
      groups={setup.data.groups}
      initialTemplate={typeof template === "string" ? template : null}
      today={clock.today()}
      hasDepartment={setup.data.hasDepartment}
    />
  );
}
