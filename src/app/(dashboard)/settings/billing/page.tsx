import { notFound } from "next/navigation";
import { getBilling, type BillingView } from "@/actions/billing";
import { SettingsPage } from "@/components/settings/settings-page";
import { BillingDetailsForm, CancelRazorpay, ManageAtStripe, PlanPicker, WaitForPayment } from "@/components/settings/billing-forms";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatMoney } from "@/lib/billing/money";
import { clockOfTenant } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { partnerShownToCustomer } from "@/lib/partners/customer-facing";
import { COMPANY_NAME } from "@/lib/brand-names";
import { currentTenant } from "@/lib/tenancy/resolve";
import { AiCreditsCard } from "@/components/settings/ai-credit-packs";

/** Where this workspace stands, in a sentence — its dates on the workspace's own clock. */
function standingText(view: BillingView, clock: Clock): { tone: "green" | "amber" | "red" | "blue" | "default"; text: string } {
  const s = view.standing;
  if (view.held) return { tone: "red", text: "The workspace is held until a plan is paid for. Nothing has been deleted — paying opens it again at once." };
  switch (s.kind) {
    case "exempt":
      return { tone: "default", text: `Your plan is looked after by ${COMPANY_NAME} — there is nothing to pay here.` };
    case "paid":
      // Paid offline (a bank transfer, a distributor): until a date, renewed by paying the next period.
      return { tone: "green", text: s.renewBy ? `Paid up until ${clock.date(s.renewBy)}.` : "Paid up." };
    case "trial":
      return { tone: "blue", text: `On a free trial until ${clock.date(s.endsAt)}.` };
    case "trial-over":
      return { tone: "amber", text: `The trial has ended. Choose a plan by ${clock.date(s.holdAt)}, or the workspace is held.` };
    case "past-due":
      return { tone: "amber", text: `A payment has failed and is being retried. Unless it is paid by ${clock.date(s.holdAt)}, the workspace is held.` };
    case "ending":
      return { tone: "amber", text: `Cancelled: it runs until ${clock.date(s.holdAt)} and does not renew.` };
    case "lapsed":
      return { tone: "red", text: "No plan is paid for." };
    default:
      return { tone: "default", text: `No plan yet. Contact ${COMPANY_NAME} to be put on one.` };
  }
}

