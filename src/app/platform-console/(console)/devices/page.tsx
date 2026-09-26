import Link from "next/link";
import { consoleReleaseDevice } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { Cell, DataTable, PageTitle, Section, when } from "@/components/console/console-ui";
import { consoleStaff, mayManage } from "@/lib/platform/console-page";
import { deviceRoutes } from "@/lib/platform/console-data";

/**
 * Attendance terminals, by serial number, and the workspace each reports to. A terminal that calls in
 * without a workspace's address is routed by its serial; a serial belongs to one workspace at a time.
 * Letting one go frees it to be registered by another — when a terminal changes hands.
 */
export default async function ConsoleDevicesPage() {
  const staff = await consoleStaff();
  const routes = await deviceRoutes();
  const manager = mayManage(staff);
  return (
    <>
      <PageTitle title="Terminals">Which workspace each attendance terminal reports to.</PageTitle>
      <Section title={`${routes.length} terminal(s)`}>
        <DataTable head={["Serial", "Workspace", "Added", "Last seen", ""]} empty="No terminal is registered.">
          {routes.map((r) => (
            <tr key={r.serial}>
              <Cell className="font-mono text-xs">{r.serial}</Cell>
              <Cell>
                <Link href={`/workspaces/${r.tenant.slug}`} className="text-brand hover:underline">
                  {r.tenant.slug}
                </Link>
              </Cell>
              <Cell className="whitespace-nowrap text-muted">{when(r.createdAt)}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(r.lastSeenAt)}</Cell>
              <Cell>
                {manager && (
                  <ConsoleAction
                    action={consoleReleaseDevice.bind(null, r.serial)}
                    label="Let go"
                    confirm={`Stop routing ${r.serial} to ${r.tenant.slug}? Its punches will be refused until a workspace registers it again.`}
                  />
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
