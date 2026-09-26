import Link from "next/link";
import { Cell, DataTable, when } from "@/components/console/console-ui";

type AuditRow = { id: string; at: Date; actorKind: string; actor: string; action: string; detail: unknown; tenant?: { slug: string } | null };

/** Rows of the platform's audit log, with staff shown by name rather than id. */
export function AuditTable({ rows, names, showWorkspace = true }: { rows: AuditRow[]; names: Map<string, string>; showWorkspace?: boolean }) {
  const head = showWorkspace ? ["When", "Who", "What", "Workspace", "Detail"] : ["When", "Who", "What", "Detail"];
  return (
    <DataTable head={head} empty="Nothing recorded yet.">
      {rows.map((row) => (
        <tr key={row.id}>
          <Cell className="whitespace-nowrap text-muted">{when(row.at)}</Cell>
          <Cell>
            {row.actorKind === "STAFF" ? (names.get(row.actor) ?? row.actor) : row.actor}
            <span className="ml-1 text-xs text-muted">{row.actorKind.toLowerCase()}</span>
          </Cell>
          <Cell className="font-mono text-xs">{row.action}</Cell>
          {showWorkspace && (
            <Cell>
              {row.tenant ? (
                <Link href={`/workspaces/${row.tenant.slug}`} className="text-brand hover:underline">
                  {row.tenant.slug}
                </Link>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Cell>
          )}
          <Cell className="max-w-[320px] break-words font-mono text-xs text-muted">{row.detail ? JSON.stringify(row.detail) : ""}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}
