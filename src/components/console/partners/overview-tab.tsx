import type { ReactNode } from "react";
import Link from "next/link";
import { CircleCheck, HandCoins, Users, Wallet } from "lucide-react";
import { consoleReviewAttribution } from "@/actions/platform/console-partners";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { ActionButton } from "@/components/console/kit/action-button";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LabelPill, StatusPill } from "@/components/console/kit/status";
import { OutboundLink, externalHref } from "@/components/ui/outbound-link";
import { plural } from "@/lib/console-shared/format";
import { PARTNER_KIND, PARTNER_REQUEST_KIND, PARTNER_STATUS } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerHeader, PartnerOverview } from "@/lib/partners/console-data";
import { consoleClock } from "@/lib/platform/console-clock";
import { AttributionFlags } from "./flags";
import { REQUESTS_PATH, countryName, partnerPath, territoriesText, workspacePath } from "./format";
import { PartnerNotes } from "./notes-editor";
import { SetPayoutButton } from "./payout";

/**
 * Partner 360 › Overview (spec §9.2): the profile, contacts and address; for SELLERS its tax ids,
 * the payout mask and the money KPIs, with "Set payout details" for PAYERS; staff notes (MANAGERS
 * edit); a distributor's resellers; its customers' open flags and the requests waiting on staff.
 * A server component, its days on the console's clock — but "this year" of commission is India's, as
 * the programme's money is. Money is not even loaded for other roles (`overview.money` is null), so
 * nothing here can leak it.
 */

const muted = (text: string) => <span className="text-muted">{text}</span>;

