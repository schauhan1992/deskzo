import Link from "next/link";
import {
  Building2,
  ChevronRight,
  Cpu,
  CreditCard,
  Earth,
  FingerprintPattern,
  Handshake,
  LayoutDashboard,
  LifeBuoy,
  Rocket,
  ScrollText,
  SquareTerminal,
  StickyNote,
  Ticket,
  Users,
  type LucideIcon,
} from "lucide-react";
import { CopyButton } from "@/components/console/kit/copy-field";
import { StatusPill, TONE_TEXT } from "@/components/console/kit/status";
import { DataTable, DayHeaderRow, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Avatar } from "@/components/ui/avatar";
import { dayGroupLabel, istDayKey } from "@/lib/console-shared/format";
import { AUDIT_CATEGORIES } from "@/lib/console-shared/labels";
import type { AuditCategoryKey } from "@/lib/console-shared/types";
import { formatIstDateTime, formatIstTime } from "@/lib/india-time";
import type { AuditRowView } from "@/lib/platform/audit-query";
import { cn } from "@/lib/utils";

/**
 * The audit log as a table (spec §3.17): newest first, grouped under a heading per Indian day, one
 * row per entry — when, who, what, on which workspace, and the entry's one-line summary. A row opens
 * (a plain `<details>`, so it works before any script loads) to the entry's full detail as JSON,
 * already redacted by the loader, with a button to copy it.
 *
 * Server-safe: the day headings come from the loader's `todayKey`, never from a clock read here.
 */

const COLUMNS = 5;

const CATEGORY_ICON: Record<AuditCategoryKey, LucideIcon> = {
  lifecycle: Building2,
  billing: CreditCard,
  staff: Users,
  support: LifeBuoy,
  setup: Rocket,
  reference: Earth,
  invites: Ticket,
  notes: StickyNote,
  terminals: FingerprintPattern,
  console: LayoutDashboard,
  partners: Handshake,
};

const CATEGORY_LABEL = new Map(AUDIT_CATEGORIES.map((c) => [c.key, c.label]));

function asDate(at: Date | string): Date {
  return at instanceof Date ? at : new Date(at);
}

/** Consecutive rows of one Indian day — the rows arrive newest first, so each day is one run. */
function byDay(rows: AuditRowView[]): { day: string; rows: AuditRowView[] }[] {
  const groups: { day: string; rows: AuditRowView[] }[] = [];
  for (const row of rows) {
    const day = istDayKey(asDate(row.at));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

export function AuditLogTable({ rows, todayKey }: { rows: AuditRowView[]; todayKey: string }) {
  return (
    <DataTable stickyHeader minWidth={960} caption="Audit log entries, newest first">
      <THead>
        <Th className="w-24">Time</Th>
        <Th className="w-52">Who</Th>
        <Th>What</Th>
        <Th className="w-40">Workspace</Th>
        <Th>Details</Th>
      </THead>
      {byDay(rows).map((group) => (
        // One row group per day: the heading row names it for a screen reader as well.
        <TBody key={group.day}>
          <DayHeaderRow label={dayGroupLabel(group.day, todayKey)} colSpan={COLUMNS} />
          {group.rows.map((row) => (
            <AuditRow key={row.id} row={row} />
          ))}
        </TBody>
      ))}
    </DataTable>
  );
}

function AuditRow({ row }: { row: AuditRowView }) {
  const at = asDate(row.at);
  const workspaceHref = row.href?.startsWith("/workspaces/") ? row.href : null;
  return (
    // Top-aligned: an opened row grows downwards without dragging its other cells to the middle.
    <Tr className="[&>td]:align-top">
      <Td nowrap muted className="tabular-nums">
        <time dateTime={at.toISOString()} title={`${formatIstDateTime(at)} IST`}>
          {formatIstTime(at)}
        </time>
      </Td>
      <Td>
        <Who row={row} />
      </Td>
      <Td>
        <What row={row} />
      </Td>
      <Td nowrap>
        {row.workspace ? (
          <Link
            href={workspaceHref ?? `/workspaces/${encodeURIComponent(row.workspace.slug)}`}
            className="rounded-base font-mono text-xs text-brand hover:underline"
          >
            {row.workspace.slug}
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        )}
      </Td>
      <Td className="min-w-64">
        <Details row={row} />
      </Td>
    </Tr>
  );
}

/** A staff member by name, with their initials; a script or the platform itself as a plain chip. */
function Who({ row }: { row: AuditRowView }) {
  if (row.actorKind === "STAFF") {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Avatar user={{ id: row.actorId, name: row.actor }} size="xs" />
        <span className="min-w-0 truncate text-text">{row.actor}</span>
      </span>
    );
  }
  const script = row.actorKind === "SCRIPT";
  const Icon = script ? SquareTerminal : Cpu;
  return (
    <StatusPill
      tone="neutral"
      icon={<Icon className="h-3 w-3" />}
      title={script ? "A script run on the server" : "The platform itself"}
      className={cn("max-w-full", script && "font-mono")}
    >
      <span className="truncate">{row.actor}</span>
    </StatusPill>
  );
}

/**
 * The entry in words, with its category's icon and the raw action key underneath — the key is what
 * the filters and the CSV use. Entries about a page rather than a workspace (a plan, an
 * announcement, staff) link to it; a workspace's entries link from the Workspace column instead.
 */
function What({ row }: { row: AuditRowView }) {
  const Icon = row.category ? CATEGORY_ICON[row.category] : ScrollText;
  const category = row.category ? (CATEGORY_LABEL.get(row.category) ?? "Other") : "Other";
  const pageHref = row.href && !row.href.startsWith("/workspaces/") ? row.href : null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span title={category} className={cn("mt-0.5 inline-flex shrink-0", TONE_TEXT[row.tone])}>
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        {pageHref ? (
          <Link href={pageHref} className="rounded-base font-medium text-text hover:text-brand hover:underline">
            {row.title}
          </Link>
        ) : (
          <span className="font-medium text-text">{row.title}</span>
        )}
        <div className="font-mono text-[11px] break-all text-subtle">{row.code}</div>
      </div>
    </div>
  );
}

/**
 * The one-line summary; with a detail to show, it is the summary of a disclosure that opens onto
 * the pretty-printed JSON. The JSON wraps rather than scrolling sideways, so an opened row never
 * widens the table.
 */
function Details({ row }: { row: AuditRowView }) {
  const summary = typeof row.detail === "string" && row.detail ? row.detail : null;
  if (!row.json) return summary ? <span className="text-xs break-words text-muted">{summary}</span> : <span className="text-subtle">—</span>;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-start gap-1 rounded-base text-xs text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-open:rotate-90" />
        <span className="min-w-0 break-words">{summary ?? "Show the full detail"}</span>
        {summary && <span className="sr-only"> — show the full detail</span>}
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-surface-sunken">
        <div className="flex items-center justify-between gap-2 border-b border-line py-0.5 pr-1 pl-3">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">Detail</span>
          <CopyButton value={row.json} label="Copy JSON" />
        </div>
        <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{row.json}</pre>
      </div>
    </details>
  );
}
