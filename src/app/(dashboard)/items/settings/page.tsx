import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getAccountsSettings } from "@/actions/accounts-settings";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { AccountsSettingsForm } from "@/components/accounts/accounts-settings-form";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Finance → Accounts › Settings (owner, 22 Oct 2026): inventory accounting, costing, what moves stock, approvals
 * and voucher numbering — src/actions/accounts-settings.ts. `accounts.configure` only; anybody else is told the
 * page isn't there, as for any address they can't open.
 */
export default async function AccountsSettingsPage() {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const settings = await getAccountsSettings();
  if (!settings) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Accounts settings</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        How stock is accounted for and costed, what moves it on its own, who approves what, and how vouchers are numbered. Every change is
        in the audit log.
      </p>
      {settings.migrated ? (
        <AccountsSettingsForm initial={settings} />
      ) : (
        <Card className="mt-4">
          <CardContent className="text-sm text-muted">
            This workspace&apos;s database hasn&apos;t been brought up to date for Accounts yet. Once its migrations have run, the settings appear here.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
