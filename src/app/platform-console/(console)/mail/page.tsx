import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Mail } from "lucide-react";
import type { MailDeliveryStatus, MailStream } from "@deskzo/control-client";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { CursorPager } from "@/components/console/kit/pager";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { withParams, type RawParams } from "@/lib/console-shared/params";
import type { Tone } from "@/lib/console-shared/types";
import { consoleStaff } from "@/lib/platform/console-page";
import { MAIL_LOG_DAYS, MAIL_STREAMS } from "@/lib/console-shared/mail-catalogue";
import { listDeliveries } from "@/lib/platform/mail/log";

export const metadata: Metadata = { title: "Mail log" };

const PATH = "/mail";
const STATUS: Record<MailDeliveryStatus, { label: string; tone: Tone }> = {
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  OUTBOX: { label: "Outbox", tone: "warning" },
};
const TYPES = MAIL_STREAMS.filter((s) => s.key !== "DEFAULT");
const streamLabel = (stream: MailStream) => (stream === "DEFAULT" ? "Account test" : (MAIL_STREAMS.find((s) => s.key === stream)?.label ?? stream));

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Every platform mail, sent or not (src/lib/platform/mail/log.ts) — so "I never got the code" can be
 * answered: when it went, through which account, and what the server said. Owners, admins and support
 * (the addresses are in full); newest first, 50 a page, kept 90 days. The accounts themselves are in
 * Settings › Mail.
 */
export default async function ConsoleMailLogPage({ searchParams }: PageProps<"/platform-console/mail">) {
  await consoleStaff(PAGE_ROLES.mail);
  const sp: RawParams = (await searchParams) ?? {};
  const stream = TYPES.find((t) => t.key === one(sp.type))?.key as MailStream | undefined;
  const status = (Object.keys(STATUS) as MailDeliveryStatus[]).find((s) => s === one(sp.status));
  const q = one(sp.q).trim().slice(0, 120);
  const page = Math.max(1, Math.floor(Number(one(sp.page)) || 1));
  // Null until the release's migration has made the mail tables (src/lib/platform/mail).
  const log = await listDeliveries({ stream, status, q, page }).catch(() => null);
  if (!log) {
    return (
      <>
        <PageHeader title="Mail log" />
        <Banner tone="warning" title="Not ready yet">
          {"This release's database migrations haven't run here, so there is no mail log yet. Run npm run tenants:migrate, then reload."}
        </Banner>
      </>
    );
  }

  const chips = [
    ...(q ? [{ key: "q", label: `Search: ${q}`, removeHref: withParams(PATH, sp, { q: null, page: null }) }] : []),
    ...(stream ? [{ key: "type", label: `Type: ${streamLabel(stream)}`, removeHref: withParams(PATH, sp, { type: null, page: null }) }] : []),
    ...(status ? [{ key: "status", label: `Status: ${STATUS[status].label}`, removeHref: withParams(PATH, sp, { status: null, page: null }) }] : []),
  ];
  const filtered = chips.length > 0;
  const newerHref = log.page > 1 ? withParams(PATH, sp, { page: log.page === 2 ? null : String(log.page - 1) }) : null;
  const olderHref = log.page < log.pages ? withParams(PATH, sp, { page: String(log.page + 1) }) : null;

  return (
    <>
      <PageHeader
        title="Mail log"
        subtitle={`Every mail the platform sent or tried to — newest first, kept ${MAIL_LOG_DAYS} days.`}
        actions={
          <Link href="/settings/mail" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            Mail accounts
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <FilterBar>
        <SearchField label="Search the mail log" placeholder="An address, or words of the subject" />
        <SelectFilter param="type" label="Type" options={TYPES.map((t) => ({ value: t.key, label: t.label }))} />
        <SelectFilter
          param="status"
          label="Status"
          options={(Object.keys(STATUS) as MailDeliveryStatus[]).map((s) => ({ value: s, label: `${STATUS[s].label} · ${log.counts[s].toLocaleString("en-IN")}` }))}
        />
      </FilterBar>
      <FilterChips chips={chips} clearHref={filtered ? PATH : undefined} />

      {log.rows.length > 0 ? (
        <>
          <Panel padded={false}>
            <ul aria-label="Mail" className="divide-y divide-line">
              {log.rows.map((r) => (
                <li key={r.id} className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
                  <p className="text-xs text-muted">
                    <RelativeTime at={r.at} />
                  </p>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{r.subject}</p>
                    <p className="truncate text-xs text-muted">
                      {`To ${r.to.join(", ")}${r.cc.length ? `, cc ${r.cc.join(", ")}` : ""} · from ${r.fromAddress}`}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {`${streamLabel(r.stream)} · ${r.via}${r.ms !== null ? ` · ${(r.ms / 1000).toFixed(1)} s` : ""}${r.test ? " · test" : ""}`}
                    </p>
                    {r.error && <p className="mt-1 text-xs break-words text-danger">{r.error}</p>}
                  </div>
                  <div className="sm:text-right">
                    <StatusPill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
          <CursorPager newerHref={newerHref} olderHref={olderHref} summary={`Page ${log.page} of ${log.pages} · ${plural(log.total, "mail")}`} />
        </>
      ) : (
        <Panel padded={false}>
          {filtered ? (
            <EmptyState variant="filtered" title="No mail matches." body="Search for part of an address, or another type or status." clearHref={PATH} />
          ) : (
            <EmptyState icon={<Mail className="h-5 w-5" />} title="No mail yet." body="Signup codes, password links, billing reminders, helpdesk replies and alerts appear here as they are sent." />
          )}
        </Panel>
      )}
    </>
  );
}
