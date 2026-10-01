"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { cancelSubscription, checkoutPlan, openBillingPortal, saveBillingDetails } from "@/actions/billing";
import type { OfferPlan } from "@/lib/billing/checkout";
import { formatMoney } from "@/lib/billing/money";
import { SUITE_NAME, choiceRefusal, needsRefusal } from "@/lib/billing/plan-choice";
import { COMPANY_NAME } from "@/lib/brand-names";
import { PRODUCTS, productByKey } from "@/lib/products";
import { cn } from "@/lib/utils";

/** The billing page's forms (src/actions/billing.ts): choosing a plan, the gateways' own pages, details. */

/** Off to a gateway's page: another site, so the browser goes itself. */
function go(url: string) {
  window.location.assign(new URL(url));
}

type Interval = "MONTH" | "YEAR";
type EditionGroup = { key: string; title: string; tagline: string | null; plans: OfferPlan[] };

/**
 * The editions on sale, grouped as they are sold: Deskzo One first, then each product in
 * src/lib/products.ts's order, then editions of no product. Empty groups are left out.
 */
function editionGroups(editions: OfferPlan[]): EditionGroup[] {
  const groups: EditionGroup[] = PRODUCTS.map((p) => ({ key: p.key, title: p.name, tagline: p.tagline, plans: editions.filter((e) => e.productKey === p.key) }));
  groups.push({ key: "own", title: "Editions", tagline: null, plans: editions.filter((e) => !productByKey(e.productKey)) });
  return groups.filter((g) => g.plans.length > 0);
}

/**
 * Deskzo One, or any number of products — one plan each — or an edition of its own; then extras.
 * Ticking a plan unticks what cannot come with it (another plan of its product; everything, for
 * Deskzo One or an edition of its own), so the ticks always make a choice that can be bought. The
 * rules and their words are src/lib/billing/plan-choice.ts's — checkout says the same.
 */
