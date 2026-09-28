import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Activity, ArrowUpRight } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { CursorPager } from "@/components/console/kit/pager";
import { Panel } from "@/components/console/kit/panel";
import { TONE_DOT } from "@/components/console/kit/status";
import { DataTable, DayHeaderRow, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { ACTION_CATEGORIES, actionLabel, actorParts, describeActivity, entityHref, type ActionCategory } from "@/components/cms/common/activity";
import { dayGroupLabel, dayKeyLabel, istDayKey, when } from "@/lib/console-shared/format";
import { withParams } from "@/lib/console-shared/params";
import { formatIstTime } from "@/lib/india-time";
import { listCmsAudit } from "@/lib/cms/audit";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_PAGE_ROLES, CMS_ROUTES } from "@/lib/cms/nav";
import { CMS_AUDIT_ACTIONS, cmsCapsFor, type CmsAuditFilters } from "@/lib/cms/types";
import { listCmsUsers } from "@/lib/cms/users";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Activity" };

const PATH = CMS_ROUTES.activity;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined);

const ENTITY_LABEL: Record<string, string> = { page: "Page", post: "Post", media: "Image", lead: "Lead", user: "Users", settings: "Settings", category: "Categories", tag: "Tags", redirect: "Redirects" };

/** Where a change made outside the CMS came from — the console, the command line, the site's contact form. */
function actorOrigin(label: string): string {
  if (label.startsWith("Platform staff")) return "from the platform console";
  if (label === "script") return "from the command line";
  if (label === "Website") return "the contact form";
  return "outside the CMS";
}

/** The address's filters, whitelisted: a person, a kind of change (or one exact action), India days, a page. */
function parseFilters(sp: Record<string, string | string[] | undefined>) {
  const actor = one(sp.actor)?.trim().slice(0, 40) || undefined;
  const kindRaw = one(sp.kind);
  const kind = ACTION_CATEGORIES.some((c) => c.key === kindRaw) ? (kindRaw as ActionCategory) : undefined;
  const actionRaw = one(sp.action);
  const action = actionRaw && (CMS_AUDIT_ACTIONS as readonly string[]).includes(actionRaw) ? actionRaw : undefined;
  const from = DAY.test(one(sp.from) ?? "") ? one(sp.from) : undefined;
  const to = DAY.test(one(sp.to) ?? "") ? one(sp.to) : undefined;
  const page = Math.min(10_000, Math.max(1, Math.floor(Number(one(sp.page)) || 1)));
  const filters: CmsAuditFilters = { actorId: actor, action: action ?? (kind ? `${kind}.` : undefined), from, to, page };
  return { actor, kind, action, from, to, page, filters };
}

/** The log a page at a time, and India's today for the day headings — read on the server. */
async function loadActivity(filters: CmsAuditFilters) {
  const [log, users] = await Promise.all([listCmsAudit(filters), listCmsUsers()]);
  return { log, users, todayKey: istDayKey(new Date()) };
}

/**
 * Activity: everything changed in the CMS — by whom, what, to which thing and when, newest first,
 * 50 at a time — grouped under India's days. Filtered by person, by kind of change (pages, posts,
 * sign-ins…) and by dates, all in the address. Each row links to what it is about where that still
 * exists and this role may open it. The log holds ids, titles, slugs and counts — never a page's
 * text, a lead's message or anything secret — so every role may read it.
 */
export default async function CmsActivityPage({ searchParams }: PageProps<"/platform-cms/activity">) {
  const session = await cmsPage(CMS_PAGE_ROLES.activity);
  const caps = cmsCapsFor(session.user.role);
  const sp = await searchParams;
  const f = parseFilters(sp);
  const { log, users, todayKey } = await loadActivity(f.filters);
  const opts = { canOpenUsers: caps.admin, canOpenSecurity: caps.admin, canOpenRedirects: caps.publish };

  const actorName = f.actor ? (users.find((u) => u.id === f.actor)?.name ?? "Somebody removed") : null;
  const chips = [
    ...(actorName ? [{ key: "actor", label: `Person: ${actorName}`, removeHref: withParams(PATH, sp, { actor: null }) }] : []),
    ...(f.action ? [{ key: "action", label: `Change: ${actionLabel(f.action).label}`, removeHref: withParams(PATH, sp, { action: null }) }] : []),
    ...(f.kind && !f.action ? [{ key: "kind", label: `Kind: ${ACTION_CATEGORIES.find((c) => c.key === f.kind)?.label}`, removeHref: withParams(PATH, sp, { kind: null }) }] : []),
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
    <>
      <PageHeader title="Activity" subtitle="Everything changed in the CMS — who, what and when. Kept for good; nobody can edit it." />

      <FilterBar>
        <SelectFilter param="actor" label="Person" allLabel="Everybody" options={users.map((u) => ({ value: u.id, label: u.active ? u.name : `${u.name} (switched off)` }))} />
        <SelectFilter param="kind" label="Kind" allLabel="Every change" options={ACTION_CATEGORIES.map((c) => ({ value: c.key, label: c.label }))} />
        <DateRangeFilter label="Dates" />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

      <Panel padded={log.rows.length === 0}>
        {log.rows.length === 0 ? (
          filtered ? (
            <EmptyState variant="filtered" title="Nothing matches those filters" body="Widen the dates, or pick another person or kind of change." clearHref={PATH} />
          ) : (
            <EmptyState icon={<Activity className="h-5 w-5" />} title="Nothing has happened yet" body="Sign-ins, edits, publishing and everything else done in the CMS appear here as they happen." />
          )
        ) : (
          <DataTable caption="CMS activity, newest first" minWidth={820}>
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
                    const { label, tone } = actionLabel(row.action);
                    const { subject, note } = describeActivity(row);
                    const who = actorParts(row.actorLabel);
                    const href = entityHref(row, opts);
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
                          {!row.actorId && <span className="block text-[11px] text-subtle">{actorOrigin(row.actorLabel)}</span>}
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
                          {href && (
                            <Link href={href} className="inline-flex items-center gap-0.5 rounded-base text-xs font-medium text-brand hover:underline">
                              {ENTITY_LABEL[row.entity] ?? "Open"}
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
    </>
  );
}
