import { Archive } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Disclosure } from "@/components/ui/disclosure";
import { plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import { consoleClock } from "@/lib/platform/console-clock";
import type { ClosedWorkspace } from "@/lib/platform/workspace-directory";
import type { Clock } from "@/lib/time/zone";

/**
 * The directory's Closed view (/workspaces?view=closed): who closed each workspace and when, the
 * final backup taken on the way out, and where it stands with the days its keys are kept. Purging
 * is never a console action — it is a command run on the server once the date has passed — so the
 * page shows the countdown and says how, and offers nothing to click. Days on the console's clock.
 */

/** "in 12 days", "Due now", "Purged" — the one column an operator scans this list for. */
function purgeState(row: ClosedWorkspace, clock: Clock): { label: string; tone: Tone; title?: string } {
  if (row.purgedAt) return { label: "Purged", tone: "neutral", title: `Purged ${clock.dateTime(row.purgedAt)}` };
  if (row.daysLeft <= 0) return { label: "Due now", tone: "warning", title: `Due since ${clock.date(row.purgeDueAt)}` };
  return { label: `in ${plural(row.daysLeft, "day")}`, tone: row.daysLeft <= 7 ? "info" : "neutral", title: `Due ${clock.date(row.purgeDueAt)}` };
}

export async function ClosedTable({ rows }: { rows: ClosedWorkspace[] }) {
  const footer = (
    <Disclosure summary="Purging runs on the server">
      Nothing in the console deletes a closed workspace. Once its purge date has passed, run{" "}
      <code className="font-mono text-xs text-text">npm run platform:tenant -- purge &lt;slug&gt;</code> on the server — it removes the final
      backups and the keys, and cannot be undone.
    </Disclosure>
  );

  if (rows.length === 0) {
    return (
      <Panel padded={false} footer={footer}>
        <EmptyState
          icon={<Archive className="h-5 w-5" />}
          title="No closed workspaces."
          body="A workspace closed from its page is listed here, with its final backup, until it is purged."
        />
      </Panel>
    );
  }

  const clock = await consoleClock();
  return (
    <Panel padded={false} footer={footer}>
      <DataTable caption="Closed workspaces" minWidth={880}>
        <THead>
          <Th>Workspace</Th>
          <Th>Closed on</Th>
          <Th>Closed by</Th>
          <Th>Final backup</Th>
          <Th>Keys kept until</Th>
          <Th>Purge due</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const purge = purgeState(row, clock);
            return (
              <Tr key={row.id} interactive>
                <Td>
                  <RowLink href={`/workspaces/${row.slug}`}>{row.name}</RowLink>
                  <div className="font-mono text-xs text-muted">{row.slug}</div>
                </Td>
                <Td muted nowrap>
                  <span title={clock.dateTime(row.deprovisionedAt)}>{clock.date(row.deprovisionedAt)}</span>
                </Td>
                <Td muted>{row.closedBy ?? "—"}</Td>
                <Td>
                  {row.backup ? (
                    <span className="font-mono text-xs break-all text-text">{row.backup}</span>
                  ) : (
                    <span className="text-xs text-subtle">None taken</span>
                  )}
                </Td>
                <Td muted nowrap>
                  {row.keysKept && !row.purgedAt ? clock.date(row.purgeDueAt) : <span className="text-xs text-subtle">Not kept</span>}
                </Td>
                <Td nowrap>
                  <StatusPill tone={purge.tone} title={purge.title}>
                    {purge.label}
                  </StatusPill>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>
    </Panel>
  );
}
