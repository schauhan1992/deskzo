import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getWorkbook, workbookFilterOptions } from "@/actions/workspace";
import { WorkbookEditor } from "@/components/workspace/workbook-editor";

export default async function EditWorkbookPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const { id } = await params;
  const [workbook, options] = await Promise.all([getWorkbook(id), workbookFilterOptions()]);
  if (!workbook) notFound();

  return (
    <div className="animate-fade-rise">
      <Link href={`/workspace/${workbook.id}`} className="text-sm text-muted hover:text-text">
        ← {workbook.name}
      </Link>
      <h1 className="mt-1 mb-5 text-xl font-semibold text-text">Edit list</h1>

      <WorkbookEditor
        options={options}
        workbook={{
          id: workbook.id,
          name: workbook.name,
          description: workbook.description,
          filters: workbook.filters,
          shared: workbook.shared,
          canEdit: workbook.canEdit,
        }}
      />
    </div>
  );
}
