"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { getOrganisation } from "@/lib/organisation";
import { financialYearOf } from "@/lib/gst-engine";
import { hasEffectivePermission } from "@/actions/permission";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { linkState, summarise } from "@/lib/feedback/rating";
import type { ActionResult } from "@/actions/company";

/**
 * Asking customers how it went, and reading what they said.
 *
 * The public half — the form itself — is in src/actions/feedback-public.ts, deliberately separate
 * because every export in a `"use server"` module is a client-callable endpoint and the two halves
 * have completely different threat models. Nothing in this file may be reached without a session.
 */

/** 192 bits, like the intake token. Long enough that guessing is not a thing that happens. */
const TOKEN_BYTES = 24;

async function access() {
  const user = await requireModuleUser("feedback");
  const [request, viewAll] = await Promise.all([
    hasEffectivePermission(user.id, "feedback.request"),
    hasEffectivePermission(user.id, "feedback.viewAll"),
  ]);
  return { user, canRequest: request, viewAll };
}

/**
 * What somebody may see without `feedback.viewAll`.
 *
 * Not nothing, deliberately: feedback about your own work is the single most useful thing in here
 * and hiding it from the person it is about would be perverse. So you see what was said about you,
 * what you asked for, and what came in on the accounts you run — and nothing else, because a two-
 * star review naming a colleague is not general reading.
 */
/**
 * Note that this already carries the account leg — `company.ownerUserId` — so the account scope in
 * src/lib/authz/company-scope.ts is not spread on top of it anywhere below. Doing so would narrow
 * it, not widen it: this clause is an OR, and a two-star review naming you is yours to read whether
 * or not you manage the account it came from. It is also stricter than the account scope on the leg
 * they share, matching `feedback.viewAll`'s own wording of "the accounts they run" — your own, not
 * your team's. Both readings are defensible; the shipped one is not this task's to change.
 */
function visibleTo(userId: string): Prisma.FeedbackRequestWhereInput {
  return {
    OR: [
      { aboutUserId: userId },
      { requestedById: userId },
      { company: { ownerUserId: userId } },
      { company: { assignedToUserId: userId } },
    ],
  };
}

