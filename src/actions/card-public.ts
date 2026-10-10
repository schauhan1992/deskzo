"use server";

import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notifyUser } from "@/lib/notify";
import { FIELD_KINDS } from "@/lib/cards/fields";
import { loadCard, publicCard, recordCardEvent } from "@/lib/cards/server";
import { intakeLead, leadPayloadSchema } from "@/lib/lead-capture/intake";
import { leadPath } from "@/lib/record-links";
import type { ActionResult } from "@/actions/company";

/**
 * A digital card's public page (/c/<handle>), for whoever was handed the card — nobody signed in.
 *
 * The card's address is not a secret: it is printed on a QR code and passed around, so what it opens
 * is only what the card shows, and the one thing it accepts is somebody's own details, given freely.
 *
 *   · No CAPTCHA, as on the public forms: a hidden field and a minimum fill time, and both answer a bot
 *     with the same thanks a person gets.
 *   · Counted in the database rather than by address: at most ten share-backs a card in ten minutes,
 *     and thirty a minute across the workspace. Nothing about who sent them is kept.
 *   · Saving the card never needs this. Sharing back is offered below it, never in front of it.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,30}$/;

export type ShareBackInput = {
  handle: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  message?: string;
  /** The template's questions, by id. */
  answers?: Record<string, string>;
  /** Hidden field. A real person never fills it in. */
  website?: string;
  /** Milliseconds the form was on screen. */
  elapsedMs?: number;
};

const BUSY = "A lot of people have shared their details with this card just now. Please try again in a few minutes.";

export async function shareBackFromCard(input: ShareBackInput): Promise<ActionResult<{ firstName: string }>> {
  if (!(await moduleAvailableForTenant("cards"))) return { ok: false, error: "This card isn't available." };
  const card = await publicCard(String(input.handle ?? ""));
  if (!card || card.state !== "live" || !card.shareBack) return { ok: false, error: "This card isn't taking details just now." };
  const thanks = { ok: true as const, data: { firstName: card.firstName } };

  // Both bot checks answer with success. Telling a bot it was detected only teaches it.
  if (input.website?.trim()) return thanks;
  if (typeof input.elapsedMs === "number" && input.elapsedMs < 2000) return thanks;

  const name = String(input.name ?? "").trim().slice(0, 120);
  const email = String(input.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = String(input.phone ?? "").trim().slice(0, 32);
  const company = String(input.company ?? "").trim().slice(0, 160);
  const jobTitle = String(input.jobTitle ?? "").trim().slice(0, 80);
  const message = String(input.message ?? "").trim().slice(0, 1000);
  if (!name) return { ok: false, error: "Your name, please." };
  if (!email && !phone) return { ok: false, error: "An email address or a phone number, so they can reach you." };
  if (email && !EMAIL.test(email)) return { ok: false, error: "That email address doesn't look right." };
  if (phone && !PHONE.test(phone)) return { ok: false, error: "That phone number doesn't look right." };

  // Only the questions the card asks, and every required one answered.
  const answers: { label: string; answer: string }[] = [];
  for (const q of card.questions) {
    const answer = String(input.answers?.[q.id] ?? "").trim().slice(0, 500);
    if (!answer && q.required) return { ok: false, error: `Please answer: ${q.label}` };
    if (answer) answers.push({ label: q.label, answer });
  }

  const [lately, everywhere] = await Promise.all([
    db.cardContact.count({ where: { cardId: card.cardId, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } }),
    db.cardContact.count({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } } }),
  ]);
  if (lately >= 10 || everywhere >= 30) return { ok: false, error: BUSY };

  const holder = await db.digitalCard.findUnique({ where: { id: card.cardId }, select: { userId: true, user: { select: { name: true } } } });
  if (!holder) return { ok: false, error: "This card isn't taking details just now." };

  const contact = await db.cardContact.create({
    data: {
      cardId: card.cardId,
      ownerUserId: holder.userId,
      name,
      email: email || null,
      phone: phone || null,
      company: company || null,
      jobTitle: jobTitle || null,
      message: message || null,
      answers,
    },
    select: { id: true },
  });
  await recordCardEvent(card.cardId, "SHARE_BACK");

  /**
   * With the CRM, a lead in the holder's name: they met. The contact above is kept either way, so the
   * card's list is whole whether or not the lead could be made — and a lead that fails costs nobody the
   * details they left.
   */
  let leadLink: string | null = null;
  if (await moduleAvailableForTenant("companies")) {
    const payload = leadPayloadSchema.safeParse({
      name,
      email,
      phone,
      company,
      designation: jobTitle,
      message: [message, ...answers.map((a) => `${a.label}: ${a.answer}`)].filter(Boolean).join("\n") || undefined,
      source: "DIGITAL_CARD",
    });
    if (payload.success) {
      try {
        const result = await intakeLead(
          { id: null, name: `${holder.user.name}'s digital card`, sourceLabel: "Digital card", createdById: holder.userId },
          payload.data,
          {
            ownerUserId: holder.userId,
            leadTitle: `${company || name} — from your digital card`,
            notifyTitle: `${name} shared their details from your card`,
          },
        );
        if (result.status !== "reseller") {
          const lead = await db.lead.findUnique({ where: { id: result.leadId }, select: { id: true, leadSeq: true } });
          if (lead) {
            await db.cardContact.update({ where: { id: contact.id }, data: { leadId: lead.id } });
            leadLink = leadPath(lead.leadSeq);
          }
        }
      } catch (err) {
        console.error("[cards] a share-back could not become a lead", err);
      }
    }
  }

  if (!leadLink) {
    await notifyUser({
      userId: holder.userId,
      type: "CARD_SHARED_BACK",
      title: `${name} shared their details from your card`,
      message: [company, email, phone].filter(Boolean).join(" · ").slice(0, 300),
      link: "/cards?tab=contacts",
    });
  }
  return thanks;
}

const TAP_KINDS = new Set<string>(FIELD_KINDS.map((k) => k.kind));

/** A link or number on the card was tapped — counted, never more. */
export async function recordCardTap(handle: string, kind: string): Promise<void> {
  if (!TAP_KINDS.has(kind)) return;
  if (!(await moduleAvailableForTenant("cards"))) return;
  const card = await loadCard({ handle: String(handle ?? "") });
  if (!card || card.status !== "ACTIVE") return;
  await recordCardEvent(card.id, "TAP", kind);
}
