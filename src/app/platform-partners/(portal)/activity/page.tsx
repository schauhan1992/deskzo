import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Activity, ArrowUpRight } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { CursorPager } from "@/components/console/kit/pager";
import { Panel } from "@/components/console/kit/panel";
import { TONE_DOT } from "@/components/console/kit/status";
import { DataTable, DayHeaderRow, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PARTNER_ACTIVITY_KINDS, describePartnerActivity, partnerActionLabel, partnerActorParts, partnerEntityHref, type PartnerActivityKind } from "@/components/partners/common/activity";
import { PortalPage } from "@/components/partners/common/page";
import { dayGroupLabel, dayKeyLabel, istDayKey, when } from "@/lib/console-shared/format";
import { withParams } from "@/lib/console-shared/params";
import { formatIstTime } from "@/lib/india-time";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES, canOpenPartnerPage } from "@/lib/partners/nav";
import { portalActivity, type ActivityFilters } from "@/lib/partners/portal-data";
import { PARTNER_AUDIT_ACTIONS } from "@/lib/partners/types";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Activity" };

const PATH = PARTNER_ROUTES.activity;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

/** The address's filters, whitelisted: a kind of change (or one exact action), India days, a page. */
function parseFilters(sp: Record<string, string | string[] | undefined>) {
  const kindRaw = one(sp.kind);
  const kind = PARTNER_ACTIVITY_KINDS.some((k) => k.key === kindRaw) ? (kindRaw as PartnerActivityKind) : undefined;
  const actionRaw = one(sp.action);
  const action = actionRaw && (PARTNER_AUDIT_ACTIONS as readonly string[]).includes(actionRaw) ? actionRaw : undefined;
  const from = DAY.test(one(sp.from) ?? "") ? one(sp.from) : undefined;
  const to = DAY.test(one(sp.to) ?? "") ? one(sp.to) : undefined;
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const filters: ActivityFilters = { action: action ?? (kind ? `${kind}.` : undefined), from, to, page };
  return { kind, action, from, to, page, filters };
}

/**
 * Activity (admins only): everything done in this partner account that the log shows to the partner —
 * sign-ins, the team, codes, links and registrations, customers arriving and leaving, statements,
 * requests and their answers — by whom and when, newest first, 50 at a time, grouped under India's
 * days. Filtered by kind of change and by India dates, all in the address (src/lib/partners/portal-data.ts
 * portalActivity). Rows the platform keeps for itself never reach this page, and neither does any
 * staff note: each row's summary reads only a few whitelisted fields.
 */
