import { Fragment } from "react";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { dayMonthYear, plural } from "@/lib/console-shared/format";
import { DEAL_STATUS, INVITE_STATE } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerPipeline } from "@/lib/partners/console-data";
import { DealDecisionButtons } from "./decisions";
import { countryName, workspacePath } from "./format";

/**
 * Partner 360 › Pipeline (spec §9.2): what the partner has out selling — its invitation codes (named
 * by their hint, never the code), its referral links, its deal registrations (approve or decline the
 * pending ones: SELLERS) — and how many signups are under way with them (a count only: an
 * unverified signup belongs to nobody yet). Each list holds the latest 200. Server-safe.
 */

function Customers({ list }: { list: { slug: string; name: string }[] }) {
  if (list.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="text-sm">
      {list.slice(0, 3).map((c, i) => (
        <Fragment key={c.slug}>
          {i > 0 && ", "}
          <Link href={workspacePath(c.slug)} className="text-text hover:text-brand">
            {c.name}
          </Link>
        </Fragment>
      ))}
      {list.length > 3 && <span className="text-muted">{` +${list.length - 3}`}</span>}
    </span>
  );
}

const moreNote = (shown: number, total: number, noun: string) => (total > shown ? `Showing the latest ${shown} of ${plural(total, noun)}.` : undefined);

export function PartnerPipelineTab({ data, caps, partnerName }: { data: PartnerPipeline; caps: Caps; partnerName: string }) {
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Hourglass aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
        {data.signupsInProgress > 0
          ? `${plural(data.signupsInProgress, "signup")} under way with its live codes or links — not verified yet.`
          : "No signup is under way with its codes or links right now."}
      </p>

      <Panel title="Invitation codes" description="Secret codes the partner hands to customers; each shown once, to whoever made it." padded={data.invites.length === 0} footer={moreNote(data.invites.length, data.totals.invites, "code")}>
        {data.invites.length === 0 ? (
          <p className="text-sm text-muted">{`${partnerName} has made no invitation codes.`}</p>
        ) : (
          <DataTable caption="Invitation codes" minWidth={900}>
            <THead>
              <Th>Code</Th>
              <Th>Note</Th>
              <Th>Plan</Th>
              <Th numeric>Used</Th>
              <Th>Ends</Th>
              <Th>State</Th>
              <Th>Customers</Th>
              <Th>Made</Th>
            </THead>
            <TBody>
              {data.invites.map((i) => (
                <Tr key={i.codeHash}>
                  <Td mono>{i.codeHint ? `…${i.codeHint}` : "—"}</Td>
                  <Td muted={!i.note}>{i.note ?? "—"}</Td>
                  <Td muted={!i.planName}>{i.planName ?? "Their choice"}</Td>
                  <Td numeric>{`${i.uses} / ${i.maxUses}`}</Td>
                  <Td nowrap muted>
                    {i.expiresAt ? dayMonthYear(i.expiresAt) : "Never"}
                  </Td>
                  <Td>
                    <LabelPill map={INVITE_STATE} value={i.state} />
                  </Td>
                  <Td>
                    <Customers list={i.customers} />
                  </Td>
                  <Td nowrap muted>
                    {`${dayMonthYear(i.createdAt)} · ${i.createdByName}`}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Referral links" description="Public links to the signup page; they attribute a signup but never open signup by themselves." padded={data.links.length === 0} footer={moreNote(data.links.length, data.totals.links, "link")}>
        {data.links.length === 0 ? (
          <p className="text-sm text-muted">{`${partnerName} has made no referral links.`}</p>
        ) : (
          <DataTable caption="Referral links" minWidth={960}>
            <THead>
              <Th>Link</Th>
              <Th>Label</Th>
              <Th>Plan</Th>
              <Th numeric>Signups</Th>
              <Th numeric>Customers</Th>
              <Th>Ends</Th>
              <Th>State</Th>
              <Th>Made</Th>
            </THead>
            <TBody>
              {data.links.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    <CopyField value={l.url} label={`referral link ${l.code}`} />
                  </Td>
                  <Td muted={!l.label}>{l.label ?? "—"}</Td>
                  <Td muted={!l.planName}>{l.planName ?? "Their choice"}</Td>
                  <Td numeric>{l.signups}</Td>
                  <Td numeric>{l.customers}</Td>
                  <Td nowrap muted>
                    {l.endedAt ? `Ended ${dayMonthYear(l.endedAt)}` : l.expiresAt ? dayMonthYear(l.expiresAt) : "Never"}
                  </Td>
                  <Td>
                    <LabelPill map={INVITE_STATE} value={l.state} />
                  </Td>
                  <Td nowrap muted>
                    {`${dayMonthYear(l.createdAt)} · ${l.createdByName}`}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel
        title="Deal registrations"
        description="Companies the partner claimed before they signed up. An approved one wins the signup from its domain while it is protected."
        padded={false}
        footer={moreNote(data.deals.length, data.totals.deals, "registration")}
      >
        {data.deals.length === 0 ? (
          <EmptyState title="No deal registrations" body={`${partnerName} has registered no companies.`} />
        ) : (
          <DataTable caption="Deal registrations" minWidth={1040}>
            <THead>
              <Th>Company</Th>
              <Th>Contact</Th>
              <Th>Expected plan</Th>
              <Th>Status</Th>
              <Th>Protected until</Th>
              <Th>Registered</Th>
              <Th>Customer</Th>
              <Th srOnly>Actions</Th>
            </THead>
            <TBody>
              {data.deals.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <span className="font-medium text-text">{d.companyName}</span>
                    <span className="block font-mono text-xs text-muted">{`${d.domain} · ${countryName(d.country)}`}</span>
                    {d.note && <span className="mt-0.5 block max-w-xs text-xs break-words text-muted">{d.note}</span>}
                  </Td>
                  <Td>
                    {d.contactName || d.contactEmail ? (
                      <span className="text-sm">
                        {d.contactName ?? ""}
                        {d.contactEmail && <span className="block text-xs break-all text-muted">{d.contactEmail}</span>}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td muted={!d.expectedPlanName}>{d.expectedPlanName ?? "—"}</Td>
                  <Td>
                    <span className="inline-flex flex-col items-start gap-0.5">
                      <LabelPill map={DEAL_STATUS} value={d.status} />
                      {d.lapsed && <StatusPill tone="warning">Protection over</StatusPill>}
                      {d.decisionNote && <span className="max-w-xs text-xs break-words text-muted">{`“${d.decisionNote}”`}</span>}
                    </span>
                  </Td>
                  <Td nowrap muted>
                    {d.expiresAt ? dayMonthYear(d.expiresAt) : "—"}
                  </Td>
                  <Td nowrap muted>
                    {`${dayMonthYear(d.createdAt)} · ${d.submittedByName}`}
                  </Td>
                  <Td>
                    {d.customer ? (
                      <Link href={workspacePath(d.customer.slug)} className="text-sm text-text hover:text-brand">
                        {d.customer.name}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <RowActionsCell>
                    {caps.partnerMoney && d.status === "PENDING" ? <DealDecisionButtons deal={{ id: d.id, companyName: d.companyName, domain: d.domain, partnerName }} /> : null}
                  </RowActionsCell>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
