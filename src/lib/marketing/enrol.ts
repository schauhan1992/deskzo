import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { coverExpiringWithin } from "@/lib/assets/lifecycle";
import { audienceCompanyWhere } from "@/lib/marketing/audience";
import { parseCompanyFilters } from "@/lib/marketing/audience";
import { daysToFinancialYearEnd, triggerByKey } from "@/lib/marketing/triggers";
import { advance, enrolmentKey, firstStep, mayReEnrol, parseExitConditions, shouldExit, stepDueAt, type ExitSignals } from "@/lib/marketing/journey";
import { canSend } from "@/lib/marketing/suppression";
import { nextSendTime } from "@/lib/marketing/schedule";
import { render } from "@/lib/marketing/merge";
import {
  buildMarketingEmail,
  marketingSettings,
  mergeValuesFor,
  newToken,
  resolveRecipients,
  subscriptionMergeValues,
  type MarketingSettings,
} from "@/lib/marketing/pipeline";
import { formatDate } from "@/lib/utils";
import { currentKeys } from "@/lib/tenancy/keys";
import { byStageDate } from "@/lib/pipeline/server";

/**
 * Finding who should be in a journey, and moving them along it.
 *
 * Server-only for the same reason as the pipeline: these functions enrol customers and queue mail.
 *
 * The whole design rests on `triggerKey`. A tick runs every five minutes and keeps finding the same
 * subscription expiring in sixty days, so enrolment has to be idempotent — the key names the thing
 * the sequence is *about*, a unique index rejects the second attempt, and the customer hears from
 * us once rather than every five minutes for two months.
 */

const DAY = 86400000;

export type Candidate = {
  companyId: string;
  /** What the sequence is about — the subscription, the asset, the lead. */
  subjectId: string;
  contactId?: string | null;
  merge?: Record<string, string | number | null>;
};

function daysAhead(days: number) {
  return new Date(Date.now() + days * DAY);
}
function daysAgo(days: number) {
  return new Date(Date.now() - days * DAY);
}

/**
 * Everybody a trigger would enrol right now.
 *
 * Each one narrows to the companies the journey's audience allows — and therefore, through
 * `buildWhere`, never returns a reseller's end customer. The suppression check later is a second
 * line, not the first.
 */
