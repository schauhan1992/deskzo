import Link from "next/link";
import type { MessageChannel, MessageClass } from "@prisma/client";
import { listMailLog } from "@/actions/mail-log";
import { viewerHas } from "@/actions/permission";
import { NoAccessNotice } from "@/components/settings/module-disabled-notice";
import { MailLogTable } from "@/components/mail-log/mail-log-table";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { Card } from "@/components/ui/card";
import { MAIL_STATUS_GROUPS, MAIL_STATUS_GROUP_KEYS, type MailStatusGroup } from "@/lib/mail-log";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

type Params = {
  q?: string;
  status?: string;
  kind?: string;
  channel?: string;
  from?: string;
  to?: string;
  companyId?: string;
  page?: string;
  pageSize?: string;
};

const KINDS: { key?: MessageClass; label: string }[] = [
  { label: "All kinds" },
  { key: "TRANSACTIONAL", label: "Notices" },
  { key: "MARKETING", label: "Marketing" },
];
const CHANNELS: { key: MessageChannel | "ALL"; label: string }[] = [
  { key: "EMAIL", label: "Email" },
  { key: "WHATSAPP", label: "WhatsApp" },
  { key: "ALL", label: "Both" },
];

/**
 * Every email the ERP sent a customer — searchable, and narrowed to one customer from their page.
 */
export default async function MailLogPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await viewerHas("emails.view"))) return <NoAccessNotice title="Mail log" permission="emails.view" />;

  const params = await searchParams;
  const status = MAIL_STATUS_GROUP_KEYS.find((k) => k === params.status);
  const kind = KINDS.find((k) => k.key && k.key === params.kind)?.key;
  const channel = CHANNELS.find((c) => c.key === params.channel)?.key ?? "EMAIL";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const result = await listMailLog({
    q: params.q,
    status,
    kind,
    channel,
    from: params.from,
    to: params.to,
    companyId: params.companyId,
    page,
    pageSize,
  });

  // A filter link keeps every other filter and drops the page number.
  const hrefWith = (overrides: Partial<Record<keyof Params, string | undefined>>) => {
    const next: Record<string, string | undefined> = { ...params, page: undefined, ...overrides };
    const query = new URLSearchParams(Object.entries(next).filter((e): e is [string, string] => !!e[1]));
    const s = query.toString();
    return s ? `/mail-log?${s}` : "/mail-log";
  };
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-sm ${active ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"}`;
  const statusChips: { key?: MailStatusGroup; label: string }[] = [
    { label: "Any status" },
    ...MAIL_STATUS_GROUP_KEYS.map((k) => ({ key: k, label: MAIL_STATUS_GROUPS[k].label })),
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Mail log</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Every email the ERP sent a customer — renewal and fulfilment notices, campaigns and journeys — with whether it arrived, and
        why when it didn&apos;t. {result.total} match.
      </p>

      {params.companyId && (
        <p className="mt-3 text-sm">
          <span className="text-muted">One customer: </span>
          <span className="font-medium text-text">{result.rows[0]?.company.name ?? "no emails"}</span>{" "}
          <Link href={hrefWith({ companyId: undefined })} className="text-muted underline underline-offset-2 hover:text-text">
            show every customer
          </Link>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {statusChips.map((c) => (
          <Link key={c.key ?? "any"} href={hrefWith({ status: c.key })} className={chip(status === c.key)}>
            {c.label}
          </Link>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {KINDS.map((k) => (
          <Link key={k.key ?? "all"} href={hrefWith({ kind: k.key })} className={chip(kind === k.key)}>
            {k.label}
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        {CHANNELS.map((c) => (
          <Link key={c.key} href={hrefWith({ channel: c.key === "EMAIL" ? undefined : c.key })} className={chip(channel === c.key)}>
            {c.label}
          </Link>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Subject, email address, customer or contact…" className="w-80" />
        <DateRangePicker fromParam="from" toParam="to" label="Sent" />
      </div>

      <Card className="mt-4 overflow-x-auto p-0">
        <MailLogTable rows={result.rows} />
      </Card>
      <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} label="emails" />
    </div>
  );
}
