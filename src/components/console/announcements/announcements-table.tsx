"use client";

import { useState } from "react";
import { consoleArchiveAnnouncement, consoleEndAnnouncement } from "@/actions/platform/console-announcements";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { LabelPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { dayMonth, dayMonthYear, istDayKey, plural, when } from "@/lib/console-shared/format";
import { ANNOUNCEMENT_TONE } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import { formatIstTime } from "@/lib/india-time";
import type { AnnouncementListRow } from "@/lib/platform/announcements";

/**
 * The announcements list (spec §3.8): one tab's rows — what each says, how loud it is, who it is for
 * and how many open workspaces that is, and when it shows. The page picks the tab and hands over its
 * rows; this draws them, and for managers the ⋮ menu: Edit, End now (live only), Duplicate, Archive.
 *
 * Ending and archiving are T1 confirmations. Both take effect on this server at once and on the
 * others within a minute (each keeps a minute-long copy of what is live), and the dialogs say so.
 */

type Pending = { kind: "end" | "archive"; row: AnnouncementListRow };

/** "IN, AE, US +2" — the first few, then how many more. */
function listed(items: readonly string[], max = 3): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max}`;
}

/** Who it is for, in the words of the list: "All workspaces", "IN, AE", "Plan: crm-starter", "5 workspaces". */
function audienceText(row: AnnouncementListRow): string {
  switch (row.audience) {
    case "ALL":
      return "All workspaces";
    case "COUNTRIES":
      return row.targets.length ? listed(row.targets) : "No countries";
    case "PLANS":
      return row.targets.length ? `${row.targets.length === 1 ? "Plan" : "Plans"}: ${listed(row.targets, 2)}` : "No plans";
    case "TENANTS":
      return plural(row.targets.length, "workspace");
  }
}

/**
 * "28 Sep, 10:00 am → 6:00 pm" (India time). Rows that are still to come or showing are near enough
 * that the year goes without saying; ended and archived ones keep it, since they may be last year's.
 */
function windowText(row: AnnouncementListRow): string {
  const withYear = row.state === "ended" || row.state === "archived";
  const stamp = (at: Date) => `${withYear ? dayMonthYear(at) : dayMonth(at)}, ${formatIstTime(at)}`;
  const start = stamp(row.startsAt);
  if (!row.endsAt) return `${start} → no end`;
  const end = istDayKey(row.startsAt) === istDayKey(row.endsAt) ? formatIstTime(row.endsAt) : stamp(row.endsAt);
  return `${start} → ${end}`;
}

function windowTitle(row: AnnouncementListRow): string {
  return `${when(row.startsAt)} to ${row.endsAt ? when(row.endsAt) : "no end"} (IST)`;
}

/** The consequence sentence for each confirmation — one line, as T1 asks. */
function consequence({ kind, row }: Pending): string {
  const showing = row.state === "live" ? `It stops showing in ${plural(row.reach, "open workspace")}` : null;
  if (kind === "end") return `${showing ?? "It stops showing"} and moves to Ended. Other servers pick it up within a minute.`;
  if (row.state === "live") return `${showing} and moves to Archived, where it can't be edited — duplicate it to use it again. Other servers pick it up within a minute.`;
  if (row.state === "scheduled") return "It will not go up, and moves to Archived, where it can't be edited — duplicate it to use it again.";
  return "It moves to Archived, where it can't be edited — duplicate it to use it again.";
}

