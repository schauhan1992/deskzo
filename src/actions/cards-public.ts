"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { newLeadStage } from "@/lib/pipeline/server";
import { isResellerManaged } from "@/lib/reseller";
import { normalizeCompanyName } from "@/lib/validation/company";
import { notifyUser } from "@/lib/notify";
import { leadPath } from "@/lib/record-links";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { readQuestions } from "@/lib/cards/template";
import { cardOffReason, isUniqueViolation, workspaceToday } from "@/lib/cards/server";
import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import type { ActionResult } from "@/actions/company";

/**
 * A card's public page (docs/digital-cards-and-signatures.md §3.5): somebody with no account here
 * saving the card, tapping a link, or sharing their details back. Every action checks the module is
 * in the workspace's plan and switched on, and that the card is live; none says which of those failed.
 *
 * Sharing back is never required to save the card. When it is used, the person lands as a lead owned
 * by the cardholder — if they gave a company, because a lead belongs to one — and always as a card
 * contact the cardholder sees on "My card".
 */

/** How many share-backs one card takes in ten minutes before it stops listening — a stand at an event is busy, not this busy. */
const SHARE_BACKS_PER_TEN_MINUTES = 30;
/** Across every card in the workspace, an hour: the ceiling a script cycling through guessable addresses meets. */
const SHARE_BACKS_PER_HOUR_WORKSPACE = 300;
/** From one address, ten minutes. Generous, because an event's wifi puts a whole hall behind one. */
const SHARE_BACKS_PER_ADDRESS = 20;
const ADDRESS_WINDOW_MS = 10 * 60_000;

/**
 * Share-backs per caller address, in memory — rough by design (one server's view, reset on restart),
 * and only a second line behind the database counts. No address, no limit here: we never guess one.
 */
const byAddress = new Map<string, number[]>();
function addressAllows(ip: string | null, now = Date.now()): boolean {
  if (!ip) return true;
  const key = createHash("sha256").update(ip).digest("hex").slice(0, 24);
  const recent = (byAddress.get(key) ?? []).filter((t) => now - t < ADDRESS_WINDOW_MS);
  if (recent.length >= SHARE_BACKS_PER_ADDRESS) {
    byAddress.set(key, recent);
    return false;
  }
  recent.push(now);
  byAddress.delete(key);
  byAddress.set(key, recent);
  // Bounded: the oldest addresses go first.
  if (byAddress.size > 10_000) byAddress.delete(byAddress.keys().next().value!);
  return true;
}

async function liveCard(slug: string) {
  if (typeof slug !== "string" || slug.length > 80) return null;
  if (!(await moduleAvailableForTenant("cards"))) return null;
  const card = await db.digitalCard.findUnique({
    where: { slug },
    select: {
      id: true,
      active: true,
      switchedOffWhy: true,
      userId: true,
      template: { select: { questions: true } },
      user: { select: { name: true, active: true, employeeProfile: { select: { exitedOn: true } } } },
    },
  });
  return card && cardOffReason(card, card.user, await workspaceToday()) === null ? card : null;
}

/** A tap on one of the card's links. Counted, never who. Silent whatever happens. */
export async function recordCardTap(slug: string): Promise<void> {
  try {
    const card = await liveCard(slug);
    if (card) await db.cardEvent.create({ data: { cardId: card.id, kind: "TAP" } });
  } catch {
    // A count is not worth an error on somebody else's phone.
  }
}

const shareBackSchema = z
  .object({
    name: z.string().trim().min(2, "Your name, please").max(100),
    email: z.string().trim().max(200).email("That email doesn't look right").optional().or(z.literal("")),
    phone: z.string().trim().max(32, "That is too long for a phone number").optional().or(z.literal("")),
    companyName: z.string().trim().max(120).optional().or(z.literal("")),
    answers: z.array(z.string().trim().max(500)).max(5).optional(),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    // The honeypot: a field people never see. Anything in it is a script.
    website: z.string().optional(),
    // How long the form was open, in ms. Under two seconds is a script.
    elapsedMs: z.number().optional(),
  })
  .refine((v) => !!v.email || !!v.phone, { message: "An email or a phone number, so they can reach you", path: ["email"] });

/**
 * Shares somebody's details back from a card. The answer is the same thank-you whether a lead was
 * made, the company belongs to a reseller, or it was a repeat — the page must not tell a stranger
 * which companies are customers.
 */
