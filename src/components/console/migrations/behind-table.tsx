"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, RotateCcw } from "lucide-react";
import { consoleMigrateWorkspace } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import { runOutcome, schemaLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { BehindRow } from "@/lib/platform/console-data";

/**
 * The workspaces not on the latest schema (spec §3.13): open ones on an older migration, and every one
 * held since a migration failed — those first, since their users see a maintenance page until one
 * succeeds. A full run (`npm run tenants:migrate`, on the server) covers them all; from here a manager
 * migrates one, or retries a held one (T1, `consoleMigrateWorkspace`). Nobody else is shown the button.
 *
 * The migration runs while the dialog waits, so its outcome — the workspace current again, or the
 * first line of why it failed — is known before the dialog closes.
 */

const held = (row: BehindRow) => row.status === "MIGRATING";

function consequence(row: BehindRow): string {
  if (held(row)) {
    return `Runs the workspace migrations on ${row.name}'s database again. It has been held since a migration failed, and opens again as soon as one succeeds.`;
  }
  const behind = row.behindBy && row.behindBy > 0 ? ` — ${plural(row.behindBy, "migration")} to apply` : "";
  return `Brings ${row.name}'s database up to the latest schema now${behind}. If a migration fails, the workspace is held — its users see a maintenance page — until a later run brings it through.`;
}

export function BehindTable({ rows, caps }: { rows: BehindRow[]; caps: Caps }) {
  const router = useRouter();
  const [target, setTarget] = useState<BehindRow | null>(null);
  const action = useConsoleAction<string>();

  function open(row: BehindRow) {
    action.reset();
    setTarget(row);
  }

  function close() {
    if (action.pending) return;
    // A migration that failed has still changed things — its run is recorded and the workspace is
    // held — and a refusal does not refresh the page on its own.
    const failed = action.error !== null;
    action.reset();
    setTarget(null);
    if (failed) router.refresh();
  }

  function confirm() {
    const row = target;
    if (!row) return;
    action.run(() => consoleMigrateWorkspace(row.slug), {
      success: held(row) ? `${row.name} is migrated and open again.` : `${row.name} is on the latest schema.`,
      onDone: () => setTarget(null),
    });
  }

  return (
    <>
      <DataTable caption="Workspaces behind the latest schema" minWidth={caps.manage ? 900 : 800}>
        <THead>
          <Th>Workspace</Th>
          <Th>Status</Th>
          <Th>Its schema</Th>
          <Th numeric>Behind by</Th>
          <Th>Last attempt</Th>
          {caps.manage && <Th srOnly>Migrate</Th>}
        </THead>
        <TBody>
          {rows.map((row) => {
            const last = row.lastAttempt ? runOutcome(row.lastAttempt.ok) : null;
            return (
              <Tr key={row.id} interactive>
                <Td>
                  <div className="max-w-[16rem] min-w-40">
                    <RowLink href={`/workspaces/${encodeURIComponent(row.slug)}`} className="block truncate">
                      {row.name}
                    </RowLink>
                    <p className="truncate font-mono text-[11px] text-subtle">{row.slug}</p>
                  </div>
                </Td>
                <Td nowrap>
                  <TenantStatusPill status={row.status} />
                </Td>
                <Td nowrap>
                  {row.schemaVersion ? (
                    <span title={row.schemaVersion}>{schemaLabel(row.schemaVersion)}</span>
                  ) : (
                    <span className="text-subtle">None recorded</span>
                  )}
                </Td>
                <Td numeric>
                  {row.behindBy === null ? (
                    <span className="text-subtle" title="Its recorded schema is not one this version of the code carries">
                      Unknown
                    </span>
                  ) : row.behindBy > 0 ? (
                    <span className="font-medium text-warning">{plural(row.behindBy, "migration")}</span>
                  ) : (
                    <span className="text-muted">None</span>
                  )}
                </Td>
                <Td nowrap>
                  {row.lastAttempt && last ? (
                    <span className="inline-flex items-center gap-2">
                      <StatusPill tone={last.tone}>{last.label}</StatusPill>
                      <RelativeTime at={row.lastAttempt.at} className="text-xs text-muted" />
                    </span>
                  ) : (
                    <span className="text-subtle">Never</span>
                  )}
                </Td>
                {caps.manage && (
                  <RowActionsCell>
                    <Button type="button" size="sm" variant={held(row) ? "primary" : "secondary"} onClick={() => open(row)} className="h-7 px-2.5">
                      {held(row) ? <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}
                      {held(row) ? "Retry" : "Migrate"}
                      <span className="sr-only">{` ${row.slug}`}</span>
                    </Button>
                  </RowActionsCell>
                )}
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      {caps.manage && (
        <ConfirmDialog
          open={target !== null}
          onClose={close}
          title={target && held(target) ? "Retry migration" : "Migrate workspace"}
          confirmLabel={target && held(target) ? "Retry" : "Migrate"}
          pending={action.pending}
          error={action.error}
          onConfirm={confirm}
        >
          {target && (
            <>
              <p>{consequence(target)}</p>
              <p className="text-xs text-muted">It usually takes under a minute. Keep this open until it finishes — the outcome is shown here.</p>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
