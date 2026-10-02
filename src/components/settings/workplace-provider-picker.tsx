"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { MicrosoftAppForm } from "@/components/settings/security-settings-form";
import { GoogleAppForm, ZohoAppForm } from "@/components/settings/workplace-app-forms";
import { cn } from "@/lib/utils";
import { PROVIDER_NAMES, WORKPLACE_PROVIDERS, type WorkplaceProvider, type ZohoRegion } from "@/lib/workplace/providers";

/**
 * Settings → Security: the company's email and sign-in — Microsoft 365, Google Workspace or Zoho. The
 * customer picks the one it uses and sees only that one's setup (owner, 2 Oct 2026); the others stay a
 * click away, for a company that uses more than one or is moving between them.
 */

const WHAT_IT_BRINGS: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Outlook · Microsoft sign-in",
  GOOGLE: "Gmail · Google sign-in",
  ZOHO: "Zoho Mail · Zoho sign-in",
};

type Microsoft = { tenantId: string; clientId: string; hasClientSecret: boolean; sso: boolean; mail: boolean };
type Google = { clientId: string; hasClientSecret: boolean; domain: string; sso: boolean; mail: boolean };
type Zoho = { clientId: string; hasClientSecret: boolean; region: ZohoRegion; sso: boolean; mail: boolean };

/** The ones with an app set up, in the order shown. */
export function providersSetUp(p: { microsoft: Microsoft; google: Google | null; zoho: Zoho | null }): WorkplaceProvider[] {
  const out: WorkplaceProvider[] = [];
  if (p.microsoft.tenantId && p.microsoft.clientId && p.microsoft.hasClientSecret) out.push("MICROSOFT");
  if (p.google?.clientId && p.google.hasClientSecret) out.push("GOOGLE");
  if (p.zoho?.clientId && p.zoho.hasClientSecret) out.push("ZOHO");
  return out;
}

export function WorkplaceProviderPicker({
  microsoft,
  google,
  zoho,
  origins,
}: {
  microsoft: Microsoft;
  /** Null in a workspace still waiting for its migration: Google and Zoho wait for it. */
  google: Google | null;
  zoho: Zoho | null;
  origins: string[];
}) {
  const setUp = providersSetUp({ microsoft, google, zoho });
  // The one the company already uses; Microsoft, as before, for a company that hasn't chosen yet.
  const [shown, setShown] = useState<WorkplaceProvider>(setUp[0] ?? "MICROSOFT");

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm text-muted">
          Which does your company use? Set it up once: people can then sign in with it, and send documents from their own mailbox.
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {WORKPLACE_PROVIDERS.map((provider) => (
            <label
              key={provider}
              className={cn(
                "flex cursor-pointer items-start justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
                shown === provider ? "border-brand bg-brand/5" : "border-line hover:border-brand/50",
              )}
            >
              <span>
                <input
                  type="radio"
                  name="workplace-provider"
                  value={provider}
                  checked={shown === provider}
                  onChange={() => setShown(provider)}
                  className="sr-only"
                />
                <span className="block font-medium text-text">{PROVIDER_NAMES[provider]}</span>
                <span className="block text-xs text-muted">{WHAT_IT_BRINGS[provider]}</span>
              </span>
              {setUp.includes(provider) && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Set up
                </span>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {shown === "MICROSOFT" && <MicrosoftAppForm settings={microsoft} origins={origins} />}
      {shown === "GOOGLE" &&
        (google ? (
          <GoogleAppForm settings={google} origins={origins} />
        ) : (
          <p className="text-sm text-muted">Google Workspace can be set up once this workspace&apos;s update has finished. Try again in a few minutes.</p>
        ))}
      {shown === "ZOHO" &&
        (zoho ? (
          <ZohoAppForm settings={zoho} origins={origins} />
        ) : (
          <p className="text-sm text-muted">Zoho can be set up once this workspace&apos;s update has finished. Try again in a few minutes.</p>
        ))}
    </div>
  );
}