export async function candidatesFor(
  trigger: string,
  config: Record<string, unknown>,
  companyWhere: Prisma.CompanyWhereInput,
): Promise<Candidate[]> {
  const days = Number(config.days ?? triggerByKey[trigger]?.defaultDays ?? 30);
  const company = companyWhere;

  switch (trigger) {
    case "SUBSCRIPTION_RENEWAL": {
      const rows = await db.companyProduct.findMany({
        where: {
          company,
          // Addons co-terminate with their parent, so the parent already stands for the whole
          // renewal. Enrolling them too would start four conversations about one date.
          parentId: null,
          item: { type: "SUBSCRIPTION" },
          orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
          endDate: { gte: new Date(), lte: daysAhead(days) },
        },
        select: {
          id: true, companyId: true, quantity: true, endDate: true, fullTermUnitPrice: true,
          item: { select: { name: true } },
        },
        take: 2000,
      });
      return rows.map((r) => ({
        companyId: r.companyId,
        subjectId: r.id,
        merge: subscriptionMergeValues(r) as Record<string, string | number | null>,
      }));
    }

    case "RENEWAL_LAPSED": {
      const rows = await db.companyProduct.findMany({
        where: {
          company,
          parentId: null,
          item: { type: "SUBSCRIPTION" },
          orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
          endDate: { gte: daysAgo(days), lt: new Date() },
        },
        select: {
          id: true, companyId: true, quantity: true, endDate: true, fullTermUnitPrice: true,
          item: { select: { id: true, name: true } },
        },
        take: 2000,
      });
      // A renewal raised since is the answer, so drop anything already followed up.
      const renewed = await db.companyProduct.findMany({
        where: {
          companyId: { in: [...new Set(rows.map((r) => r.companyId))] },
          businessType: { in: ["RENEWAL", "NEW_TO_US_RENEWAL"] },
          createdAt: { gte: daysAgo(days + 30) },
        },
        select: { companyId: true, itemId: true },
      });
      const done = new Set(renewed.map((r) => `${r.companyId}:${r.itemId}`));
      return rows
        .filter((r) => !done.has(`${r.companyId}:${r.item.id}`))
        .map((r) => ({
          companyId: r.companyId,
          subjectId: r.id,
          merge: subscriptionMergeValues(r) as Record<string, string | number | null>,
        }));
    }

    case "WARRANTY_EXPIRING": {
      const rows = await db.asset.findMany({
        where: {
          ownerCompany: company,
          status: { notIn: ["RETIRED", "LOST"] },
          warrantyEndsOn: { gte: new Date(), lte: daysAhead(days) },
          // Already covered by an AMC, so there is nothing to offer.
          OR: [{ amcEndsOn: null }, { amcEndsOn: { lt: new Date() } }],
        },
        select: { id: true, name: true, ownerCompanyId: true, warrantyEndsOn: true, amcEndsOn: true },
        take: 2000,
      });
      return rows
        .filter((r) => r.ownerCompanyId)
        .map((r) => ({
          companyId: r.ownerCompanyId!,
          subjectId: r.id,
          merge: { productName: r.name, expiryDate: r.warrantyEndsOn ? formatDate(r.warrantyEndsOn) : null },
        }));
    }

    case "AMC_EXPIRING": {
      const rows = await db.asset.findMany({
        where: { ownerCompany: company, status: { notIn: ["RETIRED", "LOST"] }, amcEndsOn: { not: null } },
        select: { id: true, name: true, ownerCompanyId: true, warrantyEndsOn: true, amcEndsOn: true },
        take: 2000,
      });
      // Lapsed cover counts, and is more urgent than cover about to lapse — see `coverExpiringWithin`.
      return coverExpiringWithin(rows, days)
        .filter((r) => r.ownerCompanyId)
        .map((r) => ({
          companyId: r.ownerCompanyId!,
          subjectId: r.id,
          merge: { productName: r.name, expiryDate: r.amcEndsOn ? formatDate(r.amcEndsOn) : null },
        }));
    }

    case "NO_COVER_RECORDED": {
      const rows = await db.company.findMany({
        where: {
          ...company,
          assetsOwned: { some: { status: { notIn: ["RETIRED", "LOST"] }, warrantyEndsOn: null, amcEndsOn: null } },
        },
        select: { id: true, _count: { select: { assetsOwned: true } } },
        take: 1000,
      });
      return rows.map((r) => ({ companyId: r.id, subjectId: r.id, merge: { assetCount: r._count.assetsOwned } }));
    }

    case "ASSET_AGEING": {
      const rows = await db.asset.findMany({
        where: {
          ownerCompany: company,
          status: { notIn: ["RETIRED", "LOST"] },
          kind: { in: ["LAPTOP", "DESKTOP", "SERVER"] },
          purchasedOn: { lt: daysAgo(days) },
        },
        select: { id: true, name: true, ownerCompanyId: true, purchasedOn: true },
        take: 2000,
      });
      return rows
        .filter((r) => r.ownerCompanyId)
        .map((r) => ({
          companyId: r.ownerCompanyId!,
          subjectId: r.id,
          merge: { productName: r.name, expiryDate: r.purchasedOn ? formatDate(r.purchasedOn) : null },
        }));
    }

    case "SEAT_GAP": {
      const gap = Number(config.days ?? 10);
      const rows = await db.company.findMany({
        where: { ...company, employeeCount: { not: null } },
        select: {
          id: true,
          employeeCount: true,
          products: {
            where: { item: { type: "SUBSCRIPTION" }, endDate: { gte: new Date() }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
            select: { quantity: true },
          },
        },
        take: 1000,
      });
      return rows
        .map((r) => ({ r, seats: r.products.reduce((t, p) => t + p.quantity, 0) }))
        .filter(({ r, seats }) => (r.employeeCount ?? 0) - seats >= gap)
        .map(({ r, seats }) => ({
          companyId: r.id,
          subjectId: r.id,
          merge: { quantity: seats, assetCount: (r.employeeCount ?? 0) - seats },
        }));
    }

    case "CROSS_SELL": {
      const brandId = typeof config.brandId === "string" ? config.brandId : null;
      if (!brandId) return [];
      const rows = await db.company.findMany({
        where: { ...company, products: { some: {} }, NOT: { products: { some: { item: { brandId } } } } },
        select: { id: true },
        take: 1000,
      });
      return rows.map((r) => ({ companyId: r.id, subjectId: r.id }));
    }

    case "NEW_CUSTOMER": {
      const rows = await db.company.findMany({
        where: { ...company, products: { some: { orderStatus: "FULFILLED", fulfilledAt: { gte: daysAgo(days) } } } },
        select: { id: true, products: { where: { orderStatus: "FULFILLED" }, select: { fulfilledAt: true }, orderBy: { fulfilledAt: "asc" }, take: 1 } },
        take: 1000,
      });
      // Only if the *first* fulfilled order is the recent one. A repeat order is growth, not a new
      // customer — the same distinction the NEW_CUSTOMERS target metric draws.
      return rows
        .filter((r) => r.products[0]?.fulfilledAt && r.products[0].fulfilledAt >= daysAgo(days))
        .map((r) => ({ companyId: r.id, subjectId: r.id }));
    }

    case "LEAD_STALLED": {
      // No movement: not moved stage in that long (src/lib/pipeline `byStageDate`). `updatedAt` moves on
      // every view and every tick, so a lead never went quiet by it.
      const rows = await byStageDate((moved) =>
        db.lead.findMany({
          where: { company, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] }, ...moved({ lt: daysAgo(days) }) },
          select: { id: true, companyId: true, title: true, contactId: true },
          take: 1000,
        }),
      );
      return rows.map((r) => ({ companyId: r.companyId, subjectId: r.id, contactId: r.contactId, merge: { productName: r.title } }));
    }

    case "PROPOSAL_NO_RESPONSE": {
      const rows = await byStageDate((moved) =>
        db.lead.findMany({
          where: { company, status: "PROPOSAL_SENT", ...moved({ lt: daysAgo(days) }) },
          select: { id: true, companyId: true, title: true, contactId: true },
          take: 1000,
        }),
      );
      return rows.map((r) => ({ companyId: r.companyId, subjectId: r.id, contactId: r.contactId, merge: { productName: r.title } }));
    }

    case "LEAD_LOST_REVISIT": {
      const rows = await byStageDate((moved) =>
        db.lead.findMany({
          // Lost, not disqualified: lost means somebody else won it and their contract will end.
          where: { company, status: "LOST", ...moved({ lt: daysAgo(days) }) },
          select: { id: true, companyId: true, title: true, contactId: true },
          take: 1000,
        }),
      );
      return rows.map((r) => ({ companyId: r.companyId, subjectId: r.id, contactId: r.contactId, merge: { productName: r.title } }));
    }

    case "TICKET_RESOLVED": {
      const rows = await db.ticket.findMany({
        where: { company, status: { in: ["RESOLVED", "CLOSED"] }, resolvedAt: { gte: daysAgo(days) } },
        select: { id: true, companyId: true, title: true, contactId: true },
        take: 1000,
      });
      return rows.map((r) => ({ companyId: r.companyId, subjectId: r.id, contactId: r.contactId, merge: { productName: r.title } }));
    }

    case "FEEDBACK_PROMOTER": {
      const rows = await db.feedbackRequest.findMany({
        where: { company, response: { isNot: null } },
        orderBy: { createdAt: "desc" },
        select: { companyId: true, response: { select: { rating: true, submittedAt: true } } },
        take: 2000,
      });
      // The latest word is the one that counts, so keep only each company's most recent answer.
      const latest = new Map<string, number>();
      for (const row of rows) {
        if (!row.response) continue;
        if (!latest.has(row.companyId)) latest.set(row.companyId, row.response.rating);
      }
      return [...latest.entries()]
        .filter(([, rating]) => rating >= 4)
        .map(([companyId]) => ({ companyId, subjectId: companyId }));
    }

    case "CUSTOMER_ANNIVERSARY": {
      const rows = await db.company.findMany({
        where: { ...company, products: { some: { orderStatus: "FULFILLED" } } },
        select: { id: true, products: { where: { orderStatus: "FULFILLED" }, select: { fulfilledAt: true }, orderBy: { fulfilledAt: "asc" }, take: 1 } },
        take: 2000,
      });
      const today = new Date();
      return rows
        .map((r) => ({ id: r.id, first: r.products[0]?.fulfilledAt ?? null }))
        .filter(({ first }) => {
          if (!first) return false;
          const years = today.getUTCFullYear() - first.getUTCFullYear();
          return (
            years >= 1 &&
            first.getUTCMonth() === today.getUTCMonth() &&
            first.getUTCDate() === today.getUTCDate()
          );
        })
        .map(({ id, first }) => ({
          companyId: id,
          // Keyed by year, so it fires once a year rather than once ever.
          subjectId: `${id}:${today.getUTCFullYear()}`,
          merge: { quantity: today.getUTCFullYear() - first!.getUTCFullYear() },
        }));
    }

    case "BUDGET_FLUSH": {
      const left = daysToFinancialYearEnd(new Date());
      if (left > days || left < 0) return [];
      const rows = await db.company.findMany({
        where: { ...company, stage: "CUSTOMER" },
        select: { id: true },
        take: 2000,
      });
      // The financial year is in the key, so it fires once per year per customer.
      const fy = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() + 1 : new Date().getUTCFullYear();
      return rows.map((r) => ({ companyId: r.id, subjectId: `${r.id}:${fy}`, merge: { daysLeft: left } }));
    }

    case "DORMANT_CUSTOMER": {
      const rows = await db.company.findMany({
        where: {
          ...company,
          products: { some: {} },
          NOT: { products: { some: { createdAt: { gte: daysAgo(days) } } } },
        },
        select: { id: true },
        take: 1000,
      });
      return rows.map((r) => ({ companyId: r.id, subjectId: r.id }));
    }

    case "PRICE_CHANGE":
    case "PRODUCT_END_OF_LIFE": {
      const itemId = typeof config.itemId === "string" ? config.itemId : null;
      if (!itemId) return [];
      const rows = await db.company.findMany({
        where: { ...company, products: { some: { itemId } } },
        select: { id: true, products: { where: { itemId }, select: { item: { select: { name: true } } }, take: 1 } },
        take: 2000,
      });
      return rows.map((r) => ({
        companyId: r.id,
        subjectId: `${r.id}:${itemId}`,
        merge: { productName: r.products[0]?.item.name ?? null },
      }));
    }

    default:
      return [];
  }
}

