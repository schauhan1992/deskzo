import { getBilling, type BillingView } from "@/actions/billing";
import { SettingsPage } from "@/components/settings/settings-page";
import { BillingDetailsForm, CancelRazorpay, ManageAtStripe, PlanPicker } from "@/components/settings/billing-forms";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatMoney } from "@/lib/billing/money";
import { formatIstDate } from "@/lib/india-time";
import { currentTenant } from "@/lib/tenancy/resolve";

/** Where this workspace stands, in a sentence. */
function standingText(view: BillingView): { tone: "green" | "amber" | "red" | "blue" | "default"; text: string } {
  const s = view.standing;
  if (view.held) return { tone: "red", text: "The workspace is held until a plan is paid for. Nothing has been deleted — paying opens it again at once." };
  switch (s.kind) {
    case "exempt":
      return { tone: "default", text: "Your plan is looked after by Wroffy — there is nothing to pay here." };
    case "paid":
      return { tone: "green", text: "Paid up." };
    case "trial":
      return { tone: "blue", text: `On a free trial until ${formatIstDate(s.endsAt)}.` };
    case "trial-over":
      return { tone: "amber", text: `The trial has ended. Choose a plan by ${formatIstDate(s.holdAt)}, or the workspace is held.` };
    case "past-due":
      return { tone: "amber", text: `A payment has failed and is being retried. Unless it is paid by ${formatIstDate(s.holdAt)}, the workspace is held.` };
    case "ending":
      return { tone: "amber", text: `Cancelled: it runs until ${formatIstDate(s.holdAt)} and does not renew.` };
    case "lapsed":
      return { tone: "red", text: "No plan is paid for." };
    default:
      return { tone: "default", text: "No plan yet. Contact Wroffy to be put on one." };
  }
}

/**
 * The workspace's plan and billing — its owner's page (src/actions/billing.ts). Reachable while the
 * workspace is held for billing, so the owner can pay and open it again (src/proxy.ts).
 */
export default async function BillingPage() {
  const view = await getBilling();
  if (!view) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-semibold text-text">Plan &amp; billing</h1>
        <p className="mt-2 text-sm text-muted">Only the workspace owner manages its plan and billing.</p>
      </div>
    );
  }
  const { country } = await currentTenant();
  const standing = standingText(view);
  const paying = view.subscriptions.some((s) => s.gateway !== "MANUAL");
  const mayBuy = !paying && view.standing.kind !== "exempt";
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
          {view.subscriptions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-base border border-line px-3 py-2">
              <span>
                <span className="font-medium text-text">{s.plans.map((p) => (p.quantity > 1 ? `${p.name} ×${p.quantity}` : p.name)).join(", ") || "—"}</span>
                <span className="block text-xs text-muted">
                  {s.gateway === "MANUAL" ? (s.status === "TRIALING" ? "Free trial" : "Given by Wroffy") : `${s.gateway === "STRIPE" ? "Stripe" : "Razorpay"}, ${s.interval === "YEAR" ? "yearly" : "monthly"}`}
                  {s.status === "PAST_DUE" && " — payment overdue"}
                  {s.currentPeriodEnd && ` — ${s.cancelAtPeriodEnd ? "ends" : "renews"} ${formatIstDate(s.currentPeriodEnd)}`}
                </span>
              </span>
              {s.gateway === "RAZORPAY" && !s.cancelAtPeriodEnd && <CancelRazorpay subscriptionId={s.id} plan={s.plans[0]?.name ?? "this plan"} />}
            </div>
          ))}
          {view.authorisations.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted">Waiting for you to authorise on Razorpay:</p>
              {view.authorisations.map((a) =>
                a.url ? (
                  <OutboundLink key={a.id} href={a.url} className="block font-medium text-brand hover:underline">
                    Pay for {a.plan}
                  </OutboundLink>
                ) : (
                  <span key={a.id} className="block text-muted">
                    {a.plan}
                  </span>
                ),
              )}
            </div>
          )}
          <p className="text-xs text-muted">
            People with an account: {view.usage.seatsUsed}
            {view.usage.seatsLimit !== null ? ` of ${view.usage.seatsLimit}` : ""} · AI copilot this month: {view.usage.copilotUsed.toLocaleString("en-IN")} tokens
            {view.usage.copilotLimit !== null ? ` of ${view.usage.copilotLimit.toLocaleString("en-IN")}` : ""}
          </p>
        </CardContent>
      </Card>

      {mayBuy && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Choose a plan</CardHeader>
          <CardContent>
            <PlanPicker plans={view.offer} currency={view.currency} gateway={view.gateway} />
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
                    <td className="py-1.5 text-muted">{formatIstDate(i.issuedAt)}</td>
                    <td className="py-1.5">{i.number ?? "—"}</td>
                    <td className="py-1.5">{formatMoney(i.total, i.currency)}</td>
                    <td className="py-1.5">{i.status.toLowerCase()}</td>
                    <td className="py-1.5 text-right">
                      {(i.pdfUrl ?? i.hostedUrl) && (
                        <OutboundLink href={(i.pdfUrl ?? i.hostedUrl)!} className="text-brand hover:underline">
                          View
                        </OutboundLink>
                      )}
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
          <BillingDetailsForm billingEmail={view.billingEmail} taxId={view.taxId} taxLabel={country === "IN" ? "GSTIN" : "VAT or tax number"} />
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
