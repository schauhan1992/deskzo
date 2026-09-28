import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import type { SupportTenantRow } from "@/lib/support/types";
import { SupportPriorityPill, SupportStatusPill } from "./badges";

/**
 * Workspace 360 › Support: what this workspace's people asked for with Contact Support, newest
 * first, each a link to the request in the Support inbox. Rendered only for the staff who may open
 * the inbox. Server-safe.
 */
export function TenantSupportRequests({ slug, rows }: { slug: string; rows: SupportTenantRow[] }) {
  return (
    <Panel
      id="support-requests"
      title="Support requests"
      description="Sent from this workspace with Contact Support, newest first."
      padded={false}
      footer={
        rows.length > 0 ? (
          <Link href={`/support?workspace=${encodeURIComponent(slug)}&status=all`} className="font-medium text-brand hover:underline">
            All of them in the Support inbox<span aria-hidden="true"> →</span>
          </Link>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={<LifeBuoy className="h-5 w-5" />} title="No support requests" body="Nobody in this workspace has pressed Contact Support yet." />
      ) : (
        <DataTable caption="This workspace's support requests" minWidth={720}>
          <THead>
            <Th>Request</Th>
            <Th>Status</Th>
            <Th>Priority</Th>
            <Th>From</Th>
            <Th>Sent</Th>
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
                </Td>
                <Td nowrap>
                  <SupportStatusPill status={row.status} />
                </Td>
                <Td nowrap>
                  <SupportPriorityPill priority={row.priority} />
                </Td>
                <Td nowrap muted>
                  {row.requesterName}
                </Td>
                <Td nowrap muted>
                  <RelativeTime at={row.createdAt} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </DataTable>
      )}
    </Panel>
  );
}
