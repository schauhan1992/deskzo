"use server";

import type { MessageChannel, MessageClass, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { viewerHas } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { pageSlice } from "@/lib/pagination";
import { workspaceClock } from "@/lib/time/workspace";
import { formatOrderId } from "@/lib/order-id";
import { MAIL_STATUS_GROUPS, mailSender, mailSource, type MailStatusGroup } from "@/lib/mail-log";

/**
 * The mail log — every email the ERP sent a customer, whatever sent it.
 *
 * One table already holds all of it: campaigns, journeys and the renewal and fulfilment notices all
 * go through the same pipeline and leave a row each, including the ones held back and why. The
 * Marketing tab showed those rows to the marketing team; this shows them to anybody who works the
 * account — `emails.view`, within their own account scope, like every other part of a customer.
 */

const listSelect = {
  id: true,
  createdAt: true,
  sentAt: true,
  status: true,
  channel: true,
  messageClass: true,
  subject: true,
  toEmail: true,
  toPhone: true,
  error: true,
  suppressedReason: true,
  noticeKind: true,
  company: { select: { id: true, companySeq: true, name: true } },
  contact: { select: { id: true, name: true } },
  campaign: { select: { reference: true, name: true, createdBy: { select: { name: true } } } },
  enrolment: { select: { journey: { select: { name: true } } } },
  sentBy: { select: { name: true } },
  companyProduct: { select: { id: true, orderSeq: true } },
  formInvite: { select: { form: { select: { id: true, name: true, category: true } } } },
  tradeDocument: { select: { docType: true, docNumber: true } },
  fromEmail: true,
  events: { select: { type: true, occurredAt: true }, orderBy: { occurredAt: "asc" as const } },
} satisfies Prisma.MarketingMessageSelect;

type Row = Prisma.MarketingMessageGetPayload<{ select: typeof listSelect }>;

function shape(m: Row) {
  return {
    ...m,
    source: mailSource(m, formatOrderId),
    sender: mailSender(m),
    openedAt: m.events.find((e) => e.type === "OPEN")?.occurredAt ?? null,
    clickedAt: m.events.find((e) => e.type === "CLICK")?.occurredAt ?? null,
  };
}

export type MailLogParams = {
  companyId?: string;
  q?: string;
  status?: MailStatusGroup;
  kind?: MessageClass;
  channel?: MessageChannel | "ALL";
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
};

async function mailWhere(userId: string, params: MailLogParams): Promise<Prisma.MarketingMessageWhereInput> {
  const q = params.q?.trim();
  const days = (await workspaceClock()).dayRange(params.from, params.to);
  const channel = params.channel ?? "EMAIL";
  return {
    AND: [
      // The scope and the search both go through `company`, so they are separate terms.
      (await viaCompanyScope(userId)) as Prisma.MarketingMessageWhereInput,
      ...(params.companyId ? [{ companyId: params.companyId }] : []),
      ...(channel === "ALL" ? [] : [{ channel }]),
      ...(params.status && MAIL_STATUS_GROUPS[params.status] ? [{ status: { in: [...MAIL_STATUS_GROUPS[params.status].statuses] } }] : []),
      ...(params.kind ? [{ messageClass: params.kind }] : []),
      // Half-open, in the workspace's days — see src/lib/time/zone.ts.
      ...(days ? [{ createdAt: days }] : []),
      ...(q
        ? [
            {
              OR: [
                { subject: { contains: q, mode: "insensitive" as const } },
                { toEmail: { contains: q, mode: "insensitive" as const } },
                { company: { name: { contains: q, mode: "insensitive" as const } } },
                { contact: { name: { contains: q, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };
}

/** A page of the log — for one customer (their Emails tab) or across every account this person sees. */
export async function listMailLog(params: MailLogParams) {
  const user = await requireUser();
  if (!(await viewerHas("emails.view"))) return { rows: [], total: 0 };
  if (params.companyId) {
    const company = await db.company.findUnique({ where: { id: params.companyId }, select: { ownerUserId: true, relationshipType: true } });
    if (!company || !(await canSeeCompany(user.id, company))) return { rows: [], total: 0 };
  }
  const where = await mailWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.marketingMessage.findMany({ where, orderBy: { createdAt: "desc" }, select: listSelect, ...pageSlice(params.page, params.pageSize) }),
    db.marketingMessage.count({ where }),
  ]);
  return toPlain({ rows: rows.map(shape), total });
}

/** The counts at the top of a customer's Emails tab. Null when the customer isn't this person's to see. */
export async function companyMailSummary(companyId: string) {
  const user = await requireUser();
  if (!(await viewerHas("emails.view"))) return null;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return null;
  const [byStatus, last] = await Promise.all([
    db.marketingMessage.groupBy({ by: ["status"], where: { companyId, channel: "EMAIL" }, _count: { _all: true } }),
    db.marketingMessage.findFirst({ where: { companyId, channel: "EMAIL", sentAt: { not: null } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
  ]);
  const count = (statuses: readonly string[]) => byStatus.filter((g) => statuses.includes(g.status)).reduce((t, g) => t + g._count._all, 0);
  return toPlain({
    total: byStatus.reduce((t, g) => t + g._count._all, 0),
    delivered: count(MAIL_STATUS_GROUPS.delivered.statuses),
    opened: count(MAIL_STATUS_GROUPS.opened.statuses),
    problem: count(MAIL_STATUS_GROUPS.problem.statuses),
    held: count(MAIL_STATUS_GROUPS.held.statuses),
    lastSentAt: last?.sentAt ?? null,
  });
}

/** One message in full — the body, where it went, and everything that happened to it. */
export async function getMailMessage(id: string) {
  const user = await requireUser();
  if (!(await viewerHas("emails.view"))) return null;
  const message = await db.marketingMessage.findUnique({
    where: { id },
    select: {
      ...listSelect,
      body: true,
      scheduledFor: true,
      attempts: true,
      providerMessageId: true,
      company: { select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true } },
      provider: { select: { label: true, fromEmail: true, fromName: true } },
      events: { select: { type: true, occurredAt: true, url: true, detail: true }, orderBy: { occurredAt: "asc" } },
    },
  });
  // Out of scope answers the same as missing, so an id says nothing about whose it is.
  if (!message || !(await canSeeCompany(user.id, message.company))) return null;
  const { company, ...rest } = message;
  return toPlain({
    ...rest,
    company: { id: company.id, companySeq: company.companySeq, name: company.name },
    source: mailSource(message, formatOrderId),
    sender: mailSender(message),
  });
}
