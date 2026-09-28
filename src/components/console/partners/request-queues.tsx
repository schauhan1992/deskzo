import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck } from "lucide-react";
import { consoleReviewAttribution } from "@/actions/platform/console-partners";
import { ActionButton } from "@/components/console/kit/action-button";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { OutboundLink, externalHref } from "@/components/ui/outbound-link";
import { dayMonthYear } from "@/lib/console-shared/format";
import { ATTRIBUTION_SOURCE, DEAL_STATUS, PARTNER_APPLICATION_STATUS, PARTNER_KIND, PARTNER_REQUEST_KIND, PARTNER_REQUEST_STATUS, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { ApplicationQueueRow, AttributionQueueRow, ChangeQueueRow, DealQueueRow, ResellerQueueRow } from "@/lib/partners/console-data";
import type { PayoutMask, TermsInput } from "@/lib/partners/types";
import { ApplicationUpdateButton, DealDecisionButtons, RequestDecisionButtons, ResellerApproveButton } from "./decisions";
import { AttributionFlags } from "./flags";
import { countryName, partnerPath, territoriesText, workspacePath } from "./format";
import { ConvertApplicationButton, type PartnerFormOptions } from "./new-partner-dialog";

/**
 * The /partners/requests tables (spec §9.2), one per tab: applications, deal registrations, profile
 * and payout changes, new resellers, flagged attributions. Each row's decision is drawn only for the
 * roles its action allows — applications, profile changes and resellers MANAGERS; deals and
 * attributions SELLERS; payout changes PAYERS — and every action checks again. Payout changes show
 * masks only, the new beside the old; the details themselves never reach this page. Server-safe.
 */

const muted = (text: string) => <span className="text-muted">{text}</span>;

function PartnerLink({ partner }: { partner: { slug: string; displayName: string } }) {
  return (
    <Link href={partnerPath(partner.slug)} className="font-medium text-text hover:text-brand">
      {partner.displayName}
    </Link>
  );
}

function Decided({ at, by, note }: { at: Date | null; by: string | null; note: string | null }): ReactNode {
  if (!at) return null;
  return (
    <span className="block text-xs text-muted">
      {`${dayMonthYear(at)}${by ? ` · ${by}` : ""}`}
      {note && <span className="block max-w-xs break-words">{`“${note}”`}</span>}
    </span>
  );
}

// ─── Applications (MANAGERS act) ─────────────────────────────────────────────────────────────────

export function ApplicationsQueue({ rows, caps, options }: { rows: ApplicationQueueRow[]; caps: Caps; options: PartnerFormOptions | null }) {
  return (
    <DataTable caption="Partner applications" minWidth={1100}>
      <THead>
        <Th>Company</Th>
        <Th>Wants to be</Th>
        <Th>Contact</Th>
        <Th>Message</Th>
        <Th>Status</Th>
        <Th>Received</Th>
        {caps.managePartners && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((a) => {
          const site = externalHref(a.website);
          const open = a.status !== "ACCEPTED" && !a.partner;
          return (
            <Tr key={a.id}>
              <Td>
                <span className="font-medium text-text">{a.companyName}</span>
                <span className="block text-xs text-muted">{countryName(a.country)}</span>
                {site && (
                  <OutboundLink href={site} className="block text-xs break-all text-brand hover:underline">
                    {a.website}
                  </OutboundLink>
                )}
              </Td>
              <Td>
                <LabelPill map={PARTNER_KIND} value={a.kindWanted} />
              </Td>
              <Td>
                <span className="text-sm text-text">{a.contactName}</span>
                <span className="block text-xs break-all text-muted">{a.contactEmail}</span>
                {a.contactPhone && <span className="block text-xs text-muted">{a.contactPhone}</span>}
              </Td>
              <Td>
                <details className="max-w-sm">
                  <summary className="cursor-pointer text-xs font-medium text-brand">{a.message.length > 80 ? `${a.message.slice(0, 80).trimEnd()}…` : "Read it"}</summary>
                  <p className="mt-1 text-sm whitespace-pre-wrap break-words text-text">{a.message}</p>
                </details>
              </Td>
              <Td>
                <span className="inline-flex flex-col items-start gap-0.5">
                  <LabelPill map={PARTNER_APPLICATION_STATUS} value={a.status} />
                  {a.partner && (
                    <span className="text-xs text-muted">
                      {"Now "}
                      <PartnerLink partner={a.partner} />
                    </span>
                  )}
                  {a.notes && <span className="max-w-xs text-xs break-words text-muted">{a.notes}</span>}
                  {a.handledByName && <span className="text-xs text-subtle">{`by ${a.handledByName}`}</span>}
                </span>
              </Td>
              <Td nowrap muted>
                {dayMonthYear(a.createdAt)}
              </Td>
              {caps.managePartners && (
                <RowActionsCell>
                  <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                    {open && options && (
                      <ConvertApplicationButton
                        application={{
                          id: a.id,
                          companyName: a.companyName,
                          website: a.website,
                          country: a.country,
                          kindWanted: a.kindWanted,
                          contactName: a.contactName,
                          contactEmail: a.contactEmail,
                          contactPhone: a.contactPhone,
                        }}
                        options={options}
                      />
                    )}
                    {open && <ApplicationUpdateButton application={{ id: a.id, companyName: a.companyName, status: a.status, notes: a.notes }} />}
                  </span>
                </RowActionsCell>
              )}
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}

// ─── Deals (SELLERS act) ─────────────────────────────────────────────────────────────────────────

export function DealsQueue({ rows, caps }: { rows: DealQueueRow[]; caps: Caps }) {
  return (
    <DataTable caption="Deal registrations" minWidth={1100}>
      <THead>
        <Th>Company</Th>
        <Th>Partner</Th>
        <Th>Contact</Th>
        <Th>Expected plan</Th>
        <Th>Registered</Th>
        <Th>Status</Th>
        {caps.partnerMoney && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((d) => {
          const outside = !d.partner.territories.includes(d.country);
          return (
            <Tr key={d.id}>
              <Td>
                <span className="font-medium text-text">{d.companyName}</span>
                <span className="block font-mono text-xs text-muted">{`${d.domain} · ${countryName(d.country)}`}</span>
                {d.note && <span className="mt-0.5 block max-w-xs text-xs break-words text-muted">{d.note}</span>}
              </Td>
              <Td>
                <PartnerLink partner={d.partner} />
                <span className="mt-0.5 flex flex-wrap items-center gap-1">
                  <LabelPill map={PARTNER_STATUS} value={d.partner.status} />
                  {outside && <StatusPill tone="warning">Outside its territories</StatusPill>}
                </span>
              </Td>
              <Td>
                {d.contactName || d.contactEmail ? (
                  <span className="text-sm">
                    {d.contactName ?? ""}
                    {d.contactEmail && <span className="block text-xs break-all text-muted">{d.contactEmail}</span>}
                  </span>
                ) : (
                  muted("—")
                )}
              </Td>
              <Td muted={!d.expectedPlanName}>{d.expectedPlanName ?? "—"}</Td>
              <Td nowrap muted>
                {`${dayMonthYear(d.createdAt)} · ${d.submittedByName}`}
              </Td>
              <Td>
                <span className="inline-flex flex-col items-start gap-0.5">
                  <LabelPill map={DEAL_STATUS} value={d.status} />
                  {d.lapsed && <StatusPill tone="warning">Protection over</StatusPill>}
                  {d.expiresAt && d.status === "APPROVED" && <span className="text-xs text-muted">{`until ${dayMonthYear(d.expiresAt)}`}</span>}
                  <Decided at={d.decidedAt} by={d.decidedByName} note={d.decisionNote} />
                </span>
              </Td>
              {caps.partnerMoney && (
                <RowActionsCell>
                  {d.status === "PENDING" ? <DealDecisionButtons deal={{ id: d.id, companyName: d.companyName, domain: d.domain, partnerName: d.partner.displayName }} /> : null}
                </RowActionsCell>
              )}
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}

// ─── Profile and payout changes (MANAGERS / PAYERS by kind) ──────────────────────────────────────

function MaskLine({ mask }: { mask: PayoutMask | null }) {
  if (!mask) return muted("Nothing on file");
  return (
    <span className="text-sm text-text">
      {`${mask.accountHolder} · ${mask.bankName}`}
      <span className="block font-mono text-xs text-muted">{`•••• ${mask.last4}${mask.ifsc ? ` · ${mask.ifsc}` : ""}${mask.swift ? ` · ${mask.swift}` : ""} · ${mask.country} · ${mask.currency}`}</span>
    </span>
  );
}

export function ChangesQueue({ rows, caps }: { rows: ChangeQueueRow[]; caps: Caps }) {
  return (
    <DataTable caption="Profile and payout changes" minWidth={1000}>
      <THead>
        <Th>Partner</Th>
        <Th>Asked for</Th>
        <Th>Change</Th>
        <Th>Status</Th>
        <Th srOnly>Actions</Th>
      </THead>
      <TBody>
        {rows.map((r) => {
          const allowed = r.kind === "PAYOUT" ? caps.payPartners : caps.managePartners;
          return (
            <Tr key={r.id}>
              <Td>
                <PartnerLink partner={r.partner} />
                <span className="block text-xs text-muted">{`${dayMonthYear(r.createdAt)} · ${r.requestedByName}`}</span>
              </Td>
              <Td>
                <LabelPill map={PARTNER_REQUEST_KIND} value={r.kind} />
              </Td>
              <Td>
                {r.profile && (
                  <dl className="space-y-1">
                    {r.profile.map((c) => (
                      <div key={c.field} className="text-sm">
                        <dt className="text-xs text-muted">{c.label}</dt>
                        <dd className="break-words text-text">
                          <span className="text-muted line-through">{c.from ?? "—"}</span>
                          {" → "}
                          <span>{c.to ?? "—"}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {r.payout && (
                  <dl className="space-y-1.5">
                    <div>
                      <dt className="text-xs text-muted">Asked for</dt>
                      <dd>
                        <MaskLine mask={r.payout.requested} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">On file now</dt>
                      <dd>
                        <MaskLine mask={r.payout.current} />
                      </dd>
                    </div>
                  </dl>
                )}
              </Td>
              <Td>
                <LabelPill map={PARTNER_REQUEST_STATUS} value={r.status} />
                <Decided at={r.decidedAt} by={r.decidedByName} note={r.decisionNote} />
              </Td>
              <RowActionsCell>
                {r.status === "PENDING" && allowed ? (
                  <RequestDecisionButtons request={{ id: r.id, subject: PARTNER_REQUEST_KIND[r.kind].label, partnerName: r.partner.displayName }} />
                ) : r.status === "PENDING" ? (
                  <span className="text-xs text-muted">{r.kind === "PAYOUT" ? "Owners and billing decide" : "Owners and admins decide"}</span>
                ) : null}
              </RowActionsCell>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}

// ─── New resellers (MANAGERS act) ────────────────────────────────────────────────────────────────

export function ResellersQueue({
  rows,
  caps,
  terms,
}: {
  rows: ResellerQueueRow[];
  caps: Caps;
  /** A new reseller's first terms: the plans a plan rate may name, and the programme's defaults. Null: this role doesn't approve. */
  terms: { plans: { key: string; name: string }[]; defaults: TermsInput; todayKey: string } | null;
}) {
  return (
    <DataTable caption="New resellers" minWidth={1000}>
      <THead>
        <Th>Proposed reseller</Th>
        <Th>Distributor</Th>
        <Th>Contact</Th>
        <Th>Status</Th>
        {caps.managePartners && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <span className="font-medium text-text">{r.proposal.displayName || r.proposal.legalName}</span>
              {r.proposal.legalName && r.proposal.legalName !== r.proposal.displayName && <span className="block text-xs text-muted">{r.proposal.legalName}</span>}
              <span className="block font-mono text-xs text-muted">{`${r.proposal.country} · ${territoriesText(r.proposal.territories)}`}</span>
              {r.proposal.note && <span className="mt-0.5 block max-w-xs text-xs break-words text-muted">{r.proposal.note}</span>}
            </Td>
            <Td>
              <PartnerLink partner={r.distributor} />
              <span className="block text-xs text-muted">{`${dayMonthYear(r.createdAt)} · ${r.requestedByName}`}</span>
            </Td>
            <Td>
              <span className="text-sm text-text">{r.proposal.contactName}</span>
              <span className="block text-xs break-all text-muted">{r.proposal.contactEmail}</span>
            </Td>
            <Td>
              <span className="inline-flex flex-col items-start gap-0.5">
                <LabelPill map={PARTNER_REQUEST_STATUS} value={r.status} />
                {r.resultPartner && (
                  <span className="text-xs text-muted">
                    {"Now "}
                    <PartnerLink partner={r.resultPartner} />
                  </span>
                )}
                <Decided at={r.decidedAt} by={r.decidedByName} note={r.decisionNote} />
              </span>
            </Td>
            {caps.managePartners && (
              <RowActionsCell>
                {r.status === "PENDING" ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                    {terms && (
                      <ResellerApproveButton
                        request={{
                          id: r.id,
                          displayName: r.proposal.displayName || r.proposal.legalName,
                          distributorName: r.distributor.displayName,
                          suggestedSlug: r.suggestedSlug,
                          contactEmail: r.proposal.contactEmail,
                        }}
                        plans={terms.plans}
                        defaults={terms.defaults}
                        todayKey={terms.todayKey}
                      />
                    )}
                    <RequestDecisionButtons request={{ id: r.id, subject: "New reseller request", partnerName: r.distributor.displayName }} canApprove={false} />
                  </span>
                ) : null}
              </RowActionsCell>
            )}
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}

// ─── Flagged attributions (SELLERS act) ──────────────────────────────────────────────────────────

export function AttributionsQueue({ rows, caps }: { rows: AttributionQueueRow[]; caps: Caps }) {
  return (
    <DataTable caption="Flagged attributions" minWidth={1000}>
      <THead>
        <Th>Workspace</Th>
        <Th>Partner</Th>
        <Th>Source</Th>
        <Th>Since</Th>
        <Th>Flags</Th>
        {caps.partnerMoney && <Th srOnly>Actions</Th>}
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td>
              <Link href={workspacePath(r.workspace.slug)} className="font-medium text-text hover:text-brand">
                {r.workspace.name}
              </Link>
              <span className="block font-mono text-xs text-muted">{`${r.workspace.slug} · ${r.workspace.country}`}</span>
            </Td>
            <Td>
              {r.partner ? (
                <>
                  <PartnerLink partner={r.partner} />
                  <span className="block font-mono text-xs text-muted">{territoriesText(r.partner.territories)}</span>
                </>
              ) : (
                muted("Direct — no partner")
              )}
            </Td>
            <Td>
              <LabelPill map={ATTRIBUTION_SOURCE} value={r.source} />
            </Td>
            <Td nowrap muted>
              {dayMonthYear(r.since)}
            </Td>
            <Td>
              <AttributionFlags flags={r.flags} reviewed={r.reviewedAt !== null} />
              {r.reviewedAt && <span className="block text-xs text-subtle">{`Reviewed ${dayMonthYear(r.reviewedAt)}${r.reviewedByName ? ` by ${r.reviewedByName}` : ""}`}</span>}
            </Td>
            {caps.partnerMoney && (
              <RowActionsCell>
                <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                  {!r.reviewedAt && (
                    <ActionButton
                      action={consoleReviewAttribution.bind(null, r.id)}
                      label="Mark reviewed"
                      icon={<CircleCheck aria-hidden="true" className="h-4 w-4" />}
                      confirm={{ title: "Mark reviewed", body: `${r.workspace.name} stays with ${r.partner?.displayName ?? "no partner"} and leaves the review queue.`, confirmLabel: "Mark reviewed" }}
                      success="Attribution marked reviewed."
                    />
                  )}
                  <Link
                    href={workspacePath(r.workspace.slug)}
                    aria-label={`Reassign ${r.workspace.name}`}
                    className="inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken"
                  >
                    Reassign
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </Link>
                </span>
              </RowActionsCell>
            )}
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
