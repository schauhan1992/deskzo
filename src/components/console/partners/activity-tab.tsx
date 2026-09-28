import { ActivityFeed, type ActivityFeedItem } from "@/components/console/kit/activity-feed";
import { DateRangeFilter, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar } from "@/components/console/kit/filters";
import { Panel } from "@/components/console/kit/panel";
import { PARTNER_ACTIVITY_KINDS, describePartnerActivity, partnerActionLabel } from "@/components/partners/common/activity";
import type { Tone } from "@/lib/console-shared/types";
import type { Paged, PartnerAuditRow } from "@/lib/partners/types";
import { LinkPager } from "./pager";

/**
 * Partner 360 › Activity (spec §9.2): the partner's own activity log, every row — including the ones
 * the partner is not shown, which say so. Filtered by kind of change and by IST days, with its own
 * prefixed keys in the address (`aaction`, `afrom`, `ato`, `apage`), so it never clashes with the
 * Commissions tab's `from`, `to` and `page`. Without money the detail of money actions is not even
 * loaded (the title stays). Server-safe.
 *
 * The words come from the portal's own catalogue (src/components/partners/common/activity.ts), with
 * the few that address the partner as "you" said the staff way here.
 */

export const ACTIVITY_PREFIX = "a";

const STAFF_WORDING: Record<string, string> = {
  "customer.assigned": "Customer assigned to it by staff",
  "customer.removed": "Customer moved away by staff",
  "payout.reveal": "Payout details viewed by platform staff",
  "terms.set": "Commission terms set",
};

const KIND_OPTIONS = PARTNER_ACTIVITY_KINDS.map((k) => ({ value: `${k.key}.`, label: k.label }));

function itemOf(row: PartnerAuditRow): ActivityFeedItem {
  const label = partnerActionLabel(row.action);
  const { subject, note } = describePartnerActivity(row);
  const summary = [subject, note].filter(Boolean).join(" · ");
  const hidden = row.visibleToPartner ? "" : "Not shown to the partner";
  return {
    id: row.id,
    at: row.at,
    title: STAFF_WORDING[row.action] ?? label.label,
    tone: label.tone as Tone,
    detail: [summary, hidden].filter(Boolean).join(" · ") || null,
    actor: row.actorLabel,
    code: row.action,
  };
}

export function PartnerActivityTab({ data, todayKey, hrefFor }: { data: Paged<PartnerAuditRow>; todayKey: string; hrefFor: (page: number) => string }) {
  const reset = [`${ACTIVITY_PREFIX}page`];
  return (
    <div>
      <FilterBar>
        <SelectFilter param={`${ACTIVITY_PREFIX}action`} label="Kind" allLabel="Everything" options={KIND_OPTIONS} resetParams={reset} />
        <DateRangeFilter label="When" fromParam={`${ACTIVITY_PREFIX}from`} toParam={`${ACTIVITY_PREFIX}to`} resetParams={reset} />
      </FilterBar>
      <Panel description="Everything in the partner's own log, the newest first. Rows marked “Not shown to the partner” are staff's alone.">
        <ActivityFeed items={data.rows.map(itemOf)} todayKey={todayKey} showWorkspace={false} empty="Nothing in its log matches." />
      </Panel>
      <LinkPager page={data.page} pageSize={data.pageSize} total={data.total} noun="entry" nouns="entries" hrefFor={hrefFor} />
    </div>
  );
}
