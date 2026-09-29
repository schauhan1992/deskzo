"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink, EyeOff, TriangleAlert } from "lucide-react";
import { cmsDeleteRedirect, cmsUpdateRedirect } from "@/actions/cms/redirects";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { RedirectDialog, STATUS_LABELS } from "@/components/cms/redirects/redirect-dialog";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/console-shared/format";
import type { RedirectRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";

/**
 * The redirect list: each old address, where it goes, how, how often it has been used and when last,
 * whether it was made automatically, whether it hides a page or post that is live, and — when a
 * visitor would pass through two or three redirects in a row — the flag to point it straight at the end. Editors and admins change, switch off and
 * delete from each row's menu; another site's redirect is an admin's to change (an editor may switch
 * it off, and change its note).
 */

type Pending = { kind: "edit"; row: RedirectRow; to?: string } | { kind: "delete"; row: RedirectRow };

export function RedirectsTable({ rows, admin, siteOrigin, used }: { rows: RedirectRow[]; admin: boolean; siteOrigin: string; used: number }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const toggle = useCmsAction<RedirectRow>();
  const siteHost = new URL(siteOrigin).host;

  function menuFor(row: RedirectRow): RowMenuItem[] {
    const mayChange = admin || !row.external;
    return [
      { key: "edit", label: mayChange ? "Edit…" : "Edit the note…", onSelect: () => setPending({ kind: "edit", row }) },
      row.enabled
        ? { key: "off", label: "Switch off", onSelect: () => toggle.run(() => cmsUpdateRedirect(row.id, { enabled: false }), { success: `Switched off ${row.fromPath}.` }) }
        : mayChange
          ? { key: "on", label: "Switch on", onSelect: () => toggle.run(() => cmsUpdateRedirect(row.id, { enabled: true }), { success: `Switched on ${row.fromPath}.` }) }
          : { key: "on", label: "Switch on (an admin's to do)", disabled: true },
      ...(row.enabled && row.match === "EXACT" ? [{ key: "try", label: "Try it on the site", href: `${siteOrigin}${row.fromPath}`, external: true }] : []),
      { key: "sep", separator: true },
      { key: "delete", label: "Delete…", danger: true, onSelect: () => setPending({ kind: "delete", row }) },
    ];
  }

  return (
    <>
      {toggle.error && (
        <p role="alert" className="border-b border-line bg-danger-bg px-5 py-2 text-xs text-danger">
          {toggle.error}
        </p>
      )}
      <DataTable caption="Redirects" minWidth={940}>
        <THead>
          <Th>Old address</Th>
          <Th>Goes to</Th>
          <Th>Status</Th>
          <Th numeric>Hits</Th>
          <Th>Last hit</Th>
          <Th srOnly>Actions</Th>
        </THead>
        <TBody>
          {rows.map((row) => (
            <Tr key={row.id} className={cn(!row.enabled && "bg-surface-sunken/60")}>
              <Td className="align-top">
                <p className={cn("font-mono text-[13px] break-all", row.enabled ? "text-text" : "text-muted line-through decoration-subtle")}>{row.fromPath}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {!row.enabled && <StatusPill tone="neutral">Switched off</StatusPill>}
                  {row.match === "PREFIX" && (
                    <StatusPill tone="neutral" title="This address and everything under it">
                      Everything under it
                    </StatusPill>
                  )}
                  {row.automatic && (
                    <StatusPill tone="info" title="Made when a page's, post's, category's or tag's address changed">
                      Created automatically
                    </StatusPill>
                  )}
                  {!!row.hides && (
                    <StatusPill tone="warning" icon={<EyeOff className="h-3 w-3" />} title="Pages or posts on the site at this address can't be reached while it is on, and are left out of the sitemap">
                      {`Hides ${plural(row.hides, "live page")}`}
                    </StatusPill>
                  )}
                </div>
                {row.note && <p className="mt-1 line-clamp-2 max-w-xs text-xs text-muted">{row.note}</p>}
              </Td>
              <Td className="align-top">
                <p className="flex items-start gap-1 font-mono text-[13px] break-all text-text">
                  <ArrowRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                  <span>{row.toUrl}</span>
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {row.external && (
                    <StatusPill tone="warning" icon={<ExternalLink className="h-3 w-3" />} title="Only admins create or change redirects to another site">
                      Another site
                    </StatusPill>
                  )}
                </div>
                {row.chain && (
                  <div className={cn("mt-1.5 flex max-w-sm items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs", row.chain.loop ? "border-danger/40 bg-danger-bg text-danger" : "border-warning/40 bg-warning-bg text-warning")}>
                    <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0">
                      {row.chain.loop ? (
                        <p>{`A loop: ${row.chain.through.join(" → ")}. Change or switch off one of them.`}</p>
                      ) : (
                        <>
                          <p className="break-all">
                            {`A chain of ${row.chain.hops}: ${[...row.chain.through, row.chain.final].join(" → ")}.`} Point it straight at <span className="font-mono">{row.chain.final}</span>.
                          </p>
                          {(admin || !row.external) && (
                            <Button type="button" variant="ghost" size="sm" className="-ml-2 h-7 text-warning" onClick={() => setPending({ kind: "edit", row, to: row.chain!.final })}>
                              <span>Point it straight at {row.chain.final}…</span>
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </Td>
              <Td nowrap className="align-top" muted>
                <span title={STATUS_LABELS[row.status].long}>{STATUS_LABELS[row.status].short}</span>
              </Td>
              <Td numeric className="align-top">
                {row.hits.toLocaleString("en-IN")}
              </Td>
              <Td muted nowrap className="align-top">
                {row.lastHitAt ? <RelativeTime at={row.lastHitAt} /> : <span className="text-subtle">Never</span>}
                <span className="block text-[11px] text-subtle">
                  Changed <RelativeTime at={row.updatedAt} />
                </span>
              </Td>
              <RowActionsCell>
                <RowMenu label={`Actions for the redirect from ${row.fromPath}`} items={menuFor(row)} />
              </RowActionsCell>
            </Tr>
          ))}
        </TBody>
      </DataTable>

      {pending?.kind === "edit" && (
        <RedirectDialog row={pending.row} admin={admin} siteHost={siteHost} used={used} preset={pending.to ? { to: pending.to } : undefined} onClose={() => setPending(null)} />
      )}
      {pending?.kind === "delete" && <DeleteRedirectDialog row={pending.row} onClose={() => setPending(null)} />}
    </>
  );
}

function DeleteRedirectDialog({ row, onClose }: { row: RedirectRow; onClose: () => void }) {
  const action = useCmsAction<null>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Delete this redirect"
      tone="danger"
      confirmLabel="Delete redirect"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsDeleteRedirect(row.id), { success: `Deleted the redirect from ${row.fromPath}.`, onDone: onClose })}
    >
      <p>
        <span className="font-mono break-all">{row.fromPath}</span> stops sending visitors to <span className="font-mono break-all">{row.toUrl}</span>
        {row.hits > 0 ? ` — it has been used ${plural(row.hits, "time")}` : ""}. Links to the old address then find nothing, unless a page is there.
      </p>
      <p className="text-xs text-muted">To keep it for later, switch it off instead.</p>
    </ConfirmDialog>
  );
}
