import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { PartnerKindPill, PartnerStatusPill } from "@/components/partners/common/pills";
import { RequestChangeButton } from "@/components/partners/profile/change-request-dialog";
import { EditCompanyButton } from "@/components/partners/profile/company-dialog";
import { AddressBlock, PayoutMaskList, countryName } from "@/components/partners/profile/details";
import { SubmitPayoutButton } from "@/components/partners/profile/payout-dialog";
import { PendingRequest, RequestsTable } from "@/components/partners/profile/requests";
import { TermsSection } from "@/components/partners/profile/terms-view";
import { OutboundLink, externalHref } from "@/components/ui/outbound-link";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES } from "@/lib/partners/nav";
import { portalProfile } from "@/lib/partners/portal-data";
import { partnerCapsFor } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Company profile" };

/**
 * Company profile (everybody reads it; what each role sees and does follows spec §8.4):
 *   · Company — the display name, phone, website and the public directory listing: an ADMIN edits
 *     these directly (src/actions/partners/profile.ts partnerUpdateProfile).
 *   · Legal and tax details — what statements and payments are made out to: read here, changed only
 *     by a request platform staff review (ADMIN).
 *   · Payout details (ADMIN, FINANCE) — the mask only: holder, bank, country, currency, IFSC or SWIFT
 *     and the account's last four. New details are a request too, sealed as they arrive; the full
 *     details never reach the portal, not even for their owner.
 *   · Commission terms (ADMIN, FINANCE) — the rates in force and any scheduled, as percentages.
 *   · Requests — every request and its answer (payout ones for the money roles only).
 * The loader reads no payout mask and no terms at all for the other roles (portal-data.ts portalProfile).
 */
export default async function PartnerProfilePage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.profile);
  const me = session.user;
  const caps = partnerCapsFor(me);
  const profile = await portalProfile(me, new Date());
  const p = profile.partner;
  const distributor = p.kind === "DISTRIBUTOR";
  const pendingProfile = profile.requests.find((r) => r.kind === "PROFILE" && r.status === "PENDING") ?? null;
  const pendingPayout = caps.money ? (profile.requests.find((r) => r.kind === "PAYOUT" && r.status === "PENDING") ?? null) : null;
  const website = externalHref(p.website);

  return (
    <PortalPage
      title="Company profile"
      chips={
        <>
          <PartnerKindPill kind={p.kind} />
          <PartnerStatusPill status={p.status} />
        </>
      }
      subtitle="Your company as the platform holds it."
    >
      <Panel
        title="Company"
        description={caps.admin ? "You can change these yourself." : "Your company's admins can change these."}
        actions={
          caps.admin ? (
            <EditCompanyButton initial={{ displayName: p.displayName, contactPhone: p.contactPhone, website: p.website, publicListing: p.publicListing, publicBlurb: p.publicBlurb }} />
          ) : undefined
        }
      >
        <DefinitionList
          items={[
            { term: "Display name", value: p.displayName },
            { term: "Territories", value: p.territories.length ? p.territories.map(countryName).join(", ") : "—" },
            ...(p.parent ? [{ term: "Your distributor", value: p.parent.displayName }] : []),
            { term: "Phone", value: p.contactPhone ?? <span className="text-muted">—</span> },
            {
              term: "Website",
              value: website ? (
                <OutboundLink href={website} className="break-all text-brand hover:underline">
                  {p.website}
                </OutboundLink>
              ) : (
                <span className="text-muted">—</span>
              ),
            },
            { term: "Public partner directory", value: p.publicListing ? "Listed" : "Not listed" },
            { term: "Public description", value: p.publicBlurb ?? <span className="text-muted">—</span>, wide: true },
          ]}
        />
      </Panel>

      <Panel
        title="Legal and tax details"
        description="What statements and payments are made out to. A change is reviewed by platform staff before it takes effect."
        actions={
          caps.admin ? (
            <RequestChangeButton current={{ legalName: p.legalName, country: p.country, contactName: p.contactName, contactEmail: p.contactEmail, address: p.address, taxIds: p.taxIds }} />
          ) : undefined
        }
      >
        <div className="space-y-4">
          {pendingProfile && <PendingRequest request={pendingProfile} canWithdraw={caps.admin} what="A change to these details is" />}
          <DefinitionList
            items={[
              { term: "Legal name", value: p.legalName },
              { term: "Country", value: countryName(p.country) },
              { term: "Contact", value: p.contactName },
              { term: "Contact email", value: <span className="break-all">{p.contactEmail}</span> },
              { term: "Address", value: <AddressBlock address={p.address} /> },
              {
                term: "Tax ids",
                value: p.taxIds.length ? (
                  <span className="block">
                    {p.taxIds.map((t) => (
                      <span key={`${t.kind}-${t.value}`} className="block">
                        <span className="text-muted">{`${t.kind} `}</span>
                        <span className="font-mono">{t.value}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted">None on file</span>
                ),
              },
            ]}
          />
        </div>
      </Panel>

      {caps.money && (
        <Panel
          title="Payout details"
          description="Where your commission is paid. Only the bank and the account's last four are ever shown."
          actions={<SubmitPayoutButton hasDetails={!!profile.payout} />}
        >
          <div className="space-y-4">
            {pendingPayout && <PendingRequest request={pendingPayout} canWithdraw what="New payout details are" />}
            {profile.payout ? (
              <PayoutMaskList mask={profile.payout} />
            ) : (
              <p className="text-sm text-muted">No payout details on file yet. A statement can&apos;t be approved for payment until they are — submit them for review.</p>
            )}
          </div>
        </Panel>
      )}

      {caps.money && profile.terms && (
        <Panel title="Commission terms" description="Set by the platform. Rates are percentages of each paid invoice before tax.">
          <TermsSection inForce={profile.terms.inForce} scheduled={profile.terms.scheduled} distributor={distributor} />
        </Panel>
      )}

      <Panel title="Requests" description="Changes you asked platform staff to make, and their answers." padded={profile.requests.length === 0}>
        {profile.requests.length === 0 ? (
          <EmptyState icon={<Inbox className="h-5 w-5" />} title="No requests yet" body="Requests to change your company's details appear here with the platform's answer." />
        ) : (
          <RequestsTable rows={profile.requests} />
        )}
      </Panel>
    </PortalPage>
  );
}
