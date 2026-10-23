import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportLibrary } from "@/components/reporting/library";
import { REPORTING_SOURCE_KEYS, sourceEntry } from "@/lib/reporting/sources";

/** Reports shared with me (design 1f): each with what I may do with it, or why I can't open what it reads. */
export default async function SharedReportsPage() {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  return <ReportLibrary tab="shared" sources={REPORTING_SOURCE_KEYS.map((key) => ({ key, label: sourceEntry(key)!.label }))} />;
}
