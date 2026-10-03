"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { consoleEndInvite } from "@/actions/platform/console";
import { consoleExtendInvite } from "@/actions/platform/console-admin";
import { Meter } from "@/components/console/charts/meter";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { Input, Label } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import { INVITE_STATE } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { InviteRow } from "@/lib/platform/console-data";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

/**
 * The invitations list (spec §3.7): who each is for, the plan it starts a workspace on, how much of
 * it is used, whether it still works, and the workspaces made with it. The code itself is never here
 * — only its hash is stored, and the code was shown once, when it was made.
 *
 * Managers may end a live invitation or give one more days (both T1). An invitation that is used up,
 * or was ended, cannot be brought back — the server refuses, so the menu does not offer it.
 *
 * An invitation may hold an address for its customer: nobody else may take it while the invitation
 * is live. Ending it lets the address go; one that is used up or has lapsed no longer holds it either.
 */

const DAY_MS = 86_400_000;
const WORKSPACES_SHOWN = 3;
const EXTEND_DAYS = { min: 1, max: 90, start: "14" };

type Pending = { kind: "end"; row: InviteRow } | { kind: "extend"; row: InviteRow } | null;

/** What a row is called in labels and confirmations: its note, or when it was made (the console's day). */
const nameOf = (row: InviteRow, clock: Clock) => row.note?.trim() || `the invitation made ${clock.date(row.createdAt)}`;