export async function shareBack(slug: string, input: unknown): Promise<ActionResult<{ firstName: string }>> {
  const parsed = shareBackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  const v = parsed.data;
  const firstName = v.name.split(/\s+/)[0] ?? v.name;

  const card = await liveCard(slug);
  if (!card) return { ok: false, error: "This card isn't taking details right now." };

  // A script, answered as if it worked so it learns nothing.
  if (v.website?.trim()) return { ok: true, data: { firstName } };
  if (typeof v.elapsedMs === "number" && v.elapsedMs < 2000) return { ok: true, data: { firstName } };

  const busy = { ok: false as const, error: "Too many people at once — try again in a few minutes." };
  let ip: string | null = null;
  try {
    ip = clientIpFrom(await headers());
  } catch {
    // Called outside a request (a check script): no address to count by.
  }
  if (!addressAllows(ip)) return busy;
  const [recent, workspaceHour] = await Promise.all([
    db.cardContact.count({ where: { cardId: card.id, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } }),
    db.cardContact.count({ where: { createdAt: { gt: new Date(Date.now() - 3600_000) } } }),
  ]);
  if (recent >= SHARE_BACKS_PER_TEN_MINUTES || workspaceHour >= SHARE_BACKS_PER_HOUR_WORKSPACE) return busy;

  const email = v.email ? v.email.toLowerCase() : null;
  const phone = v.phone || null;
  const companyName = v.companyName?.trim() || null;
  // Rate limiting needs how often, never who — salted per card, so the same person on two cards isn't linkable.
  const sourceHash = createHash("sha256").update(`${card.id}:${email ?? phone}`).digest("hex").slice(0, 32);
  // The same person twice in a day: thank them, keep the first.
  const repeat = await db.cardContact.findFirst({ where: { cardId: card.id, sourceHash, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, select: { id: true } });
  if (repeat) return { ok: true, data: { firstName } };

  const questions = readQuestions(card.template.questions);
  const answers = questions
    .map((question, i) => ({ question, answer: v.answers?.[i]?.trim() ?? "" }))
    .filter((a) => a.answer.length > 0);
  const note = v.note?.trim() || null;
  const ownerId = card.userId;

  const entry = companyName ? await newLeadStage() : null;
  const record = () => db.$transaction(async (tx) => {
    let leadId: string | null = null;
    let leadSeq: number | null = null;
    let reseller = false;
    if (companyName && entry) {
      const normalizedName = normalizeCompanyName(companyName);
      const company =
        (await tx.company.findUnique({ where: { normalizedName }, select: { id: true, managedByResellerId: true } })) ??
        (await tx.company.create({
          data: { name: companyName, normalizedName, source: "INBOUND", stage: "LEAD", createdById: ownerId, ownerUserId: ownerId },
          select: { id: true, managedByResellerId: true },
        }));
      // A reseller's end customer is not ours to approach (src/lib/reseller.ts): the card contact is kept, no lead.
      if (isResellerManaged(company)) {
        reseller = true;
      } else {
        // The same person on the company already — by email, or by phone when that is all they gave.
        const known = email
          ? await tx.contact.findFirst({ where: { companyId: company.id, email }, select: { id: true } })
          : phone
            ? await tx.contact.findFirst({ where: { companyId: company.id, phone }, select: { id: true } })
            : null;
        const contact =
          known ??
          (await tx.contact.create({ data: { companyId: company.id, name: v.name, email, phone, createdByUserId: ownerId }, select: { id: true } }));
        const description = [
          ...answers.map((a) => `${a.question}: ${a.answer}`),
          note ? `Note: ${note}` : null,
        ].filter(Boolean).join("\n");
        const lead = await tx.lead.create({
          data: {
            companyId: company.id,
            contactId: contact.id,
            title: `Digital card — ${companyName}`,
            description: description || null,
            ...entry,
            ownerUserId: ownerId,
            sourcedByUserId: ownerId,
            source: "DIGITAL_CARD",
            sourceDetail: `${card.user.name}'s card`,
          },
          select: { id: true, leadSeq: true },
        });
        leadId = lead.id;
        leadSeq = lead.leadSeq;
      }
    }
    await tx.cardContact.create({
      data: { cardId: card.id, name: v.name, email, phone, companyName, answers: answers as unknown as Prisma.InputJsonValue, note, leadId, sourceHash },
    });
    await tx.cardEvent.create({ data: { cardId: card.id, kind: "SHARE_BACK" } });
    return { leadId, leadSeq, reseller };
  });
  let made: Awaited<ReturnType<typeof record>>;
  try {
    made = await record();
  } catch (err) {
    // Somebody else created the same company a moment ago: it exists now, so the second try finds it.
    if (!isUniqueViolation(err)) throw err;
    made = await record();
  }

  if (made.leadId) await refreshLeadScore(made.leadId);
  await notifyUser({
    userId: ownerId,
    type: "LEAD_ASSIGNED",
    title: made.reseller
      ? `${v.name} (${companyName}) shared their details — reseller-managed`
      : `${v.name}${companyName ? ` (${companyName})` : ""} shared their details from your card`,
    message: made.reseller
      ? "This account belongs to a reseller, so no lead was made and nobody should contact them directly."
      : made.leadId
        ? "They're a lead now, owned by you."
        : "They're on My card. They gave no company, so no lead was made.",
    link: made.leadSeq !== null ? leadPath(made.leadSeq) : "/cards",
  });
  return { ok: true, data: { firstName } };
}
