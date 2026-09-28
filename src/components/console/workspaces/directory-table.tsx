"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { CalendarPlus, LifeBuoy, ReceiptText, ShieldCheck, Tag, Tags } from "lucide-react";
import { consoleApplyStanding, consoleMigrateWorkspace } from "@/actions/platform/console";
import { consoleExportWorkspaces, consoleExtendTrial } from "@/actions/platform/console-directory";
import { Meter } from "@/components/console/charts/meter";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ExportCsvButton } from "@/components/console/kit/export-button";
import { ImpactList } from "@/components/console/kit/impact";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StandingPill, StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, SortTh, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { dayMonthYear, plural, when } from "@/lib/console-shared/format";
import { grantLabel, schemaStatus } from "@/lib/console-shared/labels";
import type { DirectorySort } from "@/lib/console-shared/params";
import type { Caps } from "@/lib/console-shared/roles";
import type { DirectoryRow } from "@/lib/platform/workspace-directory";
import { BulkStandingDialog, BulkTagDialog, BulkTrialDialog, type BulkRow } from "./bulk-dialogs";

/**
 * The workspace directory's table (spec §3.3): one row per workspace with its health at a glance,
 * the whole row a link to its 360 page, a row menu of what this role may do to it, and — for roles
 * with a bulk action — row selection with the bulk bar.
 *
 * Nothing here decides who may do what; `caps` only chooses what to draw, and every action checks
 * the role again on the server. A control a role cannot use is not drawn at all — not disabled,
 * not hidden in a closed menu.
 *
 * Holding a workspace is not done here: the menu entry (managers only) opens the 360 page with its
 * hold dialog up (`?do=hold`), where the reason and the gateway guard live.
 */

/** Billing rules and trial extensions take at most this many workspaces at a time (BULK_CAPS). */
const BULK_CAP = 50;
const TAG_CAP = 100;
/** Plans named in the cell before "+N". */
const PLANS_SHOWN = 2;
const TAGS_SHOWN = 3;

type RowAction =
  | { kind: "migrate"; row: DirectoryRow }
  | { kind: "standing"; row: DirectoryRow }
  | { kind: "trial"; row: DirectoryRow; days: 7 | 14 | 30 };

type BulkDialog = "standing" | "trial" | "tag-add" | "tag-remove" | null;

const LINK_ICON_BUTTON =
  "inline-grid h-7 w-7 shrink-0 place-items-center rounded-base text-subtle transition-colors duration-150 hover:bg-surface-sunken hover:text-brand active:scale-95";

