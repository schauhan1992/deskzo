import { Check, ExternalLink, Minus, X } from "lucide-react";
import type { ComparisonTableProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, calendarDateLabel, comparisonMark, fill, sourceSite } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/**
 * This product beside another, feature by feature — a comparison page's table.
 *
 *   · A real table: a caption, a column header per product, a row header per feature. On a phone
 *     each row becomes a card (feature, then each product's answer under its name) rather than a
 *     table to scroll sideways; the explicit roles keep it a table to a screen reader when CSS
 *     makes its parts blocks.
 *   · "yes", "partial" and "no" are shown as a mark *and* a word, never colour alone; other words
 *     are shown as written. "No" is a neutral grey: the page says what each product does, and never
 *     runs the other one down.
 *   · A row's source is the competitor's own page, linked `nofollow` under its answer; under the
 *     table, the day that site was read and the page's disclaimer.
 */
export function ComparisonTableBlock({ props, ctx }: { props: ComparisonTableProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const us = ctx.settings.siteName;
  const them = t(props.competitor);
  const asOf = calendarDateLabel(props.asOf);
  const rows = props.rows ?? [];
  const cell = "px-5 py-4 align-top max-sm:mt-3 max-sm:flex max-sm:items-start max-sm:justify-between max-sm:gap-4 max-sm:p-0";
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <div className="mt-10 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-line sm:bg-surface sm:shadow-sm">
        <table role="table" className="w-full border-collapse text-left text-sm max-sm:block">
          <caption className="sr-only">
            {us} and {them}, feature by feature
          </caption>
          <thead role="rowgroup" className="bg-surface-sunken max-sm:sr-only">
            <tr role="row">
              <th role="columnheader" scope="col" className="w-2/5 px-5 py-3 font-semibold text-text">
                Feature
              </th>
              <th role="columnheader" scope="col" className="px-5 py-3 font-semibold text-text">
                {us}
              </th>
              <th role="columnheader" scope="col" className="px-5 py-3 font-semibold text-text">
                {them}
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="max-sm:block max-sm:space-y-3">
            {rows.map((row, i) => {
              const source = sourceSite(row.source);
              return (
                <tr key={i} role="row" className="border-t border-line max-sm:block max-sm:rounded-xl max-sm:border max-sm:bg-surface max-sm:p-4 max-sm:shadow-sm">
                  <th role="rowheader" scope="row" className="px-5 py-4 align-top font-medium text-text max-sm:block max-sm:p-0">
                    {t(row.feature)}
                    {row.note && <span className="mt-1 block text-xs font-normal leading-5 text-muted">{t(row.note)}</span>}
                  </th>
                  <td role="cell" className={cell}>
                    <span aria-hidden="true" className="text-xs font-medium text-subtle sm:hidden">
                      {us}
                    </span>
                    <Mark value={t(row.us)} />
                  </td>
                  <td role="cell" className={cell}>
                    <span aria-hidden="true" className="text-xs font-medium text-subtle sm:hidden">
                      {them}
                    </span>
                    <span className="flex flex-col items-end gap-1 sm:items-start">
                      <Mark value={t(row.them)} />
                      {source && (
                        <span className="text-xs text-subtle">
                          Source:{" "}
                          <a href={source.href} rel="nofollow noopener noreferrer" className="inline-flex items-center gap-0.5 underline decoration-line-strong underline-offset-2 hover:text-text">
                            {source.name}
                            <ExternalLink aria-hidden="true" className="h-3 w-3" />
                          </a>
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {asOf && (
        <p className="mt-4 text-xs leading-5 text-subtle">
          Information about {them} from its public website as of {asOf}.
        </p>
      )}
      {props.disclaimer && <p className="mt-2 max-w-3xl text-xs leading-5 text-subtle">{t(props.disclaimer)}</p>}
    </Section>
  );
}

const MARKS = {
  yes: { icon: Check, className: "bg-success-bg text-success" },
  partial: { icon: Minus, className: "bg-warning-bg text-warning" },
  no: { icon: X, className: "bg-surface-sunken text-subtle" },
} as const;

/** A cell's answer: a mark and a word for yes, partly and no; anything else as written. */
function Mark({ value }: { value: string }) {
  const mark = comparisonMark(value);
  if (mark.kind === "text") return <span className="text-text">{mark.text}</span>;
  const { icon: Icon, className } = MARKS[mark.kind];
  return (
    <span className="inline-flex items-center gap-2 font-medium text-text">
      <span aria-hidden="true" className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full", className)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      {mark.text}
    </span>
  );
}
