"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { Prisma, type CampaignStatus, type JourneyStatus, type MarketingTopic, type MessageChannel } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { financialYearOf } from "@/lib/gst-engine";
import { hasEffectivePermission } from "@/actions/permission";
import { summariseSuppressions } from "@/lib/marketing/suppression";
import { fieldsUsed, previewValues, render } from "@/lib/marketing/merge";
import { marketingSettings, queueCampaign, resolveRecipients } from "@/lib/marketing/pipeline";
import { runMarketingTick, tickHealth } from "@/lib/marketing/tick";
import { candidatesFor } from "@/lib/marketing/enrol";
import { audienceCompanyWhere, parseCompanyFilters, DEFAULT_CONTACT_FILTERS } from "@/lib/marketing/audience";
import { TRIGGERS } from "@/lib/marketing/triggers";
import type { ActionResult } from "@/actions/company";

/**
 * Building and sending campaigns.
 *
 * The send pipeline itself is in src/lib/marketing/*, not here, because every export in a
 * `"use server"` module is a client-callable endpoint and those functions decrypt provider secrets
 * and mark mail as sent. What lives here is what a signed-in person is allowed to ask for.
 */

async function access() {
  const user = await requireUser();
  const [manage, send, approve, viewAll] = await Promise.all([
    hasEffectivePermission(user.id, "marketing.manage"),
    hasEffectivePermission(user.id, "marketing.send"),
    hasEffectivePermission(user.id, "marketing.approve"),
    hasEffectivePermission(user.id, "marketing.viewAll"),
  ]);
  return { user, manage, send, approve, viewAll: viewAll || manage };
}

/** Links in an email have to work from outside, so the origin comes from the request. */
async function currentOrigin() {
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// ─── Audiences ────────────────────────────────────────────────────────────────

export async function listAudiences() {
  const { viewAll } = await access();
  if (!viewAll) return [];
  return toPlain(
    await db.audience.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        createdBy: { select: { name: true } },
        _count: { select: { campaigns: true, journeys: true } },
      },
    }),
  );
}

export async function saveAudience(input: {
  id?: string;
  name: string;
  description?: string;
  companyFilters: unknown;
  contactFilters: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't build audiences." };
  if (!input.name.trim()) return { ok: false, error: "Give it a name you'll recognise in three months." };

  const data = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    companyFilters: (input.companyFilters ?? {}) as Prisma.InputJsonValue,
    contactFilters: (input.contactFilters ?? DEFAULT_CONTACT_FILTERS) as Prisma.InputJsonValue,
  };

  const saved = input.id
    ? await db.audience.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.audience.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Audience",
    entityId: saved.id,
    entityLabel: data.name,
  });
  revalidatePath("/marketing/audiences");
  return { ok: true, data: saved };
}

export async function deleteAudience(id: string): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't delete audiences." };
  const inUse = await db.audience.findUnique({
    where: { id },
    select: { name: true, _count: { select: { campaigns: true, journeys: true } } },
  });
  if (!inUse) return { ok: false, error: "That audience no longer exists." };
  if (inUse._count.campaigns > 0 || inUse._count.journeys > 0) {
    return { ok: false, error: "Something is still using this audience. Retire that first." };
  }
  await db.audience.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Audience", entityId: id, entityLabel: inUse.name });
  revalidatePath("/marketing/audiences");
  return { ok: true, data: null };
}

/**
 * The dry run: who would receive this, who would not, and why not.
 *
 * The most useful screen in the module. "847 will get this, 112 won't, and here are the twelve
 * reasons" is the difference between a campaign somebody can sign off and one they have to hope
 * about.
 */
