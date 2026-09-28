import type { Metadata } from "next";
import { Link2, Ticket } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { InviteCodesTable } from "@/components/partners/invitations/codes-table";
import { ReferralLinksTable } from "@/components/partners/invitations/links-table";
import { NewInviteCodeButton } from "@/components/partners/invitations/new-code-dialog";
import { NewReferralLinkButton } from "@/components/partners/invitations/new-link-dialog";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES } from "@/lib/partners/nav";
import { portalInvitations } from "@/lib/partners/portal-data";
import { PARTNER_LIMITS, PARTNER_SELLERS } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Invitations" };

/**
 * Invitations (admin, sales, viewer): the two ways a partner brings a customer (spec §4.1–§4.2).
 *
 *   Invitation codes  secret, each for a number of signups and a number of days, optionally naming the
 *                     plan the workspace starts on; shown once when made, then only by its last four.
 *   Referral links    the signup page with the partner's public code in it. They credit a signup to
 *                     the partner; they never open signup on their own.
 *
 * Making either needs a selling role (admin, sales) and an ACTIVE partner account — the buttons are
 * not drawn otherwise, and the server refuses anyway. Ending one only takes something away, so the
 * selling roles may end codes and links while the account is being set up or suspended too.
 */
export default async function PartnerInvitationsPage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.invitations);
  const me = session.user;
  const data = await portalInvitations(me, new Date());
  const seller = PARTNER_SELLERS.includes(me.role);
  const canSell = data.canSell;
  // Ending is "write", not "sell": a selling role may end a code or a link whatever the account's status.
  const canEnd = seller;

  return (
    <PortalPage title="Invitations" subtitle="Codes and links that bring customers to you. A workspace signed up with one is credited to your company.">
      {!data.signupOpen && <Banner tone="info" title="Signing up needs an invitation right now — referral links only credit you; send invitation codes." />}
      {seller && !canSell && (
        <Banner tone="neutral" title="Creating codes and links needs an active partner account.">
          You can still end the ones you have, if one has gone somewhere it shouldn&apos;t.
        </Banner>
      )}
      {!seller && <Banner tone="neutral" title="Your role can see codes and links. An admin or a sales user makes and ends them." />}

      <Panel
        title="Invitation codes"
        description={`A company signs up with the code, and the workspace it makes is yours. Each code works a set number of times, for a set number of days; it is shown once, when it is made. Up to ${PARTNER_LIMITS.invitesPerDay} a day.`}
        actions={canSell ? <NewInviteCodeButton plans={data.plans} signupUrl={data.signupUrl} /> : undefined}
        padded={data.codes.length === 0}
      >
        {data.codes.length === 0 ? (
          <EmptyState
            icon={<Ticket className="h-5 w-5" />}
            title="No invitation codes yet"
            body={canSell ? "Make a code for a company you are bringing in, and send it with the signup address." : "Codes your company makes appear here."}
          />
        ) : (
          <InviteCodesTable rows={data.codes} canEnd={canEnd} />
        )}
      </Panel>

      <Panel
        title="Referral links"
        description={`The signup page with your partner code in it. A workspace signed up through it is credited to you; it never lets anyone sign up on its own. Up to ${PARTNER_LIMITS.liveLinks} live at once.`}
        actions={canSell ? <NewReferralLinkButton plans={data.plans} /> : undefined}
        padded={data.links.length === 0}
      >
        {data.links.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-5 w-5" />}
            title="No referral links yet"
            body={canSell ? "Make a link for your website, a campaign or an event, and share it wherever you like." : "Links your company makes appear here."}
          />
        ) : (
          <ReferralLinksTable rows={data.links} canEnd={canEnd} />
        )}
      </Panel>
    </PortalPage>
  );
}
