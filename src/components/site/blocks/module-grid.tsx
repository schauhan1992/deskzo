import type { ModuleGridProps, SiteRenderContext } from "@/components/site/blocks/types";
import { IconChip } from "@/components/site/icons";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";
import { getModuleDefinition } from "@/lib/modules";

/**
 * The modules, grouped — the words are content, and "India only" comes from the module registry
 * (src/lib/modules.ts `countries`), so it cannot drift from what is actually sold where.
 */
export function ModuleGridBlock({ props, ctx }: { props: ModuleGridProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)} tone="sunken">
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <div className="mt-12 gap-6 md:columns-2 lg:columns-3">
        {props.groups.map((group, i) => (
          <div key={i} className="mb-6 break-inside-avoid rounded-2xl border border-line bg-surface p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <IconChip name={group.icon} />
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-text">{t(group.title)}</h3>
                {group.summary && <p className="mt-0.5 text-sm text-muted">{t(group.summary)}</p>}
              </div>
            </div>
            <ul className="mt-5 space-y-4 border-t border-line pt-5">
              {group.modules.map((m, j) => {
                const onlyIn = m.key ? getModuleDefinition(m.key)?.countries : undefined;
                const where = onlyIn?.length ? (onlyIn.length === 1 && onlyIn[0] === "IN" ? "India" : onlyIn.join(", ")) : null;
                return (
                  <li key={j}>
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                      {t(m.label)}
                      {where && (
                        <span title={`Offered in ${where} only`} className="rounded-full bg-warning-bg px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warning">
                          {where}
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-muted">{t(m.blurb)}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {props.footnote && <p className="mt-4 max-w-3xl text-sm leading-6 text-muted">{t(props.footnote)}</p>}
    </Section>
  );
}
