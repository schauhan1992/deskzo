import Link from "next/link";
import { consoleMigrateWorkspace } from "@/actions/platform/console";
import { ConsoleAction } from "@/components/console/console-action";
import { Cell, DataTable, PageTitle, Section, StatusBadge, when } from "@/components/console/console-ui";
import { consoleStaff, mayManage } from "@/lib/platform/console-page";
import { migrationRuns } from "@/lib/platform/console-data";

/**
 * Schema migrations across the installation (src/lib/platform/tenant-migrations.ts). A full run is
 * `npm run tenants:migrate` on the server, before new code is deployed; from here one workspace can
 * be brought up to date or retried after a failure.
 */
export default async function ConsoleMigrationsPage() {
  const staff = await consoleStaff();
  const { version, runs, behind } = await migrationRuns();
  const manager = mayManage(staff);
  return (
    <>
      <PageTitle title="Migrations">Latest schema: {version ?? "—"}. A full run is started on the server with npm run tenants:migrate.</PageTitle>
      <Section title={`Behind the latest — ${behind.length}`}>
        <DataTable head={["Workspace", "Status", "Its schema", ""]} empty="Every open workspace is up to date.">
          {behind.map((t) => (
            <tr key={t.id}>
              <Cell>
                <Link href={`/workspaces/${t.slug}`} className="text-brand hover:underline">
                  {t.slug}
                </Link>
              </Cell>
              <Cell>
                <StatusBadge status={t.status} />
              </Cell>
              <Cell className="font-mono text-xs">{t.schemaVersion ?? "—"}</Cell>
              <Cell>{manager && <ConsoleAction action={consoleMigrateWorkspace.bind(null, t.slug)} label={t.status === "MIGRATING" ? "Retry" : "Migrate"} done="Migrated." />}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
      <Section title="Recent runs">
        <DataTable head={["Started", "Run", "Target", "From", "To", "Outcome"]} empty="No migration has been run from here yet.">
          {runs.map((r) => (
            <tr key={r.id}>
              <Cell className="whitespace-nowrap text-muted">{when(r.startedAt)}</Cell>
              <Cell className="font-mono text-xs text-muted">{r.runId.slice(0, 8)}</Cell>
              <Cell>{r.target}</Cell>
              <Cell className="font-mono text-xs">{r.fromVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell className="font-mono text-xs">{r.toVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell>
                {r.ok === null ? "running" : r.ok ? "ok" : <span className="text-danger">failed</span>}
                {r.ok === false && r.output && <span className="block max-w-[320px] break-words text-xs text-muted">{r.output.split("\n").filter(Boolean).slice(-1)[0]}</span>}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
