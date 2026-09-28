import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CreditCard, Receipt, Webhook } from "lucide-react";
import { consoleApplyStanding } from "@/actions/platform/console";
import { MoneyList } from "@/components/console/charts/money-list";
import { ActionButton } from "@/components/console/kit/action-button";
import { Banner } from "@/components/console/kit/banner";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { LabelPill, StandingPill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, TFoot, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatMoney } from "@/lib/billing/money";
import { dayMonth, dayMonthYear, gatewayDashboardUrl, istDaysBetween, plural } from "@/lib/console-shared/format";
import { ENDS_AT_PERIOD_END, EVENT_STATE, INVOICE_STATUS, SUBSCRIPTION_STATUS, gatewayLabel, intervalLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { GatewayKey, GatewayMode } from "@/lib/console-shared/types";
import type { BillingPanel, SubView, WorkspaceHeader } from "@/lib/platform/workspace-data";
import { cn } from "@/lib/utils";
import { BillingProfileButton, EndManualPlanButton, ResyncButton, TrialCard } from "./billing-actions";

/**
 * Workspace 360 › Billing: where it stands and why, its trial, its subscriptions with their ids at
 * the gateway, its invoices, the billing profile, the reminders it was sent and what the gateways
 * last said about it.
 *
 * Read by every role. Sellers change the trial, the profile and resync a subscription; managers
 * apply the billing rules now and end a plan given by hand that makes a paying workspace exempt.
 * A closed workspace shows it all read-only.
 */

const LIVE = new Set(["TRIALING", "ACTIVE", "PAST_DUE"]);

/** "in 5 days", "today", "3 days ago" — counted from the loader's clock, never the reader's. */
function distance(at: Date, asOf: Date): string {
  const days = istDaysBetween(asOf, at);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${plural(days, "day")}` : `${plural(-days, "day")} ago`;
}

function DateValue({ at, asOf, tone }: { at: Date; asOf: Date; tone?: "danger" | "warning" }) {
  return (
    <span>
      <span className={cn(tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text")}>{dayMonthYear(at)}</span>
      <span className="ml-1.5 text-xs text-muted">{distance(at, asOf)}</span>
    </span>
  );
}

/** One plain sentence for the standing — what it means, not only its name. */
function standingSentence(header: WorkspaceHeader): string {
  const s = header.standing;
  switch (s.kind) {
    case "exempt":
      return header.tenant.isDefault ? "Nothing to collect — it is the installation's own workspace." : "Nothing to collect — it is on a plan given by hand.";
    case "paid":
      return "Paid up at its gateway.";
    case "trial":
      return `On a free trial until ${dayMonthYear(s.endsAt)}.`;
    case "trial-over":
      return `Its trial is over. It is held on ${dayMonthYear(s.holdAt)} unless it buys a plan.`;
    case "past-due":
      return `A payment failed. It is held on ${dayMonthYear(s.holdAt)} unless it is paid.`;
    case "ending":
      return `Cancelled — it runs until ${dayMonthYear(s.holdAt)}, then it is held.`;
    case "lapsed":
      return `Nothing live since ${dayMonthYear(s.since)} — it should be held.`;
    default:
      return "No subscription at all. Put it on a plan under Plan & modules.";
  }
}

const modeOf = (gateway: "STRIPE" | "RAZORPAY", billing: BillingPanel): GatewayMode => (gateway === "STRIPE" ? billing.modes.stripe : billing.modes.razorpay);
const atGateway = (g: GatewayKey): g is "STRIPE" | "RAZORPAY" => g === "STRIPE" || g === "RAZORPAY";

export function BillingTab({ header, billing, caps }: { header: WorkspaceHeader; billing: BillingPanel; caps: Caps }) {
  const tenant = header.tenant;
  const closed = tenant.status === "DEPROVISIONED";
  const asOf = header.asOf;
  const standing = header.standing;
  const heldForBilling = tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING";
  const slugParam = encodeURIComponent(tenant.slug);

  // Its trial can be moved only while it pays at no gateway — a trial there would add to what it pays for.
  const showTrial = caps.sell && !closed && billing.trial !== null && header.gatewayPaying.length === 0;
  const manualActive = billing.subscriptions.find((s) => s.gateway === "MANUAL" && s.status === "ACTIVE") ?? null;
  const liveGatewaySub = billing.subscriptions.find((s) => atGateway(s.gateway) && LIVE.has(s.status)) ?? null;
  const paysThrough = [...new Set(header.gatewayPaying.map((g) => gatewayLabel(g.gateway)))];

  const facts: { term: string; value: ReactNode; wide?: boolean }[] = [
    { term: "Pays through", value: paysThrough.length > 0 ? paysThrough.join(", ") : manualActive ? "A plan given by hand" : "Nothing at a gateway" },
  ];
  if (standing.kind === "trial") facts.push({ term: "Trial ends", value: <DateValue at={standing.endsAt} asOf={asOf} /> });
  if (standing.kind === "trial-over" || standing.kind === "past-due") facts.push({ term: "Held on", value: <DateValue at={standing.holdAt} asOf={asOf} tone="danger" /> });
  if (standing.kind === "ending") facts.push({ term: "Runs until", value: <DateValue at={standing.holdAt} asOf={asOf} tone="warning" /> });
  if (standing.kind === "lapsed") facts.push({ term: "Nothing live since", value: <DateValue at={standing.since} asOf={asOf} tone="danger" /> });
  if (liveGatewaySub?.currentPeriodEnd) {
    facts.push({ term: liveGatewaySub.cancelAtPeriodEnd ? "Ends" : "Renews", value: <DateValue at={liveGatewaySub.currentPeriodEnd} asOf={asOf} /> });
  }
  if (liveGatewaySub?.pastDueSince) facts.push({ term: "Past due since", value: <DateValue at={liveGatewaySub.pastDueSince} asOf={asOf} tone="danger" /> });
  if (heldForBilling && tenant.suspendedAt) facts.push({ term: "Held for billing since", value: <DateValue at={tenant.suspendedAt} asOf={asOf} tone="danger" /> });
  facts.push({ term: "Paid, all time", value: <MoneyList amounts={billing.lifetimePaid} size="sm" empty="Nothing yet" /> });

  return (
    <div className="space-y-6">
      <div className={cn("grid gap-6", showTrial && "lg:grid-cols-3")}>
        <Panel
          title="Billing"
          description="Where it stands with billing, and what happens next."
          className={showTrial ? "lg:col-span-2" : undefined}
          actions={
            caps.manage && !closed ? (
              <ActionButton
                action={consoleApplyStanding.bind(null, tenant.id)}
                label="Apply billing rules now"
                confirm={{
                  title: "Apply billing rules now",
                  body: "Works out its standing and acts on it now rather than at the next platform tick: it can hold it, lift a billing hold, close it when auto-close is on, or email a reminder.",
                  confirmLabel: "Apply rules",
                }}
                results={{ none: "Nothing to do.", held: "Held.", lifted: "Hold lifted.", closed: "Closed." }}
              />
            ) : undefined
          }
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <StandingPill kind={standing.kind} at={header.standingAt} asOf={asOf} />
                {heldForBilling && (
                  <StatusPill tone="danger" dot>
                    Held for billing
                  </StatusPill>
                )}
              </div>
              <p className="text-sm text-text">{standingSentence(header)}</p>
            </div>

            {header.exemptWhilePaying && (
              <Banner
                tone="warning"
                title="Exempt while paying"
                action={caps.manage && !closed && manualActive ? <EndManualPlanButton tenantId={tenant.id} subscriptionId={manualActive.id} plans={manualActive.items.map((i) => i.plan.name)} /> : undefined}
              >
                {`It pays through ${paysThrough.join(" and ") || "a gateway"} and also has a plan given by hand, so billing never holds it for a failed payment.`}
              </Banner>
            )}

            <DefinitionList items={facts} columns={3} />
          </div>
        </Panel>
        {showTrial && billing.trial && <TrialCard tenantId={tenant.id} trial={billing.trial} caps={caps} asOf={asOf} />}
      </div>

      <Panel title="Subscriptions" description="Every subscription it has had — by hand, a trial, or at a gateway." padded={false}>
        {billing.subscriptions.length === 0 ? (
          <EmptyState icon={<CreditCard className="h-5 w-5" />} title="No subscriptions" body="It has never been on a plan, a trial or a gateway subscription." />
        ) : (
          <DataTable caption="Subscriptions" minWidth={1180}>
            <THead>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th>Plans</Th>
              <Th>Interval · currency</Th>
              <Th>Period / trial ends</Th>
              <Th>Cancels at period end</Th>
              <Th>Past due since</Th>
              <Th>At the gateway</Th>
              <Th>Synced</Th>
              {caps.sell && !closed && <Th srOnly>Resync</Th>}
            </THead>
            <TBody>
              {billing.subscriptions.map((s) => (
                <SubscriptionRow key={s.id} sub={s} billing={billing} caps={caps} closed={closed} />
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel
        title="Invoices"
        description={
          billing.invoiceCount === 0
            ? "None yet."
            : billing.invoiceCount > billing.invoices.length
              ? `The latest ${billing.invoices.length} of ${plural(billing.invoiceCount, "invoice")}.`
              : plural(billing.invoiceCount, "invoice")
        }
        actions={
          caps.sell && billing.invoiceCount > 0 ? (
            <Link href={`/billing?tab=invoices&tenant=${slugParam}`} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
              All invoices
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          ) : undefined
        }
        padded={false}
      >
        {billing.invoices.length === 0 ? (
          <EmptyState icon={<Receipt className="h-5 w-5" />} title="No invoices yet" body="Invoices appear here when its gateway issues them." />
        ) : (
          <DataTable caption="Invoices" minWidth={900}>
            <THead>
              <Th>Issued</Th>
              <Th>Number</Th>
              <Th>Period</Th>
              <Th numeric>Total</Th>
              <Th numeric>Paid</Th>
              <Th>Status</Th>
              <Th srOnly>Links</Th>
            </THead>
            <TBody>
              {billing.invoices.map((i) => {
                const dashboard = caps.sell && atGateway(i.gateway) ? gatewayDashboardUrl(i.gateway, "invoice", i.externalId, modeOf(i.gateway, billing)) : null;
                return (
                  <Tr key={i.id}>
                    <Td nowrap>{dayMonthYear(i.issuedAt)}</Td>
                    <Td>
                      <span className="block font-mono text-xs text-text">{i.number ?? "—"}</span>
                      <span className="block text-[11px] text-subtle">{gatewayLabel(i.gateway)}</span>
                    </Td>
                    <Td muted nowrap>
                      {i.periodStart && i.periodEnd ? `${dayMonth(i.periodStart)} – ${dayMonthYear(i.periodEnd)}` : "—"}
                    </Td>
                    <Td numeric className="font-medium">
                      {formatMoney(i.total, i.currency)}
                    </Td>
                    <Td numeric>
                      <span className={cn("block", i.amountPaid === 0 && "text-muted")}>{formatMoney(i.amountPaid, i.currency)}</span>
                      {i.paidAt && <span className="block text-[11px] text-subtle">{dayMonthYear(i.paidAt)}</span>}
                    </Td>
                    <Td>
                      <LabelPill map={INVOICE_STATUS} value={i.status} />
                    </Td>
                    <Td nowrap className="text-right">
                      <span className="inline-flex items-center gap-3">
                        {i.hostedUrl && <ExternalLink href={i.hostedUrl}>Invoice</ExternalLink>}
                        {i.pdfUrl && <ExternalLink href={i.pdfUrl}>PDF</ExternalLink>}
                        {dashboard && <ExternalLink href={dashboard}>Dashboard</ExternalLink>}
                        {!i.hostedUrl && !i.pdfUrl && !dashboard && <span className="text-muted">—</span>}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
            {billing.lifetimePaid.length > 0 && (
              <TFoot>
                {billing.lifetimePaid.map((p) => (
                  <Tr key={p.currency}>
                    <Td colSpan={4} muted>
                      {`Paid, all time${billing.lifetimePaid.length > 1 ? ` · ${p.currency}` : ""}`}
                    </Td>
                    <Td numeric>{formatMoney(p.minor, p.currency)}</Td>
                    <Td colSpan={2} />
                  </Tr>
                ))}
              </TFoot>
            )}
          </DataTable>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          title="Recent gateway events"
          description="What Stripe and Razorpay last said about it."
          className="lg:col-span-2"
          actions={
            caps.sell && billing.events.length > 0 ? (
              <Link href={`/billing?tab=events&tenant=${slugParam}`} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
                All events
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            ) : undefined
          }
          padded={false}
        >
          {billing.events.length === 0 ? (
            <EmptyState icon={<Webhook className="h-5 w-5" />} title="No gateway events" body="Neither gateway has sent anything about this workspace." />
          ) : (
            <DataTable caption="Recent gateway events" minWidth={640}>
              <THead>
                <Th>Received</Th>
                <Th>Event</Th>
                <Th>State</Th>
                <Th>Error</Th>
              </THead>
              <TBody>
                {billing.events.map((e) => {
                  const state = e.error ? "failed" : e.processedAt ? "processed" : "waiting";
                  return (
                    <Tr key={e.id}>
                      <Td muted nowrap>
                        <RelativeTime at={e.receivedAt} />
                      </Td>
                      <Td>
                        <span className="block font-mono text-xs break-all text-text">{e.type}</span>
                        <span className="block text-[11px] text-subtle">{gatewayLabel(e.gateway)}</span>
                      </Td>
                      <Td>
                        <LabelPill map={EVENT_STATE} value={state} />
                      </Td>
                      <Td muted className="max-w-xs">
                        {e.error ? (
                          <span className="block truncate text-danger" title={e.error}>
                            {e.error.split("\n")[0]}
                          </span>
                        ) : (
                          "—"
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </DataTable>
          )}
        </Panel>

        <div className="min-w-0 space-y-6">
          <Panel
            title="Billing profile"
            actions={caps.sell && !closed ? <BillingProfileButton tenantId={tenant.id} billingEmail={tenant.billingEmail} taxId={tenant.taxId} /> : undefined}
            footer={caps.sell ? "Editing these does not change the customer record at Stripe or Razorpay." : undefined}
          >
            <DefinitionList
              columns={1}
              items={[
                { term: "Billing email", value: tenant.billingEmail ?? <span className="text-muted">Not set — reminders go to the owner</span> },
                { term: "Tax ID", value: tenant.taxId ? <span className="font-mono text-xs">{tenant.taxId}</span> : <span className="text-muted">Not set</span> },
                { term: "Stripe customer", value: <CustomerId gateway="STRIPE" id={tenant.stripeCustomerId} billing={billing} caps={caps} /> },
                { term: "Razorpay customer", value: <CustomerId gateway="RAZORPAY" id={tenant.razorpayCustomerId} billing={billing} caps={caps} /> },
              ]}
            />
          </Panel>

          <Panel title="Reminders sent" description="Trial and hold reminders emailed to it.">
            {billing.notices.length === 0 ? (
              <p className="text-sm text-muted">No reminders sent.</p>
            ) : (
              <ul className="divide-y divide-line">
                {billing.notices.map((n) => (
                  <li key={n.key} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 text-sm text-text">{n.label}</span>
                    <span className="shrink-0 text-xs whitespace-nowrap text-muted">{dayMonthYear(n.sentAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function SubscriptionRow({ sub: s, billing, caps, closed }: { sub: SubView; billing: BillingPanel; caps: Caps; closed: boolean }) {
  const gateway = atGateway(s.gateway) ? s.gateway : null;
  const trialEnd = s.trialEndsAt && (s.status === "TRIALING" || !s.currentPeriodEnd) ? s.trialEndsAt : null;
  const periodEnd = trialEnd ?? s.currentPeriodEnd;
  return (
    <Tr>
      <Td nowrap className="font-medium">
        {s.kind}
      </Td>
      <Td>
        <LabelPill map={SUBSCRIPTION_STATUS} value={s.status} />
      </Td>
      <Td>
        {s.items.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <ul className="space-y-0.5">
            {s.items.map((item) => (
              <li key={item.id}>
                <span className="text-text">
                  {item.plan.name}
                  {item.quantity > 1 && <span className="ml-1 text-muted tabular-nums">×{item.quantity}</span>}
                </span>
                {item.price && (
                  <span className="ml-1.5 text-[11px] whitespace-nowrap text-subtle tabular-nums">
                    {`${formatMoney(item.price.amount, item.price.currency)} a ${intervalLabel(item.price.interval)}${item.price.perSeat ? " per seat" : ""}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Td>
      <Td muted nowrap>
        {gateway ? `${intervalLabel(s.interval)} · ${s.currency ?? "—"}` : "—"}
      </Td>
      <Td nowrap>
        {periodEnd ? (
          <>
            <span className="text-text">{dayMonthYear(periodEnd)}</span>
            {trialEnd && <span className="ml-1.5 text-[11px] text-subtle">trial</span>}
          </>
        ) : (
          <span className="text-muted">—</span>
        )}
        {s.status === "CANCELLED" && s.cancelledAt && <span className="block text-[11px] text-subtle">{`cancelled ${dayMonthYear(s.cancelledAt)}`}</span>}
      </Td>
      <Td>{s.cancelAtPeriodEnd ? <StatusPill tone={ENDS_AT_PERIOD_END.tone}>{ENDS_AT_PERIOD_END.label}</StatusPill> : <span className="text-muted">—</span>}</Td>
      <Td nowrap>{s.pastDueSince ? <span className="text-danger">{dayMonthYear(s.pastDueSince)}</span> : <span className="text-muted">—</span>}</Td>
      <Td className="min-w-56">
        {gateway && s.externalId ? (
          <CopyField
            value={s.externalId}
            label="subscription ID"
            href={caps.sell ? gatewayDashboardUrl(gateway, "subscription", s.externalId, modeOf(gateway, billing)) : undefined}
            hrefLabel="Dashboard"
          />
        ) : (
          <span className="text-muted">{gateway ? "Not made there yet" : "—"}</span>
        )}
      </Td>
      <Td muted nowrap>
        {s.syncedAt ? <RelativeTime at={s.syncedAt} /> : "—"}
      </Td>
      {caps.sell && !closed && <RowActionsCell>{gateway && s.externalId ? <ResyncButton subscriptionId={s.id} externalId={s.externalId} /> : null}</RowActionsCell>}
    </Tr>
  );
}

function CustomerId({ gateway, id, billing, caps }: { gateway: "STRIPE" | "RAZORPAY"; id: string | null; billing: BillingPanel; caps: Caps }) {
  if (!id) return <span className="text-muted">None</span>;
  return (
    <CopyField
      value={id}
      label={`${gatewayLabel(gateway)} customer ID`}
      href={caps.sell ? gatewayDashboardUrl(gateway, "customer", id, modeOf(gateway, billing)) : undefined}
      hrefLabel="Dashboard"
    />
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <OutboundLink href={href} className="inline-flex items-center gap-0.5 rounded-base text-xs font-medium text-brand hover:underline">
      {children}
      <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only"> (opens in a new tab)</span>
    </OutboundLink>
  );
}