export function DirectoryTable({
  rows,
  caps,
  asOf,
  sortHrefs,
  sort,
  exportParams,
}: {
  rows: DirectoryRow[];
  caps: Caps;
  asOf: Date;
  sortHrefs: Record<string, string>;
  sort: DirectorySort;
  exportParams: Record<string, string>;
}) {
  const selection = useRowSelection(rows);
  const { show } = useConsoleNotice();
  const action = useConsoleAction<unknown>();
  const [pendingAction, setPendingAction] = useState<RowAction | null>(null);
  const [bulk, setBulk] = useState<BulkDialog>(null);

  // Only roles with at least one bulk action get the selection column at all.
  const canBulk = caps.exportWorkspaces || caps.manage || caps.sell || caps.write;
  const selected = rows.filter((r) => selection.isSelected(r.id));
  const bulkRows: BulkRow[] = selected.map((r) => ({ id: r.id, slug: r.slug, name: r.name, tags: r.tags }));
  const pageTags = [...new Set(rows.flatMap((r) => r.tags))];
  const overCap = selection.count > BULK_CAP;

  function copyAddress(row: DirectoryRow) {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      show("error", `Couldn't copy — the address is ${row.url}`);
      return;
    }
    clipboard.writeText(row.url).then(
      () => show("success", `Copied ${row.host}.`),
      () => show("error", `Couldn't copy — the address is ${row.url}`),
    );
  }

  function closeRowAction() {
    if (action.pending) return;
    setPendingAction(null);
    action.reset();
  }

  function confirmRowAction() {
    const current = pendingAction;
    if (!current) return;
    const { row } = current;
    const done = { onDone: () => setPendingAction(null) };
    if (current.kind === "migrate") {
      action.run(() => consoleMigrateWorkspace(row.slug), { ...done, success: `${row.name} is on the latest schema.` });
    } else if (current.kind === "standing") {
      action.run(() => consoleApplyStanding(row.id), {
        ...done,
        success: (outcome) =>
          outcome === "held"
            ? `${row.name} is now held for billing.`
            : outcome === "lifted"
              ? `${row.name}'s billing hold is lifted.`
              : outcome === "closed"
                ? `${row.name} has been closed.`
                : `Nothing to change — ${row.name} already stands where its billing says.`,
      });
    } else {
      action.run(() => consoleExtendTrial(row.id, current.days), {
        ...done,
        success: (data) => {
          const d = data as { endsAt?: string; action?: string } | null;
          const end = d?.endsAt ? ` to ${dayMonthYear(d.endsAt)}` : "";
          return `${row.name}'s trial is extended${end}${d?.action === "lifted" ? " and its hold lifted" : ""}.`;
        },
      });
    }
  }

  function menuFor(row: DirectoryRow): RowMenuItem[] {
    const items: RowMenuItem[] = [{ key: "copy", label: "Copy address", onSelect: () => copyAddress(row) }];
    if (row.status !== "PROVISIONING") items.push({ key: "open", label: "Open workspace", href: row.url, external: true });
    if (caps.manage) {
      items.push({ key: "sep-manage", separator: true });
      if (row.schemaBehind) items.push({ key: "migrate", label: "Migrate now", onSelect: () => setPendingAction({ kind: "migrate", row }) });
      // The installation's own workspace is never touched by billing.
      if (!row.isDefault) items.push({ key: "standing", label: "Apply billing rules", onSelect: () => setPendingAction({ kind: "standing", row }) });
      // Open, or held for billing (a staff hold replaces it): the two a hold can be placed on.
      if (row.status === "ACTIVE" || (row.status === "SUSPENDED" && row.suspendedFor === "BILLING")) {
        items.push({ key: "hold", label: "Hold workspace…", href: `/workspaces/${row.slug}?do=hold` });
      }
    }
    if (caps.sell && (row.standing.kind === "trial" || row.standing.kind === "trial-over")) {
      items.push({ key: "sep-trial", separator: true }, { key: "trial-heading", heading: "Extend trial" });
      for (const days of [7, 14, 30] as const) {
        items.push({ key: `trial-${days}`, label: `+${days} days`, onSelect: () => setPendingAction({ kind: "trial", row, days }) });
      }
    }
    return items;
  }

  const sortState = {
    name: sort === "name" ? ("asc" as const) : null,
    standing: sort === "standing" ? ("asc" as const) : null,
    seats: sort === "-seats" ? ("desc" as const) : null,
    created: sort === "-created" ? ("desc" as const) : sort === "created" ? ("asc" as const) : null,
  };
  const someSelected = selection.count > 0 && !selection.allSelected;

  return (
    <div>
      {canBulk && selection.count > 0 && (
        // Stays in reach while scrolling a long page; the top bar is h-14.
        <div className="sticky top-16 z-10">
          <BulkBar count={selection.count} onClear={selection.clear}>
            {caps.exportWorkspaces && <ExportCsvButton action={() => consoleExportWorkspaces(exportParams, selection.ids)} label="Export selected" />}
            {caps.manage && (
              <Button type="button" variant="secondary" size="sm" disabled={overCap} onClick={() => setBulk("standing")}>
                <ReceiptText aria-hidden="true" className="h-4 w-4" />
                Apply billing rules
              </Button>
            )}
            {caps.sell && (
              <Button type="button" variant="secondary" size="sm" disabled={overCap} onClick={() => setBulk("trial")}>
                <CalendarPlus aria-hidden="true" className="h-4 w-4" />
                Extend trials +14 days
              </Button>
            )}
            {caps.write && (
              <>
                <Button type="button" variant="secondary" size="sm" disabled={selection.count > TAG_CAP} onClick={() => setBulk("tag-add")}>
                  <Tag aria-hidden="true" className="h-4 w-4" />
                  Add tag
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={selection.count > TAG_CAP} onClick={() => setBulk("tag-remove")}>
                  <Tags aria-hidden="true" className="h-4 w-4" />
                  Remove tag
                </Button>
              </>
            )}
            {overCap && (caps.manage || caps.sell) && (
              <span className="text-xs text-muted">Billing rules and trials take at most {BULK_CAP} workspaces at a time.</span>
            )}
          </BulkBar>
        </div>
      )}

      <Panel padded={false}>
        <DataTable caption="Workspaces" stickyHeader minWidth={canBulk ? 1180 : 1140}>
          <THead>
            {canBulk && (
              <Th className="w-10 pr-0">
                {/* A plain input rather than Checkbox: the header box needs a ref for its "some selected" state. */}
                <input
                  type="checkbox"
                  aria-label="Select every workspace on this page"
                  checked={selection.allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={selection.toggleAll}
                  className="h-4 w-4 cursor-pointer rounded-sm accent-[var(--brand)]"
                />
              </Th>
            )}
            <SortTh label="Workspace" active={sortState.name} href={sortHrefs.name ?? "?sort=name"} />
            <Th>Status</Th>
            <SortTh label="Standing" active={sortState.standing} href={sortHrefs.standing ?? "?sort=standing"} />
            <Th>Plans</Th>
            <SortTh label="Seats" active={sortState.seats} href={sortHrefs.seats ?? "?sort=-seats"} />
            <Th>Country</Th>
            <Th>Schema</Th>
            <Th>Support</Th>
            <SortTh label="Created" active={sortState.created} href={sortHrefs.created ?? "?sort=created"} />
            <Th srOnly>Actions</Th>
          </THead>
          <TBody>
            {rows.map((row) => {
              const isSelected = selection.isSelected(row.id);
              const enter = caps.enter && row.grant !== null && row.status === "ACTIVE";
              return (
                <Tr key={row.id} interactive selected={isSelected}>
                  {canBulk && (
                    <Td className="w-10 pr-0">
                      <Checkbox label={`Select ${row.slug}`} checked={isSelected} onChange={() => selection.toggle(row.id)} />
                    </Td>
                  )}
                  <Td>
                    {/* The width limit sits on a block inside the cell: table layout ignores max-width on a cell. */}
                    <div className="max-w-[18rem] min-w-44">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <RowLink href={`/workspaces/${row.slug}`} className="truncate">
                          {row.name}
                        </RowLink>
                        {row.isDefault && <StatusPill tone="brand">Installation&apos;s own</StatusPill>}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <span className="shrink-0 font-mono">{row.slug}</span>
                        <span aria-hidden="true" className="text-subtle">
                          ·
                        </span>
                        <span className="truncate" title={row.host}>
                          {row.host}
                        </span>
                      </div>
                      {row.tags.length > 0 && <RowTags tags={row.tags} />}
                    </div>
                  </Td>
                  <Td nowrap>
                    <TenantStatusPill status={row.status} suspendedFor={row.suspendedFor} showHeldFor />
                  </Td>
                  <Td nowrap>
                    <StandingPill kind={row.standing.kind} at={row.standing.at} asOf={asOf} />
                  </Td>
                  <Td>
                    <PlanNames plans={row.plans} />
                  </Td>
                  <Td nowrap>
                    {row.seats ? (
                      <Meter value={row.seats.used} max={row.seats.limit} label={`Seats used in ${row.name}`} size="sm" showText />
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <Td muted nowrap className="font-mono text-xs">
                    {row.country}
                  </Td>
                  <Td nowrap>
                    <SchemaCell row={row} />
                  </Td>
                  <Td nowrap>
                    {row.grant ? (
                      <StatusPill
                        tone={grantLabel("live", row.grant.level).tone}
                        icon={<ShieldCheck className="h-3 w-3" />}
                        title={`Support access until ${when(row.grant.expiresAt)}`}
                      >
                        {grantLabel("live", row.grant.level).label}
                      </StatusPill>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <Td muted nowrap>
                    <RelativeTime at={row.createdAt} absolute="date" />
                  </Td>
                  <RowActionsCell>
                    {enter && (
                      <Link
                        href={`/workspaces/${row.slug}?do=enter`}
                        aria-label={`Enter ${row.name} as support`}
                        title={`Enter ${row.name} as support`}
                        className={LINK_ICON_BUTTON}
                      >
                        <LifeBuoy aria-hidden="true" className="h-4 w-4" />
                      </Link>
                    )}
                    <RowMenu label={`Actions for ${row.name}`} items={menuFor(row)} />
                  </RowActionsCell>
                </Tr>
              );
            })}
          </TBody>
        </DataTable>
      </Panel>

      <RowActionDialog
        action={pendingAction}
        asOf={asOf}
        pending={action.pending}
        error={action.error}
        onClose={closeRowAction}
        onConfirm={confirmRowAction}
      />

      {caps.manage && <BulkStandingDialog open={bulk === "standing"} onClose={() => setBulk(null)} rows={bulkRows} onFinished={selection.clear} />}
      {caps.sell && <BulkTrialDialog open={bulk === "trial"} onClose={() => setBulk(null)} rows={bulkRows} onFinished={selection.clear} />}
      {caps.write && (
        <BulkTagDialog
          open={bulk === "tag-add" || bulk === "tag-remove"}
          mode={bulk === "tag-remove" ? "remove" : "add"}
          onClose={() => setBulk(null)}
          rows={bulkRows}
          knownTags={pageTags}
          onFinished={selection.clear}
        />
      )}
    </div>
  );
}

/** "CRM ×2, Sales" and "+1" for the rest, all of them in the title. */
function PlanNames({ plans }: { plans: DirectoryRow["plans"] }) {
  if (plans.length === 0) return <span className="text-subtle">—</span>;
  const named = plans.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name));
  const shown = named.slice(0, PLANS_SHOWN);
  const more = named.length - shown.length;
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1.5" title={named.join(", ")}>
      <span className="truncate text-text">{shown.join(", ")}</span>
      {more > 0 && <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[11px] text-muted tabular-nums">+{more}</span>}
    </span>
  );
}

/** A few of its tags, each a link to the directory filtered by it. */
function RowTags({ tags }: { tags: string[] }) {
  const shown = tags.slice(0, TAGS_SHOWN);
  const more = tags.length - shown.length;
  return (
    <ul aria-label="Tags" className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <li key={tag} className="inline-flex">
          <Link
            href={`/workspaces?tag=${encodeURIComponent(tag)}`}
            className="inline-flex h-[18px] max-w-32 items-center rounded-full border border-line bg-surface-sunken px-1.5 text-[11px] text-muted hover:border-line-strong hover:text-text"
          >
            <span className="truncate">{tag}</span>
          </Link>
        </li>
      ))}
      {more > 0 && (
        <li className="text-[11px] text-subtle tabular-nums" title={tags.slice(TAGS_SHOWN).join(", ")}>
          +{more}
        </li>
      )}
    </ul>
  );
}

