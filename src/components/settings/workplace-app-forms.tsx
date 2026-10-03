"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { removeWorkplaceApp, updateGoogleApp, updateZohoApp } from "@/actions/workplace";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Check, Code, Notices, RedirectList } from "@/components/settings/security-settings-form";
import { ZOHO_REGIONS, ZOHO_REGION_KEYS, mailCallbackPath, signInCallbackPath, type ZohoRegion } from "@/lib/workplace/providers";
import { OutboundLink } from "@/components/ui/outbound-link";

/**
 * Settings → Security → Google Workspace and Zoho: the company's own app for each — how to make one,
 * the addresses to give it, and what it is used for here (src/actions/workplace.ts).
 */

type GoogleSettings = { clientId: string; hasClientSecret: boolean; domain: string; sso: boolean; mail: boolean };

export function GoogleAppForm({ settings, origins }: { settings: GoogleSettings; origins: string[] }) {
  const router = useRouter();
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [domain, setDomain] = useState(settings.domain);
  const [sso, setSso] = useState(settings.sso);
  const [mail, setMail] = useState(settings.mail);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const setUp = !!settings.clientId;

  function save() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await updateGoogleApp({ clientId, clientSecret, domain, sso, mail });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setClientSecret("");
      setSuccess("Google Workspace saved.");
      router.refresh();
    });
  }

  function remove() {
    if (!window.confirm("Remove the Google app? Google sign-in stops, and people's Gmail connections stop sending until it's set up again.")) return;
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await removeWorkplaceApp("GOOGLE");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setClientId("");
      setDomain("");
      setSso(false);
      setSuccess("The Google app was removed.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <Notices error={error} success={success} />
      <div className="space-y-2 text-sm text-muted">
        <p>Your company&apos;s own Google app, made once in Google Cloud:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            In the Google Cloud console, pick or create a project and turn on the <strong className="font-medium text-text">Gmail API</strong> — and, with
            Calendar on, the <strong className="font-medium text-text">Google Calendar API</strong>.
          </li>
          <li>
            Set up the OAuth consent screen as <strong className="font-medium text-text">Internal</strong>: only your company&apos;s Google Workspace accounts
            can use it, and Google doesn&apos;t need to review it.
          </li>
          <li>
            Under Credentials, create an <strong className="font-medium text-text">OAuth client ID</strong> of type Web application, with these authorised
            redirect URIs:
          </li>
        </ol>
        <RedirectList origins={origins} path={signInCallbackPath("GOOGLE")} label="Google sign-in redirect URIs" />
        <RedirectList origins={origins} path={mailCallbackPath("GOOGLE")} label="Gmail redirect URIs" />
        <p>
          Sign-in asks Google for <Code>openid</Code>, <Code>email</Code> and <Code>profile</Code>; Gmail also for <Code>gmail.send</Code>, to send as the person
          who connected — never to read their mail. With Calendar on, the same connection asks for <Code>calendar.events</Code>: the person&apos;s own
          events, and meetings scheduled with a Meet link.
        </p>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="gw-client">Client ID</Label>
            <Input id="gw-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gw-secret">Client secret</Label>
            <Input
              id="gw-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={settings.hasClientSecret ? "•••••••• (saved — leave blank to keep it)" : "Client secret"}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gw-domain">Only accounts of this Google Workspace domain (optional)</Label>
          <Input id="gw-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" className="max-w-xs" />
        </div>
        <Check checked={sso} onChange={setSso} title="Show “Sign in with Google”" hint="Signs people into the account here with the same email address — it never creates one." />
        <Check checked={mail} onChange={setMail} title="Let people send from their Gmail" hint="Each person connects their own mailbox from My profile." />
      </div>

      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
        {setUp ? (
          <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={isPending}>
            Remove the Google app
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" size="sm" onClick={save} disabled={isPending}>
          {isPending ? "Saving…" : "Save Google Workspace"}
        </Button>
      </div>
    </div>
  );
}

type ZohoSettings = { clientId: string; hasClientSecret: boolean; region: ZohoRegion; sso: boolean; mail: boolean };

export function ZohoAppForm({ settings, origins }: { settings: ZohoSettings; origins: string[] }) {
  const router = useRouter();
  const [region, setRegion] = useState<ZohoRegion>(settings.region);
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [sso, setSso] = useState(settings.sso);
  const [mail, setMail] = useState(settings.mail);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const setUp = !!settings.clientId;

  function save() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await updateZohoApp({ region, clientId, clientSecret, sso, mail });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setClientSecret("");
      setSuccess("Zoho saved.");
      router.refresh();
    });
  }

  function remove() {
    if (!window.confirm("Remove the Zoho app? Zoho sign-in stops, and people's Zoho Mail connections stop sending until it's set up again.")) return;
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await removeWorkplaceApp("ZOHO");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setClientId("");
      setSso(false);
      setSuccess("The Zoho app was removed.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <Notices error={error} success={success} />
      <div className="space-y-2 text-sm text-muted">
        <p>Your company&apos;s own Zoho app, made once in Zoho&apos;s API console:</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            In the API console for your data centre (
            <OutboundLink href={ZOHO_REGIONS[region].console} className="text-brand hover:underline">
              {ZOHO_REGIONS[region].console.replace("https://", "")}
            </OutboundLink>
            ), add a client of type <strong className="font-medium text-text">Server-based Applications</strong>.
          </li>
          <li>Give it your workspace&apos;s address as the homepage URL, and these authorised redirect URIs:</li>
        </ol>
        <RedirectList origins={origins} path={signInCallbackPath("ZOHO")} label="Zoho sign-in redirect URIs" />
        <RedirectList origins={origins} path={mailCallbackPath("ZOHO")} label="Zoho Mail redirect URIs" />
        <p>
          Sign-in asks Zoho for <Code>AaaServer.profile.Read</Code>; Zoho Mail also for <Code>ZohoMail.messages.CREATE</Code> and{" "}
          <Code>ZohoMail.accounts.READ</Code>, to send as the person who connected — never to read their mail. Sign-in uses the data centre chosen here.
          With Calendar on, the same connection asks for <Code>ZohoCalendar.calendar.READ</Code>, <Code>ZohoCalendar.event.ALL</Code> and{" "}
          <Code>ZohoMeeting.meeting.ALL</Code>: the person&apos;s own calendar, and meetings scheduled with a Zoho Meeting link.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="zo-region">Data centre</Label>
          <Select id="zo-region" value={region} onChange={(e) => setRegion(e.target.value as ZohoRegion)} className="max-w-xs">
            {ZOHO_REGION_KEYS.map((key) => (
              <option key={key} value={key}>
                {ZOHO_REGIONS[key].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="zo-client">Client ID</Label>
            <Input id="zo-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1000.…" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zo-secret">Client secret</Label>
            <Input
              id="zo-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={settings.hasClientSecret ? "•••••••• (saved — leave blank to keep it)" : "Client secret"}
            />
          </div>
        </div>
        <Check checked={sso} onChange={setSso} title="Show “Sign in with Zoho”" hint="Signs people into the account here with the same email address — it never creates one." />
        <Check checked={mail} onChange={setMail} title="Let people send from their Zoho Mail" hint="Each person connects their own mailbox from My profile." />
      </div>

      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
        {setUp ? (
          <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={isPending}>
            Remove the Zoho app
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" size="sm" onClick={save} disabled={isPending}>
          {isPending ? "Saving…" : "Save Zoho"}
        </Button>
      </div>
    </div>
  );
}
