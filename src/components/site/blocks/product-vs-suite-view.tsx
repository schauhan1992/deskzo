import Link from "next/link";
import { Check, Minus } from "lucide-react";
import type { ProductVsSuiteProps, SiteRenderContext } from "@/components/site/blocks/types";
import { CountryPicker } from "@/components/site/forms/country-picker";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container } from "@/components/site/ui";
import type { OfferPrice } from "@/lib/billing/checkout";
import { formatMoney } from "@/lib/billing/money";
import { PLATFORM_GST_PERCENT } from "@/lib/billing/platform-gst";
import { soldIn, withDependencies } from "@/lib/entitlements";
import { MODULE_REGISTRY, type ModuleDefinition } from "@/lib/modules";
import { ADD_ONS, BASE_MODULES, PRODUCTS, productByKey, type Product } from "@/lib/products";
import { cn } from "@/lib/utils";

/**
 * A product beside Deskzo One, on the product's own page (owner, 11 Oct 2026: "just like Adobe promotes
 * its Creative Cloud on every app's page"). Two cards — the product alone, and every product — each
 * with its price for the visitor's country, monthly or yearly, and its own free trial; then every
 * module, side by side.
 *
 * Nothing here is written by hand: the products, their modules and what every product comes with are
 * src/lib/products.ts and src/lib/modules.ts, so the comparison can't drift from what is sold. Modules
 * built on one country's rules (India's accounting, payroll, e-way bills) are left out where they
 * aren't sold, and a product sold only in India says so elsewhere.
 *
 * Pure: the page's block (product-vs-suite.tsx) reads the prices; the CMS's preview passes none, and
 * the cards then point to the pricing page.
 */

/** The prices the page found, for one country: the product's own edition's and Deskzo One's — empty where none is on sale. */
export type ProductVsSuiteOffer = {
  country: { code: string; name: string };
  /** For the country picker. */
  countries: { code: string; name: string }[];
  currency: string;
  product: OfferPrice[];
  suite: OfferPrice[];
};

const INTERVALS = ["MONTH", "YEAR"] as const;
type Interval = (typeof INTERVALS)[number];
const PER: Record<Interval, string> = { MONTH: "month", YEAR: "year" };

const money = (amount: number, currency: string) => formatMoney(amount, currency).replace(/\.00$/, "");

/** Whether every plan has it: the core and the every-plan modules (src/lib/modules.ts). */
const everyPlanHas = (m: ModuleDefinition) => !!m.core || !!m.inEveryPlan;

/** "A, B and C". */
const andList = (labels: string[]) => (labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? ""));

/** What every product comes with, by name: the core, the every-plan modules and `BASE_MODULES`. */
const BASICS = andList(MODULE_REGISTRY.filter((m) => everyPlanHas(m) || BASE_MODULES.includes(m.key)).map((m) => m.label));

function priceFor(prices: OfferPrice[], interval: Interval): OfferPrice | undefined {
  return prices.find((p) => p.interval === interval) ?? prices[0];
}

/** How much a year costs against twelve months, when both are sold the same way. */
function yearlySaving(prices: OfferPrice[]): number | null {
  const month = prices.find((p) => p.interval === "MONTH");
  const year = prices.find((p) => p.interval === "YEAR" && p.perSeat === month?.perSeat);
  if (!month || !year || month.amount <= 0) return null;
  const pct = Math.round((1 - year.amount / (month.amount * 12)) * 100);
  return pct >= 1 ? pct : null;
}

/** A product sold in this country (Books and People: India only). */
const productSoldIn = (product: Product, country: string) => !product.soldOnlyIn?.length || product.soldOnlyIn.includes(country);

/**
 * Every module, grouped for the table: this product's own first, then each other product's (a shared
 * module once, where it is first met), then the add-ons Deskzo One includes, then what every product
 * comes with. Only modules sold in the country.
 */
