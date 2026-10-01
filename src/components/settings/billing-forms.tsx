"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { cancelSubscription, checkoutPlan, openBillingPortal, saveBillingDetails } from "@/actions/billing";
import type { OfferPlan } from "@/lib/billing/checkout";
import { formatMoney } from "@/lib/billing/money";

/** The billing page's forms (src/actions/billing.ts): choosing a plan, the gateways' own pages, details. */

/** Off to a gateway's page: another site, so the browser goes itself. */
function go(url: string) {
  window.location.assign(new URL(url));
}

export function PlanPicker({ plans, currency, gateway }: { plans: OfferPlan[]; currency: string; gateway: "STRIPE" | "RAZORPAY" }) {
  const intervals = [...new Set(plans.flatMap((p) => p.prices.map((x) => x.interval)))];
  const [interval, setBilled] = useState<"MONTH" | "YEAR">(intervals.includes("MONTH") ? "MONTH" : "YEAR");
  const editions = plans.filter((p) => p.kind === "EDITION" && p.prices.some((x) => x.interval === interval));
  const extras = plans.filter((p) => p.kind !== "EDITION" && p.prices.some((x) => x.interval === interval));
  const [edition, setEdition] = useState(editions[0]?.key ?? "");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<{ plan: string; url: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const priceOf = (plan: OfferPlan) => plan.prices.find((x) => x.interval === interval);
  const per = interval === "YEAR" ? "a year" : "a month";

  if (pages) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-text">Authorise each payment on Razorpay&apos;s page. The workspace updates by itself once each is done.</p>
        {pages.map((p) => (
          <OutboundLink key={p.url} href={p.url} className="block font-medium text-brand hover:underline">
            Pay for {p.plan}
          </OutboundLink>
        ))}
      </div>
    );
  }
  if (!editions.length) return <p className="text-sm text-muted">No plan is on sale here yet. Contact Deskzo to choose one.</p>;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const items = [
          { planKey: edition, quantity: Number(quantities[edition] || 1) },
          ...Object.entries(quantities)
            .filter(([key, q]) => key !== edition && extras.some((x) => x.key === key) && Number(q) > 0)
            .map(([planKey, q]) => ({ planKey, quantity: Number(q) })),
        ];
        startTransition(async () => {
          const r = await checkoutPlan({ interval, items });
          if (!r.ok) return setError(r.error);
          if (r.data.gateway === "STRIPE") go(r.data.url);
          else setPages(r.data.authorisations);
        });
      }}
    >
      {intervals.length > 1 && (
        <div className="inline-flex rounded-base border border-line p-0.5 text-sm" role="radiogroup" aria-label="Billed">
          {(["MONTH", "YEAR"] as const).map((i) => (
            <button key={i} type="button" role="radio" aria-checked={interval === i} onClick={() => setBilled(i)} className={interval === i ? "rounded-base bg-brand-subtle px-3 py-1 font-medium text-brand" : "px-3 py-1 text-muted"}>
              {i === "YEAR" ? "Yearly" : "Monthly"}
            </button>
          ))}
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs text-muted">Edition</legend>
        {editions.map((p) => {
          const price = priceOf(p)!;
          return (
            <label key={p.key} className="flex items-start gap-3 rounded-base border border-line px-3 py-2 text-sm">
              <input type="radio" name="edition" className="mt-1" checked={edition === p.key} onChange={() => setEdition(p.key)} />
              <span className="flex-1">
                <span className="font-medium text-text">{p.name}</span>{" "}
                <span className="text-muted">
                  {formatMoney(price.amount, currency)} {price.perSeat ? "per person " : ""}
                  {per}
                  {p.seats !== null && !price.perSeat ? `, ${p.seats} people included` : ""}
                </span>
                {p.description && <span className="block text-xs text-muted">{p.description}</span>}
              </span>
              {price.perSeat && edition === p.key && (
                <Input className="h-8 w-20" type="number" min={1} aria-label="People" value={quantities[p.key] ?? "1"} onChange={(e) => setQuantities((q) => ({ ...q, [p.key]: e.target.value }))} />
              )}
            </label>
          );
        })}
      </fieldset>
      {extras.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs text-muted">Add-ons — how many of each (none is fine)</legend>
          {extras.map((p) => {
            const price = priceOf(p)!;
            return (
              <div key={p.key} className="flex items-center gap-3 text-sm">
                <Input className="h-8 w-20" type="number" min={0} aria-label={`How many of ${p.name}`} value={quantities[p.key] ?? "0"} onChange={(e) => setQuantities((q) => ({ ...q, [p.key]: e.target.value }))} />
                <span className="text-text">{p.name}</span>
                <span className="text-muted">
                  {formatMoney(price.amount, currency)} each, {per}
                </span>
              </div>
            );
          })}
        </fieldset>
      )}
      <p className="text-xs text-muted">
        {gateway === "STRIPE" ? "Paid by card through Stripe; tax is added as your country requires, and your tax number goes on every invoice." : "Paid through Razorpay, in rupees, by card, UPI or netbanking mandate."}
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending || !edition}>
        {pending ? "Opening…" : "Continue to payment"}
      </Button>
    </form>
  );
}

export function ManageAtStripe() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await openBillingPortal();
            if (r.ok) go(r.data.url);
            else setError(r.error);
          })
        }
      >
        {pending ? "Opening…" : "Manage billing"}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

export function CancelRazorpay({ subscriptionId, plan }: { subscriptionId: string; plan: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Cancel ${plan}? It runs to the end of the period already paid for, and does not renew.`)) return;
          startTransition(async () => {
            const r = await cancelSubscription(subscriptionId);
            if (r.ok) router.refresh();
            else setError(r.error);
          });
        }}
      >
        Cancel at period end
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

export function BillingDetailsForm({ billingEmail, taxId, taxLabel }: { billingEmail: string | null; taxId: string | null; taxLabel: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(billingEmail ?? "");
  const [tax, setTax] = useState(taxId ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        startTransition(async () => {
          const r = await saveBillingDetails({ billingEmail: email, taxId: tax });
          setMessage(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.error });
          if (r.ok) router.refresh();
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="billing-email">Billing email (reminders and receipts)</Label>
          <Input id="billing-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="The owner's, when empty" />
        </div>
        <div>
          <Label htmlFor="billing-tax">{taxLabel}</Label>
          <Input id="billing-tax" value={tax} onChange={(e) => setTax(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>}
      </div>
    </form>
  );
}