export default async function PartnerActivityPage({ searchParams }: PageProps<"/platform-partners/activity">) {
  const session = await partnerPage(PARTNER_PAGE_ROLES.activity);
  const me = session.user;
  const sp = await searchParams;
  const f = parseFilters(sp);
  const log = await portalActivity(me, f.filters);
  const todayKey = istDayKey(new Date());
  const canOpen = (key: Parameters<typeof canOpenPartnerPage>[2]) => canOpenPartnerPage(me.role, me.partner.kind, key);

  const chips = [
    ...(f.action ? [{ key: "action", label: `Change: ${partnerActionLabel(f.action).label}`, removeHref: withParams(PATH, sp, { action: null }) }] : []),
    ...(f.kind && !f.action ? [{ key: "kind", label: `Kind: ${PARTNER_ACTIVITY_KINDS.find((k) => k.key === f.kind)?.label}`, removeHref: withParams(PATH, sp, { kind: null }) }] : []),
    ...(f.from || f.to
      ? [{ key: "dates", label: `Dates: ${f.from ? dayKeyLabel(f.from) : "…"} – ${f.to ? dayKeyLabel(f.to) : "…"}`, removeHref: withParams(PATH, sp, { from: null, to: null }) }]
      : []),
  ];
  const filtered = chips.length > 0;

  const pages = Math.max(1, Math.ceil(log.total / log.pageSize));
  const first = log.total === 0 ? 0 : (log.page - 1) * log.pageSize + 1;
  const last = Math.min(log.total, log.page * log.pageSize);

  // Rows under their India day, in the order they came.
  const groups: { day: string; rows: typeof log.rows }[] = [];
  for (const row of log.rows) {
    const day = istDayKey(row.at);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.day === day) lastGroup.rows.push(row);
    else groups.push({ day, rows: [row] });
  }

  return (
    <PortalPage title="Activity" subtitle="Everything done in your partner account — who, what and when. Kept for good; nobody can edit it.">
      <div>
        <FilterBar>
          <SelectFilter param="kind" label="Kind" allLabel="Every change" options={PARTNER_ACTIVITY_KINDS.map((k) => ({ value: k.key, label: k.label }))} />
          <DateRangeFilter label="Dates" />
        </FilterBar>
        <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

        <Panel padded={log.rows.length === 0}>
          {log.rows.length === 0 ? (
            filtered ? (
              <EmptyState variant="filtered" title="Nothing matches those filters" body="Widen the dates, or pick another kind of change." clearHref={PATH} />
            ) : (
              <EmptyState icon={<Activity className="h-5 w-5" />} title="Nothing has happened yet" body="Sign-ins, invitations, registrations, statements and everything else appear here as they happen." />
            )
          ) : (
            <DataTable caption="Partner account activity, newest first" minWidth={820}>
              <THead>
                <Th className="w-24">Time</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th srOnly>Open</Th>
              </THead>
              <TBody>
                {groups.map((group) => (
                  <Fragment key={group.day}>
                    <DayHeaderRow label={dayGroupLabel(group.day, todayKey)} colSpan={4} />
                    {group.rows.map((row) => {
                      const { label, tone } = partnerActionLabel(row.action);
                      const { subject, note } = describePartnerActivity(row);
                      const who = partnerActorParts(row);
                      const link = partnerEntityHref(row, canOpen);
                      return (
                        <Tr key={row.id}>
                          <Td muted nowrap className="align-top">
                            <time dateTime={row.at.toISOString()} title={when(row.at)} className="tabular-nums">
                              {formatIstTime(row.at)}
                            </time>
                          </Td>
                          <Td className="align-top">
                            <span className="block max-w-[14rem] truncate font-medium" title={who.email ?? undefined}>
                              {who.name}
                            </span>
                            {who.origin && <span className="block text-[11px] text-subtle">{who.origin}</span>}
                          </Td>
                          <Td className="align-top">
                            <div className="flex items-start gap-2">
                              <span aria-hidden="true" className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", TONE_DOT[tone])} />
                              <div className="min-w-0">
                                <p className="break-words text-text">
                                  {label}
                                  {subject && (
                                    <>
                                      {" — "}
                                      <span className="font-medium">{subject}</span>
                                    </>
                                  )}
                                </p>
                                {note && <p className="mt-0.5 text-xs break-words text-muted">{note}</p>}
                              </div>
                            </div>
                          </Td>
                          <Td nowrap className="text-right align-top">
                            {link && (
                              <Link href={link.href} className="inline-flex items-center gap-0.5 rounded-base text-xs font-medium text-brand hover:underline">
                                {link.label}
                                <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                                <span className="sr-only">{`: ${label}${subject ? `, ${subject}` : ""}`}</span>
                              </Link>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </Fragment>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>

        <CursorPager
          newerHref={log.page > 1 ? withParams(PATH, sp, { page: log.page - 1 === 1 ? null : log.page - 1 }) : null}
          olderHref={log.page < pages ? withParams(PATH, sp, { page: log.page + 1 }) : null}
          summary={log.total > 0 ? `${first.toLocaleString("en-IN")}–${last.toLocaleString("en-IN")} of ${log.total.toLocaleString("en-IN")} · page ${log.page} of ${pages}` : undefined}
        />
      </div>
    </PortalPage>
  );
}
