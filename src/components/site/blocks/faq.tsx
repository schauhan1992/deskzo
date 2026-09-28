import { ChevronDown } from "lucide-react";
import type { FaqProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";

/** Questions and answers, each a native disclosure: keyboard and screen-reader friendly with no script. */
export function FaqBlock({ props, ctx }: { props: FaqProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)}>
      <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
        <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
        <div className="divide-y divide-line border-y border-line">
          {props.items.map((item, i) => (
            <details key={i} className="group py-5">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-6 rounded-md text-left text-base font-medium text-text [&::-webkit-details-marker]:hidden">
                {t(item.question)}
                <ChevronDown aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-subtle transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-3 pr-10">
                {item.answer.map((paragraph, j) => (
                  <p key={j} className="text-sm leading-6 text-muted">
                    {t(paragraph)}
                  </p>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
