import { History, KeyRound, LifeBuoy } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { InsetBlock, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { when } from "@/lib/console-shared/format";
import { grantLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { SupportPanel, WorkspaceHeader } from "@/lib/platform/workspace-data";
import { EnterAsSupport } from "./enter-as-support";
import { RequestAccess } from "./request-access";

/**
 * Workspace 360 › Support: whether staff may go in now and on whose word, the way in, asking the
 * owner when there is no grant, and the record — every grant its super admin gave, and every time
 * staff went in. Only the workspace's super admin grants access (from its own Security settings);
 * nothing on this page can.
 */

const levelText = (level: string | null) => (level === "ADMIN" ? "Administrator" : level === "READONLY" ? "Read-only" : "—");

/**
 * The live grant (or its absence) with the way in — on the Overview and, the same card, on the
 * Support tab. The grant's reason is printed as visible text: it is what the workspace's admin
 * wrote when letting support in, and the first thing staff should read.
 */
export function SupportAccessCard({ header, support, caps }: { header: WorkspaceHeader; support: SupportPanel; caps: Caps }) {
  const grant = support.grant;
  const open = header.tenant.status === "ACTIVE";
  const live = grant ? grantLabel("live", grant.level) : null;

  return (
    <Panel
      title="Support access"
      description="Staff go into this workspace only on its super admin's grant."
      actions={live ? <StatusPill tone={live.tone} dot>{`${live.label} · live`}</StatusPill> : <StatusPill tone="neutral">Not granted</StatusPill>}
    >
      {grant ? (
        <div className="space-y-4">
          <InsetBlock className="space-y-1.5">
            <p className="text-sm text-text">{`${levelText(grant.level)} access granted by ${grant.grantedByName} until ${when(grant.expiresAt)}`}</p>
            <p className="text-sm break-words text-muted">
              Reason: <span className="text-text">{grant.reason}</span>
            </p>
          </InsetBlock>
          {caps.enter &&
            (open ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <EnterAsSupport tenantId={header.tenant.id} variant="secondary" />
                <p className="text-xs text-muted">A one-time pass to its own address, good for a minute.</p>
              </div>
            ) : (
              <p className="text-xs text-muted">Workspace is not open — support can go in once it is active again.</p>
            ))}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Not granted. Only the workspace&apos;s super admin can grant it, from its Security settings.</p>
          {caps.enter && open && support.ownerEmailKnown && <RequestAccess tenantId={header.tenant.id} lastRequest={support.lastRequest} canRequestAgainAt={support.canRequestAgainAt} />}
          {caps.enter && open && !support.ownerEmailKnown && <p className="text-xs text-muted">Its owner&apos;s email is not on record, so there is nobody to ask from here.</p>}
        </div>
      )}
    </Panel>
  );
}

export function SupportTab({ header, support, caps }: { header: WorkspaceHeader; support: SupportPanel; caps: Caps }) {
  return (
    <div className="space-y-6">
      <SupportAccessCard header={header} support={support} caps={caps} />

      <Panel title="Grants" description="Every grant its super admin gave, newest first." padded={false}>
        {support.grants.length === 0 ? (
          <EmptyState icon={<KeyRound className="h-5 w-5" />} title="Never granted" body="Its super admin has not let support in so far." />
        ) : (
          <DataTable caption="Support access grants" minWidth={760}>
            <THead>
              <Th>Granted</Th>
              <Th>Level</Th>
              <Th>By</Th>
              <Th>Until</Th>
              <Th>Ended</Th>
              <Th>Reason</Th>
            </THead>
            <TBody>
              {support.grants.map((g) => {
                const state = grantLabel(g.state, g.level);
                return (
                  <Tr key={g.id}>
                    <Td muted nowrap>
                      <RelativeTime at={g.createdAt} />
                    </Td>
                    <Td nowrap>{levelText(g.level)}</Td>
                    <Td nowrap>{g.grantedByName}</Td>
                    <Td muted nowrap>
                      <RelativeTime at={g.expiresAt} />
                    </Td>
                    <Td nowrap>
                      {g.state === "live" ? (
                        <StatusPill tone="success" dot>
                          Live
                        </StatusPill>
                      ) : g.state === "ended" && g.revokedAt ? (
                        <span className="text-muted">
                          <RelativeTime at={g.revokedAt} />
                        </span>
                      ) : (
                        <StatusPill tone={state.tone}>{state.label}</StatusPill>
                      )}
                    </Td>
                    <Td muted className="max-w-md break-words">
                      {g.reason || "—"}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Staff who went in" description="Each time staff entered as support, newest first." padded={false}>
        {support.entries.length === 0 ? (
          <EmptyState icon={<History className="h-5 w-5" />} title="Nobody from staff has gone in" body="Entries appear here each time a pass is issued." />
        ) : (
          <DataTable caption="Support entries" minWidth={520}>
            <THead>
              <Th>When</Th>
              <Th>Staff</Th>
              <Th>Level</Th>
            </THead>
            <TBody>
              {support.entries.map((e, i) => (
                <Tr key={`${i}-${e.at.toISOString()}`}>
                  <Td muted nowrap>
                    <RelativeTime at={e.at} />
                  </Td>
                  <Td nowrap>
                    <span className="inline-flex items-center gap-1.5">
                      <LifeBuoy aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />
                      {e.staff}
                    </span>
                  </Td>
                  <Td muted nowrap>
                    {levelText(e.level)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