// ─── Enrolling ────────────────────────────────────────────────────────────────

export async function runEnrolments(): Promise<{ enrolled: number }> {
  const journeys = await db.journey.findMany({
    where: { status: "ACTIVE" },
    include: { audience: true, steps: { orderBy: { order: "asc" } } },
  });

  let enrolled = 0;
  for (const journey of journeys) {
    const start = firstStep(journey.steps);
    if (!start) continue;

    const companyWhere = audienceCompanyWhere(parseCompanyFilters(journey.audience?.companyFilters ?? {}));
    const candidates = await candidatesFor(
      journey.trigger,
      (journey.triggerConfig as Record<string, unknown>) ?? {},
      companyWhere,
    );
    if (candidates.length === 0) continue;

    const keys = candidates.map((c) => enrolmentKey(journey.trigger, c.subjectId));
    const existing = await db.journeyEnrolment.findMany({
      where: { journeyId: journey.id, triggerKey: { in: keys } },
      select: { triggerKey: true, enrolledAt: true },
    });
    const seen = new Map(existing.map((e) => [e.triggerKey, e.enrolledAt]));

    for (const candidate of candidates) {
      const key = enrolmentKey(journey.trigger, candidate.subjectId);
      const last = seen.get(key) ?? null;
      if (last !== null) {
        const again = mayReEnrol({ reEnrolAfterDays: journey.reEnrolAfterDays, lastEnrolledAt: last });
        if (!again.ok) continue;
        // Re-enrolling replaces the previous run rather than sitting beside it, so the unique key
        // stays meaningful and the history is the message rows.
        await db.journeyEnrolment.update({
          where: { journeyId_triggerKey: { journeyId: journey.id, triggerKey: key } },
          data: {
            status: "ACTIVE",
            currentStep: 0,
            nextRunAt: stepDueAt(new Date(), start.delayDays),
            enrolledAt: new Date(),
            exitedAt: null,
            exitReason: null,
          },
        });
        enrolled += 1;
        continue;
      }

      await db.journeyEnrolment
        .create({
          data: {
            journeyId: journey.id,
            companyId: candidate.companyId,
            contactId: candidate.contactId ?? null,
            triggerKey: key,
            nextRunAt: stepDueAt(new Date(), start.delayDays),
          },
        })
        .then(() => {
          enrolled += 1;
        })
        // A concurrent tick got there first. The unique index is the point.
        .catch(() => undefined);
    }
  }

  return { enrolled };
}

