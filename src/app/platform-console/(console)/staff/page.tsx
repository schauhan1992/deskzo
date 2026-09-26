import { consoleDeactivateStaff, consoleEndStaffSessions, consoleResetStaffTwoFactor } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { AddStaffForm, NewSetupLink, StaffRoleSelect } from "@/components/console/console-forms";
import { Cell, DataTable, PageTitle, Section, when } from "@/components/console/console-ui";
import { consoleStaff, isOwner } from "@/lib/platform/console-page";
import { staffMembers } from "@/lib/platform/console-data";

/** The people who can sign in to this console. Only owners change them; there is always one owner. */
export default async function ConsoleStaffPage() {
  const staff = await consoleStaff();
  const members = await staffMembers();
  const owner = isOwner(staff);
  return (
    <>
      <PageTitle title="Staff">Everyone signs in with a password and an authenticator. The first owner is made on the server: npm run platform:staff.</PageTitle>
      {owner && (
        <Section title="Add someone">
          <AddStaffForm />
        </Section>
      )}
      <Section title={`${members.filter((m) => m.active).length} active`}>
        <DataTable head={owner ? ["Name", "Role", "Two-factor", "Last sign-in", "Signed in now", ""] : ["Name", "Role", "Two-factor", "Last sign-in", "Signed in now"]}>
          {members.map((m) => (
            <tr key={m.id} className={m.active ? undefined : "opacity-60"}>
              <Cell>
                {m.name}
                {m.id === staff.id && <span className="ml-1 text-xs text-muted">you</span>}
                <span className="block text-xs text-muted">{m.email}</span>
                {!m.active && <span className="block text-xs text-muted">switched off</span>}
              </Cell>
              <Cell>{owner && m.active && m.id !== staff.id ? <StaffRoleSelect userId={m.id} role={m.role} /> : m.role.toLowerCase()}</Cell>
              <Cell>{m.totpEnabledAt ? "on" : <span className="text-warning">not yet</span>}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(m.lastSignInAt)}</Cell>
              <Cell>{m.sessions.length}</Cell>
              {owner && (
                <Cell>
                  {m.active && m.id !== staff.id && (
                    <div className="flex flex-wrap gap-1">
                      {m.sessions.length > 0 && <ConsoleAction action={consoleEndStaffSessions.bind(null, m.id)} label="Sign out" variant="ghost" />}
                      {m.totpEnabledAt && (
                        <ConsoleAction
                          action={consoleResetStaffTwoFactor.bind(null, m.id)}
                          label="Reset two-factor"
                          variant="ghost"
                          confirm={`Reset ${m.name}'s authenticator? They enrol a new one at their next sign-in.`}
                        />
                      )}
                      <NewSetupLink userId={m.id} />
                      <ConsoleAction action={consoleDeactivateStaff.bind(null, m.id)} label="Switch off" variant="ghost" confirm={`Switch ${m.name} off? They are signed out and cannot sign in again.`} />
                    </div>
                  )}
                </Cell>
              )}
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
