import { listCloseOwnerOptions, listCloseTemplates } from "@/actions/close";
import { SettingsPage } from "@/components/settings/settings-page";
import { planGate } from "@/components/settings/module-disabled-notice";
import { CloseTemplateEditor } from "@/components/close/close-template-editor";

/** The month-end checklist's templates: add, edit, reorder and deactivate tasks (`close.manage`). */
export default async function CloseChecklistSettingsPage() {
  const gate = await planGate("revenue_close", "Month-end checklist");
  if (gate) return gate;
  const [templates, people] = await Promise.all([listCloseTemplates(), listCloseOwnerOptions()]);

  return (
    <SettingsPage
      settingsKey="close-checklist"
      description="The tasks every month's close is copied from — their order, who owns each one, which working day of the next month it is due, and whether an automatic check ticks it."
    >
      <CloseTemplateEditor templates={templates} people={people} />
    </SettingsPage>
  );
}