// ─── Moving people along ──────────────────────────────────────────────────────

async function exitSignalsFor(enrolment: { companyId: string; enrolledAt: Date }): Promise<ExitSignals> {
  const [orders, tickets, leads] = await Promise.all([
    db.companyProduct.count({ where: { companyId: enrolment.companyId, createdAt: { gte: enrolment.enrolledAt } } }),
    db.ticket.count({ where: { companyId: enrolment.companyId, createdAt: { gte: enrolment.enrolledAt } } }),
    // Won or lost since they were enrolled — moved there since (src/lib/pipeline `byStageDate`).
    byStageDate((moved) =>
      db.lead.findMany({
        where: { companyId: enrolment.companyId, ...moved({ gte: enrolment.enrolledAt }) },
        select: { status: true },
      }),
    ),
  ]);
  return {
    replied: false, // Inbound reply detection needs a mailbox to read; nothing claims it yet.
    ordered: orders > 0,
    renewed: orders > 0,
    ticketRaised: tickets > 0,
    leadWon: leads.some((l) => l.status === "WON"),
    leadLost: leads.some((l) => l.status === "LOST"),
    unsubscribed: false,
    suppressed: false,
  };
}

export type AdvanceOutcome = { stepped: number; exited: number; queued: number; tasks: number };