export async function PartnerOverviewTab({ header, overview, caps }: { header: PartnerHeader; overview: PartnerOverview; caps: Caps }) {
  const clock = await consoleClock();
  const { profile, contact, address, money } = overview;
  const base = partnerPath(header.slug);
  const addressText = [address.line1, address.line2, address.city, address.region, address.postalCode].filter(Boolean).join(", ");
  const website = profile.website ? externalHref(profile.website) : null;

  const details: { term: string; value: ReactNode; wide?: boolean }[] = [
    { term: "Legal name", value: profile.legalName },
    { term: "Display name", value: profile.displayName },
    { term: "Kind", value: <LabelPill map={PARTNER_KIND} value={profile.kind} /> },
    { term: "Status", value: <LabelPill map={PARTNER_STATUS} value={profile.status} /> },
    { term: "Country", value: `${countryName(profile.country)} (${profile.country})` },
    {
      term: "Distributor",
      value: profile.parent ? (
        <Link href={partnerPath(profile.parent.slug)} className="font-medium text-text hover:text-brand">
          {profile.parent.displayName}
        </Link>
      ) : (
        muted(profile.kind === "DISTRIBUTOR" ? "It is one" : "None — direct under the platform")
      ),
    },
    { term: "Territories", value: profile.territories.length ? profile.territories.map((c) => `${countryName(c)} (${c})`).join(", ") : muted("None"), wide: true },
    {
      term: "Website",
      value: website ? (
        <OutboundLink href={website} className="break-all text-brand hover:underline">
          {profile.website}
        </OutboundLink>
      ) : (
        muted("—")
      ),
    },
    { term: "Public listing", value: profile.publicListing ? "Listed on Find a partner" : muted("Not listed") },
    ...(profile.publicListing && profile.publicBlurb ? [{ term: "Public blurb", value: profile.publicBlurb, wide: true }] : []),
    { term: "Created", value: `${clock.date(profile.createdAt)} by ${profile.createdByName}` },
    { term: "Updated", value: <RelativeTime at={profile.updatedAt} /> },
  ];
  if (header.activatedAt) details.push({ term: "First activated", value: clock.date(header.activatedAt) });

  return (
    <div className="space-y-6">
      <KpiGrid columns={money ? 3 : 2}>
        <KpiTile label="Customers" icon={<Users className="h-4 w-4" />} value={overview.customers} secondary="Open workspaces attributed now" href={`${base}?tab=customers`} />
        {money && <KpiTile label="Customers' MRR" icon={<Wallet className="h-4 w-4" />} value={<MoneyList amounts={money.mrr} />} secondary="Per currency, from their live subscriptions" />}
        {money && (
          <KpiTile label="Commission this year" icon={<HandCoins className="h-4 w-4" />} value={<MoneyList amounts={money.commissionThisYear} />} secondary="Earned since 1 January, India time, voids left out" />
        )}
        {!money && <KpiTile label="Resellers" icon={<Users className="h-4 w-4" />} value={overview.resellers.length} secondary={profile.kind === "DISTRIBUTOR" ? "Under it" : "A reseller has none"} />}
      </KpiGrid>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Panel title="Profile">
            <DefinitionList items={details} />
          </Panel>

          <Panel title="Contact and address">
            <DefinitionList
              items={[
                { term: "Contact", value: contact.name },
                {
                  term: "Email",
                  value: (
                    <a href={`mailto:${contact.email}`} className="break-all text-brand hover:underline">
                      {contact.email}
                    </a>
                  ),
                },
                { term: "Phone", value: contact.phone ?? muted("—") },
                { term: "Address", value: addressText || muted("Not given"), wide: true },
              ]}
            />
          </Panel>

          {overview.flags.length > 0 && (
            <Panel title="Open flags" description="Its customers' signups flagged for a look — outside its territories, or claimed by another partner too." padded={false}>
              <ul className="divide-y divide-line">
                {overview.flags.map((flag) => (
                  <li key={flag.attributionId} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                    <div className="min-w-0 space-y-1">
                      <Link href={workspacePath(flag.workspace.slug)} className="text-sm font-medium text-text hover:text-brand">
                        {flag.workspace.name}
                      </Link>
                      <p className="text-xs text-muted">{`${flag.workspace.slug} · ${countryName(flag.workspace.country)} · since ${clock.date(flag.since)}`}</p>
                      <AttributionFlags flags={flag.flags} />
                    </div>
                    {caps.partnerMoney && (
                      <ActionButton
                        action={consoleReviewAttribution.bind(null, flag.attributionId)}
                        label="Mark reviewed"
                        icon={<CircleCheck aria-hidden="true" className="h-4 w-4" />}
                        confirm={{ title: "Mark reviewed", body: `The attribution of ${flag.workspace.name} stays as it is and leaves the review queue.`, confirmLabel: "Mark reviewed" }}
                        success="Attribution marked reviewed."
                      />
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {profile.kind === "DISTRIBUTOR" && (
            <Panel title="Resellers" description={overview.resellers.length ? `${plural(overview.resellers.length, "reseller")} under it.` : undefined} padded={overview.resellers.length === 0}>
              {overview.resellers.length === 0 ? (
                <p className="text-sm text-muted">No resellers under it yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {overview.resellers.map((r) => (
                    <li key={r.slug} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                      <span className="min-w-0">
                        <Link href={partnerPath(r.slug)} className="text-sm font-medium text-text hover:text-brand">
                          {r.displayName}
                        </Link>
                        <span className="block font-mono text-xs text-muted">{territoriesText(r.territories)}</span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        {plural(r.customers, "customer")}
                        <LabelPill map={PARTNER_STATUS} value={r.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {money && (
            <Panel title="Payout details" actions={caps.payPartners ? <SetPayoutButton partner={{ id: header.id, displayName: header.displayName }} /> : undefined}>
              {money.payout ? (
                <DefinitionList
                  columns={1}
                  items={[
                    { term: "Account holder", value: money.payout.accountHolder },
                    { term: "Bank", value: money.payout.bankName },
                    { term: "Account", value: <span className="font-mono text-xs">{`•••• ${money.payout.last4}`}</span> },
                    ...(money.payout.ifsc ? [{ term: "IFSC", value: <span className="font-mono text-xs">{money.payout.ifsc}</span> }] : []),
                    ...(money.payout.swift ? [{ term: "SWIFT (BIC)", value: <span className="font-mono text-xs">{money.payout.swift}</span> }] : []),
                    { term: "Country · currency", value: `${countryName(money.payout.country)} · ${money.payout.currency}` },
                    ...(money.payoutUpdatedAt ? [{ term: "Set", value: clock.date(money.payoutUpdatedAt) }] : []),
                  ]}
                />
              ) : (
                <p className="text-sm text-muted">No payout details on file. Statements can be drafted, but not approved, until they are set.</p>
              )}
            </Panel>
          )}

          {money && (
            <Panel title="Tax ids">
              {money.taxIds.length === 0 ? (
                <p className="text-sm text-muted">None on file.</p>
              ) : (
                <ul className="space-y-1.5">
                  {money.taxIds.map((t, i) => (
                    <li key={`${i}-${t.kind}`} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-xs text-muted">{t.kind}</span>
                      <span className="font-mono text-xs break-all text-text">{t.value}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {!money && (
            <Panel title="Money">
              <p className="text-sm text-muted">Its MRR, commission, tax ids and payout details are visible to billing staff.</p>
            </Panel>
          )}

          {overview.pendingRequests.length > 0 && (
            <Panel title="Waiting on staff" padded={false}>
              <ul className="divide-y divide-line">
                {overview.pendingRequests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <StatusPill tone="warning">{PARTNER_REQUEST_KIND[r.kind]?.label ?? r.kind}</StatusPill>
                    <span className="text-xs text-muted">
                      {"Asked "}
                      <RelativeTime at={r.createdAt} absolute="date" />
                    </span>
                  </li>
                ))}
              </ul>
              {caps.partnerMoney && (
                <div className="border-t border-line px-5 py-2.5">
                  <Link href={`${REQUESTS_PATH}?tab=${overview.pendingRequests.some((r) => r.kind !== "NEW_RESELLER") ? "changes" : "resellers"}`} className="text-xs font-medium text-brand hover:underline">
                    Open the requests queue
                  </Link>
                </div>
              )}
            </Panel>
          )}

          <Panel title="Staff notes" description="Never shown to the partner.">
            <PartnerNotes partnerId={header.id} notes={overview.notes} canEdit={caps.managePartners} />
          </Panel>
        </div>
      </div>
    </div>
  );
}
