import Link from "next/link";
import { Check } from "lucide-react";
import type { PricingTableProps, SiteRenderContext } from "@/components/site/blocks/types";
import { CountryPicker } from "@/components/site/forms/country-picker";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container } from "@/components/site/ui";
import { gatewayFor, type OfferPlan, type OfferPrice } from "@/lib/billing/checkout";
import { formatMoney } from "@/lib/billing/money";
import { soldIn, withDependencies } from "@/lib/entitlements";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { MODULE_REGISTRY } from "@/lib/modules";
import { publicOffer, type PublicOffer } from "@/lib/platform/public-offer";
import { cn } from "@/lib/utils";

/**
 * The plans on sale, live from the control plane, for the country in the address (`?country=`, India
 * by default) — through its gateway and in its one currency (src/lib/platform/public-offer.ts). Prices
 * are shown as the gateway will charge them, never converted. `?interval=YEAR` shows yearly prices
 * where plans have them.
 */

const INTERVALS = ["MONTH", "YEAR"] as const;
type Interval = (typeof INTERVALS)[number];
const PER: Record<Interval, string> = { MONTH: "month", YEAR: "year" };

const money = (amount: number, currency: string) => formatMoney(amount, currency).replace(/\.00$/, "");

/** What every workspace has whatever its plan: the core modules and the every-plan ones (src/lib/modules.ts). */
const BASICS = (() => {
  const labels = MODULE_REGISTRY.filter((m) => m.core || m.inEveryPlan).map((m) => m.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "");
})();

/** The modules a plan names, with what they need — the core and every-plan ones left out, as every plan has them. */
function planModules(plan: OfferPlan, country: string): { all: boolean; labels: string[] } {
  if (plan.modules.includes("all")) return { all: true, labels: [] };
  const keys = withDependencies(plan.modules);
  return { all: false, labels: MODULE_REGISTRY.filter((m) => keys.has(m.key) && !m.core && !m.inEveryPlan && soldIn(m, country)).map((m) => m.label) };
}

function priceFor(plan: OfferPlan, interval: Interval): OfferPrice | undefined {
  return plan.prices.find((p) => p.interval === interval) ?? plan.prices[0];
}

/** How much a year costs against twelve months, when both are sold the same way. */
function yearlySaving(plan: OfferPlan): number | null {
  const month = plan.prices.find((p) => p.interval === "MONTH");
  const year = plan.prices.find((p) => p.interval === "YEAR" && p.perSeat === month?.perSeat);
  if (!month || !year || month.amount <= 0) return null;
  const pct = Math.round((1 - year.amount / (month.amount * 12)) * 100);
  return pct >= 1 ? pct : null;
}

function seatsLine(plan: OfferPlan, price: OfferPrice | undefined): string {
  if (price?.perSeat) return "Priced per person";
  if (plan.seats === null) return "No limit on people";
  return `${plan.seats} ${plan.seats === 1 ? "person" : "people"} included`;
}

