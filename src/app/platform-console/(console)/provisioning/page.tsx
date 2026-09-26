import Link from "next/link";
import { consoleRetryJob, consoleTopUpWarmPool } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { Cell, DataTable, PageTitle, Section, StatusBadge, when } from "@/components/console/console-ui";
import { consoleStaff, mayManage } from "@/lib/platform/console-page";
import { provisioningQueue } from "@/lib/platform/console-data";

/** Workspaces being set up by the platform worker (scripts/platform-worker.ts), and its warm pool. */
export default async function ConsoleProvisioningPage() {
  const staff = await consoleStaff();
  const { jobs, warm, version } = await provisioningQueue();
  const manager = mayManage(staff);
  const ready = warm.filter((w) => !w.claimedAt);
  return (
    <>
      <PageTitle title="Provisioning">Setting a workspace up: its database, its first owner, its organisation. The worker takes one job at a time.</PageTitle>
      <Section title="Setups">
        <DataTable head={["Workspace", "Status", "Step", "Tries", "Started", "Finished", ""]} empty="No workspace has been set up yet.">
          {jobs.map((j) => (
            <tr key={j.id}>
              <Cell>
                <Link href={`/workspaces/${j.tenant.slug}`} className="text-brand hover:underline">
                  {j.tenant.slug}
                </Link>
                <span className="block text-xs text-muted">{j.companyName}</span>
              </Cell>
              <Cell>
                <StatusBadge status={j.status} />
              </Cell>
              <Cell>
                {j.step}
                {j.error && <span className="block max-w-[320px] break-words text-xs text-danger">{j.error.split("\n")[0]}</span>}
              </Cell>
              <Cell>{j.attempts}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(j.startedAt)}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(j.finishedAt)}</Cell>
              <Cell>{manager && j.status === "FAILED" && <ConsoleAction action={consoleRetryJob.bind(null, j.id)} label="Try again" />}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
      <Section
        title={`Warm pool — ${ready.length} ready`}
        aside={manager && <ConsoleAction action={consoleTopUpWarmPool} label="Top it up now" done="The worker has been started." />}
      >
        <p className="mb-3 text-xs text-muted">Databases made and migrated ahead of time, so a signup gets one at once. Latest schema: {version ?? "—"}.</p>
        <DataTable head={["Database", "Schema", "Made", "Taken"]} empty="None made yet — the worker keeps two ready.">
          {warm.map((w) => (
            <tr key={w.id}>
              <Cell className="font-mono text-xs">{w.dbName}</Cell>
              <Cell className={w.schemaVersion === version ? "font-mono text-xs" : "font-mono text-xs text-warning"}>{w.schemaVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(w.createdAt)}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(w.claimedAt)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