export function AnnouncementsTable({ rows, caps }: { rows: AnnouncementListRow[]; caps: Caps }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const action = useConsoleAction<null>();
  const manage = caps.announce;

  function close() {
    setPending(null);
    action.reset();
  }

  function confirm() {
    if (!pending) return;
    const { kind, row } = pending;
    action.run(() => (kind === "end" ? consoleEndAnnouncement(row.id) : consoleArchiveAnnouncement(row.id)), {
      success: kind === "end" ? `“${row.title}” ended.` : `“${row.title}” archived.`,
      onDone: () => setPending(null),
    });
  }

  function menuFor(row: AnnouncementListRow): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    // An archived one can't be edited, and only an owner may save one that goes to every workspace.
    if (row.state !== "archived" && (row.audience !== "ALL" || caps.announceAll)) items.push({ key: "edit", label: "Edit", href: `/announcements/${encodeURIComponent(row.id)}` });
    if (row.state === "live") items.push({ key: "end", label: "End now…", onSelect: () => setPending({ kind: "end", row }) });
    items.push({ key: "duplicate", label: "Duplicate", href: `/announcements/new?from=${encodeURIComponent(row.id)}` });
    if (row.state !== "archived") {
      items.push({ key: "sep-archive", separator: true }, { key: "archive", label: "Archive…", danger: row.state === "live", onSelect: () => setPending({ kind: "archive", row }) });
    }
    return items;
  }

  return (
    <>
      <DataTable caption="Announcements" minWidth={manage ? 1040 : 980}>
        <THead>
          <Th>Title</Th>
          <Th>Tone</Th>
          <Th>Audience</Th>
          <Th>Window (IST)</Th>
          <Th>Dismissible</Th>
          <Th>Created by</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => {
            const upcoming = row.state === "live" || row.state === "scheduled";
            return (
              <Tr key={row.id} interactive>
                <Td className="max-w-[22rem] min-w-[14rem]">
                  <RowLink href={`/announcements/${encodeURIComponent(row.id)}`} className="break-words">
                    {row.title}
                  </RowLink>
                  <p className="mt-0.5 truncate text-xs text-muted">{row.body}</p>
                </Td>
                <Td nowrap>
                  <LabelPill map={ANNOUNCEMENT_TONE} value={row.tone} />
                </Td>
                <Td>
                  <span className="whitespace-nowrap text-text" title={row.audience === "ALL" ? undefined : row.targets.join(", ")}>
                    {audienceText(row)}
                  </span>
                  {/* Reach is counted now — it means something only for what is showing or still to come. */}
                  {upcoming && (
                    <p className="text-xs whitespace-nowrap text-muted tabular-nums" title="Open workspaces it reaches as of now">
                      {row.state === "live" ? `Showing in ${plural(row.reach, "workspace")}` : `${plural(row.reach, "open workspace")} today`}
                    </p>
                  )}
                </Td>
                <Td nowrap>
                  <span title={windowTitle(row)} className="tabular-nums">
                    {windowText(row)}
                  </span>
                  {row.state === "live" && (
                    <p className="text-xs text-muted">
                      {row.endsAt ? (
                        <>
                          Ends <RelativeTime at={row.endsAt} />
                        </>
                      ) : (
                        "Until someone ends it"
                      )}
                    </p>
                  )}
                  {row.state === "scheduled" && (
                    <p className="text-xs text-muted">
                      Starts <RelativeTime at={row.startsAt} />
                    </p>
                  )}
                </Td>
                <Td muted nowrap>
                  <span title={row.tone === "CRITICAL" ? "A critical announcement can't be dismissed" : undefined}>{row.dismissible ? "Yes" : "No"}</span>
                </Td>
                <Td muted>
                  <span className="whitespace-nowrap">{row.createdByName}</span>
                </Td>
                {manage && (
                  <RowActionsCell>
                    <RowMenu label={`Actions for ${row.title}`} items={menuFor(row)} />
                  </RowActionsCell>
                )}
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      {manage && (
        <ConfirmDialog
          open={pending !== null}
          onClose={close}
          title={pending?.kind === "archive" ? "Archive announcement" : "End announcement"}
          confirmLabel={pending?.kind === "archive" ? "Archive" : "End now"}
          tone={pending?.kind === "archive" && pending.row.state === "live" ? "danger" : "primary"}
          pending={action.pending}
          error={action.error}
          onConfirm={confirm}
        >
          {pending && (
            <>
              <p className="font-medium break-words">{pending.row.title}</p>
              <p className="text-muted">{consequence(pending)}</p>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
