import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { workbookFilterOptions } from "@/actions/workspace";
import { WorkbookEditor } from "@/components/workspace/workbook-editor";

export default async function NewWorkbookPage() {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const options = await workbookFilterOptions();

  return (
    <div className="animate-fade-rise">
      <Link href="/workspace" className="text-sm text-muted hover:text-text">
        ← Workspace
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">New list</h1>
      <p className="mt-1 mb-5 text-sm text-muted">
        Narrow the companies down, watch the count, then save it. Nothing is saved until you press Save.
      </p>

      <WorkbookEditor options={options} />
    </div>
  );
}
