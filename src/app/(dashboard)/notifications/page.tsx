import Link from "next/link";
import type { NotificationType } from "@prisma/client";
import { listNotifications, notificationPreferences } from "@/actions/notification";
import { notificationLabel } from "@/lib/notifications/catalogue";
import { NotificationList } from "@/components/notifications/notification-list";
import { NotificationPreferences } from "@/components/notifications/notification-preferences";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { cn } from "@/lib/utils";

/**
 * Everything, rather than the most recent twenty.
 *
 * Never cached: a notification marked read on another tab, or one that arrived a second ago, has to
 * be right on this page or the unread count and the list disagree.
 */
export const dynamic = "force-dynamic";

const TABS = [
  { key: "inbox", label: "Inbox" },
  { key: "archived", label: "Archived" },
  { key: "preferences", label: "Preferences" },
] as const;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    unread?: string;
    type?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const params = await searchParams;
  const view = TABS.some((t) => t.key === params.view) ? (params.view as (typeof TABS)[number]["key"]) : "inbox";

  if (view === "preferences") {
    const preferences = await notificationPreferences();
    return (
      <div>
        <Header view={view} unread={null} archived={null} />
        <div className="mt-5">
          {preferences.ok ? (
            <NotificationPreferences preferences={preferences.data} />
          ) : (
            <p className="text-sm text-danger">{preferences.error}</p>
          )}
        </div>
      </div>
    );
  }

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const result = await listNotifications({
    page,
    pageSize,
    view,
    unreadOnly: params.unread === "1",
    type: params.type,
    from: params.from,
    to: params.to,
  });

  return (
    <div>
      <Header view={view} unread={result.unread} archived={result.archived} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SelectParamFilter
          paramName="type"
          label="Any kind"
          options={[
            ...result.presentTypes.map((t) => ({ value: t, label: notificationLabel(t as NotificationType) })),
          ].sort((a, b) => a.label.localeCompare(b.label))}
        />
        <DateRangePicker fromParam="from" toParam="to" label="Any date" />
        {/*
          A link rather than a control, so the filter survives a reload and can be shared — the same
          reason every other filter in the app lives in the URL.
        */}
        <Link
          href={{ pathname: "/notifications", query: { ...params, unread: params.unread === "1" ? undefined : "1", page: undefined } }}
          className={cn(
            "rounded-base border px-3 py-1.5 text-sm font-medium",
            params.unread === "1"
              ? "border-brand bg-brand-subtle text-brand"
              : "border-line-strong bg-surface text-muted hover:text-text",
          )}
        >
          Unread only
        </Link>
      </div>

      <div className="mt-4">
        <NotificationList rows={result.rows} view={view} />
      </div>

      {result.total > pageSize && (
        <div className="mt-4">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </div>
      )}
    </div>
  );
}

function Header({
  view,
  unread,
  archived,
}: {
  view: string;
  unread: number | null;
  archived: number | null;
}) {
  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Notifications</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Everything the app has told you, and control over what it tells you next.
      </p>

      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "inbox" ? "/notifications" : `/notifications?view=${t.key}`}
            className={cn(
              "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              view === t.key ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
            {t.key === "inbox" && unread !== null && unread > 0 && (
              <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[11px] text-brand-contrast">{unread}</span>
            )}
            {t.key === "archived" && archived !== null && archived > 0 && (
              <span className="ml-1.5 text-xs text-subtle">{archived}</span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
