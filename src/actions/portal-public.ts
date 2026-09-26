"use server";

import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { notifyUser } from "@/lib/notify";
import {
  REFUSAL_MESSAGE,
  allowedActions,
  companyMayUsePortal,
  linkState,
  visibleSections,
  type Action,
  type Section,
} from "@/lib/portal/access";
import type { ActionResult } from "@/actions/company";

/**
 * The customer's own view of their account, served to somebody with no login here.
 *
 * The third module in the app that answers to a stranger holding a token — after the new-joiner
 * intake and the feedback form — and by far the one that returns the most, so the rules those two
 * established are worth restating in the place they matter most:
 *
 *   · **The token is the authentication.** 192 bits of randomness, revocable, and expiring if the
 *     settings say so. There is no password, because there is no account.
 *   · **Every query is scoped by the company the token resolves to**, and that company id comes
 *     from the token alone. Nothing the browser sends is ever allowed to name a company, an order
 *     or an invoice — see `subscriptionOf` below, which is the one place a client-supplied id is
 *     accepted and therefore the one place it is re-checked against the token's company.
 *   · **A bad token is indistinguishable from a revoked, expired, or switched-off one.** Four
 *     different refusals, one sentence, because the customer's next step is the same for all four
 *     and the differences would tell somebody which tokens are real.
 *   · **Nothing here writes to anything the customer does not own.** The only writes are their own
 *     visit counter and a request addressed to us.
 *
 * What it deliberately does *not* return: cost prices, margins, internal notes, who owns the
 * account, or anything about any other company. The selects below are explicit for that reason —
 * a `select` that grows by accident is the way this module would leak.
 */

export type PortalView = {
  companyName: string;
  personName: string;
  /** Null when the organisation has no name recorded — the page then omits the line entirely. */
  ourName: string | null;
  welcome: string | null;
  sections: Section[];
  actions: Action[];
};

type Resolved = {
  loginId: string;
  companyId: string;
  companyName: string;
  personName: string;
  personEmail: string | null;
  sections: Set<Section>;
  actions: Set<Action>;
  settings: { welcomeMessage: string | null };
};

/**
 * Turns a token into a company, or into nothing.
 *
 * Every exported function starts here and none of them take a company id, which is the property
 * that makes the rest of the file safe to read: there is no path to another customer's data
 * because there is no argument that could describe one.
 */
/** The module each section shows — a section whose module is gone is not shown, whatever the settings say. */
const SECTION_MODULES: Record<Section, string | null> = {
  subscriptions: "orders",
  invoices: "sales_documents",
  payments: "payments",
  tickets: "helpdesk",
  assets: "it_assets",
  contacts: null,
};

async function withinPlan(sections: Set<Section>): Promise<Set<Section>> {
  const kept = new Set<Section>();
  for (const section of sections) {
    const key = SECTION_MODULES[section];
    if (!key || (await moduleAvailableForTenant(key))) kept.add(section);
  }
  return kept;
}

async function resolve(token: string): Promise<Resolved | null> {
  if (!token || token.length < 20) return null;
  if (!(await moduleAvailableForTenant("customer_portal"))) return null;

  const login = await db.portalLogin.findUnique({
    where: { token },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      personName: true,
      personEmail: true,
      company: {
        select: {
          id: true,
          name: true,
          portalEnabled: true,
          relationshipType: true,
          managedByResellerId: true,
        },
      },
    },
  });

  const state = linkState(login, new Date());
  if (!state.ok || !login) return null;

  const settings = await db.portalSettings.findUnique({ where: { id: "global" } });
  if (!settings) return null;

  const allowed = companyMayUsePortal(settings, login.company);
  if (!allowed.ok) return null;

  const sections = await withinPlan(visibleSections(settings));
  const actions = allowedActions(settings);
  // Renewals and seats are asked for against a subscription; no subscriptions shown, nothing to ask.
  if (!sections.has("subscriptions")) {
    actions.delete("renewal");
    actions.delete("seats");
  }

  return {
    loginId: login.id,
    companyId: login.company.id,
    companyName: login.company.name,
    personName: login.personName,
    personEmail: login.personEmail,
    sections,
    actions,
    settings: { welcomeMessage: settings.welcomeMessage },
  };
}

/** What the page needs to draw its frame. Null means the one refusal sentence. */
export async function openPortal(token: string): Promise<PortalView | null> {
  const resolved = await resolve(token);
  if (!resolved) return null;

  const org = await getOrganisation();

  // Recorded here rather than on every fetch, so the count is visits rather than page components.
  // Failure is swallowed: a customer should never be shown an error because our counter broke.
  await db.portalLogin
    .update({ where: { id: resolved.loginId }, data: { lastSeenAt: new Date(), visits: { increment: 1 } } })
    .catch(() => {});

  return {
    companyName: resolved.companyName,
    // The first name only, as the feedback form does. The rest of what we hold about them is not
    // this page's business.
    personName: resolved.personName.trim().split(/\s+/)[0] ?? resolved.personName,
    ourName: org.tradeName || org.legalName || null,
    welcome: resolved.settings.welcomeMessage,
    sections: [...resolved.sections],
    actions: [...resolved.actions],
  };
}

