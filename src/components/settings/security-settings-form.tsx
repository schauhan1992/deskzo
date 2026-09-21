"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSecuritySettings } from "@/actions/security";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type Settings = {
  enforceTwoFactor: boolean;
  ssoEnabled: boolean;
  enforceSso: boolean;
  microsoftTenantId: string;
  microsoftClientId: string;
  hasClientSecret: boolean;
};

export function SecuritySettingsForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [enforceTwoFactor, setEnforceTwoFactor] = useState(settings.enforceTwoFactor);
  const [ssoEnabled, setSsoEnabled] = useState(settings.ssoEnabled);
  const [enforceSso, setEnforceSso] = useState(settings.enforceSso);
  const [tenantId, setTenantId] = useState(settings.microsoftTenantId);
  const [clientId, setClientId] = useState(settings.microsoftClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function handleSave() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await updateSecuritySettings({
        enforceTwoFactor,
        ssoEnabled,
        enforceSso,
        microsoftTenantId: tenantId,
        microsoftClientId: clientId,
        microsoftClientSecret: clientSecret,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setClientSecret("");
      setSuccess(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      {success && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Security settings saved.</p>}

      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={enforceTwoFactor}
          onChange={(e) => setEnforceTwoFactor(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium text-text">Require two-factor authentication</span>
          <span className="block text-sm text-muted">
            Every user (except break-glass admin access) must set up an authenticator app before they can use the
            rest of the app.
          </span>
        </span>
      </label>

      <div className="border-t border-line pt-4">
        <div className="mb-3">
          <h3 className="text-sm font-medium text-text">Microsoft sign-in (SSO)</h3>
          <p className="mt-0.5 text-sm text-muted">
            Register an app in your Microsoft Entra ID (Azure AD) admin center, then paste its details here.
            Redirect URI (append to this site&rsquo;s URL):{" "}
            <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">/api/auth/callback/microsoft-entra-id</code>
          </p>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ss-tenant">Directory (tenant) ID</Label>
              <Input id="ss-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ss-client">Application (client) ID</Label>
              <Input id="ss-client" value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ss-secret">Client secret</Label>
            <Input
              id="ss-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={settings.hasClientSecret ? "•••••••• (saved — leave blank to keep it)" : "Client secret value"}
            />
          </div>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={ssoEnabled}
              onChange={(e) => {
                setSsoEnabled(e.target.checked);
                if (!e.target.checked) setEnforceSso(false);
              }}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-sm font-medium text-text">Show &ldquo;Sign in with Microsoft&rdquo;</span>
              <span className="block text-sm text-muted">Makes Microsoft sign-in available on the login page.</span>
            </span>
          </label>

          <label className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={enforceSso}
              disabled={!ssoEnabled}
              onChange={(e) => setEnforceSso(e.target.checked)}
              className="mt-0.5 h-4 w-4 disabled:opacity-40"
            />
            <span>
              <span className="block text-sm font-medium text-text">Require Microsoft sign-in</span>
              <span className="block text-sm text-muted">
                Turns off password sign-in for everyone except admins, who always keep password access as a
                fallback.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="flex justify-end border-t border-line pt-4">
        <Button type="button" size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save security settings"}
        </Button>
      </div>
    </div>
  );
}
