import Link from "next/link";
import { getOrganisation, isOrganisationReady } from "@/lib/organisation";
import { branchIdentity, isMultiBranch } from "@/lib/branches/identity";
import { SettingsPage } from "@/components/settings/settings-page";
import { OrganisationManager } from "@/components/settings/organisation-manager";
import { TimeZoneCard } from "@/components/settings/time-zone-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getTimeZoneSetting } from "@/actions/time-zone";
import { listOrganisationBankAccounts } from "@/actions/organisation-bank";
import { BankAccountsManager } from "@/components/banking/bank-accounts-manager";

export default async function Page() {
  const [organisation, headOffice, multiBranch, timeZone, bankAccounts] = await Promise.all([
    getOrganisation(),
    // Never throws: at worst the organisation's own details under a "Head office" placeholder.
    branchIdentity(null),
    isMultiBranch().catch(() => false),
    getTimeZoneSetting(),
    // Null without settings.manage, when the page shows nothing but its refusal anyway.
    listOrganisationBankAccounts().catch(() => null),
  ]);
  /**
   * A head office with an address of its own is not the registered office, and its GSTIN may be
   * another state's — so it is shown here but changed under Branches, and never sent from this form
   * (the registered office's state code would be checked against it and every save refused).
   */
  const gstinManagedByBranch = headOffice.addressSource === "branch";

  return (
    <SettingsPage
      title="Profile"
      description="Who this company is on paper. These details print on every proposal, invoice and purchase order, and are what the government portal checks a document against."
      settingsKey="organisation"
    >
      {multiBranch && (
        <p className="text-sm text-muted">
          Each branch prints its own address, GSTIN and any overrides set under{" "}
          <Link href="/settings/branches" className="text-brand hover:underline">
            Branches &amp; GST registrations
          </Link>
          ; what&apos;s here prints wherever a branch leaves something blank.
        </p>
      )}
      {!isOrganisationReady(organisation) && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          Your legal name, GSTIN, state code and registered address need to be filled in before an invoice can be
          reported to the e-invoice portal.
        </Card>
      )}
      <OrganisationManager
        organisation={organisation}
        multiBranch={multiBranch}
        headOffice={gstinManagedByBranch ? { name: headOffice.name, city: headOffice.city, state: headOffice.state } : null}
      />
      {bankAccounts && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Bank accounts</CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted">
              The primary prints on every sales document. A branch can default to another under Branches, and a
              document can pick any of them.
            </p>
            <BankAccountsManager
              scope={{ kind: "organisation" }}
              accounts={bankAccounts}
              canManage
              emptyText="No bank accounts yet — add the one your customers pay into, and it prints on your invoices."
            />
          </CardContent>
        </Card>
      )}
      {timeZone && <TimeZoneCard setting={timeZone} />}
    </SettingsPage>
  );
}
