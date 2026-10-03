import { UserRound } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerUsersView } from "@/lib/partners/console-data";
import { PARTNER_ROLE_LABELS } from "@/lib/partners/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { PartnerUserMenu } from "./user-menu";

/**
 * Partner 360 › Users (spec §9.2): the partner's portal accounts — never a password, a link or a
 * secret — with MANAGERS' actions on each (a new set-password link, reset two-factor, switch off or
 * back on). New admins come from "Invite partner admin" at the top of the page; the partner's own
 * admins invite everyone else from the portal. A server component: its days are on the console's clock.
 */
export async function PartnerUsersTab({ data, caps, partnerName }: { data: PartnerUsersView; caps: Caps; partnerName: string }) {
  if (data.users.length === 0) {
    return (
      <Panel>
        <EmptyState icon={<UserRound className="h-5 w-5" />} title="No portal users yet" body={`${partnerName}'s first admin is invited from the top of this page; they add the rest of their team themselves.`} />
      </Panel>
    );
  }
  const manage = caps.managePartners;
  const clock = await consoleClock();
  return (
    <Panel padded={false} title="Portal users" description={`${data.activeUsers} of at most ${data.limit} active · ${data.activeAdmins === 1 ? "1 active admin" : `${data.activeAdmins} active admins`}`}>
      <DataTable caption="Portal users" minWidth={900}>
        <THead>
          <Th>Person</Th>
          <Th>Role</Th>
          <Th>Two-factor</Th>
          <Th>Last sign-in</Th>
          <Th>State</Th>
          <Th numeric>Sessions</Th>
          <Th>Added</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {data.users.map((u) => (
            <Tr key={u.id}>
              <Td>
                <span className="font-medium text-text">{u.name}</span>
                <span className="block text-xs break-all text-muted">{u.email}</span>
              </Td>
              <Td>{PARTNER_ROLE_LABELS[u.role] ?? u.role}</Td>
              <Td>{u.twoFactor ? <StatusPill tone="success">Set up</StatusPill> : <StatusPill tone="neutral">Not yet</StatusPill>}</Td>
              <Td nowrap muted>
                {u.lastSignInAt ? <RelativeTime at={u.lastSignInAt} /> : "Never"}
              </Td>
              <Td>
                <span className="inline-flex flex-col items-start gap-0.5">
                  {u.active ? <StatusPill tone="success">Active</StatusPill> : <StatusPill tone="neutral">Switched off</StatusPill>}
                  {u.active && !u.hasPassword && <span className="text-xs text-muted">{u.setupPending ? "Link sent — no password yet" : "No password yet"}</span>}
                </span>
              </Td>
              <Td numeric>{u.liveSessions}</Td>
              <Td nowrap muted>
                {`${clock.date(u.createdAt)} · ${u.createdBy}`}
              </Td>
              {manage && (
                <RowActionsCell>
                  <PartnerUserMenu
                    user={{ id: u.id, name: u.name, email: u.email, active: u.active, twoFactor: u.twoFactor }}
                    lastAdmin={u.active && u.role === "ADMIN" && data.activeAdmins <= 1}
                  />
                </RowActionsCell>
              )}
            </Tr>
          ))}
        </TBody>
      </DataTable>
    </Panel>
  );
}
