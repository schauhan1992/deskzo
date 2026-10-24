import { ArrowRight } from "lucide-react";
import { ProductIcon } from "@/components/brand/product-icon";
import type { RelatedLinksProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, linkShown, safeHref } from "@/components/site/links";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import { productByPath } from "@/lib/products";

/**
 * Cards linking to other pages on this site — a page's "Related" or a guide's "Read next": the
 * internal links that tie the site together. A card whose address is not a path on this site is
 * left out (the CMS refuses one; this is the renderer's own check). A card for a product's page
 * carries the product's icon.
 */
export function RelatedLinksBlock({ props, ctx }: { props: RelatedLinksProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const links = (props.links ?? []).filter((link) => safeHref(link.href)?.startsWith("/") && linkShown(link.href, ctx));
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((link, i) => {
          const product = productByPath(link.href);
          return (
            <li key={i} className="min-w-0">
              <SiteAnchor
                href={link.href}
                className="group flex h-full items-start gap-4 rounded-2xl border border-line bg-surface p-5 shadow-sm transition-colors hover:border-line-strong hover:bg-surface-sunken/40"
              >
                {product && <ProductIcon product={product.key} className="h-12 w-12" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-start justify-between gap-3 text-base font-semibold text-text">
                    {t(link.label)}
                    <ArrowRight aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-subtle transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-brand" />
                  </span>
                  {link.description && <span className="mt-1.5 text-sm leading-6 text-muted">{t(link.description)}</span>}
                </span>
              </SiteAnchor>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
