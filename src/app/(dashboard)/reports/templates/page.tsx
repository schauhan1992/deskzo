import { isModuleEnabled } from "@/actions/module";
import { reportingSetup } from "@/actions/reporting";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { TemplateGallery } from "@/components/reporting/templates";

/** Report templates (design 1g) — each over a real source's fields, locked where this person can't open the source. */
export default async function ReportTemplatesPage() {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const setup = await reportingSetup();
  if (!setup.ok) return <ModuleDisabledNotice moduleKey="reports" />;
  return <TemplateGallery templates={setup.data.templates} categories={setup.data.categories} />;
}
