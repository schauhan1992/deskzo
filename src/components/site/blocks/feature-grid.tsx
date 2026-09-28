import { ArrowRight, Check } from "lucide-react";
import type { FeatureGridProps, SiteRenderContext } from "@/components/site/blocks/types";
import { IconChip } from "@/components/site/icons";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import { cn } from "@/lib/utils";

const COLUMNS = { 2: "md:grid-cols-2", 3: "md:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const;

/** Cards, each an icon, a title, a sentence and optionally a list — "Built for India / works worldwide". */
export function FeatureGridBlock({ props, ctx }: { props: FeatureGridProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <div className={cn("mt-12 grid gap-6", COLUMNS[props.columns ?? 3] ?? COLUMNS[3])}>
        {props.items.map((item, i) => (
          <div key={i} className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            {item.icon && <IconChip name={item.icon} />}
            <h3 className={cn("text-lg font-semibold text-text", item.icon && "mt-5")}>{t(item.title)}</h3>
            {item.body && <p className="mt-2 text-sm leading-6 text-muted">{t(item.body)}</p>}
            {!!item.bullets?.length && (
              <ul className="mt-5 space-y-3">
                {item.bullets.map((bullet, j) => (
                  <li key={j} className="flex gap-3 text-sm leading-6 text-text">
                    <Check aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-brand" />
                    <span>{t(bullet)}</span>
                  </li>
                ))}
              </ul>
            )}
            {item.link && (
              <SiteAnchor href={item.link.href} className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                {t(item.link.label)}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </SiteAnchor>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
