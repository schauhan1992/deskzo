import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, KeyRound, Mail, Smartphone } from "lucide-react";
import { consoleMyPasswordLink } from "@/actions/platform/console-admin";
import { Preferences } from "@/components/console/account/preferences";
import { MySessions } from "@/components/console/account/sessions-table";
import { ActionButton } from "@/components/console/kit/action-button";
import { ActivityFeed } from "@/components/console/kit/activity-feed";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RolePill, StatusPill } from "@/components/console/kit/status";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { consoleClock } from "@/lib/platform/console-clock";
import { consoleStaff } from "@/lib/platform/console-page";
import { accountOverview } from "@/lib/platform/staff";
import { currentStaffSession } from "@/lib/platform/staff-session";

export const metadata: Metadata = { title: "My account" };

/**
 * My account (spec §3.19): the signed-in staff member's own profile, how they sign in, where they
 * are signed in, their preferences and what they changed lately. Open to every role and only ever
 * about the viewer — the loader reads by the signed-in id, and the session actions refuse anybody
 * else's sessions.
 *
 * Nothing here changes a role or shows a password: an owner changes roles, and a new password comes
 * as a one-time link emailed to the member's own address, never shown on the page.
 */
export default async function ConsoleAccountPage() {
  const staff = await consoleStaff(PAGE_ROLES.account);
  const [session, clock] = await Promise.all([currentStaffSession(), consoleClock()]);
  const data = await accountOverview(staff.id, session?.sessionId ?? null);
  const { profile } = data;
  const required = session?.twoFactorRequired ?? false;
  // Every row is the viewer's own: their name on each one says nothing.
  const recent = data.recent.map((item) => ({ ...item, actor: null }));

  return (
    <>
      <PageHeader title="My account" chips={<RolePill role={profile.role} />} subtitle={`${profile.name} · ${profile.email}`} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <MySessions sessions={data.sessions} />

          <Panel
            title="My recent activity"
            description="The last 20 changes you made in the console, newest first."
            actions={
              <Link href={`/audit?staff=${encodeURIComponent(profile.id)}`} className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap text-brand hover:underline">
                Open in audit log
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            }
          >
            <ActivityFeed items={recent} todayKey={data.todayKey} empty="You haven't changed anything in the console yet." />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Profile" footer="An owner changes roles.">
            <DefinitionList
              columns={1}
              items={[
                { term: "Name", value: profile.name },
                { term: "Email", value: profile.email },
                { term: "Role", value: <RolePill role={profile.role} /> },
                { term: "On the staff since", value: clock.date(profile.createdAt) },
                { term: "Last sign-in", value: profile.lastSignInAt ? <RelativeTime at={profile.lastSignInAt} /> : "—" },
              ]}
            />
          </Panel>

          <Panel title="Security" description="How you sign in to the console.">
            <div className="divide-y divide-line">
              <SecurityItem
                icon={<Smartphone className="h-4 w-4" />}
                title="Authenticator app"
                status={
                  profile.totpEnabledAt ? (
                    <StatusPill tone="success">{`Set up on ${clock.date(profile.totpEnabledAt)}`}</StatusPill>
                  ) : (
                    <StatusPill tone={required ? "warning" : "neutral"}>Not set up</StatusPill>
                  )
                }
              >
                {profile.totpEnabledAt
                  ? "Lost or replaced your phone? An owner resets it, and you set up the new one at your next sign-in."
                  : required
                    ? "You're asked to set one up at your next sign-in."
                    : "Two-factor is off for the console, so a password is enough for now."}
              </SecurityItem>
              <SecurityItem
                icon={<KeyRound className="h-4 w-4" />}
                title="Password"
                action={
                  <ActionButton
                    action={consoleMyPasswordLink}
                    label="Email me a password link"
                    icon={<Mail aria-hidden="true" className="h-4 w-4" />}
                    confirm={{
                      title: "Email me a password link",
                      body: `A one-time link to choose a new password goes to ${profile.email}. It lasts 3 days and replaces any link sent before; choosing a password with it signs you out everywhere, this device included.`,
                      confirmLabel: "Send link",
                    }}
                    success={`Sent to ${profile.email}. The link lasts 3 days.`}
                  />
                }
              >
                Nobody else ever sees or types your password. To change it, ask for a one-time link at your own email address.
              </SecurityItem>
            </div>
          </Panel>

          <Panel title="Preferences" description="Kept in this browser only — nobody else sees them.">
            <Preferences />
          </Panel>
        </div>
      </div>
    </>
  );
}

/** One way of signing in: what it is, its state, a line about it and what can be done. */
function SecurityItem({ icon, title, status, action, children }: { icon: ReactNode; title: string; status?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-4 first:pt-0 last:pb-0">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-text">{title}</h3>
          {status}
        </div>
        <p className="mt-1 text-xs text-muted">{children}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