/**
 * "Up to date", "Behind 3", or "Behind" for one on a migration this release does not carry. A
 * workspace still being set up, or closed, has no schema worth a pill.
 */
function SchemaCell({ row }: { row: DirectoryRow }) {
  if (row.status === "PROVISIONING" || row.status === "DEPROVISIONED") return <span className="text-subtle">—</span>;
  if (row.schemaBehind && (row.behindBy === null || row.behindBy <= 0)) {
    return (
      <StatusPill tone="warning" title={row.schemaVersion ?? "No migration recorded"}>
        Behind
      </StatusPill>
    );
  }
  const s = schemaStatus(row.schemaVersion, null, row.behindBy);
  return (
    <StatusPill tone={s.tone} title={s.title ?? undefined}>
      {s.label}
    </StatusPill>
  );
}

/** One row's action, confirmed (spec §1.12, T1): the verb as the title, one consequence, Cancel and the verb. */
function RowActionDialog({
  action,
  asOf,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  action: RowAction | null;
  asOf: Date;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const row = action?.row;
  let title = "";
  let confirmLabel = "";
  let body: ReactNode = null;
  if (action?.kind === "migrate" && row) {
    title = "Migrate now";
    confirmLabel = "Migrate now";
    body = (
      <p>
        <strong className="font-medium">{row.name}</strong> is brought to the latest schema now
        {row.behindBy ? ` — ${plural(row.behindBy, "migration")} to apply` : ""}. If a migration fails, the workspace stays held until one succeeds;
        the output is on the Migrations page.
      </p>
    );
  } else if (action?.kind === "standing" && row) {
    title = "Apply billing rules";
    confirmLabel = "Apply billing rules";
    body = (
      <>
        <p>
          <strong className="font-medium">{row.name}</strong>&apos;s billing standing is applied now rather than at the next tick: it may be held,
          have its billing hold lifted, or — with auto-close on — be closed.
        </p>
        <ImpactList items={[{ label: "Standing now", value: <StandingPill kind={row.standing.kind} at={row.standing.at} asOf={asOf} /> }]} />
      </>
    );
  } else if (action?.kind === "trial" && row) {
    title = `Extend trial by ${action.days} days`;
    confirmLabel = `Extend by ${action.days} days`;
    body = (
      <>
        <p>
          <strong className="font-medium">{row.name}</strong>&apos;s trial is extended by {action.days} days from its current end — or from today, if
          it has already ended. If it is held because the trial ran out, it is reopened.
        </p>
        <ImpactList items={[{ label: "Standing now", value: <StandingPill kind={row.standing.kind} at={row.standing.at} asOf={asOf} /> }]} />
      </>
    );
  }

  return (
    <ConfirmDialog
      open={action !== null}
      onClose={onClose}
      title={title}
      confirmLabel={confirmLabel}
      pending={pending}
      error={error}
      onConfirm={onConfirm}
    >
      <div className="space-y-3">{body}</div>
    </ConfirmDialog>
  );
}