export type PortalSubscription = {
  id: string;
  name: string;
  quantity: number;
  startDate: Date | null;
  endDate: Date | null;
  /** Null when the term has no end, negative once it has passed. */
  daysLeft: number | null;
  status: string;
};

export async function portalSubscriptions(token: string): Promise<PortalSubscription[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("subscriptions")) return [];

  const orders = await db.companyProduct.findMany({
    where: {
      companyId: resolved.companyId,
      // What they bought, not what somebody is still thinking about. An order sitting in approval
      // is an internal state, and showing it invites "why does my portal say pending".
      orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] },
    },
    select: {
      id: true,
      quantity: true,
      startDate: true,
      endDate: true,
      orderStatus: true,
      item: { select: { name: true } },
    },
    orderBy: [{ endDate: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const today = new Date();
  return orders.map((o) => ({
    id: o.id,
    name: o.item.name,
    quantity: o.quantity,
    startDate: o.startDate,
    endDate: o.endDate,
    daysLeft: o.endDate ? Math.ceil((o.endDate.getTime() - today.getTime()) / 86400000) : null,
    status: o.orderStatus,
  }));
}

export type PortalInvoice = {
  id: string;
  number: string;
  date: Date;
  dueDate: Date | null;
  total: number;
  status: string;
};

export async function portalInvoices(token: string): Promise<PortalInvoice[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("invoices")) return [];

  const documents = await db.tradeDocument.findMany({
    where: {
      companyId: resolved.companyId,
      direction: "SALES",
      docType: { in: ["INVOICE", "PROFORMA", "CREDIT_NOTE"] },
      // A draft is our workings. Issuing one is the act that makes it theirs to see.
      status: { not: "DRAFT" },
    },
    select: { id: true, docNumber: true, docType: true, issueDate: true, dueDate: true, total: true, status: true },
    orderBy: { issueDate: "desc" },
    take: 100,
  });

  return documents.map((d) => ({
    id: d.id,
    number: d.docNumber,
    date: d.issueDate,
    dueDate: d.dueDate,
    total: Number(d.total),
    status: d.docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : d.status,
  }));
}

export type PortalTicket = {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
};

export async function portalTickets(token: string): Promise<PortalTicket[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("tickets")) return [];

  const tickets = await db.ticket.findMany({
    where: { companyId: resolved.companyId },
    // Deliberately no internal notes, no assignee and no SLA state: a customer reading "breached"
    // about their own ticket is a conversation nobody planned to have.
    select: { id: true, ticketSeq: true, title: true, status: true, priority: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return tickets.map((t) => ({
    id: t.id,
    reference: `#${t.ticketSeq}`,
    title: t.title,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
  }));
}

/**
 * Raises a request.
 *
 * `companyProductId` is the only client-supplied id this file accepts, so it is re-read scoped to
 * the token's own company before anything is written. Taking it on trust would let somebody paste
 * another customer's order id into a form and have us record — and then act on — a request against
 * a subscription that is not theirs.
 */
export async function raisePortalRequest(
  token: string,
  input: { kind: Action; companyProductId?: string | null; quantity?: number | null; message?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const resolved = await resolve(token);
  if (!resolved) return { ok: false, error: REFUSAL_MESSAGE };
  if (!resolved.actions.has(input.kind)) return { ok: false, error: "That isn't something you can ask for here." };

  let companyProductId: string | null = null;
  if (input.kind === "renewal" || input.kind === "seats") {
    if (!input.companyProductId) return { ok: false, error: "Choose which subscription this is about." };
    const owned = await db.companyProduct.findFirst({
      where: { id: input.companyProductId, companyId: resolved.companyId },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: REFUSAL_MESSAGE };
    companyProductId = owned.id;
  }

  if (input.kind === "seats") {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 10000) {
      return { ok: false, error: "How many seats? Give a whole number." };
    }
  }

  const message = (input.message ?? "").trim().slice(0, 2000);
  if (input.kind === "question" && !message) return { ok: false, error: "What would you like to ask?" };

  const created = await db.portalRequest.create({
    data: {
      companyId: resolved.companyId,
      loginId: resolved.loginId,
      personName: resolved.personName,
      personEmail: resolved.personEmail,
      kind: input.kind === "renewal" ? "RENEWAL" : input.kind === "seats" ? "ADD_SEATS" : "QUESTION",
      companyProductId,
      quantity: input.kind === "seats" ? Number(input.quantity) : null,
      message: message || null,
    },
    select: { id: true },
  });

  /**
   * Told to whoever owns the account, falling back to nobody rather than to everybody.
   *
   * A request nobody is told about is the failure mode that makes a portal worse than a phone call
   * — but notifying the whole company because an account has no owner would train people to ignore
   * the notification, which comes to the same thing by a longer road.
   */
  const owner = await db.company.findUnique({
    where: { id: resolved.companyId },
    select: { assignedToUserId: true, name: true },
  });
  if (owner?.assignedToUserId) {
    const what =
      input.kind === "renewal"
        ? "wants to renew a subscription"
        : input.kind === "seats"
          ? `wants ${input.quantity} more seat(s)`
          : "asked a question";
    await notifyUser({
      userId: owner.assignedToUserId,
      type: "PORTAL_REQUEST",
      title: `${owner.name} ${what}`,
      message: message || undefined,
      link: "/customer-requests",
    });
  }

  return { ok: true, data: { id: created.id } };
}
