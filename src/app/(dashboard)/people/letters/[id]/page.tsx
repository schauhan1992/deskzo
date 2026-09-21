import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getLetter } from "@/actions/employee-docs";
import { hrCapabilities } from "@/actions/hr";
import { LetterEditor } from "@/components/hr/letter-editor";

export default async function LetterPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const [letter, caps] = await Promise.all([getLetter(id), hrCapabilities()]);
  if (!letter) notFound();

  return (
    <div className="animate-fade-rise">
      <LetterEditor letter={letter} canManage={caps.manage} />
    </div>
  );
}
