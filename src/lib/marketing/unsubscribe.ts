import { db } from "@/lib/db";
import { TOPICS } from "@/lib/marketing/topics";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Unsubscribing from everything, by the token in an email — shared by the preference centre's
 * button and the one-click `List-Unsubscribe` POST that Gmail and Yahoo send on a person's behalf,
 * so the two can never disagree about what "unsubscribe" means.
 *
 * Server-only and not a `"use server"` module: the token is the only authority, and exposing this
 * as an action would let anything that can guess a function id call it.
 */

/**
 * The contact a token belongs to — through the message it was sent in, or their own preference link.
 *
 * Both kinds outlive the contact they were made for when two companies are merged and the person is
 * combined with their duplicate (src/lib/companies/merge.ts): a message that lost its contact still
 * finds them by the address it went to, and a preference link by the contact it was folded into.
 */
export async function contactForToken(token: string) {
  if (!token || token.length < 10) return null;
  const message = await db.marketingMessage.findUnique({ where: { token }, select: { contactId: true, companyId: true, toEmail: true } });
  if (message) {
    if (message.contactId) return db.contact.findUnique({ where: { id: message.contactId } });
    if (!message.toEmail) return null;
    return db.contact.findFirst({
      where: { companyId: message.companyId, email: { equals: message.toEmail.trim(), mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });
  }
  return (
    (await db.contact.findUnique({ where: { preferenceToken: token } })) ??
    (await db.contact.findFirst({ where: { formerPreferenceTokens: { has: token } } }))
  );
}

/** Out of every topic, the address suppressed, any sequence ended. False when the token is nobody's. */
export async function unsubscribeByToken(token: string, how: "PREFERENCE_CENTRE" | "ONE_CLICK"): Promise<boolean> {
  const now = new Date();
  const note = how === "ONE_CLICK" ? "Unsubscribed with their mail app's one-click unsubscribe" : "Unsubscribed from everything";
  const contact = await contactForToken(token);
  if (!contact) return unsubscribeAddressOnly(token, note);
  // The day on the workspace's calendar, not UTC's.
  const today = (await workspaceClock()).today(now);

  for (const topic of TOPICS) {
    await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: topic.key } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: topic.key,
        status: "UNSUBSCRIBED",
        source: "PREFERENCE_CENTRE",
        evidence: `${note} on ${today}.`,
        withdrawnAt: now,
      },
      update: { status: "UNSUBSCRIBED", withdrawnAt: now, source: "PREFERENCE_CENTRE" },
    });
  }

  // Belt and braces: the address itself is suppressed, so a campaign built from a stale audience
  // still cannot reach them.
  if (contact.email) {
    await db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: contact.email.trim().toLowerCase() } },
      create: { scope: "EMAIL", value: contact.email.trim().toLowerCase(), reason: "UNSUBSCRIBED", note: `${note}.` },
      update: { reason: "UNSUBSCRIBED" },
    });
  }

  // Any sequence they were in ends now, rather than at its next step.
  await db.journeyEnrolment.updateMany({
    where: { contactId: contact.id, status: "ACTIVE" },
    data: { status: "EXITED", exitedAt: now, exitReason: "They unsubscribed", nextRunAt: null },
  });

  // Counted against the email they unsubscribed from, so its campaign report shows it.
  const message = await db.marketingMessage.findUnique({ where: { token }, select: { id: true } });
  if (message) {
    await db.messageEvent.create({ data: { messageId: message.id, type: "UNSUBSCRIBE", detail: note } }).catch(() => undefined);
  }
  return true;
}

/**
 * An email whose contact is no longer there — deleted, or combined into a duplicate with another
 * address when their companies were merged. There is nobody's consent to change, but the address the
 * email went to is suppressed all the same: somebody who pressed unsubscribe is told they are
 * unsubscribed, and it has to be true.
 */
async function unsubscribeAddressOnly(token: string, note: string): Promise<boolean> {
  const message = await db.marketingMessage.findUnique({ where: { token }, select: { id: true, toEmail: true } });
  const address = message?.toEmail?.trim().toLowerCase();
  if (!message || !address) return false;
  await db.suppression.upsert({
    where: { scope_value: { scope: "EMAIL", value: address } },
    create: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", note: `${note}.` },
    update: { reason: "UNSUBSCRIBED" },
  });
  await db.messageEvent.create({ data: { messageId: message.id, type: "UNSUBSCRIBE", detail: note } }).catch(() => undefined);
  return true;
}
