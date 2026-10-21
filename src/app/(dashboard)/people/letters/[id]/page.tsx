import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getLetter } from "@/actions/employee-docs";
import { hrCapabilities } from "@/actions/hr";
import { LetterEditor } from "@/components/hr/letter-editor";
import { letterSignatureImage } from "@/lib/organisation";

export default async function LetterPage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const { id } = await params;
  const [letter, caps] = await Promise.all([getLetter(id), hrCapabilities()]);
  if (!letter) notFound();
  // What a draft would be signed with if issued now; an issued letter shows its own copy.
  const signatureImage = caps.manage && letter.status === "DRAFT" ? await letterSignatureImage() : null;

  return (
    <div className="animate-fade-rise">
      <LetterEditor letter={letter} canManage={caps.manage} signatureImage={signatureImage} />
    </div>
  );
}