export function comparisonRows(product: Product, country: string) {
  const sold = (key: string) => {
    const def = MODULE_REGISTRY.find((m) => m.key === key);
    return !!def && soldIn(def, country);
  };
  const basics = new Set(MODULE_REGISTRY.filter((m) => everyPlanHas(m) || BASE_MODULES.includes(m.key)).map((m) => m.key));
  // What the product's plan really holds: its modules and what they need.
  const has = withDependencies([...product.modules, ...BASE_MODULES]);
  const seen = new Set<string>(basics);
  const label = (key: string) => MODULE_REGISTRY.find((m) => m.key === key)!.label;
  const suiteName = productByKey("one")?.name ?? "";
  const group = (keys: readonly string[]) =>
    MODULE_REGISTRY.filter((m) => keys.includes(m.key) && !seen.has(m.key) && sold(m.key)).map((m) => {
      seen.add(m.key);
      return { key: m.key, label: m.label, inProduct: has.has(m.key) };
    });
  const groups: { title: string; rows: { key: string; label: string; inProduct: boolean | "addon" }[] }[] = [];
  groups.push({ title: product.name, rows: group([...product.modules, ...[...has].filter((k) => !product.modules.includes(k))]) });
  // A product not sold here (Books, People abroad) still brings its other modules to Deskzo One.
  for (const other of PRODUCTS) {
    if (other.key === "one" || other.key === product.key) continue;
    const rows = group(other.modules);
    if (rows.length) groups.push({ title: productSoldIn(other, country) ? other.name : `${other.name}: in ${suiteName} here`, rows });
  }
  const included = ADD_ONS.filter((a) => a.includedIn.includes("one") && a.modules.length && a.modules.every(sold)).map((a) => ({
    key: a.key,
    label: a.modules.length === 1 && label(a.modules[0]!) === a.name ? a.name : `${a.name}: ${a.modules.map(label).join(", ")}`,
    inProduct: a.onProduct === product.key ? ("addon" as const) : false,
  }));
  if (included.length) groups.push({ title: `Add-ons included in ${suiteName}`, rows: included });
  groups.push({ title: "In every product", rows: MODULE_REGISTRY.filter((m) => basics.has(m.key) && sold(m.key)).map((m) => ({ key: m.key, label: m.label, inProduct: true })) });
  return groups.filter((g) => g.rows.length);
}