export async function previewAudience(input: {
  companyFilters: unknown;
  contactFilters: unknown;
  channel?: MessageChannel;
  topic?: MarketingTopic;
}) {
  const { viewAll } = await access();
  if (!viewAll) return null;

  const settings = await marketingSettings();
  const resolved = await resolveRecipients({
    companyFilters: input.companyFilters,
    contactFilters: input.contactFilters,
    channel: input.channel ?? "EMAIL",
    topic: input.topic ?? "OFFERS",
    messageClass: "MARKETING",
    settings,
  });

  const companies = await db.company.count({ where: audienceCompanyWhere(parseCompanyFilters(input.companyFilters)) });
  const summary = summariseSuppressions(resolved.map((r) => r.verdict));

  return toPlain({
    companies,
    contacts: resolved.length,
    ...summary,
    // A handful of real names, so somebody can sanity-check that the filters mean what they think.
    sample: resolved
      .filter((r) => r.verdict.ok)
      .slice(0, 8)
      .map((r) => ({ name: r.recipient.name, company: r.recipient.companyName, email: r.recipient.email })),
    blocked: resolved
      .filter((r) => !r.verdict.ok)
      .slice(0, 8)
      .map((r) => ({
        name: r.recipient.name,
        company: r.recipient.companyName,
        reason: r.verdict.ok ? "" : r.verdict.detail,
      })),
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function listTemplates() {
  const { viewAll } = await access();
  if (!viewAll) return [];
  return toPlain(
    await db.marketingTemplate.findMany({
      orderBy: { updatedAt: "desc" },
      include: { createdBy: { select: { name: true } } },
    }),
  );
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  channel: MessageChannel;
  topic: MarketingTopic;
  subject?: string;
  preheader?: string;
  body: string;
  whatsappTemplateName?: string;
  active?: boolean;
}): Promise<ActionResult<{ id: string; warnings: string[] }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't edit templates." };
  if (!input.name.trim()) return { ok: false, error: "Give the template a name." };
  if (!input.body.trim()) return { ok: false, error: "There's nothing in the body." };

  // A typo'd merge field is an author error, and it is much cheaper to catch here than at send.
  const used = fieldsUsed(`${input.subject ?? ""} ${input.body}`);
  if (used.unknown.length > 0) {
    return { ok: false, error: `No such merge field: ${used.unknown.map((u) => `{{${u}}}`).join(", ")}` };
  }

  const warnings: string[] = [];
  if (input.channel === "EMAIL" && !input.subject?.trim()) warnings.push("No subject line.");
  if (input.channel === "EMAIL" && !input.body.includes("{{unsubscribeUrl}}")) {
    warnings.push("No unsubscribe link — one is added automatically, but putting it where you want it reads better.");
  }
  if (input.channel === "WHATSAPP" && !input.whatsappTemplateName?.trim()) {
    warnings.push("WhatsApp will reject this without an approved template name.");
  }

  const data = {
    name: input.name.trim(),
    channel: input.channel,
    topic: input.topic,
    subject: input.subject?.trim() || null,
    preheader: input.preheader?.trim() || null,
    body: input.body,
    whatsappTemplateName: input.whatsappTemplateName?.trim() || null,
    active: input.active ?? true,
  };

  const saved = input.id
    ? await db.marketingTemplate.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.marketingTemplate.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "MarketingTemplate",
    entityId: saved.id,
    entityLabel: data.name,
  });
  revalidatePath("/marketing/templates");
  return { ok: true, data: { id: saved.id, warnings } };
}

