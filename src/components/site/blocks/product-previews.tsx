import type { ProductPreviewsProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { ProductPreview } from "@/components/site/previews";
import { Section, SectionHeading } from "@/components/site/ui";

/** A strip of the drawn product screens, each with a caption. */
export function ProductPreviewsBlock({ props, ctx }: { props: ProductPreviewsProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <div className="mt-12 grid gap-8 lg:grid-cols-3">
        {props.items.map((item, i) => (
          <figure key={i} className="flex min-w-0 flex-col">
            <div className="rounded-[1.25rem] border border-line bg-surface-sunken p-1.5">
              <ProductPreview kind={item.preview} framed={false} className="shadow-sm" />
            </div>
            <figcaption className="mt-5">
              <span className="block text-base font-semibold text-text">{t(item.title)}</span>
              <span className="mt-1 block text-sm leading-6 text-muted">{t(item.body)}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}
