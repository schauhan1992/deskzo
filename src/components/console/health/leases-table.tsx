import { LoaderCircle, Timer } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { leaseOutcome } from "@/lib/console-shared/labels";
import type { PlatformLease } from "@/lib/platform/health";
import type { Clock } from "@/lib/time/zone";

/**
 * "Platform leases" on System health (spec §3.11): the platform's own scheduled jobs — the tick,
 * migration runs, the warm pool — each with the process that holds (or last held) its lease, until
 * when, when it last started and finished, and how that ended. A lease is how one process at a time
 * runs a job; one still held past its run is a worker that died mid-run and is taken back when it
 * lapses.
 */

/** The first non-empty line of an error (already redacted by the loader), cut for a table cell. */
function firstLine(text: string | null): string | null {
  const line = text
    ?.split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** `clock` is the console's (`consoleClock()`): the page draws this on the server. */
export function LeasesTable({ rows, clock }: { rows: PlatformLease[]; clock: Clock }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Timer className="h-5 w-5" />}
        title="No platform job has run yet."
        body="The platform tick, migration runs and the warm pool record each run here."
      />
    );
  }
  return (
    <DataTable caption="Platform leases" minWidth={880}>
      <THead>
        <Th>Job</Th>
        <Th>Holder</Th>
        <Th>Leased until</Th>
        <Th>Last started</Th>
        <Th>Last finished</Th>
        <Th>Outcome</Th>
      </THead>
      <TBody>
        {rows.map((row) => {
          const outcome = leaseOutcome(row);
          const error = row.lastOk === false ? firstLine(row.lastError) : null;
          return (
            <Tr key={row.job}>
              <Td>
                <p className="font-medium text-text">{row.label}</p>
                {row.label !== row.job && <p className="font-mono text-[11px] text-subtle">{row.job}</p>}
              </Td>
              <Td mono muted>
                <span className="block max-w-48 truncate" title={row.holder || undefined}>
                  {row.holder || "—"}
                </span>
              </Td>
              <Td nowrap muted>
                {row.runningNow ? (
                  <RelativeTime at={row.leasedUntil} />
                ) : (
                  <span className="text-subtle" title={`The last lease ran out ${clock.dateTime(row.leasedUntil)}`}>
                    Not held
                  </span>
                )}
              </Td>
              <Td nowrap muted>
                {row.lastStartedAt ? <RelativeTime at={row.lastStartedAt} /> : <span className="text-subtle">—</span>}
              </Td>
              <Td nowrap muted>
                {row.lastFinishedAt ? <RelativeTime at={row.lastFinishedAt} /> : <span className="text-subtle">—</span>}
              </Td>
              <Td>
                <StatusPill tone={outcome.tone} icon={row.runningNow ? <LoaderCircle className="h-3 w-3 animate-spin" /> : undefined}>
                  {outcome.label}
                </StatusPill>
                {error && (
                  <p className="mt-1 max-w-72 truncate font-mono text-[11px] text-danger" title={error}>
                    {error}
                  </p>
                )}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
