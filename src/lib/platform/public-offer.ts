import { gatewayFor, type Gateway, type OfferPlan } from "@/lib/billing/checkout";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { trialDays } from "@/lib/platform/settings";

/**
 * What is on sale in a country, for the public pricing page — `offerFor` in src/lib/billing/checkout.ts
 * without a workspace: the country is the visitor's choice rather than a workspace's.
 *
 *   · The gateway follows the country (`gatewayFor`): Razorpay in India, Stripe everywhere else.
 *   · One currency, never mixed or converted: rupees at Razorpay; at Stripe, US dollars — unless every
 *     price on offer is in one other currency, which is then the one shown.
 *   · Plans offered there (everywhere, or naming the country), still sold (`active`), of a kind that is
 *     sold at all (never INTERNAL), with an active price at the gateway in that currency.
 *
 * Read narrowly: no gateway ids (`externalId`), nothing about any workspace.
 */

export type PublicOffer = { gateway: Gateway; currency: string; plans: OfferPlan[]; trialDays: number };

export async function publicOffer(country: string): Promise<PublicOffer> {
  const code = String(country ?? "").trim().toUpperCase();
  const gateway = gatewayFor(code);
  if (!controlConfigured()) return { gateway, currency: gateway === "RAZORPAY" ? "INR" : "USD", plans: [], trialDays: 14 };

  const [rows, days] = await Promise.all([
    controlDb().plan.findMany({
      where: { active: true, kind: { in: ["EDITION", "BUNDLE", "ADDON"] }, OR: [{ countries: { isEmpty: true } }, { countries: { has: code } }] },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        kind: true,
        productKey: true,
        description: true,
        seats: true,
        allModules: true,
        modules: { select: { moduleKey: true } },
        prices: { where: { gateway, active: true }, select: { id: true, currency: true, interval: true, amount: true, perSeat: true }, orderBy: { amount: "asc" } },
      },
    }),
    trialDays(),
  ]);

  const currencies = new Set(rows.flatMap((p) => p.prices.map((x) => x.currency.toUpperCase())));
  const currency = gateway === "RAZORPAY" ? "INR" : currencies.size === 1 ? [...currencies][0]! : "USD";
  const plans: OfferPlan[] = rows
    .map((p) => ({
      key: p.key,
      name: p.name,
      kind: p.kind as OfferPlan["kind"],
      productKey: p.productKey,
      description: p.description,
      seats: p.seats,
      modules: p.allModules ? ["all"] : p.modules.map((m) => m.moduleKey),
      prices: p.prices
        .filter((x) => x.currency.toUpperCase() === currency)
        .map((x) => ({ id: x.id, currency, interval: x.interval, amount: x.amount, perSeat: x.perSeat })),
    }))
    .filter((p) => p.prices.length > 0);
  return { gateway, currency, plans, trialDays: days };
}
