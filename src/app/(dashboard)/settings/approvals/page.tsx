import { listApprovalPolicies } from "@/actions/document-approval";
import { listAssignableUsers } from "@/actions/company";
import { listRoles } from "@/lib/authz/role-registry";
import { SettingsPage } from "@/components/settings/settings-page";
import { ApprovalPolicies } from "@/components/settings/approval-policies";
import { planGate } from "@/components/settings/module-disabled-notice";

export default async function Page() {
  const gate = await planGate(["sales_documents", "purchase_documents"], "Document approvals");
  if (gate) return gate;
  const [policies, users, roles] = await Promise.all([
    listApprovalPolicies(),
    listAssignableUsers(),
    listRoles(),
  ]);

  return (
    <SettingsPage
      title="Document approvals"
      description="Which documents need signing off before they can be issued, and who may sign them. Everything is off until you turn it on, and a document of a switched-on type can still be drafted and edited freely — it just cannot be issued until somebody approves it."
      settingsKey="approvals"
    >
      {policies.ok ? (
        <ApprovalPolicies
          policies={policies.data}
          roles={roles.map((r) => ({ key: r.key, name: r.name }))}
          users={users.map((u) => ({ id: u.id, name: u.name, role: u.role }))}
        />
      ) : (
        <p className="text-sm text-danger">{policies.error}</p>
      )}
    </SettingsPage>
  );
}
