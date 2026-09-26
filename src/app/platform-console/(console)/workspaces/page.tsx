import Link from "next/link";
import { Cell, DataTable, PageTitle, Section, StatusBadge, when } from "@/components/console/console-ui";
import { consoleStaff } from "@/lib/platform/console-page";
import { listTenants } from "@/lib/platform/console-data";

export default async function ConsoleWorkspacesPage({ searchParams }: PageProps<"/platform-console/workspaces">) {
  await consoleStaff();
  const { q } = await searchParams;
  const search = typeof q === "string" ? q.slice(0, 100) : "";
  const tenants = await listTenants(search);
  return (
    <>
      <PageTitle title="Workspaces">Newest first. Search by address, name or the owner&apos;s email.</PageTitle>
      <Section
        title={`${tenants.length}${tenants.length === 200 ? "+" : ""} workspace(s)`}
        aside={
          <form className="flex gap-2" role="search">
            <input
              name="q"
              defaultValue={search}
              placeholder="Search"
              aria-label="Search workspaces"
              className="h-8 w-48 rounded-base border border-line-strong bg-surface px-2 text-sm text-text"
            />
          </form>
        }
      >
        <DataTable head={["Address", "Name", "Status", "Country", "Schema", "Owner", "Created"]} empty="No workspace matches.">
          {tenants.map((t) => (
            <tr key={t.id}>
              <Cell>
                <Link href={`/workspaces/${t.slug}`} className="font-medium text-brand hover:underline">
                  {t.slug}
                </Link>
                {t.isDefault && <span className="ml-1 text-xs text-muted">first</span>}
              </Cell>
              <Cell>{t.name}</Cell>
              <Cell>
                <StatusBadge status={t.status} />
              </Cell>
              <Cell>{t.country}</Cell>
              <Cell className="font-mono text-xs text-muted">{t.schemaVersion?.slice(0, 14) ?? "—"}</Cell>
              <Cell className="text-muted">{t.ownerEmail ?? "—"}</Cell>
              <Cell className="whitespace-nowrap text-muted">{when(t.createdAt)}</Cell>
            </tr>
          ))}
        </DataTable>
      </Section>
    </>
  );
}
