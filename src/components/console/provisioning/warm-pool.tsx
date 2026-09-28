import type { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import type { ChartTone } from "@/components/console/charts/chart-utils";
import { Meter } from "@/components/console/charts/meter";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { plural } from "@/lib/console-shared/format";
import { schemaLabel } from "@/lib/console-shared/labels";
import type { Tone } from "@/lib/console-shared/types";
import type { ProvisioningBoard } from "@/lib/platform/console-data";

/**
 * The warm pool on the Provisioning board (spec §3.12, `/provisioning#warm-pool`): databases the
 * worker makes and migrates ahead of time, so a signup gets one at once instead of waiting for a
 * fresh one. How full it is against its target, the ones ready (and whether each is on the latest
 * schema — a migration run brings the others up), and the last ten taken, with who took them.
 *
 * Server-safe. Topping the pool up is the page header's button, for managers only.
 */

type PoolTone = Extract<Tone, "success" | "warning" | "danger">;

/** A full pool is the healthy state, so it is coloured by how empty it is, not how full. */
function poolTone(ready: number, target: number): PoolTone {
  return ready === 0 ? "danger" : ready < target ? "warning" : "success";
}

function summary(ready: number, target: number): string {
  if (target <= 0) return "The warm pool is off — each signup waits while a fresh database is made.";
  if (ready === 0) return "None ready — the next signup waits while a fresh database is made.";
  if (ready < target) return `${ready.toLocaleString("en-IN")} of ${target.toLocaleString("en-IN")} ready — the worker makes more when it next runs.`;
  return `Full — the worker keeps ${plural(target, "database")} ready.`;
}

function SchemaCell({ version, current }: { version: string | null; current: boolean }) {
  const pill = current ? (
    <StatusPill tone="success" icon={<Check className="h-3 w-3" />}>
      Up to date
    </StatusPill>
  ) : version ? (
    <StatusPill tone="warning" title={version}>
      Behind
    </StatusPill>
  ) : (
    <StatusPill tone="neutral">Unknown</StatusPill>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {pill}
      {version && (
        <span className="text-xs text-muted" title={version}>
          {schemaLabel(version)}
        </span>
      )}
    </span>
  );
}

function SubList({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="border-t border-line">
      <h3 className="flex items-center gap-1.5 px-5 pt-3.5 pb-1.5 text-[13px] font-medium text-text">
        {title}
        <span className="rounded-full bg-surface-sunken px-1.5 text-[11px] text-muted tabular-nums">{count.toLocaleString("en-IN")}</span>
      </h3>
      {children}
    </div>
  );
}

export function WarmPool({ warm }: { warm: ProvisioningBoard["warm"] }) {
  const ready = warm.ready.length;
  const behind = warm.ready.filter((w) => !w.current).length;
  const tone = poolTone(ready, warm.target);
  const meterTone: ChartTone = tone;

  return (
    <Panel
      id="warm-pool"
      title="Warm pool"
      description="Databases made and migrated ahead of time, so a new signup gets one at once"
      actions={
        warm.target > 0 ? (
          <StatusPill tone={tone} dot>
            {`${ready.toLocaleString("en-IN")} of ${warm.target.toLocaleString("en-IN")} ready`}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">Off</StatusPill>
        )
      }
      padded={false}
    >
      <div className="space-y-2 px-5 py-4">
        {warm.target > 0 && <Meter value={ready} max={warm.target} label="Warm databases ready" tone={meterTone} showText />}
        <p className="text-xs text-muted">
          {summary(ready, warm.target)}
          {behind > 0 && ` ${plural(behind, "of them is", "of them are")} on an older schema; the next full migration run brings ${behind === 1 ? "it" : "them"} up to date.`}
        </p>
      </div>

      <SubList title="Ready" count={ready}>
        {ready === 0 ? (
          <p className="px-5 pb-4 text-sm text-muted">None ready right now.</p>
        ) : (
          <DataTable caption="Warm databases ready" minWidth={440}>
            <THead>
              <Th>Database</Th>
              <Th>Schema</Th>
              <Th>Made</Th>
            </THead>
            <TBody>
              {warm.ready.map((w) => (
                <Tr key={w.id}>
                  <Td mono nowrap>
                    {w.dbName}
                  </Td>
                  <Td>
                    <SchemaCell version={w.schemaVersion} current={w.current} />
                  </Td>
                  <Td muted nowrap>
                    <RelativeTime at={w.createdAt} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </SubList>

      <SubList title="Recently taken" count={warm.taken.length}>
        {warm.taken.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-muted">None taken yet — a signup takes the oldest ready database.</p>
        ) : (
          <DataTable caption="Warm databases recently taken" minWidth={440}>
            <THead>
              <Th>Database</Th>
              <Th>Taken</Th>
              <Th>Workspace</Th>
            </THead>
            <TBody>
              {warm.taken.map((w) => (
                <Tr key={w.id}>
                  <Td mono nowrap muted>
                    {w.dbName}
                  </Td>
                  <Td muted nowrap>
                    <RelativeTime at={w.claimedAt} />
                  </Td>
                  <Td nowrap>
                    {w.tenant ? (
                      <Link href={`/workspaces/${encodeURIComponent(w.tenant.slug)}`} className="rounded-base font-mono text-xs font-medium text-brand hover:underline">
                        {w.tenant.slug}
                      </Link>
                    ) : (
                      <span className="text-subtle" title="The workspace that took it has been removed">
                        —
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </SubList>
    </Panel>
  );
}