/**
 * Runs every enrolment that is due.
 *
 * Exits are checked *before* the step, not after. A sequence that sends one more email to somebody
 * who bought yesterday has told them plainly that nobody is reading.
 */
export async function advanceEnrolments(origin: string): Promise<AdvanceOutcome> {
  const due = await db.journeyEnrolment.findMany({
    where: { status: "ACTIVE", nextRunAt: { lte: new Date() } },
    include: {
      journey: { include: { steps: { orderBy: { order: "asc" } } } },
      company: { select: { id: true, name: true, ownerUserId: true, assignedToUserId: true, managedByResellerId: true } },
    },
    take: 500,
  });
  if (due.length === 0) return { stepped: 0, exited: 0, queued: 0, tasks: 0 };

  const settings = await marketingSettings();
  let stepped = 0;
  let exited = 0;
  let queued = 0;
  let tasks = 0;

  for (const enrolment of due) {
    const signals = await exitSignalsFor(enrolment);
    const exit = shouldExit(parseExitConditions(enrolment.journey.exitOn), signals);
    if (exit.exit) {
      await db.journeyEnrolment.update({
        where: { id: enrolment.id },
        data: { status: "EXITED", exitedAt: new Date(), exitReason: exit.label ?? exit.reason, nextRunAt: null },
      });
      exited += 1;
      continue;
    }

    const next = advance(enrolment.currentStep, enrolment.journey.steps, new Date());
    if (next.done) {
      await db.journeyEnrolment.update({
        where: { id: enrolment.id },
        data: { status: "COMPLETED", nextRunAt: null },
      });
      continue;
    }

    const step = enrolment.journey.steps.find((s) => s.id === next.step.id)!;
    const outcome = await runStep(enrolment, step, settings, origin);
    if (outcome === "QUEUED") queued += 1;
    if (outcome === "TASK") tasks += 1;

    const after = advance(step.order, enrolment.journey.steps, new Date());
    await db.journeyEnrolment.update({
      where: { id: enrolment.id },
      data: {
        currentStep: step.order,
        status: after.done ? "COMPLETED" : "ACTIVE",
        nextRunAt: after.done ? null : after.dueAt,
      },
    });
    stepped += 1;
  }

  return { stepped, exited, queued, tasks };
}

type StepOutcome = "QUEUED" | "TASK" | "SKIPPED";