export async function PricingTableBlock({ props, ctx }: { props: PricingTableProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const asked = String(ctx.searchParams.country ?? "IN").trim().toUpperCase();
  const country = WORLD_COUNTRIES.find((c) => c.code === asked) ?? WORLD_COUNTRIES.find((c) => c.code === "IN")!;

  let offer: PublicOffer;
  try {
    offer = await publicOffer(country.code);
  } catch (err) {
    console.warn(`[site] prices unavailable: ${err instanceof Error ? err.name : "error"}`);
    const gateway = gatewayFor(country.code);
    offer = { gateway, currency: gateway === "RAZORPAY" ? "INR" : "USD", plans: [], trialDays: ctx.trialDays };
  }

  const sold = INTERVALS.filter((i) => offer.plans.some((p) => p.prices.some((x) => x.interval === i)));
  const wanted = String(ctx.searchParams.interval ?? "").toUpperCase();
  const interval: Interval = sold.find((i) => i === wanted) ?? sold[0] ?? "MONTH";
  const editions = offer.plans.filter((p) => p.kind === "EDITION");
  const extras = offer.plans.filter((p) => p.kind !== "EDITION");
  const signup = resolveAction({ kind: "signup" }, ctx);
  const empty = props.emptyAction ? resolveAction(props.emptyAction, ctx) : null;
  const query = (i: Interval) => `?${new URLSearchParams({ country: country.code, interval: i }).toString()}`;

  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <CountryPicker label={t(props.countryLabel)} countries={WORLD_COUNTRIES.map(({ code, name }) => ({ code, name }))} value={country.code} interval={sold.length > 1 ? interval : null} />
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>
              Prices in <span className="font-semibold text-text">{offer.currency}</span>, paid through {offer.gateway === "RAZORPAY" ? "Razorpay" : "Stripe"}
            </span>
            {sold.length > 1 && (
              <nav aria-label="Billing period" className="inline-flex rounded-base border border-line bg-surface-sunken p-0.5">
                {sold.map((i) => (
                  <Link
                    key={i}
                    href={query(i)}
                    aria-current={i === interval ? "page" : undefined}
                    className={cn("rounded-[6px] px-3 py-1 text-[13px] font-medium transition-colors", i === interval ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
                    scroll={false}
                  >
                    {i === "MONTH" ? "Monthly" : "Yearly"}
                  </Link>
                ))}
              </nav>
            )}
          </div>
        </div>

        {!offer.plans.length ? (
          <div className="mt-10 rounded-2xl border border-dashed border-line-strong bg-surface-sunken px-6 py-14 text-center">
            <h2 className="text-xl font-semibold text-text">{t(props.emptyHeading)}</h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted">{t(props.emptyBody)}</p>
            {empty && <ButtonLink href={empty.href} label={empty.label} className="mt-6" arrow />}
          </div>
        ) : (
          <>
            {!!editions.length && (
              <>
                <h2 className="mt-12 text-2xl font-semibold tracking-tight text-text">{t(props.editionsHeading)}</h2>
                <ul className={cn("mt-6 grid gap-6", editions.length === 1 ? "max-w-md" : editions.length === 2 ? "md:grid-cols-2" : "md:grid-cols-2 lg:grid-cols-3")}>
                  {editions.map((plan) => {
                    const price = priceFor(plan, interval);
                    const modules = planModules(plan, country.code);
                    const saving = interval === "YEAR" ? yearlySaving(plan) : null;
                    return (
                      <li key={plan.key} className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="text-lg font-semibold text-text">{plan.name}</h3>
                          {saving && <span className="shrink-0 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success">Save {saving}%</span>}
                        </div>
                        {plan.description && <p className="mt-2 text-sm leading-6 text-muted">{plan.description}</p>}
                        {price && (
                          <p className="mt-6 flex flex-wrap items-baseline gap-x-1.5">
                            <span className="text-4xl font-semibold tracking-tight text-text tabular-nums">{money(price.amount, offer.currency)}</span>
                            <span className="text-sm text-muted">
                              {price.perSeat ? "per person / " : "/ "}
                              {PER[price.interval as Interval] ?? "month"}
                            </span>
                          </p>
                        )}
                        <p className="mt-1 text-sm text-muted">{seatsLine(plan, price)}</p>
                        <ButtonLink href={signup.href} label={signup.label} className="mt-6 h-10 w-full" />
                        <div className="mt-6 border-t border-line pt-6">
                          <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Includes</p>
                          <ul className="mt-3 space-y-2.5">
                            {modules.all ? (
                              <PlanLine>{country.code === "IN" ? "Every module" : `Every module offered in ${country.name}`}</PlanLine>
                            ) : (
                              modules.labels.map((label) => <PlanLine key={label}>{label}</PlanLine>)
                            )}
                            {BASICS && <PlanLine muted>{`Always: ${BASICS}`}</PlanLine>}
                          </ul>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {!!extras.length && (
              <>
                <h2 className="mt-14 text-2xl font-semibold tracking-tight text-text">{t(props.extrasHeading)}</h2>
                {props.extrasIntro && <p className="mt-2 text-sm text-muted">{t(props.extrasIntro)}</p>}
                <ul className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {extras.map((plan) => {
                    const price = priceFor(plan, interval);
                    const modules = planModules(plan, country.code);
                    return (
                      <li key={plan.key} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                        <div className="min-w-0">
                          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
                            {plan.name}
                            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-muted">{plan.kind === "BUNDLE" ? "Bundle" : "Add-on"}</span>
                          </h3>
                          {plan.description && <p className="mt-1 text-sm leading-6 text-muted">{plan.description}</p>}
                          {(modules.all || modules.labels.length > 0) && <p className="mt-1 text-xs text-subtle">{modules.all ? "Every module" : modules.labels.join(" · ")}</p>}
                        </div>
                        {price && (
                          <p className="shrink-0 text-sm text-muted sm:text-right">
                            <span className="text-lg font-semibold text-text tabular-nums">{money(price.amount, offer.currency)}</span>{" "}
                            {price.perSeat ? "per person / " : "/ "}
                            {PER[price.interval as Interval] ?? "month"}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}

        {(props.trialNote || props.footnote) && (
          <div className="mt-8 space-y-1 text-sm text-muted">
            {props.trialNote && <p>{t(props.trialNote)}</p>}
            {props.footnote && <p>{t(props.footnote)}</p>}
          </div>
        )}
      </Container>
    </section>
  );
}

function PlanLine({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <li className={cn("flex gap-2.5 text-sm leading-6", muted ? "text-muted" : "text-text")}>
      <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-brand" />
      <span>{children}</span>
    </li>
  );
}
