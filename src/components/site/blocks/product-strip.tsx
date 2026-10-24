import { ArrowRight } from "lucide-react";
import { ProductIcon } from "@/components/brand/product-icon";
import type { ProductStripProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import { PRODUCT_FAMILY, PRODUCTS, type Product } from "@/lib/products";

/**
 * Every product as a strip of icons (owner, 24 Oct 2026: "a product strip with the icons to the home
 * page"): each product's 3D icon, its name and its line, linking to its page, on a shelf seven across —
 * four on a tablet, three on a phone, the last row centred. Pure, so the CMS's preview draws it as the
 * site does.
 */

/**
 * The products in the website's order — the Product menu's (scripts/site-content/_catalog.ts
 * PRODUCT_MENU_ORDER): the suite, then what sells and serves, runs the business and looks after its
 * people. A product not listed here follows the rest, by its group, so a new one is never left out.
 */
const ORDER: readonly Product["key"][] = ["one", "crm", "pipeline", "desk", "campaigns", "cards", "signatures", "subscriptions", "books", "inventory", "projects", "analytics", "people", "vault"];
const GROUP_ORDER: readonly Product["group"][] = ["suite", "sell", "run", "people"];

export function stripProducts(): Product[] {
  const rank = (p: Product) => {
    const i = ORDER.indexOf(p.key);
    return i >= 0 ? i : ORDER.length + GROUP_ORDER.indexOf(p.group);
  };
  return [...PRODUCTS].sort((a, b) => rank(a) - rank(b));
}

const shortName = (p: Product) => (p.group !== "suite" && p.name.startsWith(`${PRODUCT_FAMILY} `) ? p.name.slice(PRODUCT_FAMILY.length + 1) : p.name);

export function ProductStripBlock({ props, ctx }: { props: ProductStripProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const action = props.action ? resolveAction(props.action, ctx) : null;
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} align="center" />
      <div className="relative mt-12">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[10%] -top-6 bottom-0 rounded-full bg-[radial-gradient(50%_50%_at_50%_50%,color-mix(in_srgb,var(--brand)_12%,transparent),transparent)] blur-2xl" />
        <ul className="relative flex flex-wrap justify-center rounded-[1.75rem] border border-line bg-[linear-gradient(180deg,var(--surface),color-mix(in_srgb,var(--brand)_4%,var(--surface)))] p-2 shadow-sm sm:p-3">
          {stripProducts().map((product) => (
            <li key={product.key} className="w-1/3 p-1 sm:w-1/4 lg:w-1/7">
              <SiteAnchor
                href={product.path}
                className="group flex h-full flex-col items-center rounded-2xl px-2 pb-4 pt-5 text-center transition-[background-color,box-shadow] duration-200 hover:bg-surface hover:shadow-[0_14px_32px_-16px_rgb(15_23_42/0.35)] sm:px-3"
              >
                <ProductIcon product={product.key} className="h-14 w-14 transition-transform duration-300 ease-out group-hover:-translate-y-1.5 sm:h-16 sm:w-16" />
                <span className="mt-3 text-[13px] font-semibold leading-5 text-text transition-colors group-hover:text-brand sm:text-sm">
                  {/* Three across on a phone: the name without the family's ("CRM"), but the suite's whole ("Deskzo One"). */}
                  <span className="sm:hidden">{shortName(product)}</span>
                  <span className="hidden sm:inline">{product.name}</span>
                </span>
                {/* The line from a tablet up: three across on a phone leaves room for the name alone. */}
                <span className="mt-1 hidden sm:block">
                  <span className="line-clamp-2 text-xs leading-5 text-muted">{product.tagline}</span>
                </span>
              </SiteAnchor>
            </li>
          ))}
        </ul>
      </div>
      {action && (
        <p className="mt-8 text-center">
          <SiteAnchor href={action.href} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
            {action.label}
            <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </SiteAnchor>
        </p>
      )}
    </Section>
  );
}
