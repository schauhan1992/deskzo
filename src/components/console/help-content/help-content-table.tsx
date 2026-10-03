"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Pin } from "lucide-react";
import { consoleReorderHelpLinks } from "@/actions/platform/console-help";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { useClock } from "@/components/time/clock-provider";
import { IconButton } from "@/components/ui/icon-button";
import type { Caps } from "@/lib/console-shared/roles";
import { HelpVerbDialog, VERB_LABEL, verbsFor, type HelpVerb, type HelpVerbTarget } from "./help-verb-dialog";
import { HELP_STATE, isEverywhere, linkText, reachLine, targetingText, type HelpListItem, type HelpTab } from "./shared";

/**
 * One tab of Help and What's new: articles or videos in the order workspaces show them, or What's
 * new posts. The page picks the tab and hands over its rows; this draws them and, for managers, the
 * ⋮ menu (Edit, Publish now, Take down, Archive, Restore as draft) and — on the articles and videos —
 * the arrows that move one up or down.
 *
 * A move sends the whole new order (`consoleReorderHelpLinks`), so a list changed by somebody else
 * meanwhile is refused rather than shuffled; drafts and scheduled ones keep their place, and take it
 * in workspaces when they go live.
 */

function targetOf(row: HelpListItem): HelpVerbTarget {
  return { id: row.id, kind: row.kind, title: row.title, state: row.state, publishedAt: row.publishedAt, modules: row.modules, countries: row.countries, reach: row.reach };
}

export function HelpContentTable({ rows, tab, caps, ordering }: { rows: HelpListItem[]; tab: HelpTab; caps: Caps; ordering: boolean }) {
  const clock = useClock();
  // The exact moment on the console's clock, saying which.
  const zoned = (at: Date) => `${clock.dateTime(at)} ${clock.offsetLabel(at)}`;
  const [pending, setPending] = useState<{ verb: HelpVerb; target: HelpVerbTarget } | null>(null);
  const move = useConsoleAction<null>();
  const manage = caps.manage;
  const posts = tab === "updates";
  const canOrder = ordering && manage && !posts && rows.length > 1;

  function moveRow(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const ids = rows.map((r) => r.id);
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    move.run(() => consoleReorderHelpLinks(tab === "videos" ? "VIDEO" : "ARTICLE", ids), { success: "" });
  }

  function menuFor(row: HelpListItem): RowMenuItem[] {
    const items: RowMenuItem[] = [];
    if (row.state !== "archived") items.push({ key: "edit", label: "Edit", href: `/help-content/${encodeURIComponent(row.id)}` });
    for (const verb of verbsFor(row.state)) {
      if (verb === "archive") items.push({ key: "sep-archive", separator: true });
      items.push({ key: verb, label: VERB_LABEL[verb], danger: verb === "archive" && row.state === "live", onSelect: () => setPending({ verb, target: targetOf(row) }) });
    }
    return items;
  }

  return (
    <>
      {move.error && (
        <p role="alert" className="border-b border-line px-5 py-2 text-xs text-danger">
          {move.error}
        </p>
      )}
      <DataTable caption={posts ? "What's new posts" : tab === "videos" ? "Videos" : "Articles"} minWidth={posts ? 980 : 1040}>
        <THead>
          {canOrder && <Th srOnly>Order</Th>}
          <Th>Title</Th>
          {posts && <Th>Pinned</Th>}
          <Th>Status</Th>
          <Th>Shown to</Th>
          <Th>Updated</Th>
          {manage && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row, i) => {
            const reach = reachLine(row.state, row.reach);
            return (
              <Tr key={row.id} interactive>
                {canOrder && (
                  <RowActionsCell>
                    <IconButton icon={ArrowUp} label={`Move “${row.title}” up`} disabled={i === 0 || move.pending} onClick={() => moveRow(i, -1)} className="disabled:opacity-30" />
                    <IconButton icon={ArrowDown} label={`Move “${row.title}” down`} disabled={i === rows.length - 1 || move.pending} onClick={() => moveRow(i, 1)} className="disabled:opacity-30" />
                  </RowActionsCell>
                )}
                <Td className="max-w-[26rem] min-w-[16rem]">
                  <RowLink href={`/help-content/${encodeURIComponent(row.id)}`} className="break-words">
                    {row.title}
                  </RowLink>
                  {!posts && row.url && <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{linkText(row.url)}</p>}
                  {row.text && <p className="mt-0.5 truncate text-xs text-muted">{row.text}</p>}
                </Td>
                {posts && (
                  <Td nowrap>
                    {row.pinned ? (
                      <StatusPill tone="brand" icon={<Pin className="h-3 w-3" />}>
                        Pinned
                      </StatusPill>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                )}
                <Td nowrap>
                  <LabelPill map={HELP_STATE} value={row.state} />
                  {row.state === "scheduled" && row.publishedAt && (
                    <p className="mt-0.5 text-xs text-muted" title={zoned(row.publishedAt)}>
                      Goes live <RelativeTime at={row.publishedAt} />
                    </p>
                  )}
                  {row.state === "live" && row.publishedAt && (
                    <p className="mt-0.5 text-xs text-muted tabular-nums" title={zoned(row.publishedAt)}>
                      Since {clock.date(row.publishedAt)}
                    </p>
                  )}
                </Td>
                <Td>
                  <span
                    className="whitespace-nowrap text-text"
                    title={isEverywhere(row) ? undefined : [...row.modules, ...row.countries].join(", ")}
                  >
                    {targetingText(row.modules, row.countries)}
                  </span>
                  {reach && <p className="text-xs whitespace-nowrap text-muted tabular-nums">{reach}</p>}
                </Td>
                <Td muted>
                  <span className="block whitespace-nowrap">{row.updatedByName}</span>
                  <span className="block text-xs whitespace-nowrap">
                    <RelativeTime at={row.updatedAt} />
                  </span>
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

      {manage && <HelpVerbDialog pending={pending} caps={caps} onClose={() => setPending(null)} />}
    </>
  );
}
