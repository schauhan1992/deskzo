import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportLibrary } from "@/components/reporting/library";
import { REPORTING_SOURCE_KEYS, sourceEntry } from "@/lib/reporting/sources";

/** My reports and favourites (design 1e). What is listed is decided by the server: only what this person may open. */
export default async function ReportLibraryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const { tab } = await searchParams;
  return <ReportLibrary tab={tab === "favourites" ? "favourites" : tab === "shared" ? "shared" : "mine"} sources={REPORTING_SOURCE_KEYS.map((key) => ({ key, label: sourceEntry(key)!.label }))} />;
}
