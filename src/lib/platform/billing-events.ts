import type { Prisma } from "@wroffy/control-client";
import type { EventFilters } from "@/lib/console-shared/params";
import { redactSecrets } from "@/lib/console-shared/redact";
import type { GatewayKey } from "@/lib/console-shared/types";
import { endOfIndianDay, startOfIndianDay } from "@/lib/india-time";
import { controlDb } from "@/lib/platform/control-db";

/**
 * The webhook inspector: what each gateway told the platform, and what became of it (features F13).
 *
 * A stored webhook's payload holds the gateway's view of a customer — names, emails, addresses,
 * cards. So the list never reads it; one event's detail does (`billingEvent`, the only reader of
 * `payload` in the console), and gives it with personal fields replaced unless an owner asked for
 * it raw — which the action audits. Errors are shown through `redactSecrets`: a gateway's error
 * sometimes quotes what it was sent.
 */

export type BillingEventState = "processed" | "failed" | "waiting";

export type BillingEventRow = {
  id: string;
  gateway: GatewayKey;
  eventId: string;
  type: string;
  tenant: { id: string; slug: string } | null;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
  state: BillingEventState;
};
export type BillingEventsPage = {
  rows: BillingEventRow[];
  /** Events the filters match. */
  total: number;
  /** Events that failed and have not gone through since — whatever the filters. */
  failing: number;
  page: number;
  pageSize: number;
};
export type BillingEventDetail = {
  id: string;
  gateway: GatewayKey;
  eventId: string;
  type: string;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
  payload: unknown;
  /** Personal fields replaced (the default); false only for an owner's raw view. */
  redacted: boolean;
};

const PAGE_SIZE = 50;

/** Processed; failed (an error, and not processed since); waiting (neither, yet). */
const STATE_WHERE = {
  failed: { processedAt: null, error: { not: null } },
  waiting: { processedAt: null, error: null },
  processed: { processedAt: { not: null } },
} as const satisfies Record<BillingEventState, Prisma.BillingEventWhereInput>;

const stateOf = (e: { processedAt: Date | null; error: string | null }): BillingEventState => (e.processedAt ? "processed" : e.error ? "failed" : "waiting");

/** The filters as a query; null when they name a workspace that does not exist. */
async function eventWhere(f: EventFilters): Promise<Prisma.BillingEventWhereInput | null> {
  let tenantId: string | undefined;
  if (f.tenant) {
    const tenant = await controlDb().tenant.findUnique({ where: { slug: f.tenant }, select: { id: true } });
    if (!tenant) return null;
    tenantId = tenant.id;
  }
  // An event name or part of one; a trailing * ("customer.subscription.*") asks for names that start so.
  const typed = f.type?.replace(/\*+/g, "").trim();
  const type = typed ? (f.type!.trim().endsWith("*") ? { startsWith: typed, mode: "insensitive" as const } : { contains: typed, mode: "insensitive" as const }) : undefined;
  const from = f.from ? startOfIndianDay(f.from) : null;
  const to = f.to ? endOfIndianDay(f.to) : null;
  return {
    ...(f.gateway ? { gateway: f.gateway } : {}),
    ...(f.state ? STATE_WHERE[f.state] : {}),
    ...(type ? { type } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
}

/** Received webhooks, newest first, fifty to a page — without their payloads. */
export async function billingEvents(f: EventFilters): Promise<BillingEventsPage> {
  const control = controlDb();
  const [where, failing] = await Promise.all([eventWhere(f), control.billingEvent.count({ where: STATE_WHERE.failed })]);
  if (!where) return { rows: [], total: 0, failing, page: 1, pageSize: PAGE_SIZE };
  const total = await control.billingEvent.count({ where });
  const page = Math.min(Math.max(1, Math.trunc(f.page) || 1), Math.max(1, Math.ceil(total / PAGE_SIZE)));
  const rows = total
    ? await control.billingEvent.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, gateway: true, eventId: true, type: true, tenantId: true, receivedAt: true, processedAt: true, error: true },
      })
    : [];
  const ids = [...new Set(rows.map((r) => r.tenantId).filter((id): id is string => !!id))];
  const tenants = ids.length ? await control.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } }) : [];
  const slugs = new Map(tenants.map((t) => [t.id, t.slug]));
  return {
    rows: rows.map((r) => {
      const slug = r.tenantId ? slugs.get(r.tenantId) : undefined;
      return {
        id: r.id,
        gateway: r.gateway,
        eventId: r.eventId,
        type: r.type,
        tenant: r.tenantId && slug ? { id: r.tenantId, slug } : null,
        receivedAt: r.receivedAt,
        processedAt: r.processedAt,
        error: redactSecrets(r.error),
        state: stateOf(r),
      };
    }),
    total,
    failing,
    page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * One event, with its payload — the only place the console reads a payload. Redacted (personal
 * fields replaced) unless `raw`, which only an owner may ask for and which the caller audits. Null
 * when there is no such event.
 */
export async function billingEvent(id: string, opts: { raw: boolean }): Promise<BillingEventDetail | null> {
  const key = String(id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const event = await controlDb().billingEvent.findUnique({
    where: { id: key },
    select: { id: true, gateway: true, eventId: true, type: true, receivedAt: true, processedAt: true, error: true, payload: true },
  });
  if (!event) return null;
  const raw = opts?.raw === true;
  return {
    id: event.id,
    gateway: event.gateway,
    eventId: event.eventId,
    type: event.type,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
    error: redactSecrets(event.error),
    payload: raw ? event.payload : redactPayload(event.payload),
    redacted: !raw,
  };
}

// ─── Redaction ───────────────────────────────────────────────────────────────────────────────────

/** Keys whose values are about a person: replaced whole, whatever they hold (an object included). */
const PERSONAL_KEY =
  /^(email|phone|contact|name|address|line1|line2|city|state|postal_code|tax_id|tax_ids|gstin|vpa|card|bank|account_number|ifsc|customer_details|billing_details|shipping|customer_email|customer_name|customer_phone)$/i;
const REDACTED = "[redacted]";
/** Deeper than any gateway nests; anything past it is hidden rather than walked. */
const MAX_DEPTH = 64;

function walk(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      // An empty value says nothing about anybody; everything else under a personal key goes.
      const next = PERSONAL_KEY.test(key) ? (v === null || v === "" ? v : REDACTED) : walk(v, depth + 1);
      // Defined, not assigned: a JSON key "__proto__" must stay a key, not become the prototype.
      Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return REDACTED;
}

/**
 * A webhook payload with its personal fields replaced by "[redacted]" — names, emails, phones,
 * addresses, tax ids, card and bank details, wherever they are nested. Ids, event types, amounts,
 * currencies, statuses and timestamps are kept, which is what finding a problem needs.
 */
export function redactPayload(value: unknown): unknown {
  return walk(value, 0);
}
