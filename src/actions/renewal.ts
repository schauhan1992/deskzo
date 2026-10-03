"use server";

import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { requireModuleUser } from "@/lib/modules-access";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { resolveRenewalStage, type RenewalStageKey } from "@/lib/renewals";
import { pageSlice } from "@/lib/pagination";
import { workspaceClock } from "@/lib/time/workspace";
import { revalidatePath } from "next/cache";
import { notifyUser } from "@/lib/notify";
import { formatOrderId } from "@/lib/order-id";
import { bulkRenewalTasksSchema } from "@/lib/validation/task";
import type { ActionResult } from "@/actions/company";
import type { Prisma } from "@prisma/client";
import { viewerHas } from "@/actions/permission";

export type RenewalWindow = "expired" | "30" | "60" | "90";

/**
 * Which subscriptions the renewals list is about, as one `where` both the page query and the two
 * counts are built from — so a filter can never mean one thing to the rows and another to the
 * tally beside them.
 *
 * `today` is passed in rather than taken here, because the window bound and the expired bound have to
 * be the same day: computing them a few milliseconds apart, across midnight, would let a subscription
 * expiring in that gap be inside the window and outside the expired count at the same time.
 *
 * It is the workspace's today as the column holds a day (`clock.calendarDate(now)`). An end date is a
 * calendar day, kept as its midnight UTC, so a subscription runs through its last day and has expired
 * the day after. Compared with the moment instead, it lapsed at midnight UTC on its last day — 05:30
 * in India, the evening before in America.
 *
 * The account scope lives here for the same reason the filters do. A renewal is an order, so it
 * reaches its account through its own company, one hop — and the page runs this `where` three
 * times: the rows, the total, and the expired tally. Applied at the call sites instead, the tally
 * is the one that gets forgotten, and "14 expired" beside four rows is a headline count of
 * somebody else's book.
 */
async function renewalWhere(
  params: { window?: RenewalWindow; search?: string } | undefined,
  today: Date,
  userId: string,
) {
  const endDate: { not: null; lt?: Date; gte?: Date; lte?: Date } = { not: null };
  if (params?.window === "expired") {
    endDate.lt = today;
  } else if (params?.window === "30" || params?.window === "60" || params?.window === "90") {
    endDate.gte = today;
    // Days added to a midnight UTC: UTC has no clock changes, so this is the day `window` days on.
    endDate.lte = new Date(today.getTime() + Number(params.window) * 86_400_000);
  }

  return {
    item: { type: "SUBSCRIPTION" as const },
    // Parents only. An addon co-terminates with its subscription and comes back with it — listing
    // it separately would turn one renewal conversation into three.
    parentId: null,
    endDate,
    // The scope and the search both narrow through `company`, so they are two `AND` terms rather
    // than two spreads into one object — a second `company` key would replace the first, and the
    // one written first is the scope.
    AND: [
      await viaCompanyScope(userId),
      ...(params?.search
        ? [{ company: { name: { contains: params.search, mode: "insensitive" as const } } }]
        : []),
    ],
  };
}

const renewalInclude = {
  company: {
    select: {
      id: true,
      name: true,
      stage: true,
      relationshipType: true,
      // Whose number this is, and who to ring. Both are what the list is actually used for.
      owner: { select: { id: true, name: true } },
      contacts: {
        where: { phone: { not: null } },
        orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
        take: 1,
        select: { id: true, name: true, phone: true },
      },
    },
  },
  // Set once a renewal has been punched, so the list stops asking for one.
  renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
  // Who pinned the stage, where somebody has. The column says so rather than implying the app knew.
  renewalStageBy: { select: { id: true, name: true } },
  // On a reseller's order this is whose subscription it actually is — renew through the
  // reseller, but the seats and expiry belong to the end customer.
  endCustomer: { select: { id: true, name: true } },
  item: { select: { id: true, name: true, sku: true, unit: true, billingCycle: true } },
  addedBy: { select: { id: true, name: true } },
  addons: {
    where: { orderStatus: { not: "CANCELLED" as const } },
    select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
  },
} satisfies Prisma.CompanyProductInclude;

/**
 * Soonest expiry first, and `id` to break a tie.
 *
 * The tiebreaker is not cosmetic. 28 of today's expiry dates are shared by more than one order (64
 * rows, the largest group 7), and one of those groups straddles the page-4/page-5 boundary. Ordering
 * by `endDate` alone leaves the order within a tie up to the query plan, which is harmless when one
 * query fetches everything and slices in memory, but not when each page is its own `LIMIT`/`OFFSET`:
 * two such queries may break the same tie differently, and a row then shows up on both pages or on
 * neither. A unique final key makes the sequence total, so the pages partition the list exactly.
 */
const renewalOrderBy = [
  { endDate: "asc" },
  { id: "asc" },
] satisfies Prisma.CompanyProductOrderByWithRelationInput[];

type RenewalGroupSource = {
  id: string;
  quantity: number;
  unitPrice: unknown;
  fullTermUnitPrice: unknown;
  startDate: Date | null;
  addons: { id: string; quantity: number; unitPrice: unknown; fullTermUnitPrice: unknown; startDate: Date | null }[];
};

