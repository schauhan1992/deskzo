"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { updateMicrosoftApp, updateSignInPolicy } from "@/actions/security";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { mailCallbackPath, sayEither, signInCallbackPath } from "@/lib/workplace/providers";

/**
 * Settings → Security → Sign-in: the policy (this file's first form), then one card per suite —
 * Microsoft 365 here, Google Workspace and Zoho in workplace-app-forms.tsx.
 *
 * `origins`: every address the workspace answers at — its own and each live custom one — to show the
 * exact redirect addresses a provider must be given: one for each address people sign in at.
 */

type Policy = { enforceTwoFactor: boolean; enforceSso: boolean };

export function SignInPolicyForm({ settings, signInWith }: { settings: Policy; /** The sign-ins switched on below, by name. */ signInWith: string[] }) {
  const router = useRouter();
  const [enforceTwoFactor, setEnforceTwoFactor] = useState(settings.enforceTwoFactor);
  const [enforceSso, setEnforceSso] = useState(settings.enforceSso);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function save() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await updateSignInPolicy({ enforceTwoFactor, enforceSso });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <Notices error={error} success={success ? "Sign-in settings saved." : null} />

      <Check
        checked={enforceTwoFactor}
        onChange={setEnforceTwoFactor}
        title="Require two-factor authentication"
        hint="Every user (except break-glass admin access) must set up an authenticator app before they can use the rest of the app."
      />

      <Check
        checked={enforceSso}
        onChange={setEnforceSso}
        title="Require single sign-on"
        hint={
          signInWith.length > 0
            ? `Everyone signs in with ${sayEither(signInWith)}; password sign-in is off for everyone except admins, who keep it as a fallback.`
            : "Turn on sign-in with Microsoft, Google or Zoho below first. Then password sign-in can be switched off for everyone except admins."
        }
      />

      <div className="flex justify-end border-t border-line pt-4">
        <Button type="button" size="sm" onClick={save} disabled={isPending}>
          {isPending ? "Saving…" : "Save sign-in settings"}
        </Button>
      </div>
    </div>
  );
}

type MicrosoftSettings = { tenantId: string; clientId: string; hasClientSecret: boolean; sso: boolean; mail: boolean };

export function MicrosoftAppForm({ settings, origins }: { settings: MicrosoftSettings; origins: string[] }) {
  const router = useRouter();
  const [tenantId, setTenantId] = useState(settings.tenantId);
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [sso, setSso] = useState(settings.sso);
  const [mail, setMail] = useState(settings.mail);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function save() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await updateMicrosoftApp({ microsoftTenantId: tenantId, microsoftClientId: clientId, microsoftClientSecret: clientSecret, sso, mail });
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
      <Notices error={error} success={success ? "Microsoft 365 saved." : null} />
      <div>
        <p className="text-sm text-muted">
          Register an app in your Microsoft Entra ID (Azure AD) admin center, then paste its details here.
          {origins.length > 1 ? " Redirect URIs — one for each address this workspace answers at:" : " Redirect URI:"}
        </p>
        <RedirectList origins={origins} path={signInCallbackPath("MICROSOFT")} label="Sign-in redirect URIs" />
        {/* The same app sends documents from people's own Outlook — src/lib/mail/microsoft.ts. */}
        <p className="mt-2 text-sm text-muted">
          To let people email invoices and proposals from their own Outlook, add to the same app {origins.length > 1 ? "these redirect URIs as well" : "a second redirect URI"}:
        </p>
        <RedirectList origins={origins} path={mailCallbackPath("MICROSOFT")} label="Outlook redirect URIs" />
        <p className="mt-2 text-sm text-muted">
          Outlook also needs the delegated Microsoft Graph permissions <Code>Mail.Send</Code>, <Code>User.Read</Code> and <Code>offline_access</Code>. Each
          person then connects their own mailbox from My profile; nobody can send as anybody else.
        </p>
        <p className="mt-2 text-sm text-muted">
          With Calendar on (Settings → Modules), add <Code>Calendars.ReadWrite</Code> (delegated) too: people&apos;s own calendars, kept in step here, and
          meetings scheduled with a Teams link. The same connection carries it; people who connected before reconnect once.
        </p>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <Check checked={sso} onChange={setSso} title="Show “Sign in with Microsoft”" hint="Makes Microsoft sign-in available on the login page." />
        <Check checked={mail} onChange={setMail} title="Let people send from their Outlook" hint="Each person connects their own mailbox from My profile." />
      </div>

      <div className="flex justify-end border-t border-line pt-4">
        <Button type="button" size="sm" onClick={save} disabled={isPending}>
          {isPending ? "Saving…" : "Save Microsoft 365"}
        </Button>
      </div>
    </div>
  );
}

// ─── Shared pieces ───────────────────────────────────────────────────────────────────────────────

export function Notices({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-sm text-success">
          {success}
        </p>
      )}
    </>
  );
}

export function Check({ checked, onChange, title, hint, disabled }: { checked: boolean; onChange: (on: boolean) => void; title: string; hint: string; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2.5">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 disabled:opacity-40" />
      <span>
        <span className="block text-sm font-medium text-text">{title}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
    </label>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-sunken px-1 py-0.5 text-xs">{children}</code>;
}

/** One redirect address for each address the workspace answers at. */
export function RedirectList({ origins, path, label }: { origins: string[]; path: string; label: string }) {
  return (
    <ul aria-label={label} className="mt-1 space-y-1">
      {origins.map((origin) => (
        <li key={origin}>
          <code className="break-all rounded bg-surface-sunken px-1 py-0.5 text-xs">{`${origin}${path}`}</code>
        </li>
      ))}
    </ul>
  );
}
