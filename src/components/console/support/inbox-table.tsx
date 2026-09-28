import Link from "next/link";
import { Paperclip, Video } from "lucide-react";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { plural } from "@/lib/console-shared/format";
import type { SupportListRow } from "@/lib/support/types";
import { SupportPriorityPill, SupportStatusPill } from "./badges";

/**
 * The Support inbox's table: one row per request, the whole row a link to it. The loader has
 * already put the most critical and then the oldest first, so the table does no sorting of its own.
 *
 * What a customer wrote is shown as text only — the subject is a text node, cut visually with
 * `truncate` and given in full in the title.
 */
export function SupportInboxTable({ rows }: { rows: SupportListRow[] }) {
  return (
    <DataTable caption="Support requests" minWidth={960}>
      <THead>
        <Th>Request</Th>
        <Th>Workspace</Th>
        <Th>Priority</Th>
        <Th>Status</Th>
        <Th>Assignee</Th>
        <Th>Age</Th>
        <Th>Last activity</Th>
      </THead>
      <TBody>
        {rows.map((row) => (
          <Tr key={row.id} interactive>
            <Td className="max-w-md">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-mono text-xs text-muted">{row.ref}</span>
                <RowLink href={`/support/${row.number}`} className="min-w-0 truncate">
                  <span title={row.subject}>{row.subject}</span>
                </RowLink>
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                <span className="min-w-0 truncate" title={row.requesterEmail}>{`${row.requesterName} · ${row.requesterEmail}`}</span>
                {row.attachments > 0 && (
                  <span className="inline-flex items-center gap-1 text-subtle" title={plural(row.attachments, "attachment")}>
                    {row.hasRecording ? <Video aria-hidden="true" className="h-3.5 w-3.5" /> : <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />}
                    <span className="tabular-nums">{row.attachments}</span>
                    <span className="sr-only">{row.hasRecording ? " attachments, including a screen recording" : " attachments"}</span>
                  </span>
                )}
              </div>
            </Td>
            <Td>
              <Link href={`/workspaces/${encodeURIComponent(row.workspace.slug)}`} className="block max-w-56 truncate text-text hover:text-brand" title={row.workspace.name}>
                {row.workspace.name}
              </Link>
              <span className="font-mono text-[11px] text-subtle">{row.workspace.slug}</span>
            </Td>
            <Td nowrap>
              <SupportPriorityPill priority={row.priority} />
            </Td>
            <Td nowrap>
              <SupportStatusPill status={row.status} />
            </Td>
            <Td nowrap muted={!row.assignee}>
              {row.assignee ? row.assignee.name : "Unassigned"}
            </Td>
            <Td nowrap muted>
              <RelativeTime at={row.createdAt} />
            </Td>
            <Td nowrap muted>
              <RelativeTime at={row.lastActivityAt} />
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