/**
 * The seat count and the renewal value are the group's, not the parent's — "15 seats expiring on
 * the 9th" is the conversation, not "10 seats, and separately 5 seats".
 *
 * Purely a rendered value: nothing about the group takes part in the `where` or the `orderBy`, so it
 * can be worked out for one page's rows without changing which rows that page holds.
 */
function withRenewalGroup<T extends RenewalGroupSource>(row: T) {
  return {
    ...row,
    group: renewalGroup([
      {
        id: row.id,
        quantity: row.quantity,
        unitPrice: row.unitPrice ? Number(row.unitPrice) : null,
        fullTermUnitPrice: row.fullTermUnitPrice ? Number(row.fullTermUnitPrice) : null,
        startDate: row.startDate,
        isAddon: false,
      },
      ...row.addons.map((a) => ({
        id: a.id,
        quantity: a.quantity,
        unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
        fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
        startDate: a.startDate,
        isAddon: true,
      })),
    ]),
  };
}

/** The title `bulkCreateRenewalTasks` writes, which is also how it recognises its own tasks. */
function renewalTaskTitle(itemName: string, companyName: string) {
  return `Renew ${itemName} — ${companyName}`;
}

type StageSource = {
  id: string;
  companyId: string;
  item: { name: string };
  company: { name: string };
  renewedBy: { id: string } | null;
};

/**
 * What the record already says about how far each renewal has got.
 *
 * Four batched queries for the whole page rather than four per row — the alternative is 100 round
 * trips to render 25 lines, which is the shape of slow list page nobody notices until the book
 * doubles.
 *
 * The task signal matches on company and title because a `Task` has no link to an order. That is
 * not a guess: `bulkCreateRenewalTasks` recognises its own tasks the same way, so this reads exactly
 * what that writes. It is the weakest of the four — renaming the product orphans the match — which
 * is why it is the lowest rung and why the three above it are real foreign keys.
 */
async function renewalStageSignals(rows: StageSource[]) {
  const signals = new Map<
    string,
    { renewed: boolean; quoted: boolean; contacted: boolean; taskRaised: boolean; quote: QuoteRef | null }
  >();
  if (rows.length === 0) return signals;

  const ids = rows.map((r) => r.id);

  const [quoteLines, calls, tasks] = await Promise.all([
    /**
     * A document quoting this subscription's next term.
     *
     * Proformas and invoices count as well as proposals: a renewal billed directly, without a quote
     * ever going out, has plainly got past "Contacted". Cancelled, rejected and expired documents do
     * not count — a withdrawn quote is not a quote outstanding.
     */
    db.tradeDocumentLine.findMany({
      where: {
        companyProductId: { in: ids },
        document: {
          docType: { in: ["PROPOSAL", "PROFORMA", "INVOICE"] },
          status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
        },
      },
      select: {
        companyProductId: true,
        document: { select: { id: true, docNumber: true, docType: true, status: true, issueDate: true } },
      },
      orderBy: { document: { issueDate: "desc" } },
    }),
    db.callLog.findMany({ where: { companyProductId: { in: ids } }, select: { companyProductId: true } }),
    db.task.findMany({
      where: {
        done: false,
        OR: rows.map((r) => ({ companyId: r.companyId, title: renewalTaskTitle(r.item.name, r.company.name) })),
      },
      select: { companyId: true, title: true },
    }),
  ]);

  const quoted = new Map<string, QuoteRef>();
  for (const line of quoteLines) {
    // Ordered newest first, so the first one seen for an order is the one worth linking to.
    if (line.companyProductId && !quoted.has(line.companyProductId)) {
      quoted.set(line.companyProductId, {
        id: line.document.id,
        docNumber: line.document.docNumber,
        docType: line.document.docType,
        status: line.document.status,
      });
    }
  }
  const called = new Set(calls.map((c) => c.companyProductId).filter(Boolean) as string[]);
  const tasked = new Set(tasks.map((t) => `${t.companyId}::${t.title}`));

  for (const row of rows) {
    const quote = quoted.get(row.id) ?? null;
    signals.set(row.id, {
      renewed: Boolean(row.renewedBy),
      quoted: Boolean(quote),
      contacted: called.has(row.id),
      taskRaised: tasked.has(`${row.companyId}::${renewalTaskTitle(row.item.name, row.company.name)}`),
      quote,
    });
  }
  return signals;
}

export type QuoteRef = { id: string; docNumber: string; docType: string; status: string };

/**
 * Each row with the stage it is at, resolved from the evidence and whatever somebody pinned.
 *
 * Done here rather than in the component so the list, any export and any future report all answer
 * the question the same way — a stage worked out twice is a stage that eventually disagrees with
 * itself.
 */
