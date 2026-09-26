import { consoleEndInvite } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { InviteForm } from "@/components/console/console-forms";
import { Cell, DataTable, PageTitle, Section, when } from "@/components/console/console-ui";
import { consoleStaff, mayManage } from "@/lib/platform/console-page";
import { invites, plansList } from "@/lib/platform/console-data";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/** Signup is by invitation until billing opens it (src/actions/platform/signup.ts). */
export default async function ConsoleInvitesPage() {
  const staff = await consoleStaff();
  const [rows, plans] = await Promise.all([invites(), plansList()]);
  // What a new workspace may start on: offered, and never an internal plan.
  const offered = plans.filter((p) => p.active && p.kind !== "INTERNAL").map((p) => ({ key: p.key, name: p.name }));
  const manager = mayManage(staff);
  const siteHost = `www.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`;
  return (
    <>
      <PageTitle title="Invitations">Setting up a workspace needs an invitation code for now.</PageTitle>
      {manager && (
        <Section title="New invitation">
          <InviteForm signupUrl={`${protocolFor(siteHost)}://${siteHost}/signup`} plans={offered} />
        </Section>
      )}
      <Section title="Invitations">
        <DataTable head={["For", "Plan", "Used", "Valid until", "Made", ""]} empty="None made yet.">
          {rows.map((i) => {
            const { live } = i;
            return (
              <tr key={i.codeHash}>
                <Cell>{i.note ?? <span className="text-muted">—</span>}</Cell>
                <Cell className="font-mono text-xs text-muted">{i.planKey ?? "default"}</Cell>
                <Cell>
                  {i.uses} of {i.maxUses}
                </Cell>
                <Cell className={live ? "whitespace-nowrap text-muted" : "whitespace-nowrap text-muted line-through"}>{when(i.expiresAt)}</Cell>
                <Cell className="whitespace-nowrap text-muted">{when(i.createdAt)}</Cell>
                <Cell>{manager && live && <ConsoleAction action={consoleEndInvite.bind(null, i.codeHash)} label="End it" confirm="End this invitation? Its code stops working now." />}</Cell>
              </tr>
            );
          })}
        </DataTable>
      </Section>
    </>
  );
}