/** What a template looks like filled in, before anybody commits to sending it. */
export async function previewTemplate(input: { subject?: string; body: string }) {
  await access();
  const values = previewValues();
  const subject = render(input.subject ?? "", values);
  const body = render(input.body, values);
  return {
    subject: subject.ok ? subject.text : null,
    body: body.ok ? body.text : null,
    problems: [
      ...(subject.ok ? [] : subject.missing.map((m) => `Subject needs {{${m}}}`)),
      ...(body.ok ? [] : body.missing.map((m) => `Body needs {{${m}}}`)),
    ],
  };
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

async function nextCampaignReference(tx: Prisma.TransactionClient, date: Date) {
  const prefix = `MC/${financialYearOf(date)}/`;
  const last = await tx.campaign.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: "desc" },
    select: { reference: true },
  });
  const serial = last ? Number(last.reference.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(serial).padStart(4, "0")}`;
}

export async function listCampaigns(filters?: { status?: string }) {
  const { viewAll } = await access();
  if (!viewAll) return [];
  return toPlain(
    await db.campaign.findMany({
      where: filters?.status ? { status: filters.status as CampaignStatus } : {},
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        audience: { select: { id: true, name: true } },
        template: { select: { id: true, name: true, topic: true } },
        createdBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
        _count: { select: { messages: true } },
      },
    }),
  );
}

export async function getCampaign(id: string) {
  const { viewAll } = await access();
  if (!viewAll) return null;
  const campaign = await db.campaign.findUnique({
    where: { id },
    include: {
      audience: true,
      template: true,
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  });
  if (!campaign) return null;

  const [counts, suppressed] = await Promise.all([
    db.marketingMessage.groupBy({
      by: ["status"],
      where: { campaignId: id },
      _count: { _all: true },
    }),
    db.marketingMessage.findMany({
      where: { campaignId: id, status: "SUPPRESSED" },
      select: { suppressedReason: true, company: { select: { name: true } } },
      take: 50,
    }),
  ]);

  return toPlain({
    campaign,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    suppressed,
  });
}

export async function saveCampaign(input: {
  id?: string;
  name: string;
  audienceId: string;
  templateId: string;
  channel: MessageChannel;
  scheduledFor?: string;
  windowStartMinute?: number | null;
  windowEndMinute?: number | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't create campaigns." };
  if (!input.name.trim()) return { ok: false, error: "Give the campaign a name." };

  const data = {
    name: input.name.trim(),
    audienceId: input.audienceId,
    templateId: input.templateId,
    channel: input.channel,
    scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
    windowStartMinute: input.windowStartMinute ?? null,
    windowEndMinute: input.windowEndMinute ?? null,
  };

  if (input.id) {
    const existing = await db.campaign.findUnique({ where: { id: input.id }, select: { status: true } });
    if (!existing) return { ok: false, error: "That campaign no longer exists." };
    // Once it has started going out, the audience and wording are history rather than settings.
    if (existing.status !== "DRAFT" && existing.status !== "PENDING_APPROVAL") {
      return { ok: false, error: "This campaign has already been scheduled. Cancel it to change anything." };
    }
    const saved = await db.campaign.update({ where: { id: input.id }, data, select: { id: true } });
    revalidatePath("/marketing");
    return { ok: true, data: saved };
  }

  const saved = await db.$transaction(async (tx) =>
    tx.campaign.create({
      data: { ...data, reference: await nextCampaignReference(tx, new Date()), createdById: user.id },
      select: { id: true, reference: true },
    }),
  );

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Campaign",
    entityId: saved.id,
    entityLabel: `${saved.reference} — ${data.name}`,
  });
  revalidatePath("/marketing");
  return { ok: true, data: { id: saved.id } };
}

/**
 * Freezes the recipient list and hands it to the scheduler.
 *
 * Above the configured size it needs a second person first, mirroring how an order needs approval —
 * a campaign is the one action in this app that reaches thousands of customers at once and cannot
 * be recalled.
 */
/**
 * Who would receive this, before anybody does.
 *
 * `scheduleCampaign` already tells you to "check the dry run for why" when an audience resolves to
 * nobody, and there was no dry run to check: the send button went straight from one click to a
 * mailshot, and the recipient count arrived in the sentence confirming it had already happened.
 * The one number somebody needs in order to decide — how many customers this reaches — was shown
 * only once it was too late to use it.
 *
 * Reads the campaign's own audience and template rather than loose filters, so what it counts is
 * exactly what `scheduleCampaign` would queue a moment later.
 */
export async function dryRunCampaign(id: string): Promise<ActionResult<{
  reference: string;
  subject: string;
  audienceName: string;
  willReceive: number;
  withheld: number;
  reasons: { reason: string; count: number }[];
  sample: { name: string; company: string | null; email: string | null }[];
  needsApproval: boolean;
  approvalThreshold: number;
}>> {
  const { send } = await access();
  if (!send) return { ok: false, error: "You can't send campaigns." };

  const campaign = await db.campaign.findUnique({ where: { id }, include: { audience: true, template: true } });
  if (!campaign) return { ok: false, error: "That campaign no longer exists." };

  const settings = await marketingSettings();
  const resolved = await resolveRecipients({
    companyFilters: campaign.audience.companyFilters,
    contactFilters: campaign.audience.contactFilters,
    channel: campaign.channel,
    topic: campaign.template.topic,
    messageClass: "MARKETING",
    settings,
  });

  const sendable = resolved.filter((r) => r.verdict.ok);
  const withheld = resolved.filter((r) => !r.verdict.ok);

  /**
   * Grouped by reason rather than listed, because "112 won't receive this" is a number somebody
   * nods at and "80 unsubscribed, 30 no valid address, 2 reseller-managed" is one they act on.
   */
  const byReason = new Map<string, number>();
  for (const r of withheld) {
    const reason = r.verdict.ok ? "" : r.verdict.detail;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  return {
    ok: true,
    data: toPlain({
      reference: campaign.reference,
      subject: campaign.template.subject ?? campaign.template.name,
      audienceName: campaign.audience.name,
      willReceive: sendable.length,
      withheld: withheld.length,
      reasons: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      sample: sendable.slice(0, 5).map((r) => ({
        name: r.recipient.name,
        company: r.recipient.companyName,
        email: r.recipient.email,
      })),
      needsApproval: sendable.length >= settings.approvalThreshold && !campaign.approvedAt,
      approvalThreshold: settings.approvalThreshold,
    }),
  };
}

export async function scheduleCampaign(id: string): Promise<ActionResult<{ queued: number; suppressed: number; blocked: number; needsApproval: boolean }>> {
  const { user, send } = await access();
  if (!send) return { ok: false, error: "You can't send campaigns." };

  const campaign = await db.campaign.findUnique({ where: { id }, include: { audience: true, template: true } });
  if (!campaign) return { ok: false, error: "That campaign no longer exists." };
  if (campaign.status !== "DRAFT" && campaign.status !== "PENDING_APPROVAL") {
    return { ok: false, error: `It is already ${campaign.status.toLowerCase().replaceAll("_", " ")}.` };
  }

  const settings = await marketingSettings();
  const resolved = await resolveRecipients({
    companyFilters: campaign.audience.companyFilters,
    contactFilters: campaign.audience.contactFilters,
    channel: campaign.channel,
    topic: campaign.template.topic,
    messageClass: "MARKETING",
    settings,
  });
  const sendable = resolved.filter((r) => r.verdict.ok).length;

  if (sendable === 0) {
    return { ok: false, error: "Nobody in this audience can be contacted. Check the dry run for why." };
  }

  if (sendable >= settings.approvalThreshold && !campaign.approvedAt) {
    await db.campaign.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
    revalidatePath("/marketing");
    return {
      ok: true,
      data: { queued: 0, suppressed: 0, blocked: 0, needsApproval: true },
    };
  }

  const origin = await currentOrigin();
  const outcome = await queueCampaign(id, origin);
  await db.campaign.update({ where: { id }, data: { status: "SCHEDULED", startedAt: new Date() } });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Campaign",
    entityId: id,
    entityLabel: `${campaign.reference} scheduled — ${outcome.queued} queued, ${outcome.suppressed + outcome.blocked} not sent`,
  });
  revalidatePath("/marketing");
  return { ok: true, data: { ...outcome, needsApproval: false } };
}

export async function approveCampaign(id: string): Promise<ActionResult<null>> {
  const { user, approve } = await access();
  if (!approve) return { ok: false, error: "You can't approve campaigns." };

  const campaign = await db.campaign.findUnique({
    where: { id },
    select: { id: true, reference: true, status: true, createdById: true },
  });
  if (!campaign) return { ok: false, error: "That campaign no longer exists." };
  if (campaign.status !== "PENDING_APPROVAL") return { ok: false, error: "It isn't waiting for approval." };
  // The point of a second pair of eyes is that they belong to a second person.
  if (campaign.createdById === user.id) {
    return { ok: false, error: "Somebody else has to approve a campaign you built." };
  }

  await db.campaign.update({ where: { id }, data: { approvedById: user.id, approvedAt: new Date() } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Campaign",
    entityId: id,
    entityLabel: `${campaign.reference} approved`,
  });
  revalidatePath("/marketing");
  return { ok: true, data: null };
}

export async function cancelCampaign(id: string): Promise<ActionResult<{ stopped: number }>> {
  const { user, send } = await access();
  if (!send) return { ok: false, error: "You can't stop campaigns." };
  const campaign = await db.campaign.findUnique({ where: { id }, select: { reference: true, status: true } });
  if (!campaign) return { ok: false, error: "That campaign no longer exists." };
  if (campaign.status === "SENT") return { ok: false, error: "It has already gone. Nothing to stop." };

  // Only what hasn't left. Anything already sent stays exactly as it is.
  const stopped = await db.marketingMessage.updateMany({
    where: { campaignId: id, status: "QUEUED" },
    data: { status: "SUPPRESSED", suppressedReason: "The campaign was stopped before this went out." },
  });
  await db.campaign.update({ where: { id }, data: { status: "CANCELLED", finishedAt: new Date() } });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Campaign",
    entityId: id,
    entityLabel: `${campaign.reference} stopped — ${stopped.count} held back`,
  });
  revalidatePath("/marketing");
  return { ok: true, data: { stopped: stopped.count } };
}

// ─── Journeys ─────────────────────────────────────────────────────────────────

export async function listJourneys() {
  const { viewAll } = await access();
  if (!viewAll) return [];
  return toPlain(
    await db.journey.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        audience: { select: { id: true, name: true } },
        steps: { orderBy: { order: "asc" }, include: { template: { select: { name: true } } } },
        _count: { select: { enrolments: true } },
      },
    }),
  );
}

export async function saveJourney(input: {
  id?: string;
  name: string;
  trigger: string;
  triggerConfig?: Record<string, unknown>;
  audienceId?: string | null;
  exitOn?: string[];
  reEnrolAfterDays?: number | null;
  steps: {
    order: number;
    delayDays: number;
    channel: MessageChannel;
    templateId?: string | null;
    taskTitle?: string | null;
    taskDetail?: string | null;
    taskDueDays?: number | null;
    taskAssignee?: string | null;
  }[];
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't build journeys." };
  if (!input.name.trim()) return { ok: false, error: "Give the journey a name." };
  if (!TRIGGERS.some((t) => t.key === input.trigger)) return { ok: false, error: "No such trigger." };
  if (input.steps.length === 0) return { ok: false, error: "A journey with no steps does nothing." };

  for (const step of input.steps) {
    const needsTemplate = step.channel === "EMAIL" || step.channel === "WHATSAPP";
    if (needsTemplate && !step.templateId) return { ok: false, error: `Step ${step.order} has no template.` };
    if (!needsTemplate && !step.taskTitle?.trim()) return { ok: false, error: `Step ${step.order} has no task title.` };
  }

  const data = {
    name: input.name.trim(),
    trigger: input.trigger,
    triggerConfig: (input.triggerConfig ?? {}) as Prisma.InputJsonValue,
    audienceId: input.audienceId || null,
    exitOn: (input.exitOn ?? []) as Prisma.InputJsonValue,
    reEnrolAfterDays: input.reEnrolAfterDays ?? null,
  };

  const journey = await db.$transaction(async (tx) => {
    const saved = input.id
      ? await tx.journey.update({ where: { id: input.id }, data, select: { id: true } })
      : await tx.journey.create({ data: { ...data, createdById: user.id }, select: { id: true } });

    // Steps are replaced wholesale. Enrolments track `currentStep` by order, so editing a running
    // journey moves people onto the new step of the same number rather than losing them.
    await tx.journeyStep.deleteMany({ where: { journeyId: saved.id } });
    await tx.journeyStep.createMany({
      data: input.steps.map((s) => ({
        journeyId: saved.id,
        order: s.order,
        delayDays: s.delayDays,
        channel: s.channel,
        templateId: s.templateId || null,
        taskTitle: s.taskTitle?.trim() || null,
        taskDetail: s.taskDetail?.trim() || null,
        taskDueDays: s.taskDueDays ?? null,
        taskAssignee: s.taskAssignee || null,
      })),
    });
    return saved;
  });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Journey",
    entityId: journey.id,
    entityLabel: `${data.name} — ${input.trigger}`,
  });
  revalidatePath("/marketing/journeys");
  return { ok: true, data: journey };
}

export async function setJourneyStatus(id: string, status: JourneyStatus): Promise<ActionResult<null>> {
  const { user, send } = await access();
  if (!send) return { ok: false, error: "You can't start or stop journeys." };
  const journey = await db.journey.findUnique({ where: { id }, select: { name: true, steps: { select: { id: true } } } });
  if (!journey) return { ok: false, error: "That journey no longer exists." };
  if (status === "ACTIVE" && journey.steps.length === 0) {
    return { ok: false, error: "It has no steps, so there is nothing to start." };
  }

  await db.journey.update({ where: { id }, data: { status } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Journey",
    entityId: id,
    entityLabel: `${journey.name} — ${status.toLowerCase()}`,
  });
  revalidatePath("/marketing/journeys");
  return { ok: true, data: null };
}

/** How many a trigger would catch today, before anybody turns the journey on. */
export async function previewTrigger(input: {
  trigger: string;
  triggerConfig?: Record<string, unknown>;
  audienceId?: string | null;
}) {
  const { viewAll } = await access();
  if (!viewAll) return null;

  const audience = input.audienceId
    ? await db.audience.findUnique({ where: { id: input.audienceId }, select: { companyFilters: true } })
    : null;
  const where = audienceCompanyWhere(parseCompanyFilters(audience?.companyFilters ?? {}));
  const candidates = await candidatesFor(input.trigger, input.triggerConfig ?? {}, where);

  const companies = await db.company.findMany({
    where: { id: { in: candidates.slice(0, 8).map((c) => c.companyId) } },
    select: { id: true, name: true },
  });
  return toPlain({ count: candidates.length, sample: companies.map((c) => c.name) });
}

// ─── Suppressions and consent ─────────────────────────────────────────────────

export async function listSuppressions(search?: string) {
  const { viewAll } = await access();
  if (!viewAll) return [];
  return toPlain(
    await db.suppression.findMany({
      where: search ? { value: { contains: search, mode: "insensitive" } } : {},
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { createdBy: { select: { name: true } } },
    }),
  );
}

export async function addSuppression(input: {
  scope: "EMAIL" | "CONTACT" | "COMPANY" | "DOMAIN";
  value: string;
  note?: string;
}): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change the suppression list." };
  const value = input.value.trim().toLowerCase();
  if (!value) return { ok: false, error: "Nothing to suppress." };

  await db.suppression.upsert({
    where: { scope_value: { scope: input.scope, value } },
    create: { scope: input.scope, value, reason: "MANUAL", note: input.note?.trim() || null, createdById: user.id },
    update: { note: input.note?.trim() || null },
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Suppression",
    entityId: value,
    entityLabel: `${input.scope.toLowerCase()} ${value} suppressed`,
  });
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: null };
}

export async function removeSuppression(id: string): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change the suppression list." };
  const row = await db.suppression.findUnique({ where: { id }, select: { value: true, reason: true } });
  if (!row) return { ok: false, error: "That entry no longer exists." };
  // An unsubscribe is the customer's decision, not ours to reverse from an admin screen.
  if (row.reason === "UNSUBSCRIBED" || row.reason === "COMPLAINT") {
    return {
      ok: false,
      error: "They asked us to stop. If they've since asked to be added back, record that as consent instead.",
    };
  }

  await db.suppression.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Suppression",
    entityId: id,
    entityLabel: `${row.value} un-suppressed`,
  });
  revalidatePath("/marketing/suppressions");
  return { ok: true, data: null };
}

export async function setConsent(input: {
  contactId: string;
  topic: MarketingTopic;
  channel?: MessageChannel;
  subscribed: boolean;
  evidence?: string;
}): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't record consent." };
  const channel = input.channel ?? "EMAIL";

  await db.contactConsent.upsert({
    where: { contactId_channel_topic: { contactId: input.contactId, channel, topic: input.topic } },
    create: {
      contactId: input.contactId,
      channel,
      topic: input.topic,
      status: input.subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
      source: "VERBAL",
      evidence: input.evidence?.trim() || null,
      capturedById: user.id,
      withdrawnAt: input.subscribed ? null : new Date(),
    },
    update: {
      status: input.subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
      evidence: input.evidence?.trim() || undefined,
      capturedById: user.id,
      // Withdrawal is a timestamp, not a deletion — a deleted record cannot show consent was withdrawn.
      withdrawnAt: input.subscribed ? null : new Date(),
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ContactConsent",
    entityId: input.contactId,
    entityLabel: `${input.topic} ${input.subscribed ? "opted in" : "opted out"}`,
  });
  return { ok: true, data: null };
}

// ─── The company tab, the dashboard, and the watchdog ─────────────────────────

export async function companyMarketing(companyId: string) {
  const { viewAll, manage } = await access();
  if (!viewAll) return null;

  const [messages, consents, company, enrolments] = await Promise.all([
    db.marketingMessage.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        contact: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true, reference: true } },
        enrolment: { select: { journey: { select: { id: true, name: true } } } },
      },
    }),
    db.contactConsent.findMany({
      where: { contact: { companyId } },
      include: { contact: { select: { id: true, name: true } } },
    }),
    db.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, managedByResellerId: true },
    }),
    db.journeyEnrolment.findMany({
      where: { companyId, status: "ACTIVE" },
      include: { journey: { select: { id: true, name: true } } },
    }),
  ]);
  if (!company) return null;

  return toPlain({ company, messages, consents, enrolments, canManage: manage });
}

export async function marketingOverview() {
  const { viewAll } = await access();
  if (!viewAll) return null;

  const since = new Date(Date.now() - 30 * 86400000);
  const [counts, campaigns, journeys, health, suppressed] = await Promise.all([
    db.marketingMessage.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.campaign.count({ where: { status: { in: ["SCHEDULED", "SENDING", "PENDING_APPROVAL"] } } }),
    db.journey.count({ where: { status: "ACTIVE" } }),
    tickHealth(),
    db.suppression.count(),
  ]);

  return toPlain({
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    campaigns,
    journeys,
    health,
    suppressed,
  });
}

/**
 * Runs a tick by hand.
 *
 * Here because the scheduler lives outside the app, and "is the cron actually wired up?" is a
 * question somebody will need to answer on day one without shelling into the server.
 */
export async function runTickNow(): Promise<ActionResult<{ sent: number; enrolled: number; stepped: number }>> {
  const { user, send } = await access();
  if (!send) return { ok: false, error: "You can't run the scheduler." };

  const origin = await currentOrigin();
  try {
    const result = await runMarketingTick(origin);
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "MarketingTick",
      entityId: result.runId,
      entityLabel: `Run by hand — ${result.sent} sent, ${result.enrolled} enrolled`,
    });
    revalidatePath("/marketing");
    return { ok: true, data: { sent: result.sent, enrolled: result.enrolled, stepped: result.stepped } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The tick failed." };
  }
}

/** The registry, for the journey builder. Async because everything in a "use server" file must be. */
export async function listTriggers() {
  await requireUser();
  return TRIGGERS;
}