export function ProductVsSuiteView({ props, ctx, offer }: { props: ProductVsSuiteProps; ctx: SiteRenderContext; offer: ProductVsSuiteOffer | null }) {
  const product = productByKey(props.product);
  const suite = productByKey("one");
  if (!product || product.key === "one" || !suite) return null;
  const t = (s?: string) => fill(s, ctx);
  const anchor = anchorId(props.anchor) ?? "plans";
  const country = offer?.country ?? { code: "IN", name: "India" };
  const sold = INTERVALS.filter((i) => [...(offer?.product ?? []), ...(offer?.suite ?? [])].some((p) => p.interval === i));
  const wanted = String(ctx.searchParams.interval ?? "").toUpperCase();
  const interval: Interval = sold.find((i) => i === wanted) ?? sold[0] ?? "MONTH";
  const query = (i: Interval) => `?${new URLSearchParams({ country: country.code, interval: i }).toString()}#${anchor}`;
  const available = productSoldIn(product, country.code);
  const groups = comparisonRows(product, country.code);
  const ownRows = groups[0]?.title === product.name ? groups[0].rows : [];
  const others = PRODUCTS.filter((p) => p.key !== "one" && p.key !== product.key && productSoldIn(p, country.code));
  const demo = `/contact?${new URLSearchParams({ topic: "demo", product: product.key }).toString()}`;
  const trialOfProduct = resolveAction({ kind: "signup", product: product.key }, ctx);
  const trialOfSuite = resolveAction({ kind: "signup", product: "one" }, ctx);
  const nameOf = (code: string) => offer?.countries.find((c) => c.code === code)?.name ?? (code === "IN" ? "India" : code);

  return (
    <section id={anchor} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="max-w-3xl">
          {props.eyebrow && <p className="text-sm font-semibold text-brand">{t(props.eyebrow)}</p>}
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-text text-balance">{t(props.heading)}</h2>
          {props.intro && <p className="mt-4 text-base leading-7 text-muted">{t(props.intro)}</p>}
        </div>

        {offer && (
          <div className="mt-8 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <CountryPicker label="Prices for" countries={offer.countries} value={country.code} interval={sold.length > 1 ? interval : null} />
            {sold.length > 1 && (
              <nav aria-label="Billing period" className="inline-flex self-start rounded-base border border-line bg-surface-sunken p-0.5 sm:self-auto">
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
        )}

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            <h3 className="text-lg font-semibold text-text">{product.name}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{product.tagline}</p>
            {available ? (
              <>
                <Price prices={offer?.product ?? []} interval={interval} currency={offer?.currency ?? ""} />
                <ButtonLink href={trialOfProduct.href} label={trialOfProduct.label} tone="secondary" className="mt-6 h-10 w-full" />
              </>
            ) : (
              <p className="mt-6 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-muted">{`${product.name} is sold in ${andList((product.soldOnlyIn ?? []).map(nameOf))} only for now — every product is in ${suite.name}.`}</p>
            )}
            <p className="mt-6 border-t border-line pt-6 text-xs font-semibold uppercase tracking-wider text-subtle">Includes</p>
            <ul className="mt-3 space-y-2.5">
              {ownRows.map((r) => (
                <Line key={r.key}>{r.label}</Line>
              ))}
              <Line muted>{`Always: ${BASICS}`}</Line>
            </ul>
          </div>

          <div className="relative flex flex-col rounded-2xl border border-brand bg-surface p-6 shadow-sm ring-1 ring-brand sm:p-8">
            <span className="absolute -top-3 left-6 rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-brand-contrast">Every product</span>
            <h3 className="text-lg font-semibold text-text">{suite.name}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{suite.tagline}</p>
            <Price prices={offer?.suite ?? []} interval={interval} currency={offer?.currency ?? ""} />
            <ButtonLink href={trialOfSuite.href} label={trialOfSuite.label} className="mt-6 h-10 w-full" />
            <p className="mt-6 border-t border-line pt-6 text-xs font-semibold uppercase tracking-wider text-subtle">{available ? `Everything in ${product.name}, plus` : "Includes"}</p>
            <ul className="mt-3 space-y-2.5">
              {(available ? others : [product, ...others]).map((p) => (
                <Line key={p.key}>
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-xs leading-5 text-muted">{p.tagline}</span>
                </Line>
              ))}
              {ADD_ONS.filter((a) => a.includedIn.includes("one") && a.modules.length && a.modules.every((k) => soldIn(MODULE_REGISTRY.find((m) => m.key === k)!, country.code))).map((a) => (
                <Line key={a.key}>
                  <span className="font-medium">{a.name}</span>
                  <span className="block text-xs leading-5 text-muted">Included — an add-on elsewhere</span>
                </Line>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-6 text-sm text-muted">
          {props.demoNote ? `${t(props.demoNote)} ` : ""}
          <Link href={demo} className="font-medium text-brand hover:underline">
            {`Book a demo of ${product.name}`}
          </Link>
          {" · "}
          <Link href={`/pricing?country=${encodeURIComponent(country.code)}`} className="font-medium text-brand hover:underline">
            Every plan and add-on
          </Link>
        </p>

        <details className="group mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
          <summary className="cursor-pointer list-none px-5 py-4 text-sm font-semibold text-text hover:bg-surface-sunken [&::-webkit-details-marker]:hidden">
            {`Compare every module — ${product.name} and ${suite.name}`}
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full min-w-[32rem] text-sm">
              <caption className="sr-only">{`What ${product.name} and ${suite.name} include, module by module${country.code === "IN" ? "" : `, as sold in ${country.name}`}`}</caption>
              <thead>
                <tr className="bg-surface-sunken text-left text-xs uppercase tracking-wider text-subtle">
                  <th scope="col" className="px-5 py-3 font-semibold">
                    Module
                  </th>
                  <th scope="col" className="w-36 px-5 py-3 text-center font-semibold">
                    {product.name}
                  </th>
                  <th scope="col" className="w-36 px-5 py-3 text-center font-semibold">
                    {suite.name}
                  </th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.title} className="border-t border-line">
                  <tr>
                    <th scope="colgroup" colSpan={3} className="bg-surface px-5 pt-4 pb-1 text-left text-xs font-semibold text-muted">
                      {g.title}
                    </th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.key} className="border-t border-line/60">
                      <th scope="row" className="px-5 py-2.5 text-left font-normal text-text">
                        {r.label}
                      </th>
                      <td className="px-5 py-2.5 text-center">{available ? <Mark value={r.inProduct} /> : <Mark value={false} />}</td>
                      <td className="px-5 py-2.5 text-center">
                        <Mark value={true} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          {country.code !== "IN" && <p className="border-t border-line px-5 py-3 text-xs text-subtle">{`As sold in ${country.name}: modules built on India's tax rules are left out.`}</p>}
        </details>
      </Container>
    </section>
  );
}

/** A price, monthly or yearly, with the yearly saving — or, with none on sale here, where to find them. */
function Price({ prices, interval, currency }: { prices: OfferPrice[]; interval: Interval; currency: string }) {
  const price = priceFor(prices, interval);
  if (!price) return <p className="mt-6 text-sm text-muted">Prices are on the pricing page.</p>;
  const saving = price.interval === "YEAR" ? yearlySaving(prices) : null;
  return (
    <p className="mt-6 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
      <span className="text-4xl font-semibold tracking-tight text-text tabular-nums">{money(price.amount, currency)}</span>
      <span className="text-sm text-muted">
        {price.perSeat ? "per person / " : "/ "}
        {PER[price.interval as Interval] ?? "month"}
        {currency === "INR" ? ` + ${PLATFORM_GST_PERCENT}% GST` : ""}
      </span>
      {saving && <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success">Save {saving}%</span>}
    </p>
  );
}

function Line({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <li className={cn("flex gap-2.5 text-sm leading-6", muted ? "text-muted" : "text-text")}>
      <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-brand" />
      <span>{children}</span>
    </li>
  );
}

/** A table cell's answer, as an icon and words for screen readers. */
function Mark({ value }: { value: boolean | "addon" }) {
  if (value === "addon") return <span className="text-xs font-medium text-muted">Add-on</span>;
  return value ? (
    <>
      <Check aria-hidden="true" className="mx-auto h-4 w-4 text-brand" />
      <span className="sr-only">Included</span>
    </>
  ) : (
    <>
      <Minus aria-hidden="true" className="mx-auto h-4 w-4 text-subtle" />
      <span className="sr-only">Not included</span>
    </>
  );
}
