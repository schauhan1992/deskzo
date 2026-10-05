import type { MailDeliveryStatus, MailStream, Prisma } from "@deskzo/control-client";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { MAIL_LOG_DAYS } from "@/lib/console-shared/mail-catalogue";

/**
 * The platform's mail, sent or not (console › Mail log): when, which type, the account it went through,
 * who it was to — in full, the owner's choice (5 Oct 2026) — the subject, and why it failed. Kept
 * MAIL_LOG_DAYS (90) days: the platform tick's daily chores drop older rows (`purgeDeliveries`).
 *
 * Writing a row never stops a mail: a log the control plane can't take is a warning in the server's
 * log, by status and type only.
 */

export type DeliveryRecord = {
  stream: MailStream;
  status: MailDeliveryStatus;
  connectionId: string | null;
  via: string;
  to: string[];
  cc: string[];
  fromAddress: string;
  subject: string;
  error?: string | null;
  messageId?: string | null;
  ms?: number | null;
  test?: boolean;
};

export async function recordDelivery(r: DeliveryRecord): Promise<void> {
  if (!controlConfigured()) return;
  try {
    await controlDb().mailDelivery.create({
      data: {
        stream: r.stream,
        status: r.status,
        connectionId: r.connectionId,
        via: r.via.slice(0, 120),
        toAddresses: r.to.slice(0, 50),
        ccAddresses: r.cc.slice(0, 50),
        addresses: [...r.to, ...r.cc].join(" ").toLowerCase().slice(0, 4000),
        fromAddress: r.fromAddress.slice(0, 254),
        subject: r.subject.slice(0, 300),
        error: r.error ? r.error.slice(0, 300) : null,
        messageId: r.messageId ? r.messageId.slice(0, 300) : null,
        ms: r.ms ?? null,
        test: r.test === true,
      },
      select: { id: true },
    });
  } catch (err) {
    console.warn(`[mail] a ${r.status.toLowerCase()} ${r.stream.toLowerCase()} mail was not logged: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  }
}

export const MAIL_LOG_PAGE_SIZE = 50;
export type DeliveryFilters = { stream?: MailStream | null; status?: MailDeliveryStatus | null; q?: string | null; page?: number };
export type DeliveryRow = {
  id: string;
  at: Date;
  stream: MailStream;
  status: MailDeliveryStatus;
  via: string;
  to: string[];
  cc: string[];
  fromAddress: string;
  subject: string;
  error: string | null;
  ms: number | null;
  test: boolean;
};

/** One page of the log, newest first; `q` finds an address (any part of one) or words of the subject. */
export async function listDeliveries(filters: DeliveryFilters = {}): Promise<{ rows: DeliveryRow[]; total: number; page: number; pages: number; counts: Record<MailDeliveryStatus, number> }> {
  const page = Math.min(1000, Math.max(1, Math.floor(Number(filters.page) || 1)));
  const q = (filters.q ?? "").trim().slice(0, 120);
  const where: Prisma.MailDeliveryWhereInput = {
    ...(filters.stream ? { stream: filters.stream } : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: "insensitive" } },
            { addresses: { contains: q.toLowerCase() } },
            { fromAddress: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const db = controlDb();
  const [rows, total, grouped] = await Promise.all([
    db.mailDelivery.findMany({
      where: { ...where, ...(filters.status ? { status: filters.status } : {}) },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      skip: (page - 1) * MAIL_LOG_PAGE_SIZE,
      take: MAIL_LOG_PAGE_SIZE,
    }),
    db.mailDelivery.count({ where: { ...where, ...(filters.status ? { status: filters.status } : {}) } }),
    db.mailDelivery.groupBy({ by: ["status"], where, _count: { _all: true } }),
  ]);
  const counts = { SENT: 0, FAILED: 0, OUTBOX: 0 } as Record<MailDeliveryStatus, number>;
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    rows: rows.map((r) => ({ id: r.id, at: r.at, stream: r.stream, status: r.status, via: r.via, to: r.toAddresses, cc: r.ccAddresses, fromAddress: r.fromAddress, subject: r.subject, error: r.error, ms: r.ms, test: r.test })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / MAIL_LOG_PAGE_SIZE)),
    counts,
  };
}

/** Drops rows older than the log keeps. Returns how many went. */
export async function purgeDeliveries(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - MAIL_LOG_DAYS * 86_400_000);
  const { count } = await controlDb().mailDelivery.deleteMany({ where: { at: { lt: before } } });
  return count;
}