export function PlanPicker({ plans, currency, gateway }: { plans: OfferPlan[]; currency: string; gateway: "STRIPE" | "RAZORPAY" }) {
  const intervals = [...new Set(plans.flatMap((p) => p.prices.map((x) => x.interval)))];
  const [interval, setBilled] = useState<Interval>(intervals.includes("MONTH") ? "MONTH" : "YEAR");
  const priceOf = (plan: OfferPlan) => plan.prices.find((x) => x.interval === interval);
  const editions = plans.filter((p) => p.kind === "EDITION" && !!priceOf(p));
  const extras = plans.filter((p) => p.kind !== "EDITION" && !!priceOf(p));
  const groups = editionGroups(editions);
  const [picked, setPicked] = useState<string[]>(() => {
    const first = editionGroups(plans.filter((p) => p.kind === "EDITION" && p.prices.some((x) => x.interval === interval)))[0]?.plans[0];
    return first ? [first.key] : [];
  });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<{ plan: string; url: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const per = interval === "YEAR" ? "a year" : "a month";

  // What is chosen at this interval: the ticked editions on sale in it, and every extra with a number.
  const chosenEditions = editions.filter((p) => picked.includes(p.key));
  const countOf = (plan: OfferPlan, fallback: number) => {
    const n = Number(quantities[plan.key] ?? fallback);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const lines = [
    ...chosenEditions.map((plan) => ({ plan, quantity: priceOf(plan)!.perSeat ? Math.max(1, countOf(plan, 1)) : 1 })),
    ...extras.map((plan) => ({ plan, quantity: countOf(plan, 0) })).filter((l) => l.quantity > 0),
  ];
  const total = lines.reduce((sum, l) => sum + priceOf(l.plan)!.amount * l.quantity, 0);
  const suiteChosen = chosenEditions.some((p) => p.productKey === "one");

  function pick(plan: OfferPlan, on: boolean) {
    setError(null);
    setPicked((prev) => {
      if (!on) return prev.filter((k) => k !== plan.key);
      const alone = !plan.productKey || plan.productKey === "one";
      const kept = prev.filter((k) => {
        const other = plans.find((p) => p.key === k);
        if (!other || alone) return false;
        return !!other.productKey && other.productKey !== "one" && other.productKey !== plan.productKey;
      });
      return [...kept, plan.key];
    });
  }

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
  if (!plans.some((p) => p.kind === "EDITION")) return <p className="text-sm text-muted">No plan is on sale here yet. Contact {COMPANY_NAME} to choose one.</p>;
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const refusal = choiceRefusal(lines.map((l) => l.plan));
        if (refusal) return setError(refusal);
        const items = lines.map((l) => ({ planKey: l.plan.key, quantity: l.quantity }));
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
      <p className="text-xs text-muted">
        Choose {SUITE_NAME}, or the products you want — one plan for each. {SUITE_NAME} already includes every product.
      </p>
      {!editions.length && <p className="text-sm text-muted">Nothing is sold {interval === "YEAR" ? "yearly" : "monthly"} here — try the other period.</p>}
      {groups.map((group) => (
        <fieldset key={group.key} className="space-y-2">
          <legend className="text-sm font-semibold text-text">{group.title}</legend>
          {group.tagline && <p className="-mt-1 text-xs text-muted">{group.tagline}</p>}
          {suiteChosen && group.key !== "one" && group.key !== "own" && <p className="text-xs text-subtle">Included in {SUITE_NAME}.</p>}
          {group.plans.map((p) => {
            const price = priceOf(p)!;
            const on = picked.includes(p.key);
            return (
              <label key={p.key} className={cn("flex items-start gap-3 rounded-base border px-3 py-2 text-sm", on ? "border-brand bg-brand-subtle/40" : "border-line")}>
                <input type="checkbox" className="mt-1" checked={on} onChange={(e) => pick(p, e.target.checked)} />
                <span className="flex-1">
                  <span className="font-medium text-text">{p.name}</span>{" "}
                  <span className="text-muted">
                    {formatMoney(price.amount, currency)} {price.perSeat ? "per person " : ""}
                    {per}
                    {p.seats !== null && !price.perSeat ? `, ${p.seats} people included` : ""}
                  </span>
                  {p.description && p.description !== group.tagline && <span className="block text-xs text-muted">{p.description}</span>}
                </span>
                {price.perSeat && on && (
                  <Input className="h-8 w-20" type="number" min={1} aria-label={`People on ${p.name}`} value={quantities[p.key] ?? "1"} onChange={(e) => setQuantities((q) => ({ ...q, [p.key]: e.target.value }))} />
                )}
              </label>
            );
          })}
        </fieldset>
      ))}
      {extras.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold text-text">Add-ons — how many of each (none is fine)</legend>
          {extras.map((p) => {
            const price = priceOf(p)!;
            const needs = needsRefusal(p, chosenEditions);
            return (
              <div key={p.key} className="text-sm">
                <div className="flex items-center gap-3">
                  <Input className="h-8 w-20" type="number" min={0} aria-label={`How many of ${p.name}`} value={quantities[p.key] ?? "0"} onChange={(e) => setQuantities((q) => ({ ...q, [p.key]: e.target.value }))} />
                  <span className="text-text">{p.name}</span>
                  <span className="text-muted">
                    {formatMoney(price.amount, currency)} each, {per}
                  </span>
                </div>
                {needs && <p className="mt-1 pl-[92px] text-xs text-warning">{needs}</p>}
              </div>
            );
          })}
        </fieldset>
      )}
      <p className="text-sm text-text" aria-live="polite">
        {lines.length ? (
          <>
            Total <span className="font-semibold tabular-nums">{formatMoney(total, currency)}</span> {per}, before tax — {lines.map((l) => (l.quantity > 1 ? `${l.plan.name} ×${l.quantity}` : l.plan.name)).join(", ")}.
          </>
        ) : (
          <span className="text-muted">Nothing chosen yet.</span>
        )}
      </p>
      <p className="text-xs text-muted">
        {gateway === "STRIPE" ? "Paid by card through Stripe; tax is added as your country requires, and your tax number goes on every invoice." : "Paid through Razorpay, in rupees, by card, UPI or netbanking mandate."}
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending || chosenEditions.length === 0}>
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