/**
 * The workspace's plan and billing — its owner's, and whoever they let manage billing (src/actions/
 * billing.ts); anybody else gets a 404, as every refused page does. Reachable while the workspace is held
 * for billing, so it can be paid for and opened again (src/proxy.ts). Paying through Razorpay, the plans
 * or people change from the next renewal; in India, a proforma can be asked for to pay by bank transfer.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; credits?: string }> }) {
  const view = await getBilling();
  if (!view) notFound();
  const search = await searchParams;
  const justPaid = search.checkout === "done";
  const tenant = await currentTenant();
  const { id: tenantId, country } = tenant;
  const clock = clockOfTenant(tenant);
  // The partner that sold this workspace, named but read-only: moving a workspace to another partner
  // is a staff act with a reason (spec §4.4), so there is nothing here to change it. It never throws
  // and waits 1.5 s at most; without an answer the line is simply left out.
  const partner = await partnerShownToCustomer(tenantId).catch(() => null);
  const standing = standingText(view, clock);
  const paying = view.subscriptions.some((s) => s.gateway !== "MANUAL");
  const mayBuy = !paying && view.standing.kind !== "exempt";
  // Paying through Razorpay now (not a change waiting to start): its plans change from the next renewal.
  const razorpayNow = view.subscriptions.filter((s) => s.gateway === "RAZORPAY" && !s.startsAt && (s.status === "ACTIVE" || s.status === "PAST_DUE"));
  const renewsOn = razorpayNow.map((s) => s.currentPeriodEnd).filter((d): d is string => !!d).sort().at(-1) ?? null;
  const changeWaiting = view.subscriptions.some((s) => !!s.startsAt) || view.authorisations.some((a) => !!a.startsAt);
  // Paid by bank transfer: the next period by another proforma.
  const offline = view.subscriptions.find((s) => s.gateway === "OFFLINE");
  const onlyOffline = !!offline && view.subscriptions.every((s) => s.gateway === "OFFLINE" || s.gateway === "MANUAL");
  const asItIs = (subs: BillingView["subscriptions"]) => {
    const first = subs[0];
    if (!first) return null;
    return { interval: (first.interval === "YEAR" ? "YEAR" : "MONTH") as "MONTH" | "YEAR", items: subs.flatMap((s) => s.plans.map((p) => ({ planKey: p.key, quantity: p.quantity }))) };
  };
  return (
    <SettingsPage settingsKey="billing" description="Your plan, paying for it, and how much of it is in use.">
      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Your plan</span>
          {paying && view.canManageAtStripe && <ManageAtStripe />}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            <Badge tone={standing.tone}>{view.held ? "held" : view.standing.kind.replace("-", " ")}</Badge> <span className="ml-1 text-text">{standing.text}</span>
          </p>
          {justPaid && !paying && (
            <p className="rounded-base border border-info/30 bg-info-bg px-3 py-2 text-info">Payment received — the plan switches on as soon as the gateway confirms it, usually within a minute. This page updates by itself.</p>
          )}
          {((justPaid && !paying) || view.authorisations.length > 0) && <WaitForPayment />}
          {view.subscriptions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-base border border-line px-3 py-2">
              <span>
                <span className="font-medium text-text">{s.plans.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join(", ") || "—"}</span>
                <span className="block text-xs text-muted">
                  {s.gateway === "MANUAL"
                    ? s.status === "TRIALING"
                      ? "Free trial"
                      : `Given by ${COMPANY_NAME}`
                    : s.gateway === "OFFLINE"
                      ? "Paid by bank transfer"
                      : `${s.gateway === "STRIPE" ? "Stripe" : "Razorpay"}, ${s.interval === "YEAR" ? "yearly" : "monthly"}`}
                  {s.status === "PAST_DUE" && " — payment overdue"}
                  {s.startsAt
                    ? ` — authorised, starts ${clock.date(s.startsAt)}`
                    : s.currentPeriodEnd &&
                      (s.gateway === "OFFLINE" ? ` — paid until ${clock.date(s.currentPeriodEnd)}` : ` — ${s.cancelAtPeriodEnd ? (changeWaiting ? "replaced" : "ends") : "renews"} ${clock.date(s.currentPeriodEnd)}`)}
                </span>
              </span>
              {s.gateway === "RAZORPAY" && !s.cancelAtPeriodEnd && !s.startsAt && <CancelRazorpay subscriptionId={s.id} plan={s.plans[0]?.name ?? "this plan"} />}
            </div>
          ))}
          {view.authorisations.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted">
                {view.authorisations.some((a) => a.startsAt)
                  ? `Waiting for you to authorise on Razorpay — the change starts ${clock.date(view.authorisations.find((a) => a.startsAt)!.startsAt!)}, and nothing is charged until then:`
                  : "Waiting for you to authorise on Razorpay:"}
              </p>
              {view.authorisations.map((a) =>
                a.url ? (
                  <OutboundLink key={a.id} href={a.url} className="block font-medium text-brand hover:underline">
                    {a.startsAt ? `Authorise ${a.plan}` : `Pay for ${a.plan}`}
                  </OutboundLink>
                ) : (
                  <span key={a.id} className="block text-muted">
                    {a.plan}
                  </span>
                ),
              )}
            </div>
          )}
          {partner && <p className="text-muted">Sold and supported by {partner.displayName}.</p>}
          <p className="text-xs text-muted">
            People with an account: {view.usage.seatsUsed}
            {view.usage.seatsLimit !== null && !view.held ? ` of ${view.usage.seatsLimit}` : ""}
          </p>
        </CardContent>
      </Card>

      {!view.held && <AiCreditsCard credits={view.aiCredits} justBought={search.credits === "done"} />}

      {mayBuy && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Choose a plan</CardHeader>
          <CardContent>
            <PlanPicker plans={view.offer} currency={view.currency} gateway={view.gateway} bankTransfer={view.bankTransfer} />
          </CardContent>
        </Card>
      )}

      {razorpayNow.length > 0 && renewsOn && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Change plan or people</CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">
              The change starts when the current plans renew, on {clock.date(renewsOn)} — Razorpay can&apos;t change a UPI or mandate payment part-way. Need more people before then? Write to us.
            </p>
            <PlanPicker plans={view.offer} currency={view.currency} gateway={view.gateway} mode="change" renewsOn={renewsOn} initial={asItIs(razorpayNow)} />
          </CardContent>
        </Card>
      )}

      {onlyOffline && view.bankTransfer && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Pay the next period by bank transfer</CardHeader>
          <CardContent>
            <PlanPicker plans={view.offer} currency={view.currency} gateway={view.gateway} mode="transfer" initial={offline ? asItIs([offline]) : null} />
          </CardContent>
        </Card>
      )}

      {view.proformas.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Proformas</CardHeader>
          <CardContent>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="py-1 font-medium">Number</th>
                  <th className="py-1 font-medium">Amount</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.proformas.map((p) => (
                  <tr key={p.id}>
                    <td className="py-1.5">{p.number}</td>
                    <td className="py-1.5">{formatMoney(p.total, "INR")}</td>
                    <td className="py-1.5 text-muted">
                      {p.status === "PAID" ? "paid" : p.status === "CANCELLED" ? "replaced or cancelled" : p.expired ? "expired — ask for a new one" : `waiting for the transfer, until ${clock.date(p.validUntil)}`}
                    </td>
                    <td className="py-1.5 text-right">
                      <OutboundLink href={p.url} className="text-brand hover:underline">
                        View
                      </OutboundLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Invoices</CardHeader>
        <CardContent>
          {view.invoices.length === 0 ? (
            <p className="text-sm text-muted">None yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="py-1 font-medium">Date</th>
                  <th className="py-1 font-medium">Number</th>
                  <th className="py-1 font-medium">Amount</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1.5 text-muted">{clock.date(i.issuedAt)}</td>
                    <td className="py-1.5">{i.number ?? "—"}</td>
                    <td className="py-1.5">{formatMoney(i.total, i.currency)}</td>
                    <td className="py-1.5">{i.status.toLowerCase()}</td>
                    <td className="py-1.5 text-right">
                      <span className="inline-flex flex-wrap justify-end gap-x-3">
                        {i.taxUrl && (
                          <OutboundLink href={i.taxUrl} className="text-brand hover:underline">
                            {`Tax invoice ${i.taxNumber}`}
                          </OutboundLink>
                        )}
                        {i.creditNotes.map((c) => (
                          <OutboundLink key={c.number} href={c.url} className="text-brand hover:underline">
                            {`Credit note ${c.number}`}
                          </OutboundLink>
                        ))}
                        {!i.taxUrl && (i.pdfUrl ?? i.hostedUrl) && (
                          <OutboundLink href={(i.pdfUrl ?? i.hostedUrl)!} className="text-brand hover:underline">
                            View
                          </OutboundLink>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Billing details</CardHeader>
        <CardContent>
          <BillingDetailsForm
            billingEmail={view.billingEmail}
            taxId={view.taxId}
            taxLabel={country === "IN" ? "GSTIN" : "VAT or tax number"}
            india={country === "IN"}
            billingName={view.billingName}
            billingAddress={view.billingAddress}
            billingState={view.billingState}
          />
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
