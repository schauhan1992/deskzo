import { listCustomFieldsForManage } from "@/actions/custom-fields";
import { SettingsPage } from "@/components/settings/settings-page";
import { CustomFieldsManager } from "@/components/settings/custom-fields-manager";

/**
 * Custom fields (owner, 2 Oct 2026) — src/actions/custom-fields.ts, src/lib/custom-fields. The
 * workspace's own fields on its companies, contacts, leads, orders and products. `fields.manage`
 * (the catalogue's gate) opens it.
 */
export default async function Page() {
  const data = await listCustomFieldsForManage();
  return (
    <SettingsPage
      settingsKey="custom-fields"
      description="Add the fields your business needs to companies, contacts, leads, orders and products — a batch number, a tower and floor, a licence expiry. They appear on the forms, on each record and as list columns; a required field must be filled in before a record is saved, and a restricted one is seen only by people allowed to see restricted fields. Retiring a field hides it but keeps every value."
    >
      <CustomFieldsManager
        entities={(data?.entities ?? []).map((e) => ({
          entity: e.entity,
          label: e.label,
          fields: e.fields.map((f) => ({
            id: f.id,
            entity: f.entity,
            key: f.key,
            label: f.label,
            type: f.type,
            options: f.options,
            required: f.required,
            helpText: f.helpText,
            group: f.group,
            restricted: f.restricted,
            showInList: f.showInList,
            archived: f.archived,
            inUse: f.inUse,
          })),
        }))}
      />
    </SettingsPage>
  );
}
