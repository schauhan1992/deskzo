import Link from "next/link";
import { Clock, EyeOff } from "lucide-react";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { openParam, STATUS_LABEL, TYPE_LABEL, withOpen } from "@/components/cms/seo/dashboard-params";
import { ScoreChip } from "@/components/cms/seo/score-ui";
import type { RawParams } from "@/lib/console-shared/params";
import { plural } from "@/lib/console-shared/format";
import type { SeoScoreRow } from "@/lib/cms/types";

/**
 * The dashboard's table: one row per page, post, category, tag and the blog index, from the score
 * cache — its title and address, what it is, its SEO, AEO, GEO and overall scores (the overall with
 * its label), whether it is on the site, its critical issues and warnings, and when it was scored,
 * marked when that is out of date. A click anywhere on a row opens its analysis (`?open=`).
 */
export function SeoScoresTable({ rows, sp, openKey }: { rows: SeoScoreRow[]; sp: RawParams; openKey: string | null }) {
  return (
    <DataTable caption="Scores for every page, post and archive" minWidth={960}>
      <THead>
        <Th>Page or post</Th>
        <Th>Type</Th>
        <Th numeric>SEO</Th>
        <Th numeric>AEO</Th>
        <Th numeric>GEO</Th>
        <Th>Overall</Th>
        <Th>Status</Th>
        <Th>Issues</Th>
        <Th>Last updated</Th>
      </THead>
      <TBody>
        {rows.map((row) => {
          const open = openParam(row.type, row.key);
          const selected = open === openKey;
          return (
            <Tr key={open} interactive selected={selected}>
              <Td className="max-w-[20rem] align-top">
                <Link
                  href={withOpen(sp, open)}
                  scroll={false}
                  data-row-link=""
                  aria-current={selected ? "true" : undefined}
                  className="block truncate font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand"
                >
                  {row.title || row.path}
                  <span className="sr-only"> — open its analysis</span>
                </Link>
                <span className="block truncate font-mono text-xs text-muted">{row.path}</span>
                {(row.excluded || !row.live) && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {row.excluded && (
                      <StatusPill tone="info" icon={<EyeOff className="h-3 w-3" />} title="Kept out of search engines on purpose (noindex): not scored against it, and not in the site's score">
                        Excluded (noindex)
                      </StatusPill>
                    )}
                    {!row.live && !row.excluded && (
                      <StatusPill tone="neutral" title="A draft, a post scheduled for later, or an archive with no posts on the site">
                        Not on the site
                      </StatusPill>
                    )}
                  </span>
                )}
              </Td>
              <Td muted nowrap className="align-top">
                {TYPE_LABEL[row.type]}
              </Td>
              <Td numeric className="align-top">
                {row.seo}
              </Td>
              <Td numeric className="align-top">
                {row.aeo}
              </Td>
              <Td numeric className="align-top">
                {row.geo}
              </Td>
              <Td nowrap className="align-top">
                <ScoreChip score={row.overall} label={row.label} what="Overall score" />
              </Td>
              <Td muted nowrap className="align-top">
                {STATUS_LABEL[row.status]}
              </Td>
              <Td nowrap className="align-top text-xs">
                {row.critical === 0 && row.warnings === 0 ? (
                  <span className="text-muted">None</span>
                ) : (
                  <>
                    {row.critical > 0 && <span className="block font-medium text-danger">{`${row.critical} critical`}</span>}
                    {row.warnings > 0 && <span className="block text-warning">{plural(row.warnings, "warning")}</span>}
                  </>
                )}
              </Td>
              <Td muted nowrap className="align-top text-xs">
                <RelativeTime at={row.calculatedAt} />
                {row.stale && (
                  <span className="mt-1 block">
                    <StatusPill tone="warning" icon={<Clock className="h-3 w-3" />} title="It changed since it was scored — recalculate to bring the numbers up to date">
                      Stale
                    </StatusPill>
                  </span>
                )}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
