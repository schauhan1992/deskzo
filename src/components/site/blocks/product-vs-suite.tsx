import type { ProductVsSuiteProps, SiteRenderContext } from "@/components/site/blocks/types";
import { ProductVsSuiteView, type ProductVsSuiteOffer } from "@/components/site/blocks/product-vs-suite-view";
import type { OfferPlan } from "@/lib/billing/checkout";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { publicOffer } from "@/lib/platform/public-offer";

/**
 * A product beside Deskzo One (product-vs-suite-view.tsx), with the prices on sale for the country in
 * the address (`?country=`, India by default) — the same offer, gateway and currency as the pricing
 * table, never converted. Each side's price is its catalogue edition's (`deskzo-<product>`, src/lib/
 * platform/product-plans.ts), or the first edition of that product on sale. Without prices — none set
 * yet, or the control plane out of reach — the cards point to the pricing page.
 */
export async function ProductVsSuiteBlock({ props, ctx }: { props: ProductVsSuiteProps; ctx: SiteRenderContext }) {
  const asked = String(ctx.searchParams.country ?? "IN").trim().toUpperCase();
  const country = WORLD_COUNTRIES.find((c) => c.code === asked) ?? WORLD_COUNTRIES.find((c) => c.code === "IN")!;
  let plans: OfferPlan[] = [];
  let currency = "";
  try {
    const found = await publicOffer(country.code);
    plans = found.plans;
    currency = found.currency;
  } catch (err) {
    console.warn(`[site] prices unavailable: ${err instanceof Error ? err.name : "error"}`);
  }
  const editionOf = (key: string) => plans.find((p) => p.kind === "EDITION" && p.key === `deskzo-${key}`) ?? plans.find((p) => p.kind === "EDITION" && p.productKey === key);
  const offer: ProductVsSuiteOffer = {
    country: { code: country.code, name: country.name },
    countries: WORLD_COUNTRIES.map(({ code, name }) => ({ code, name })),
    currency,
    product: editionOf(props.product)?.prices ?? [],
    suite: editionOf("one")?.prices ?? [],
  };
  return <ProductVsSuiteView props={props} ctx={ctx} offer={offer} />;
}