const requestSelect = {
  id: true,
  reference: true,
  status: true,
  sentAt: true,
  expiresAt: true,
  cancelledAt: true,
  message: true,
  serviceLabel: true,
  sentToName: true,
  sentToEmail: true,
  sentToPhone: true,
  createdAt: true,
  company: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true, email: true, phone: true } },
  aboutUser: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
  visit: { select: { id: true, purpose: true, scheduledFor: true } },
  order: { select: { id: true, item: { select: { name: true } } } },
  response: {
    select: {
      id: true,
      rating: true,
      personRating: true,
      serviceRating: true,
      comment: true,
      reviewInvited: true,
      reviewMinRatingAtTime: true,
      reviewOpenedAt: true,
      submittedAt: true,
      acknowledgedAt: true,
      actionNote: true,
      acknowledgedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.FeedbackRequestSelect;

// ─── Asking ───────────────────────────────────────────────────────────────────

/**
 * The reference somebody reads out. Financial-year scoped like every other number in the app, so
 * "FB slash twenty-six slash forty-one" is unambiguous about which year it belongs to.
 */
async function nextReference(tx: Prisma.TransactionClient, date: Date) {
  const prefix = `FB/${financialYearOf(date)}/`;
  const last = await tx.feedbackRequest.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: "desc" },
    select: { reference: true },
  });
  const serial = last ? Number(last.reference.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(serial).padStart(4, "0")}`;
}

export async function createFeedbackRequest(input: {
  companyId: string;
  contactId?: string;
  aboutUserId?: string;
  ticketId?: string;
  visitId?: string;
  companyProductId?: string;
  serviceLabel?: string;
  message?: string;
  /** Overrides the organisation default, for a link that should close sooner. */
  expiresInDays?: number;
}): Promise<ActionResult<{ id: string; token: string; reference: string; expiresAt: Date }>> {
  const { user, canRequest } = await access();
  if (!canRequest) return { ok: false, error: "You can't ask customers for feedback." };

  const company = await db.company.findUnique({
    where: { id: input.companyId },
    select: { id: true, name: true, managedByResellerId: true, ownerUserId: true },
  });
  if (!company) return { ok: false, error: "That company no longer exists." };
  // `feedback.request` says somebody may ask customers for feedback. It does not say which
  // customers — the account scope answers that, and it is settled before the reseller rule below so
  // that "managed by a reseller" is not something you can learn about an account you cannot see.
  if (!(await canSeeCompany(user.id, company.ownerUserId))) {
    return { ok: false, error: "That isn't your account to ask." };
  }
  // A reseller's end customer is the reseller's relationship, not ours — the same do-not-contact
  // rule the rest of the app follows. Asking them directly would go round the partner.
  if (company.managedByResellerId) {
    return {
      ok: false,
      error: "This company is managed by a reseller, so we don't contact them directly. Ask the reseller instead.",
    };
  }

  const contact = input.contactId
    ? await db.contact.findFirst({
        where: { id: input.contactId, companyId: company.id },
        select: { id: true, name: true, email: true, phone: true },
      })
    : null;
  if (input.contactId && !contact) return { ok: false, error: "That contact isn't at this company." };

  const org = await getOrganisation();
  const days = Math.min(365, Math.max(1, input.expiresInDays ?? org.feedbackLinkDays));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days * 86400000);
  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  const created = await db.$transaction(async (tx) => {
    return tx.feedbackRequest.create({
      data: {
        token,
        reference: await nextReference(tx, now),
        companyId: company.id,
        contactId: contact?.id ?? null,
        // Snapshotted, so editing or deleting the contact later doesn't rewrite where this went.
        sentToName: contact?.name ?? null,
        sentToEmail: contact?.email ?? null,
        sentToPhone: contact?.phone ?? null,
        aboutUserId: input.aboutUserId || null,
        ticketId: input.ticketId || null,
        visitId: input.visitId || null,
        companyProductId: input.companyProductId || null,
        serviceLabel: input.serviceLabel?.trim() || null,
        message: input.message?.trim() || null,
        // Created and sent are the same act: the only reason to make one of these is to send it,
        // and a draft feedback request is a thing nobody ever wanted.
        status: "SENT",
        sentAt: now,
        expiresAt,
        requestedById: user.id,
      },
      select: { id: true, token: true, reference: true, expiresAt: true },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "FeedbackRequest",
    entityId: created.id,
    entityLabel: `${created.reference} — asked ${contact?.name ?? company.name} for feedback`,
  });
  revalidatePath("/feedback");
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: { ...created, expiresAt: created.expiresAt! } };
}

/** Withdraws the link. The record stays — that we asked and then thought better of it is history. */
export async function cancelFeedbackRequest(id: string, reason?: string): Promise<ActionResult<null>> {
  const { user, canRequest } = await access();
  const request = await db.feedbackRequest.findUnique({
    where: { id },
    select: { id: true, reference: true, status: true, requestedById: true, companyId: true },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (!canRequest && request.requestedById !== user.id) {
    return { ok: false, error: "You can't withdraw somebody else's request." };
  }
  if (request.status === "ANSWERED") {
    return { ok: false, error: "They have already answered it. Withdrawing it now would delete what they said." };
  }
  if (request.status === "CANCELLED") return { ok: false, error: "Already withdrawn." };

  await db.feedbackRequest.update({
    where: { id },
    data: { status: "CANCELLED", cancelledAt: new Date(), message: reason?.trim() || undefined },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "FeedbackRequest",
    entityId: id,
    entityLabel: `${request.reference} withdrawn`,
  });
  revalidatePath("/feedback");
  revalidatePath(`/companies/${request.companyId}`);
  return { ok: true, data: null };
}

/**
 * The link for one request, fetched on demand.
 *
 * Deliberately not part of the list payload. A token is a live credential — whoever holds it can
 * answer on the customer's behalf — so shipping three hundred of them into a browser to render a
 * page that shows one at a time would be handing out capability nobody asked for. This returns
 * exactly the one somebody clicked, and only while it still works.
 */
export async function feedbackLink(id: string): Promise<ActionResult<{ url: string }>> {
  const { user, viewAll } = await access();
  const request = await db.feedbackRequest.findFirst({
    where: { id, ...(viewAll ? {} : visibleTo(user.id)) },
    select: { token: true, status: true, expiresAt: true, response: { select: { id: true } } },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };
  const state = linkState({ status: request.status, expiresAt: request.expiresAt, answered: !!request.response });
  if (!state.usable) return { ok: false, error: `That link is no longer open — ${state.label.toLowerCase()}.` };
  return { ok: true, data: { url: `/review/${request.token}` } };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export type FeedbackFilters = {
  companyId?: string;
  aboutUserId?: string;
  /** "answered" | "waiting" | "unhappy" | "unanswered" */
  view?: string;
  search?: string;
};

export async function listFeedback(filters?: FeedbackFilters) {
  const { user, viewAll } = await access();

  const view = filters?.view;
  const where: Prisma.FeedbackRequestWhereInput = {
    ...(viewAll ? {} : visibleTo(user.id)),
    ...(filters?.companyId ? { companyId: filters.companyId } : {}),
    ...(filters?.aboutUserId ? { aboutUserId: filters.aboutUserId } : {}),
    ...(view === "answered" ? { status: "ANSWERED" as const } : {}),
    ...(view === "waiting" ? { status: "SENT" as const } : {}),
    // A 3 counts as unhappy. Somebody who bothered to reply "okay" is telling you something, and
    // filing that under satisfied is how a business stops hearing anything at all.
    ...(view === "unhappy" ? { response: { rating: { lte: 3 } } } : {}),
    ...(view === "unanswered" ? { response: { rating: { lte: 3 }, acknowledgedAt: null } } : {}),
    ...(filters?.search
      ? {
          OR: [
            { reference: { contains: filters.search, mode: "insensitive" as const } },
            { company: { name: { contains: filters.search, mode: "insensitive" as const } } },
            { response: { comment: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const rows = await db.feedbackRequest.findMany({
    where,
    // Answered first — the whole point of the page is what people said, not what we sent.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 300,
    select: requestSelect,
  });
  return toPlain({ rows, summary: summarise(rows), viewAll });
}

export async function getFeedbackRequest(id: string) {
  const { user, viewAll } = await access();
  const row = await db.feedbackRequest.findFirst({
    where: { id, ...(viewAll ? {} : visibleTo(user.id)) },
    select: requestSelect,
  });
  return row ? toPlain(row) : null;
}

/** One company's feedback, for the tab on their page. */
export async function companyFeedback(companyId: string) {
  const { user, viewAll, canRequest } = await access();
  const rows = await db.feedbackRequest.findMany({
    where: { companyId, ...(viewAll ? {} : visibleTo(user.id)) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: requestSelect,
  });
  return toPlain({ rows, summary: summarise(rows), canRequest });
}

/** What customers have said about one person — their own page, and their manager's view of it. */
export async function feedbackAbout(userId: string) {
  const { user, viewAll } = await access();
  if (!viewAll && userId !== user.id) return null;
  const rows = await db.feedbackRequest.findMany({
    where: { aboutUserId: userId, status: "ANSWERED" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: requestSelect,
  });
  return toPlain({ rows, summary: summarise(rows) });
}

// ─── Answering it ─────────────────────────────────────────────────────────────

/**
 * Somebody has picked up a low score and done something about it.
 *
 * Recorded rather than assumed, because "we always follow up" is what every business believes about
 * itself. A date and a name make it checkable.
 */
export async function acknowledgeFeedback(input: {
  responseId: string;
  note: string;
}): Promise<ActionResult<null>> {
  const { user, viewAll } = await access();
  const response = await db.feedbackResponse.findUnique({
    where: { id: input.responseId },
    select: {
      id: true,
      rating: true,
      acknowledgedAt: true,
      request: {
        select: {
          id: true,
          reference: true,
          companyId: true,
          aboutUserId: true,
          requestedById: true,
          company: { select: { name: true, ownerUserId: true, assignedToUserId: true } },
        },
      },
    },
  });
  if (!response) return { ok: false, error: "That feedback no longer exists." };

  const req = response.request;
  const mine =
    req.aboutUserId === user.id ||
    req.requestedById === user.id ||
    req.company.ownerUserId === user.id ||
    req.company.assignedToUserId === user.id;
  if (!viewAll && !mine) return { ok: false, error: "That isn't your account's feedback." };
  if (!input.note.trim()) return { ok: false, error: "Say what was done about it — that is the whole record." };
  if (response.acknowledgedAt) return { ok: false, error: "Somebody has already answered this one." };

  await db.feedbackResponse.update({
    where: { id: response.id },
    data: { acknowledgedAt: new Date(), acknowledgedById: user.id, actionNote: input.note.trim() },
  });

  // The person it was about hears that it was picked up. Being rated 2 and then hearing nothing is
  // its own small injury.
  if (req.aboutUserId && req.aboutUserId !== user.id) {
    await notifyUser({
      userId: req.aboutUserId,
      type: "FEEDBACK_RECEIVED",
      title: `${req.company.name}'s feedback has been answered`,
      message: input.note.trim().slice(0, 140),
      link: `/feedback?requestId=${req.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "FeedbackResponse",
    entityId: response.id,
    entityLabel: `${req.reference} — ${response.rating}/5 answered`,
  });
  revalidatePath("/feedback");
  revalidatePath(`/companies/${req.companyId}`);
  return { ok: true, data: null };
}

// ─── Options for the ask-for-feedback form ────────────────────────────────────

/**
 * What one company can be asked about.
 *
 * Only finished work: asking somebody to rate a ticket that is still open, or a visit that hasn't
 * happened, invites a score for something nobody has done yet.
 */
export async function feedbackTargets(companyId: string) {
  const { user, canRequest } = await access();
  if (!canRequest) return { contacts: [], people: [], tickets: [], visits: [], orders: [] };

  /**
   * And only a company whose account you hold.
   *
   * Scoped on the account rather than through `visibleTo` above, because none of this is feedback —
   * it is the company's contacts with their email addresses and phone numbers, its tickets, its
   * completed visits and its fulfilled orders, reached by an id the caller supplies. `canRequest`
   * is held by every sales executive, so without this one line it was the whole address book to
   * anybody who could type a company id. Refused as a whole rather than filtered query by query:
   * five wheres are five chances to miss one, and the same empty shape already means "not for you".
   */
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) {
    return { contacts: [], people: [], tickets: [], visits: [], orders: [] };
  }

  const [contacts, people, tickets, visits, orders] = await Promise.all([
    db.contact.findMany({
      where: { companyId },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, phone: true, designation: true, isPrimary: true },
    }),
    // Who the feedback would be about: our own staff, so not an account's anything and not scoped.
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.ticket.findMany({
      where: { companyId, status: { in: ["RESOLVED", "CLOSED"] } },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: { id: true, ticketSeq: true, title: true, assignedTo: { select: { id: true, name: true } } },
    }),
    db.visit.findMany({
      where: { companyId, status: "COMPLETED" },
      orderBy: { scheduledFor: "desc" },
      take: 25,
      select: { id: true, purpose: true, scheduledFor: true, user: { select: { id: true, name: true } } },
    }),
    db.companyProduct.findMany({
      where: { companyId, orderStatus: "FULFILLED" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        quantity: true,
        item: { select: { name: true } },
        addedBy: { select: { id: true, name: true } },
      },
    }),
  ]);

  return toPlain({ contacts, people, tickets, visits, orders });
}
