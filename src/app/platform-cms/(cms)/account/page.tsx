import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, KeyRound, Mail } from "lucide-react";
import { cmsEmailMyPasswordLink } from "@/actions/cms/auth";
import { ActionButton } from "@/components/console/kit/action-button";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { activityFeedItems } from "@/components/cms/common/activity";
import { CmsRolePill } from "@/components/cms/common/status";
import { dayMonthYear, istDayKey } from "@/lib/console-shared/format";
import { listCmsAudit } from "@/lib/cms/audit";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { cmsEnrolmentChallenge, cmsTwoFactorPolicy } from "@/lib/cms/session";
import { CMS_ROLE_DESCRIPTIONS, cmsCapsFor, type CmsMe } from "@/lib/cms/types";
import { listCmsSessions, listCmsUsers } from "@/lib/cms/users";
import { CmsMySessions, RenameForm, TwoFactorCard } from "./account-forms";

export const metadata: Metadata = { title: "My account" };

/** Everything the page shows about the signed-in person — and India's today, for the activity headings. */
async function loadAccount(me: CmsMe, sessionId: string, enrolled: boolean) {
  const [users, sessions, policy, challenge, recent] = await Promise.all([
    listCmsUsers(),
    listCmsSessions(me.id, sessionId),
    cmsTwoFactorPolicy(),
    // Their own authenticator's QR code and key, made once and kept sealed — for this page only.
    enrolled ? Promise.resolve(null) : cmsEnrolmentChallenge(),
    listCmsAudit({ actorId: me.id }),
  ]);
  return { profile: users.find((u) => u.id === me.id) ?? null, sessions, policy, challenge, recent: recent.rows.slice(0, 15), todayKey: istDayKey(new Date()) };
}

/**
 * My account: the signed-in person's name, email and role, where they're signed in, their password
 * (a one-time link to their own address — never a field) and their authenticator, and what they
 * changed lately. Only ever about the viewer: the loaders read by the session's own id, and the
 * actions act on the session's own user. The session's id stays on the server — the sessions list
 * names each one by a handle that is neither its token nor its hash.
 */
export default async function CmsAccountPage() {
  const session = await cmsPage(CMS_PAGE_ROLES.account);
  const me = session.user;
  const caps = cmsCapsFor(me.role);
  const data = await loadAccount(me, session.sessionId, session.enrolled);
  const feed = activityFeedItems(data.recent, { canOpenUsers: caps.admin, canOpenSecurity: caps.admin, canOpenRedirects: caps.publish, hideActor: true });

  return (
    <>
      <PageHeader title="My account" chips={<CmsRolePill role={me.role} />} subtitle={`${me.name} · ${me.email}`} />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <CmsMySessions sessions={data.sessions} />

          <Panel
            title="Your recent activity"
            description="The last things you changed in the CMS."
            actions={
              <Link href={`${CMS_ROUTES.activity}?actor=${encodeURIComponent(me.id)}`} className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap text-brand hover:underline">
                See it all
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            }
          >
            <ActivityFeed items={feed} todayKey={data.todayKey} showWorkspace={false} empty="You haven't changed anything in the CMS yet." />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Profile" footer={caps.admin ? "Roles are changed in Users." : "An admin changes roles."}>
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
                        <CmsRolePill role={me.role} />
                        <span className="block text-xs text-muted">{CMS_ROLE_DESCRIPTIONS[me.role]}</span>
                      </span>
                    ),
                  },
                  ...(data.profile ? [{ term: "In the CMS since", value: dayMonthYear(data.profile.createdAt) }] : []),
                  ...(data.profile?.lastSignInAt ? [{ term: "Last sign-in", value: <RelativeTime at={data.profile.lastSignInAt} /> }] : []),
                ]}
              />
            </div>
          </Panel>

          <Panel title="Security" description="How you sign in to the CMS.">
            <div className="divide-y divide-line">
              <div className="pb-4">
                <TwoFactorCard enrolled={session.enrolled} policy={data.policy.mode} challenge={data.challenge} />
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
                  action={cmsEmailMyPasswordLink}
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
    </>
  );
}
