"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { consoleReleaseDevice } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyField } from "@/components/console/kit/copy-field";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StatusDot } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { TERMINAL_STATE } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { TerminalRow } from "@/lib/platform/console-data";

/**
 * The Terminals list (spec §3.14): each attendance terminal's serial, the workspace its punches are
 * routed to, and when it last called in — the dot says at a glance whether it is still reporting.
 *
 * Releasing a terminal is for managers, and is the only thing here that changes anything: the serial
 * stops belonging to its workspace, so its punches are refused until a workspace registers it again.
 * Moving a terminal between workspaces is deliberately not offered — the receiving workspace claims it
 * from its own attendance settings, so both sides agree.
 */
export function TerminalsTable({ rows, caps }: { rows: TerminalRow[]; caps: Caps }) {
  const clock = useClock();
  const searchParams = useSearchParams();
  const action = useConsoleAction<null>();
  const [releasing, setReleasing] = useState<TerminalRow | null>(null);
  // Already narrowed to one workspace: "only this workspace's terminals" would lead back here.
  const tenantFilter = searchParams.get("tenant");

  function menuFor(row: TerminalRow): RowMenuItem[] {
    const items: RowMenuItem[] = [{ key: "open", label: "Open workspace", href: `/workspaces/${row.tenant.slug}` }];
    if (tenantFilter !== row.tenant.slug) {
      items.push({ key: "only", label: "Only this workspace's terminals", href: `/devices?tenant=${encodeURIComponent(row.tenant.slug)}` });
    }
    if (caps.manage) {
      items.push(
        { key: "sep-release", separator: true },
        {
          key: "release",
          label: "Release terminal…",
          danger: true,
          onSelect: () => {
            action.reset();
            setReleasing(row);
          },
        },
      );
    }
    return items;
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setReleasing(null);
  }

  function release() {
    const row = releasing;
    if (!row) return;
    action.run(() => consoleReleaseDevice(row.serial), { success: `Terminal ${row.serial} released.`, onDone: () => setReleasing(null) });
  }

  return (
    <>
      <DataTable caption="Terminals">
        <THead>
          <Th>Serial</Th>
          <Th>Workspace</Th>
          <Th>Last seen</Th>
          <Th>Added</Th>
          <Th srOnly>Actions</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const state = TERMINAL_STATE[row.state] ?? { label: String(row.state), tone: "neutral" as const };
            return (
              <Tr key={row.serial} className="hover:bg-surface-sunken">
                <Td>
                  <CopyField value={row.serial} label={`serial ${row.serial}`} />
                </Td>
                <Td>
                  <div className="max-w-[18rem] min-w-40">
                    <Link href={`/workspaces/${row.tenant.slug}`} className="block truncate font-medium text-text hover:text-brand" title={row.tenant.name}>
                      {row.tenant.name}
                    </Link>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted">{row.tenant.slug}</span>
                  </div>
                </Td>
                <Td nowrap>
                  <span className="inline-flex items-center gap-2">
                    <StatusDot tone={state.tone} label={state.label} />
                    {row.lastSeenAt ? <RelativeTime at={row.lastSeenAt} className="text-text" /> : <span className="text-muted">Never seen</span>}
                  </span>
                </Td>
                <Td nowrap muted>
                  <span title={clock.dateTime(row.createdAt)}>{clock.date(row.createdAt)}</span>
                </Td>
                <RowActionsCell>
                  <RowMenu label={`Actions for ${row.serial}`} items={menuFor(row)} />
                </RowActionsCell>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      {caps.manage && (
        <ConfirmDialog
          open={releasing !== null}
          onClose={close}
          title="Release terminal"
          confirmLabel="Release terminal"
          tone="danger"
          pending={action.pending}
          error={action.error}
          onConfirm={release}
        >
          {releasing && (
            <p>
              <span className="font-mono text-[13px] break-all">{releasing.serial}</span> stops reporting to{" "}
              <strong className="font-medium">{releasing.tenant.name}</strong>. Its punches are refused until a workspace registers it again.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
