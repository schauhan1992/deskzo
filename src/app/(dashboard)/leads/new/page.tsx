import { notFound } from "next/navigation";
import { listAssignableUsers, listCompanyOptions } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { listItemOptions } from "@/actions/item";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { NewLeadForm } from "@/components/leads/new-lead-form";
import { formSetup } from "@/lib/custom-fields/server";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string }>;
}) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const [itemsEnabled, user] = await Promise.all([isModuleEnabled("items"), requireUser()]);
  const [canViewLeads, canAddContact] = await Promise.all([
    hasEffectivePermission(user.id, "leads.view"),
    hasEffectivePermission(user.id, "contacts.view"),
  ]);
  if (!canViewLeads) notFound();
  const [{ companyId }, companies, items, industries, canAssign, people, customFields] = await Promise.all([
    searchParams,
    listCompanyOptions(),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    listIndustries(),
    // Either permission that assigns may choose the owner — matching `resolveOwner` in actions/lead.ts.
    Promise.all([hasEffectivePermission(user.id, "leads.assign"), hasEffectivePermission(user.id, "accounts.reassign")]).then(
      ([assign, reassign]) => assign || reassign,
    ),
    listAssignableUsers(),
    // The workspace's own lead fields (src/lib/custom-fields).
    formSetup("LEAD", user.id),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">New lead</h1>
      <p className="mt-1 text-sm text-muted">
        Log a confirmed requirement against a company — this starts the sales pipeline.
      </p>
      <div className="mt-6">
        <NewLeadForm
          companies={companies}
          initialCompanyId={companyId}
          items={items}
          itemsEnabled={itemsEnabled}
          industries={industries}
          currentUser={{ id: user.id, role: user.role }}
          canAssign={canAssign}
          canAddContact={canAddContact}
          people={people.map((p) => ({ id: p.id, name: p.name, email: p.email, hint: p.role }))}
          customFields={customFields}
        />
      </div>
    </div>
  );
}
