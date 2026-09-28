import type { Metadata } from "next";
import Link from "next/link";
import { Crown, MonitorSmartphone, ShieldAlert, ShieldCheck, ShieldOff, Users } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { AddStaffButton } from "@/components/console/staff/add-staff-dialog";
import { RoleMatrix } from "@/components/console/staff/role-matrix";
import { StaffTable } from "@/components/console/staff/staff-table";
import { ROLE_LABEL } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { parseStaffFilters, withParams, type StaffFilters } from "@/lib/console-shared/params";
import { ALL_ROLES, capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { listStaffSessions, staffBoard } from "@/lib/platform/staff";

export const metadata: Metadata = { title: "Staff" };

const PATH = "/staff";
const num = (n: number) => n.toLocaleString("en-IN");

const STATUS_TABS: { key: StaffFilters["status"]; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "off", label: "Switched off" },
  { key: "all", label: "All" },
];

/**
 * Staff (spec §3.16): the people who can sign in to this console, their roles and two-factor, and
 * who is signed in right now. Every staff member may look — support included — but only an owner
 * changes anything: the Add button, its dialog and the row menus are drawn for owners alone, and
 * never on an owner's own row. The two-factor policy itself lives in Settings › Staff security.
 *
 * Sessions are loaded for everybody's rows; where they came from (the IP address) reaches the
 * browser for owners only — for anybody else it is dropped here, before the props are serialised.
 */
export default async function ConsoleStaffPage({ searchParams }: PageProps<"/platform-console/staff">) {
  const staff = await consoleStaff(PAGE_ROLES.staff);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseStaffFilters(sp);
  const [board, allSessions] = await Promise.all([staffBoard(f), listStaffSessions()]);

  const shown = new Set(board.rows.map((r) => r.id));
  const sessions = allSessions.filter((s) => shown.has(s.userId)).map((s) => (caps.owner ? s : { ...s, ip: null }));
  const c = board.counts;
  const required = board.policy.mode === "required";

  const chips = [
    ...(f.role ? [{ key: "role", label: `Role: ${ROLE_LABEL[f.role].label}`, removeHref: withParams(PATH, sp, { role: null }) }] : []),
    ...(f.q ? [{ key: "q", label: `Search: ${f.q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
  ];
  const narrowed = chips.length > 0 || f.status !== "active";

  const policyPill = (
    <StatusPill tone={required ? "success" : "neutral"} icon={required ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}>
      {`Two-factor: ${required ? "required" : "off"}`}
    </StatusPill>
  );

  return (
    <>
      <PageHeader
        title="Staff"
        chips={
          caps.viewSettings ? (
            <Link href="/settings#security" aria-label={`Two-factor: ${required ? "required" : "off"} — staff security settings`} className="rounded-full hover:opacity-80">
              {policyPill}
            </Link>
          ) : (
            policyPill
          )
        }
        subtitle={required ? "Everyone signs in with a password and an authenticator app." : "Everyone signs in with a password alone — two-factor is off."}
        asOf={board.asOf}
        actions={caps.owner ? <AddStaffButton /> : undefined}
      />

      <div className="space-y-6">
        <KpiGrid columns={4}>
          <KpiTile label="Active staff" value={num(c.active)} icon={<Users className="h-4 w-4" />} href={PATH} secondary="Can sign in to the console" />
          <KpiTile
            label="Owners"
            value={num(c.owners)}
            icon={<Crown className="h-4 w-4" />}
            href={withParams(PATH, {}, { role: "OWNER" })}
            secondary={c.owners === 1 ? "The last one can't be removed" : "Staff, security and gateway keys"}
          />
          <KpiTile
            label="No authenticator"
            value={num(c.noAuthenticator)}
            icon={<ShieldAlert className="h-4 w-4" />}
            tone={required && c.noAuthenticator > 0 ? "warning" : "neutral"}
            secondary={required ? "Asked for one at their next sign-in" : "Two-factor is off — not asked for"}
          />
          <KpiTile
            label="Signed in now"
            value={num(c.signedInNow)}
            icon={<MonitorSmartphone className="h-4 w-4" />}
            tone={c.signedInNow > 0 ? "success" : "neutral"}
            secondary="Used the console in the last 30 minutes"
          />
        </KpiGrid>

        <section aria-label="Staff members">
          <FilterBar>
            <ViewTabs
              label="Staff status"
              items={STATUS_TABS.map((tab) => ({
                key: tab.key,
                label: tab.label,
                href: withParams(PATH, sp, { status: tab.key === "active" ? null : tab.key }),
                active: f.status === tab.key,
              }))}
            />
            <SearchField label="Search staff" placeholder="Name or email" />
            <SelectFilter param="role" label="Role" allLabel="Any role" options={ALL_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role].label }))} />
          </FilterBar>
          <FilterChips chips={chips} clearHref={chips.length > 1 ? withParams(PATH, sp, { q: null, role: null }) : undefined} />

          <Panel padded={false}>
            {board.rows.length > 0 ? (
              <StaffTable rows={board.rows} sessions={sessions} me={staff.id} owner={caps.owner} policy={board.policy.mode} />
            ) : f.status === "off" && chips.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="Nobody is switched off."
                body="Staff who are switched off stay listed here with their history, and an owner can switch them back on."
              />
            ) : narrowed ? (
              <EmptyState variant="filtered" title="No staff member matches." body="Search by part of a name or an email address." clearHref={PATH} />
            ) : (
              <EmptyState icon={<Users className="h-5 w-5" />} title="No staff yet." body="The first owner is made on the server with npm run platform:staff." />
            )}
          </Panel>
        </section>

        <RoleMatrix />
      </div>
    </>
  );
}
