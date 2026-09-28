import type { Metadata } from "next";
import { KeyRound, Mail } from "lucide-react";
import { partnerEmailMyPasswordLink } from "@/actions/partners/auth";
import { ActionButton } from "@/components/console/kit/action-button";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { PartnerMySessions, RenameForm, TwoFactorCard } from "@/components/partners/account/account-forms";
import { PortalPage } from "@/components/partners/common/page";
import { PartnerKindPill, PartnerRolePill } from "@/components/partners/common/pills";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES } from "@/lib/partners/nav";
import { portalAccount } from "@/lib/partners/portal-data";
import { partnerEnrolmentChallenge } from "@/lib/partners/session";
import { PARTNER_ROLE_DESCRIPTIONS, partnerCapsFor } from "@/lib/partners/types";

export const metadata: Metadata = { title: "My account" };

/**
 * My account: the signed-in person's name, email and role, where they're signed in, their password
 * (a one-time link to their own address — never a field) and their authenticator. Only ever about
 * the viewer: the loader reads by the session's own user (src/lib/partners/portal-data.ts
 * portalAccount), and the actions act on the session's own user. The session's id stays on the
 * server — the sessions list names each one by a handle that is neither its token nor its hash — and
 * the authenticator's QR code and key are made here, for this person only, when they have none yet.
 */
export default async function PartnerAccountPage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.account);
  const account = await portalAccount(session.user, session.sessionId);
  const me = account.me;
  const challenge = account.enrolled ? null : await partnerEnrolmentChallenge();
  const caps = partnerCapsFor(me);

  return (
    <PortalPage title="My account" chips={<PartnerRolePill role={me.role} />} subtitle={`${me.name} · ${me.email}`}>
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <PartnerMySessions sessions={account.sessions} />
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Profile" footer={caps.admin ? "Roles are changed in Team." : "An admin of your partner account changes roles."}>
            <div className="space-y-4">
              <RenameForm name={me.name} />
              <DefinitionList
                columns={1}
                items={[
                  { term: "Email", value: <span translate="no">{me.email}</span> },
                  {
                    term: "Role",
                    value: (
                      <span className="block space-y-1">
                        <PartnerRolePill role={me.role} />
                        <span className="block text-xs text-muted">{PARTNER_ROLE_DESCRIPTIONS[me.role]}</span>
                      </span>
                    ),
                  },
                  {
                    term: "Partner",
                    value: (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span>{me.partner.displayName}</span>
                        <PartnerKindPill kind={me.partner.kind} />
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel title="Security" description="How you sign in to the partner portal.">
            <div className="divide-y divide-line">
              <div className="pb-4">
                <TwoFactorCard enrolled={account.enrolled} required={session.twoFactorRequired} challenge={challenge} />
              </div>
              <div className="space-y-3 pt-4">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-surface-sunken text-muted">
                    <KeyRound className="h-4 w-4" />
                  </span>
                  <span className="text-[13px] font-medium text-text">Password</span>
                </div>
                <p className="text-xs text-muted">Nobody else ever sees or types your password. To change it, ask for a one-time link at your own email address.</p>
                <ActionButton
                  action={partnerEmailMyPasswordLink}
                  label="Email me a link to change my password"
                  icon={<Mail aria-hidden="true" className="h-4 w-4" />}
                  confirm={{
                    title: "Email me a password link",
                    body: `A one-time link to choose a new password goes to ${me.email}. It lasts 3 days and replaces any link sent before; choosing a password with it signs you out everywhere, this device included.`,
                    confirmLabel: "Send link",
                  }}
                  success={`Sent to ${me.email}. The link lasts 3 days.`}
                />
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </PortalPage>
  );
}
