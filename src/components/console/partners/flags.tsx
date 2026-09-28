import { Fragment } from "react";
import Link from "next/link";
import { StatusPill } from "@/components/console/kit/status";
import { ATTRIBUTION_SOURCE } from "@/lib/console-shared/labels";
import type { AttributionFlagsView } from "@/lib/partners/console-data";
import { partnerPath } from "./format";

/**
 * Why an attribution was flagged for a look (spec §4.1, D7, D9): the signup's country outside the
 * winning partner's territories, and every other partner that claimed it, named — for staff only; the
 * portal never shows either. Server-safe.
 */
export function AttributionFlags({ flags, reviewed }: { flags: AttributionFlagsView | null; reviewed?: boolean }) {
  if (!flags || (!flags.outsideTerritory && flags.conflicts.length === 0)) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="flex flex-wrap items-center gap-1">
        {flags.outsideTerritory && <StatusPill tone={reviewed ? "neutral" : "warning"}>Outside territory</StatusPill>}
        {flags.conflicts.length > 0 && <StatusPill tone={reviewed ? "neutral" : "warning"}>{flags.conflicts.length === 1 ? "Conflict" : `${flags.conflicts.length} conflicts`}</StatusPill>}
        {reviewed && <StatusPill tone="success">Reviewed</StatusPill>}
      </span>
      {flags.conflicts.length > 0 && <ConflictNames conflicts={flags.conflicts} />}
    </span>
  );
}

/** "Also claimed by Acme (Invitation code), Beta (Referral link)." */
export function ConflictNames({ conflicts }: { conflicts: AttributionFlagsView["conflicts"] }) {
  return (
    <span className="text-xs text-muted">
      {"Also claimed by "}
      {conflicts.map((c, i) => (
        <Fragment key={`${i}-${c.partner?.slug ?? "gone"}`}>
          {i > 0 && ", "}
          {c.partner ? (
            <Link href={partnerPath(c.partner.slug)} className="font-medium text-text hover:text-brand">
              {c.partner.displayName}
            </Link>
          ) : (
            "a partner no longer on file"
          )}
          {` (${ATTRIBUTION_SOURCE[c.source]?.label ?? c.source})`}
        </Fragment>
      ))}
      .
    </span>
  );
}
