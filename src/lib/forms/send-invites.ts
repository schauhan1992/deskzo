import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { render } from "@/lib/marketing/merge";
import { marketingSettings, mergeValuesFor, newToken, sendQueued } from "@/lib/marketing/pipeline";
import type { RecipientState } from "@/lib/marketing/suppression";
import { workspaceClock } from "@/lib/time/workspace";
import { inviteLink, inviteVerdict, tooSoonToResend } from "@/lib/forms/invites";
import type { ActionResult } from "@/actions/company";

/**
 * Sending personal invitations to a form.
 *
 * Server-only rather than a `"use server"` module, like the order-notice sender it is modelled on:
 * every export of one of those is a client-callable endpoint, and the session and per-form checks
 * belong in the action that wraps this. It also lets `check:forms` exercise the real code.
 *
 * The caller has already narrowed `contactIds` to the people it may invite. This decides, for each
 * of them, whether they can be reached at all — and the answer is worked out before anything is
 * queued, so the dialog can say "this one bounced last month" instead of reporting it afterwards.
 */

type FormForInvites = {
  id: string;
  slug: string;
  name: string;
  topic: import("@prisma/client").MarketingTopic;
  eventStartsAt: Date | null;
  venue: string | null;
};

/** Who we would be writing to, and whether each of them can be written to. */
export async function inviteCandidates(form: Pick<FormForInvites, "id" | "topic">, contactIds: string[]) {
  if (contactIds.length === 0) return [];

  const [contacts, settings, existing] = await Promise.all([
    db.contact.findMany({
      where: { id: { in: contactIds }, ...STILL_THERE },
      orderBy: [{ company: { name: "asc" } }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        designation: true,
        emailStatus: true,
        emailCheckedValue: true,
        company: { select: { id: true, name: true, managedByResellerId: true, owner: { select: { name: true, email: true } } } },
        consents: { where: { channel: "EMAIL", topic: form.topic }, select: { status: true } },
      },
    }),
    marketingSettings(),
    db.formInvite.findMany({
      where: { formId: form.id, contactId: { in: contactIds } },
      select: { contactId: true, lastSentAt: true, revokedAt: true, submission: { select: { id: true } } },
    }),
  ]);

  const addresses = contacts.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter((d): d is string => !!d))];
  const companyIds = [...new Set(contacts.map((c) => c.company.id))];
  const now = new Date();
  const suppressions = await db.suppression.findMany({
    where: {
      OR: [
        { scope: "EMAIL", value: { in: addresses } },
        { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
        { scope: "COMPANY", value: { in: companyIds } },
        { scope: "DOMAIN", value: { in: domains } },
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: { scope: true, value: true, reason: true },
  });

  const previous = new Map(existing.map((e) => [e.contactId, e]));

  return contacts.map((contact) => {
    const address = contact.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const state: RecipientState = {
      company: { managedByResellerId: contact.company.managedByResellerId },
      contact: {
        email: contact.email,
        phone: contact.phone,
        emailStatus: contact.emailStatus,
        emailCheckedValue: contact.emailCheckedValue,
      },
      suppressions: suppressions
        .filter(
          (s) =>
            (s.scope === "EMAIL" && address !== null && s.value === address) ||
            (s.scope === "CONTACT" && s.value === contact.id) ||
            (s.scope === "COMPANY" && s.value === contact.company.id) ||
            (s.scope === "DOMAIN" && domain !== null && s.value === domain),
        )
        .map((s) => ({ reason: s.reason })),
      consent: contact.consents[0] ?? null,
      // Not consulted for a personal message, but the shape wants them.
      signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
    };

    const verdict = inviteVerdict(state, { topic: form.topic, limits: settings.limits });
    const before = previous.get(contact.id) ?? null;
    let blockedBecause = verdict.ok ? null : verdict.reason;
    if (!blockedBecause && before?.submission) blockedBecause = "Already answered — nothing to remind them about.";
    if (!blockedBecause && before && tooSoonToResend(before.lastSentAt, now)) blockedBecause = "Sent to them a few minutes ago.";

    return {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      designation: contact.designation,
      company: { id: contact.company.id, name: contact.company.name },
      owner: contact.company.owner,
      /** Invited before: sending again is a reminder with the same link. */
      reminder: before !== null && before.revokedAt === null,
      canReceive: blockedBecause === null,
      blockedBecause,
    };
  });
}

export async function queueFormInvites(input: {
  form: FormForInvites;
  contactIds: string[];
  subject: string;
  body: string;
  /** Absolute, for the personal link and the preference link. */
  origin: string;
  sentByUserId: string;
  inviterName: string;
}): Promise<ActionResult<{ sent: number; failed: number; queued: number; skipped: { name: string; reason: string }[] }>> {
  if (input.contactIds.length === 0) return { ok: false, error: "Pick at least one person to invite." };
  if (!input.subject.trim()) return { ok: false, error: "The invitation needs a subject." };
  // Without the link an invitation is a letter with no way to reply to it.
  if (!/\{\{\s*formLink\s*(\|[^}]*)?\}\}/.test(input.body)) {
    return { ok: false, error: "The message has to include {{formLink}} — it is each person's own link to the form." };
  }

  const [candidates, settings, clock] = await Promise.all([inviteCandidates(input.form, input.contactIds), marketingSettings(), workspaceClock()]);
  if (candidates.length === 0) return { ok: false, error: "Those people aren't in the address book." };

  const skipped: { name: string; reason: string }[] = [];
  let queued = 0;

  for (const person of candidates) {
    if (!person.canReceive || !person.email) {
      skipped.push({ name: person.name, reason: person.blockedBecause ?? "No email address." });
      continue;
    }

    // One invitation per person per form. A second send reuses it, token and all, so every email
    // they were sent opens the same answer. The link is worked out before anything is written, so a
    // message that cannot be rendered leaves no half-made invitation behind.
    const existing = await db.formInvite.findUnique({
      where: { formId_contactId: { formId: input.form.id, contactId: person.id } },
      select: { token: true },
    });
    const inviteToken = existing?.token ?? newToken();

    const messageToken = newToken();
    const values = mergeValuesFor(
      {
        contactId: person.id,
        companyId: person.company.id,
        companyName: person.company.name,
        name: person.name,
        email: person.email,
        phone: null,
        ownerName: person.owner?.name ?? null,
        ownerEmail: person.owner?.email ?? null,
        state: {} as RecipientState,
      },
      settings,
      {
        formName: input.form.name,
        formLink: inviteLink(input.origin, input.form.slug, inviteToken),
        // The event's start on the workspace's clock — where the event is.
        eventDate: input.form.eventStartsAt ? clock.dateTime(input.form.eventStartsAt) : null,
        eventVenue: input.form.venue,
        inviterName: input.inviterName,
        unsubscribeUrl: `${input.origin.replace(/\/+$/, "")}/preferences/${messageToken}`,
      },
    );

    const subject = render(input.subject, values);
    const body = render(input.body, values);
    if (!subject.ok || !body.ok) {
      const problems = [
        ...(subject.ok ? [] : [...subject.unknown.map((u) => `{{${u}}} isn't a merge field`), ...subject.missing]),
        ...(body.ok ? [] : [...body.unknown.map((u) => `{{${u}}} isn't a merge field`), ...body.missing]),
      ];
      skipped.push({ name: person.name, reason: `The message needs ${[...new Set(problems)].join(", ")}.` });
      continue;
    }

    // A withdrawn invitation sent again is live again.
    const invite = await db.formInvite.upsert({
      where: { formId_contactId: { formId: input.form.id, contactId: person.id } },
      create: {
        formId: input.form.id,
        contactId: person.id,
        companyId: person.company.id,
        email: person.email.trim().toLowerCase(),
        token: inviteToken,
        invitedById: input.sentByUserId,
      },
      update: { revokedAt: null, email: person.email.trim().toLowerCase() },
      select: { id: true },
    });

    await db.$transaction(async (tx) => {
      await tx.marketingMessage.create({
        data: {
          token: messageToken,
          companyId: person.company.id,
          contactId: person.id,
          channel: "EMAIL",
          // A person inviting a named customer, one at a time — see src/lib/forms/invites.ts.
          messageClass: "TRANSACTIONAL",
          subject: subject.text,
          body: body.text,
          toEmail: person.email,
          sentByUserId: input.sentByUserId,
          formInviteId: invite.id,
          // Sent now: somebody pressed a button and expects it gone, and quiet hours are for campaigns.
          scheduledFor: new Date(),
          status: "QUEUED",
        },
      });
      await tx.formInvite.update({ where: { id: invite.id }, data: { lastSentAt: new Date(), sendCount: { increment: 1 } } });
    });
    queued += 1;
  }

  if (queued === 0) return { ok: false, error: skipped[0]?.reason ?? "Nobody selected can be invited." };

  const result = await sendQueued(`invite-${Date.now().toString(36)}`);
  return { ok: true, data: { queued, sent: Math.min(result.sent, queued), failed: result.failed, skipped } };
}