async function withRenewalStage<T extends StageSource & { renewalStage: unknown; renewalStageNote: string | null; renewalStageAt: Date | null; renewalStageBy: { id: string; name: string } | null }>(
  rows: T[],
) {
  const signals = await renewalStageSignals(rows);
  return rows.map((row) => {
    const signal = signals.get(row.id) ?? { renewed: false, quoted: false, contacted: false, taskRaised: false, quote: null };
    const resolved = resolveRenewalStage({
      override: (row.renewalStage as RenewalStageKey | null) ?? null,
      signals: signal,
    });
    return {
      ...row,
      stage: {
        ...resolved,
        note: row.renewalStageNote,
        setAt: row.renewalStageAt,
        setBy: row.renewalStageBy,
        /** The document behind a "Quoted", so the cell can link straight to it. */
        quote: signal.quote,
      },
    };
  });
}

/**
 * Every matching subscription, with no ceiling on how many that is.
 *
 * Nothing in the app calls this — the renewals screen goes through `listRenewalsPaged`. It is kept
 * for the export/tally case that genuinely wants the whole book, and it shares its `where`,
 * `include` and `orderBy` with the paged query so the two cannot drift apart. If you reach for it,
 * remember that it grows with the subscription book: 181 rows today, unbounded tomorrow.
 */
export async function listRenewals(params?: { window?: RenewalWindow; search?: string }) {
  const user = await requireModuleUser("renewals");
  if (!(await viewerHas("orders.view"))) return [];
  const rows = await db.companyProduct.findMany({
    where: await renewalWhere(params, (await workspaceClock()).calendarDate(new Date()), user.id),
    include: renewalInclude,
    orderBy: renewalOrderBy,
  });
  return withRenewalStage(rows.map(withRenewalGroup));
}

/**
 * One page of the renewals list.
 *
 * The page is cut in the database rather than in memory: fetching every matching subscription with
 * the include tree above to render 25 of them costs the deep read on all 181 rows, and that figure
 * only goes one way.
 */
export async function listRenewalsPaged(params: { window?: RenewalWindow; search?: string; page: number; pageSize: number }) {
  const user = await requireModuleUser("renewals");
  if (!(await viewerHas("orders.view"))) return { rows: [], total: 0, expired: 0 };
  const today = (await workspaceClock()).calendarDate(new Date());
  const where = await renewalWhere(params, today, user.id);

  const [rows, total, expired] = await Promise.all([
    db.companyProduct.findMany({
      where,
      include: renewalInclude,
      orderBy: renewalOrderBy,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.companyProduct.count({ where }),
    // The expired tally is over everything the filters match, not over the page — so it is its own
    // count, with the same `where` narrowed to what has already lapsed. Spreading the window's own
    // `endDate` bounds keeps the two consistent: on the 30/60/90 windows the added `lt: today` cannot
    // be satisfied alongside `gte: today`, which is right — nothing in a forward-looking window has
    // expired yet.
    db.companyProduct.count({ where: { ...where, endDate: { ...where.endDate, lt: today } } }),
  ]);

  return { rows: toPlain(await withRenewalStage(rows.map(withRenewalGroup))), total, expired };
}

/**
 * Turns a selection of expiring subscriptions into renewal tasks — the one action this screen
 * actually needs, since spotting an expiry is only useful if someone is then asked to chase it.
 * A task is skipped when an open renewal task already exists for that order, so re-running the
 * bulk action after adding a few more rows doesn't produce duplicates.
 */
export async function bulkCreateRenewalTasks(input: unknown): Promise<ActionResult<{ count: number; skipped: number }>> {
  const user = await requireModuleUser("renewals");
  const parsed = bulkRenewalTasksSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orderIds, assignedToUserId, dueDate } = parsed.data;

  if (assignedToUserId) {
    const assignee = await db.user.findUnique({ where: { id: assignedToUserId }, select: { active: true } });
    if (!assignee || !assignee.active) return { ok: false, error: "That user can't be assigned tasks." };
  }

  const orders = await db.companyProduct.findMany({
    // Scoped as well as filtered by id. The rows were ticked on a list that is account-scoped now,
    // so a real selection is unaffected — but the ids are posted from the browser, and the task
    // this writes carries the customer's name onto a task list and onto their account.
    where: { id: { in: orderIds }, ...(await viaCompanyScope(user.id)) },
    select: {
      id: true,
      orderSeq: true,
      companyId: true,
      endDate: true,
      item: { select: { name: true } },
      company: { select: { name: true } },
    },
  });

  let created = 0;
  let skipped = 0;

  for (const order of orders) {
    const title = `Renew ${order.item.name} — ${order.company.name}`;
    const existing = await db.task.findFirst({ where: { companyId: order.companyId, title, done: false } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.task.create({
      data: {
        title,
        description: `${formatOrderId(order.orderSeq)} expires ${order.endDate ? order.endDate.toISOString().slice(0, 10) : "soon"}.`,
        dueDate: dueDate ? new Date(dueDate) : order.endDate,
        companyId: order.companyId,
        assignedToUserId: assignedToUserId || null,
        createdByUserId: user.id,
      },
    });
    created += 1;
    if (assignedToUserId && assignedToUserId !== user.id) {
      await notifyUser({
        userId: assignedToUserId,
        type: "TASK_ASSIGNED",
        title: "Renewal task assigned",
        message: title,
        link: "/tasks",
      });
    }
  }

  revalidatePath("/tasks");
  revalidatePath("/renewals");
  return { ok: true, data: { count: created, skipped } };
}
