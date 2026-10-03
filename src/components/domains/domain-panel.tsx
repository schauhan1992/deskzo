"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { refreshDomainProfile, type getDomainBriefing } from "@/actions/domain";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CompanyLinks } from "@/components/companies/company-links";
import { OutboundLink } from "@/components/ui/outbound-link";
import { useClock } from "@/components/time/clock-provider";
import { headcountLabel } from "@/lib/company-size";

type Briefing = NonNullable<Awaited<ReturnType<typeof getDomainBriefing>>>;

/**
 * What public DNS and the company's own website say about them, and what that means for a sale.
 *
 * Shown on the Details tab of anything that is a company — so the same panel serves Companies,
 * Customers, Vendors, Resellers and Leads. Nothing here is fetched until someone presses Refresh:
 * the lookups reach out to DNS, the customer's own site and RDAP, which is slow and not something
 * to do on every page view.
 */
export function DomainPanel({ companyId, briefing }: { companyId: string; briefing: Briefing }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { profile, company, opportunities, domain } = briefing;

  function refresh() {
    setError(null);
    startTransition(async () => {
      const result = await refreshDomainProfile(companyId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="@container">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-subtle" />
          Domain &amp; web
          {domain && <span className="font-mono text-xs font-normal text-muted">{domain}</span>}
        </span>
        <div className="flex items-center gap-2">
          {profile?.fetchedAt && (
            <span className="text-xs font-normal text-subtle">Checked {clock.dateTimeShort(profile.fetchedAt)}</span>
          )}
          <Button size="sm" variant="secondary" disabled={pending} onClick={refresh}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />
            {pending ? "Looking up…" : profile ? "Refresh" : "Look up"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

        {!domain && !error && (
          <p className="text-sm text-muted">
            No website on file for this company. Add one on the company record and this fills itself in.
          </p>
        )}

        {domain && !profile && !error && (
          <p className="text-sm text-muted">
            Nothing looked up yet. Press <span className="font-medium text-text">Look up</span> to read their DNS and
            homepage — it takes a few seconds and only happens when you ask.
          </p>
        )}

        {profile?.error && (
          <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
            Last lookup failed: {profile.error}
          </p>
        )}

        {profile && (
          <>
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-[200px_1fr]">
              {profile.screenshotUrl ? (
                <OutboundLink
                  href={profile.finalUrl ?? `https://${profile.domain}`}
                  className="block overflow-hidden rounded-lg border border-line bg-surface-sunken"
                  title="Open the site"
                >
                  {/* A plain img: the thumbnail comes from a third-party renderer, and routing it
                      through next/image would mean listing that host in next.config and proxying
                      every screenshot through this server for no benefit.

                      `referrerPolicy` matters here for the same reason it does on the links: the
                      browser fetches this image directly from the screenshot service, and would
                      otherwise tell it which company record was open when it did. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={profile.screenshotUrl}
                    alt={`Homepage of ${profile.domain}`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-auto w-full"
                  />
                </OutboundLink>
              ) : (
                <div className="grid h-32 place-items-center rounded-lg border border-line bg-surface-sunken text-xs text-subtle">
                  No screenshot
                </div>
              )}

              <div className="min-w-0 space-y-2">
                {profile.siteTitle && <p className="font-medium text-text">{profile.siteTitle}</p>}
                {profile.siteDescription ? (
                  <p className="text-sm text-muted">{profile.siteDescription}</p>
                ) : (
                  <p className="text-sm text-subtle">
                    Their homepage publishes no description — often a sign nobody owns the website.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                  {company.industry?.name && <span>{company.industry.name}</span>}
                  {headcountLabel(company.employeeCount) && <span>{headcountLabel(company.employeeCount)} employees</span>}
                  {company.category && <span>{company.category}</span>}
                  <CompanyLinks
                    website={profile.finalUrl ?? company.website}
                    linkedinUrl={company.linkedinUrl}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm @xl:grid-cols-2">
              <Fact label="Email" value={profile.emailProvider} detail={profile.mxHosts[0]} />
              <Fact label="Mail security" value={profile.emailSecurityProvider ?? "None detected"} />
              <Fact label="Website platform" value={profile.platform ?? "Not identified"} detail={profile.platformEvidence} />
              <Fact label="Hosted on" value={profile.hostProvider} detail={profile.ipAddress} />
              <Fact label="DNS" value={profile.dnsProvider} detail={profile.nsHosts[0]} />
              <Fact
                label="Registrar"
                value={profile.registrar}
                detail={profile.expiresOn ? `expires ${clock.date(profile.expiresOn)}` : null}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <SecurityBadge ok={!!profile.spfRecord} label="SPF" missing="No SPF" />
              <SecurityBadge
                ok={!!profile.dmarcRecord && profile.dmarcPolicy !== "none"}
                label={profile.dmarcPolicy ? `DMARC p=${profile.dmarcPolicy}` : "DMARC"}
                missing={profile.dmarcRecord ? "DMARC monitor-only" : "No DMARC"}
              />
              <SecurityBadge ok={profile.dkimFound} label="DKIM" missing="No DKIM found" />
            </div>

            {opportunities.length > 0 && (
              <div className="rounded-lg border border-line bg-surface-sunken p-3">
                <div className="text-xs uppercase tracking-wide text-subtle">Where the conversation is</div>
                <ul className="mt-2 space-y-2.5">
                  {opportunities.map((o) => (
                    <li key={o.key} className="text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text">{o.observation}</span>
                        <Badge tone={o.weight === "strong" ? "green" : "default"}>{o.area}</Badge>
                      </div>
                      <p className="mt-0.5 text-muted">{o.angle}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value, detail }: { label: string; value: string | null; detail?: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-1 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-right text-text">
        {value ?? "—"}
        {detail && <span className="ml-2 font-mono text-xs text-subtle">{detail}</span>}
      </span>
    </div>
  );
}

/** Green when published, amber when not — a missing record is a gap, not an error. */
function SecurityBadge({ ok, label, missing }: { ok: boolean; label: string; missing: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ok ? "bg-success-bg text-success" : "bg-warning-bg text-warning"
      }`}
    >
      {ok ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
      {ok ? label : missing}
    </span>
  );
}
