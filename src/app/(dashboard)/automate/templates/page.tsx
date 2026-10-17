import { isModuleEnabled } from "@/actions/module";
import { getDraftingAvailability, listAutomationCompanyTemplates } from "@/actions/automate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { TemplateGallery } from "@/components/automate/template-gallery";
import { TEMPLATES } from "@/lib/automate/templates";
import { db } from "@/lib/db";

/**
 * Automate › Templates (Phase 3): ready-made workflows to start from — or an empty one. Each opens as a
 * draft in the builder; nothing runs until it is published there.
 */
export default async function AutomateTemplatesPage() {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;
  const [people, company, drafting] = await Promise.all([
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listAutomationCompanyTemplates(),
    getDraftingAvailability(),
  ]);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Templates</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">Start from one of these, describe what you want, or save one of your own workflows as a template. It opens as a draft: test it on a real record, then publish it.</p>
      </div>
      <TemplateGallery templates={TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, steps: t.steps, blanks: t.blanks }))} people={people} company={company} drafting={drafting} />
    </div>
  );
}
