import Link from "next/link";
import { AuditTable } from "@/components/console/audit-table";
import { PageTitle, Section, Stat } from "@/components/console/console-ui";
import { consoleStaff } from "@/lib/platform/console-page";
import { overview, staffNames } from "@/lib/platform/console-data";

export default async function ConsoleOverviewPage() {
  await consoleStaff();
  const [data, names] = await Promise.all([overview(), staffNames()]);
  const count = (status: string) => data.workspaces[status] ?? 0;
  return (
    <>
      <PageTitle title="Overview">Every workspace on this installation, from the control plane. Schema {data.version ?? "—"}.</PageTitle>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Active workspaces" value={count("ACTIVE")} />
        <Stat label="Being set up" value={count("PROVISIONING")} />
        <Stat label="Held" value={count("SUSPENDED")} tone={count("SUSPENDED") ? "warning" : undefined} />
        <Stat label="Held for a migration" value={count("MIGRATING")} tone={count("MIGRATING") ? "danger" : undefined} />
        <Stat label="Behind the latest schema" value={<Link href="/migrations" className="hover:underline">{data.drift}</Link>} tone={data.drift ? "warning" : undefined} />
        <Stat label="Failed setups" value={<Link href="/provisioning" className="hover:underline">{data.failedJobs}</Link>} tone={data.failedJobs ? "danger" : undefined} />
        <Stat label="Setups waiting" value={data.pendingJobs} />
        <Stat label="Warm databases ready" value={data.warm} tone={data.warm ? undefined : "warning"} />
      </div>
      <Section title="Recent activity" aside={<Link href="/audit" className="text-sm text-brand hover:underline">All of it</Link>}>
        <p className="mb-3 text-xs text-muted">{data.grants} workspace(s) have support access granted right now.</p>
        <AuditTable rows={data.recent} names={names} />
      </Section>
    </>
  );
}
