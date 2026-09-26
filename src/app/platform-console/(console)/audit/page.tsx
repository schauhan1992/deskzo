import { AuditTable } from "@/components/console/audit-table";
import { PageTitle, Section } from "@/components/console/console-ui";
import { consoleStaff } from "@/lib/platform/console-page";
import { auditLog, staffNames } from "@/lib/platform/console-data";

/** Everything done to the platform — by staff, by scripts on the server, and by the platform itself. */
export default async function ConsoleAuditPage({ searchParams }: PageProps<"/platform-console/audit">) {
  await consoleStaff();
  const { q } = await searchParams;
  const search = typeof q === "string" ? q.slice(0, 100) : "";
  const [rows, names] = await Promise.all([auditLog(search), staffNames()]);
  return (
    <>
      <PageTitle title="Audit log">The latest 200 entries. Search by action, workspace or who did it.</PageTitle>
      <Section
        title={search ? `Matching “${search}”` : "Latest"}
        aside={
          <form role="search">
            <input
              name="q"
              defaultValue={search}
              placeholder="Search"
              aria-label="Search the audit log"
              className="h-8 w-48 rounded-base border border-line-strong bg-surface px-2 text-sm text-text"
            />
          </form>
        }
      >
        <AuditTable rows={rows} names={names} />
      </Section>
    </>
  );
}
