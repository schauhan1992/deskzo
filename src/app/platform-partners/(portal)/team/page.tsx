import type { Metadata } from "next";
import { Crown, MailClock, MonitorSmartphone, ShieldAlert, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { PortalPage } from "@/components/partners/common/page";
import { PartnerRolePill } from "@/components/partners/common/pills";
import { InviteUserButton } from "@/components/partners/team/invite-dialog";
import { PartnerUsersTable } from "@/components/partners/team/users-table";
import { withParams } from "@/lib/console-shared/params";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES } from "@/lib/partners/nav";
import { portalTeam } from "@/lib/partners/portal-data";
import { partnerTwoFactorPolicy } from "@/lib/partners/settings";
import { PARTNER_LIMITS, PARTNER_ROLES, PARTNER_ROLE_DESCRIPTIONS } from "@/lib/partners/types";

export const metadata: Metadata = { title: "Team" };

const PATH = PARTNER_ROUTES.team;
const num = (n: number) => n.toLocaleString("en-IN");

const TABS = [
  { key: "active", label: "Active" },
  { key: "off", label: "Switched off" },
  { key: "all", label: "All" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/**
 * Team (admins only — anybody else gets "not found"): who can sign in to the portal for this
 * partner, as what, whether their authenticator is set up, when they last signed in and who is
 * signed in now. Admins invite, change roles, send new links, reset two-factor, sign people out and
 * switch them off here (src/actions/partners/team.ts). The partner always keeps at least one active
 * admin; the server says so rather than letting the last one go.
 *
 * Small enough to load whole (at most fifty active users); the tabs and the search narrow it on the
 * server, from the address, so a filtered list survives a reload.
 */
export default async function PartnerTeamPage({ searchParams }: PageProps<"/platform-partners/team">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.team);
  const sp = await searchParams;
  const tab: Tab = sp.status === "off" ? "off" : sp.status === "all" ? "all" : "active";
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase().slice(0, 100) : "";
  const [users, policy] = await Promise.all([portalTeam(session.user), partnerTwoFactorPolicy()]);

  const active = users.filter((u) => u.active);
  const admins = active.filter((u) => u.role === "ADMIN").length;
  const noAuthenticator = active.filter((u) => !u.twoFactor).length;
  const waiting = active.filter((u) => !u.hasPassword).length;
  const signedIn = active.filter((u) => u.liveSessions > 0).length;
  const counts: Record<Tab, number> = { active: active.length, off: users.length - active.length, all: users.length };
  const rows = users.filter((u) => (tab === "all" || (tab === "active" ? u.active : !u.active)) && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q)));
  const required = policy.mode === "required";
  const onlyAdmin = admins === 1 && active.some((u) => u.role === "ADMIN" && u.id === session.user.id);

  return (
    <PortalPage
      title="Team"
      chips={
        <StatusPill tone={required ? "success" : "neutral"} icon={required ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}>
          {`Two-factor: ${required ? "required" : "optional"}`}
        </StatusPill>
      }
      subtitle={`People who can sign in to the partner portal for ${session.user.partner.displayName}. At most ${PARTNER_LIMITS.users} active at once.`}
      actions={<InviteUserButton />}
    >
      {onlyAdmin && (
        <Banner tone="info" title="You're the only admin">
          Your partner account always keeps one active admin, so you can&apos;t be switched off or lose the role. Make somebody else an admin too, so the account never
          depends on one person.
        </Banner>
      )}

      <KpiGrid columns={4}>
        <KpiTile label="Active users" value={num(active.length)} icon={<Users className="h-4 w-4" />} secondary={`${num(signedIn)} signed in now`} />
        <KpiTile label="Admins" value={num(admins)} icon={<Crown className="h-4 w-4" />} secondary={admins === 1 ? "The last one can't be removed" : "The team and the company profile"} />
        <KpiTile
          label="No authenticator"
          value={num(noAuthenticator)}
          icon={<ShieldAlert className="h-4 w-4" />}
          tone={required && noAuthenticator > 0 ? "warning" : "neutral"}
          secondary={required ? "Asked for one at their next sign-in" : "Two-factor is optional — not asked"}
        />
        <KpiTile
          label="Waiting to set a password"
          value={num(waiting)}
          icon={<MailClock className="h-4 w-4" />}
          tone={waiting > 0 ? "info" : "neutral"}
          secondary="Invited, link not used yet"
        />
      </KpiGrid>

      <section aria-label="Partner portal users">
        <FilterBar>
          <ViewTabs
            label="Account status"
            items={TABS.map((t) => ({ key: t.key, label: t.label, href: withParams(PATH, sp, { status: t.key === "active" ? null : t.key }), active: tab === t.key, count: counts[t.key] }))}
          />
          <SearchField label="Search the team" placeholder="Name or email" />
        </FilterBar>
        <Panel padded={rows.length === 0}>
          {rows.length === 0 ? (
            q ? (
              <EmptyState variant="filtered" title="Nobody matches that" body="Try part of a name or an email address." clearHref={withParams(PATH, sp, { q: null })} />
            ) : (
              <EmptyState
                icon={<MonitorSmartphone className="h-5 w-5" />}
                title={tab === "off" ? "Nobody is switched off" : "No users here"}
                body={tab === "off" ? "People you switch off appear here, and can be switched back on." : "Invite somebody to get started."}
              />
            )
          ) : (
            <PartnerUsersTable rows={rows} me={session.user.id} policy={policy.mode} />
          )}
        </Panel>
      </section>

      <Panel title="Roles" description="What each role may do. The server checks every action against these, whatever the screen shows.">
        <dl className="grid gap-4 sm:grid-cols-2">
          {PARTNER_ROLES.map((role) => (
            <div key={role} className="min-w-0">
              <dt>
                <PartnerRolePill role={role} />
              </dt>
              <dd className="mt-1.5 text-xs text-muted">{PARTNER_ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </PortalPage>
  );
}
