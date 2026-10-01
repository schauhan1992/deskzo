import { ArrowRight } from "lucide-react";
import type { ModuleHighlightsProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, linkShown, safeHref } from "@/components/site/links";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";

/**
 * A hub page's map of the pages under it (the product, solutions and compare hubs): groups, each a
 * heading and its links, every link a line on what the page covers. Links go to pages on this site
 * only; one that doesn't is left out.
 */
export function ModuleHighlightsBlock({ props, ctx }: { props: ModuleHighlightsProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const groups = (props.groups ?? []).map((group) => ({ ...group, items: (group.items ?? []).filter((item) => safeHref(item.href)?.startsWith("/") && linkShown(item.href, ctx)) })).filter((group) => group.items.length);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <div className="mt-12 space-y-12">
        {groups.map((group, i) => (
          <div key={i}>
            <h3 className="border-b border-line pb-3 text-lg font-semibold text-text">{t(group.title)}</h3>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item, j) => (
                <li key={j} className="min-w-0">
                  <SiteAnchor href={item.href} className="group flex h-full flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-sunken/40">
                    <span className="flex items-center justify-between gap-3 text-sm font-semibold text-text">
                      {t(item.label)}
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-brand" />
                    </span>
                    {item.description && <span className="mt-1 text-sm leading-6 text-muted">{t(item.description)}</span>}
                  </SiteAnchor>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
