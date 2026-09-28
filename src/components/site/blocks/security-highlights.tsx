import { ArrowRight } from "lucide-react";
import type { SecurityHighlightsProps, SiteRenderContext } from "@/components/site/blocks/types";
import { IconChip } from "@/components/site/icons";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";

/** How the platform protects each company, point by point. */
export function SecurityHighlightsBlock({ props, ctx }: { props: SecurityHighlightsProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)} tone="sunken">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
        {props.link && (
          <SiteAnchor href={props.link.href} className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand hover:underline">
            {t(props.link.label)}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </SiteAnchor>
        )}
      </div>
      <ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
        {props.items.map((item, i) => (
          <li key={i} className="bg-surface p-6 sm:p-8">
            <IconChip name={item.icon} />
            <h3 className="mt-5 text-base font-semibold text-text">{t(item.title)}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{t(item.body)}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
