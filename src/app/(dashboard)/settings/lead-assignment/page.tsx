import { listAssignmentRules } from "@/actions/lead-assignment";
import { SettingsPage } from "@/components/settings/settings-page";
import { LeadAssignmentManager } from "@/components/settings/lead-assignment-manager";

/** The rules that choose a salesperson for a lead nobody assigned — see src/lib/leads/assign.ts. */
export default async function Page() {
  const data = await listAssignmentRules();

  return (
    <SettingsPage
      title="Lead assignment"
      description="Who a new lead goes to when nobody chooses — website leads, and leads created with the salesperson left empty. Rules are tried in order; the first that fits decides."
      settingsKey="lead-assignment"
    >
      {data ? (
        <LeadAssignmentManager rules={data.rules} brands={data.brands} people={data.people} />
      ) : (
        <p className="text-sm text-danger">You can&apos;t manage lead assignment.</p>
      )}
    </SettingsPage>
  );
}