export function InvitesTable({ rows, caps }: { rows: InviteRow[]; caps: Caps }) {
  const clock = useClock();
  const [pending, setPending] = useState<Pending>(null);
  const manage = caps.manage;

  function menuFor(row: InviteRow): RowMenuItem[] {
    const menu: RowMenuItem[] = [];
    // The server extends a live or lapsed invitation that has an end date; never a used-up or ended one.
    if ((row.state === "live" || row.state === "expired") && row.expiresAt) {
      menu.push({ key: "extend", label: "Extend…", onSelect: () => setPending({ kind: "extend", row }) });
    }
    if (row.state === "live") menu.push({ key: "end", label: "End invitation", danger: true, onSelect: () => setPending({ kind: "end", row }) });
    return menu;
  }

  return (
    <>
      <DataTable caption="Invitations" minWidth={manage ? 1240 : 1200}>
        <THead>
          <Th>For</Th>
          <Th>Holds address</Th>
          <Th>Plan</Th>
          <Th>Uses</Th>
          <Th>Status</Th>
          <Th>Valid until</Th>
          <Th>Created by</Th>
          <Th>Created</Th>
          <Th>Workspaces</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => {
            const usedUp = row.uses >= row.maxUses;
            const over = row.state !== "live";
            return (
              <Tr key={row.codeHash}>
                <Td>
                  {row.note ? (
                    <span className="block max-w-[18rem] min-w-32 truncate font-medium text-text" title={row.note}>
                      {row.note}
                    </span>
                  ) : (
                    <span className="text-subtle">No note</span>
                  )}
                </Td>
                <Td nowrap>
                  <HeldAddress row={row} />
                </Td>
                <Td nowrap>
                  {row.planName ?? (row.planKey ? <span className="font-mono text-xs text-muted">{row.planKey}</span> : <span className="text-muted">Default plan</span>)}
                </Td>
                <Td nowrap>
                  <div className="flex items-center gap-2">
                    <span className="text-text tabular-nums">
                      {row.uses} of {row.maxUses}
                    </span>
                    <Meter value={row.uses} max={row.maxUses} label={`Uses of ${nameOf(row, clock)}`} size="sm" tone={usedUp ? "muted" : "brand"} />
                  </div>
                </Td>
                <Td nowrap>
                  <LabelPill map={INVITE_STATE} value={row.state} />
                </Td>
                <Td muted nowrap>
                  {row.expiresAt ? <RelativeTime at={row.expiresAt} className={cn(over && "text-subtle")} /> : "No end date"}
                </Td>
                <Td muted nowrap>
                  {row.createdByName ?? "—"}
                </Td>
                <Td muted nowrap>
                  <RelativeTime at={row.createdAt} absolute="date" />
                </Td>
                <Td>
                  <Workspaces slugs={row.workspaces.map((w) => w.slug)} />
                </Td>
                {manage && (
                  <RowActionsCell>
                    <RowMenu label={`Actions for ${nameOf(row, clock)}`} items={menuFor(row)} />
                  </RowActionsCell>
                )}
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      {manage && (
        <>
          <EndInviteDialog row={pending?.kind === "end" ? pending.row : null} onClose={() => setPending(null)} />
          {/* Keyed by the invitation, so each opening starts from the default length. */}
          {pending?.kind === "extend" && <ExtendInviteDialog key={pending.row.codeHash} row={pending.row} onClose={() => setPending(null)} />}
        </>
      )}
    </>
  );
}

/** The address an invitation holds: held while it is live; after that, kept here only as what it was for. */
function HeldAddress({ row }: { row: InviteRow }): ReactNode {
  if (!row.heldSlug) return <span className="text-subtle">—</span>;
  const live = row.state === "live";
  return (
    <span className="inline-flex flex-col">
      <span className={cn("font-mono text-xs", live ? "text-text" : "text-subtle line-through")} title={live ? "Held for this invitation's customer" : "No longer held"}>
        {row.heldSlug}
      </span>
      <span className="text-[11px] text-muted">{live ? (row.heldSkipsReserved ? "Held · may be reserved" : "Held") : "No longer held"}</span>
    </span>
  );
}

/** How many workspaces were made with it, and the first few by address — each a link to its page. */
function Workspaces({ slugs }: { slugs: string[] }): ReactNode {
  if (slugs.length === 0) return <span className="text-subtle">—</span>;
  const shown = slugs.slice(0, WORKSPACES_SHOWN);
  const more = slugs.length - shown.length;
  return (
    <div className="flex max-w-[16rem] flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="text-text tabular-nums">{slugs.length}</span>
      <ul aria-label="Workspaces made with it" className="contents">
        {shown.map((slug) => (
          <li key={slug} className="inline-flex">
            <Link href={`/workspaces/${slug}`} className="font-mono text-xs text-brand hover:underline">
              {slug}
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <span className="text-[11px] text-subtle tabular-nums" title={slugs.slice(WORKSPACES_SHOWN).join(", ")}>
          +{more}
        </span>
      )}
    </div>
  );
}

/** End a live invitation (T1): its code stops working now. */
function EndInviteDialog({ row, onClose }: { row: InviteRow | null; onClose: () => void }) {
  const clock = useClock();
  const action = useConsoleAction<null>();

  function close() {
    if (action.pending) return;
    action.reset();
    onClose();
  }

  return (
    <ConfirmDialog
      open={row !== null}
      onClose={close}
      title="End invitation"
      confirmLabel="End invitation"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => {
        if (row) action.run(() => consoleEndInvite(row.codeHash), { success: "Invitation ended — its code no longer works.", onDone: onClose });
      }}
    >
      {row && (
        <p>
          The code for <strong className="font-medium">{nameOf(row, clock)}</strong> stops working now
          {row.uses > 0 ? `. The ${plural(row.uses, "workspace")} already made with it ${row.uses === 1 ? "is" : "are"} not affected.` : "."}
          {row.heldSlug ? <> The address it holds, <span className="font-mono">{row.heldSlug}</span>, is let go: anybody may have it again.</> : null}
        </p>
      )}
    </ConfirmDialog>
  );
}

/**
 * More days for an invitation (T1): from its end while it is live, or from now once it has lapsed.
 * The new end is worked out from the row, never from the reader's clock.
 */
function ExtendInviteDialog({ row, onClose }: { row: InviteRow; onClose: () => void }) {
  const clock = useClock();
  const id = useId();
  const action = useConsoleAction<{ expiresAt: string }>();
  const [days, setDays] = useState(EXTEND_DAYS.start);
  const n = /^\d{1,2}$/.test(days.trim()) ? Number(days.trim()) : NaN;
  const valid = Number.isInteger(n) && n >= EXTEND_DAYS.min && n <= EXTEND_DAYS.max;
  const live = row.state === "live" && row.expiresAt !== null;

  function close() {
    if (!action.pending) onClose();
  }

  const daysId = `${id}-days`;
  const hintId = `${id}-hint`;

  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Extend invitation"
      confirmLabel={valid ? `Extend by ${plural(n, "day")}` : "Extend"}
      pending={action.pending}
      error={action.error}
      confirmDisabled={!valid}
      onConfirm={() =>
        action.run(() => consoleExtendInvite(row.codeHash, n), {
          success: (data) => `Invitation extended — it now works until ${clock.date(data.expiresAt)}.`,
          onDone: onClose,
        })
      }
    >
      <p>
        The code for <strong className="font-medium">{nameOf(row, clock)}</strong> works for longer —{" "}
        {live ? "counted from its current end." : "counted from now, since it has lapsed."}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={daysId}>Extend by (days)</Label>
        <Input
          id={daysId}
          type="number"
          inputMode="numeric"
          min={EXTEND_DAYS.min}
          max={EXTEND_DAYS.max}
          step={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-invalid={!valid || undefined}
          aria-describedby={hintId}
          readOnly={action.pending}
          className="w-32"
        />
        <p id={hintId} className={cn("text-xs", valid ? "text-muted" : "text-danger")}>
          {valid ? `From ${EXTEND_DAYS.min} to ${EXTEND_DAYS.max} days.` : `A whole number from ${EXTEND_DAYS.min} to ${EXTEND_DAYS.max}.`}
        </p>
      </div>
      <ImpactList
        items={[
          { label: live ? "Works until" : "Lapsed", value: clock.date(row.expiresAt) },
          {
            label: "Will work until",
            value: !valid ? "—" : live && row.expiresAt ? clock.date(new Date(new Date(row.expiresAt).getTime() + n * DAY_MS)) : `${plural(n, "day")} from now`,
            tone: valid ? "success" : undefined,
          },
          { label: "Uses left", value: `${Math.max(0, row.maxUses - row.uses)} of ${row.maxUses}` },
        ]}
      />
    </ConfirmDialog>
  );
}