async function runStep(
  enrolment: Awaited<ReturnType<typeof db.journeyEnrolment.findMany>>[number] & {
    company: { id: string; name: string; ownerUserId: string | null; assignedToUserId: string | null };
    journey: { id: string; name: string; trigger: string };
  },
  step: { id: string; channel: string; templateId: string | null; taskTitle: string | null; taskDetail: string | null; taskDueDays: number | null; taskAssignee: string | null },
  settings: MarketingSettings,
  origin: string,
): Promise<StepOutcome> {
  // ── A job for one of ours ────────────────────────────────────────────────────
  if (step.channel === "TASK" || step.channel === "NOTIFICATION") {
    const assignee =
      step.taskAssignee === "OWNER"
        ? enrolment.company.ownerUserId
        : step.taskAssignee === "ASSIGNEE"
          ? enrolment.company.assignedToUserId
          : step.taskAssignee || enrolment.company.ownerUserId;
    if (!assignee) return "SKIPPED";

    await db.task.create({
      data: {
        title: (step.taskTitle ?? enrolment.journey.name).replace("{{companyName}}", enrolment.company.name),
        description: step.taskDetail ?? null,
        dueDate: step.taskDueDays ? stepDueAt(new Date(), step.taskDueDays) : null,
        assignedToUserId: assignee,
        createdByUserId: assignee,
        companyId: enrolment.company.id,
      },
    });
    return "TASK";
  }

  // ── A message to the customer ────────────────────────────────────────────────
  if (!step.templateId) return "SKIPPED";
  const template = await db.marketingTemplate.findUnique({ where: { id: step.templateId } });
  if (!template) return "SKIPPED";

  const resolved = await resolveRecipients({
    // One company, and whichever contact the enrolment named — narrowed by id rather than by the
    // audience, because the audience already chose this company when it was enrolled.
    companyFilters: {},
    contactFilters: { primaryOnly: !enrolment.contactId, verifiedOnly: true, maxPerCompany: 1 },
    channel: template.channel,
    topic: template.topic,
    messageClass: "MARKETING",
    settings,
  }).then((all) =>
    all.filter(
      (r) =>
        r.recipient.companyId === enrolment.companyId &&
        (!enrolment.contactId || r.recipient.contactId === enrolment.contactId),
    ),
  );

  const chosen = resolved[0];
  if (!chosen) return "SKIPPED";

  const token = newToken();
  // Email is built exactly as a campaign's is — footer, one-click unsubscribe, tracking. WhatsApp
  // carries its words as written.
  const email = template.channel === "EMAIL" ? buildMarketingEmail({ template, recipient: chosen.recipient, settings, token, origin, trackingKey: (await currentKeys()).trackingKey }) : null;
  const values = mergeValuesFor(chosen.recipient, settings, { unsubscribeUrl: `${origin}/preferences/${token}` });
  const subject = email ? null : render(template.subject ?? "", values);
  const body = email ? null : render(template.body, values);

  const base = {
    token,
    enrolmentId: enrolment.id,
    stepId: step.id,
    companyId: enrolment.companyId,
    contactId: chosen.recipient.contactId,
    channel: template.channel,
    messageClass: "MARKETING" as const,
    toEmail: chosen.recipient.email,
    toPhone: chosen.recipient.phone,
    scheduledFor: nextSendTime(new Date(), settings.rules),
  };

  if (!chosen.verdict.ok) {
    await db.marketingMessage
      .create({
        data: {
          ...base,
          subject: template.subject,
          body: "",
          status: "SUPPRESSED",
          suppressedReason: `${chosen.verdict.reason}: ${chosen.verdict.detail}`,
        },
      })
      .catch(() => undefined);
    return "SKIPPED";
  }

  const missing = email ? (email.ok ? [] : email.missing) : [subject!, body!].flatMap((r) => (r.ok ? [] : r.missing));
  if (missing.length > 0) {
    await db.marketingMessage
      .create({
        data: {
          ...base,
          subject: template.subject,
          body: "",
          status: "SUPPRESSED",
          suppressedReason: `Missing merge field(s): ${[...new Set(missing)].join(", ")}`,
        },
      })
      .catch(() => undefined);
    return "SKIPPED";
  }

  const content =
    email && email.ok
      ? { subject: email.subject, body: email.html, textBody: email.text, unsubscribeUrl: email.unsubscribeUrl }
      : { subject: subject?.ok ? subject.text : "", body: body?.ok ? body.text : "" };
  await db.marketingMessage.create({ data: { ...base, ...content, status: "QUEUED" } }).catch(() => undefined);
  return "QUEUED";
}

/** Everything one tick does, in order: find people, move them, then send what is due. */
export { canSend };
