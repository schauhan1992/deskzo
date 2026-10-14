import type { CardContactVia } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notifyUser } from "@/lib/notify";
import { intakeLead, leadPayloadSchema } from "@/lib/lead-capture/intake";
import { leadPath } from "@/lib/record-links";

/**
 * Somebody met through a card, written down: a share-back from its page, a visitor at an event's stand,
 * or a card one of the team scanned. One path for the three, so they cannot drift.
 *
 * The card contact is always kept. Through the website intake's rules (no duplicate companies or people,
 * resellers' customers routed to the partner) they are also a company and contact in the CRM — and,
 * where the plan has leads, a lead owned by whoever met them, source Event when it came from one,
 * Digital card otherwise (owner, 14 Oct 2026: before, every workspace had leads). A lead that can't be
 * made costs nobody the details they left.
 */
export type MetPerson = {
  name: string;
  email: string;
  phone: string;
  company: string;
  jobTitle: string;
  message: string;
  answers: { label: string; answer: string }[];
};

export async function recordCardContact(input: {
  cardId: string | null;
  owner: { id: string; name: string };
  via: CardContactVia;
  event: { id: string; name: string } | null;
  person: MetPerson;
}): Promise<{ contactId: string; leadLink: string | null }> {
  const { person, event, owner } = input;
  const contact = await db.cardContact.create({
    data: {
      cardId: input.cardId,
      via: input.via,
      campaignId: event?.id ?? null,
      ownerUserId: owner.id,
      name: person.name,
      email: person.email || null,
      phone: person.phone || null,
      company: person.company || null,
      jobTitle: person.jobTitle || null,
      message: person.message || null,
      answers: person.answers,
    },
    select: { id: true },
  });

  let leadLink: string | null = null;
  const leadsHere = await moduleAvailableForTenant("leads");
  const payload = leadPayloadSchema.safeParse({
    name: person.name,
    email: person.email,
    phone: person.phone,
    company: person.company,
    designation: person.jobTitle,
    message: [person.message, ...person.answers.map((a) => `${a.label}: ${a.answer}`)].filter(Boolean).join("\n") || undefined,
    source: event ? "EVENT" : "DIGITAL_CARD",
  });
  if (payload.success) {
    const who = person.company || person.name;
    try {
      const result = await intakeLead(
        event
          ? { id: null, name: event.name, sourceLabel: `${event.name} (event)`, createdById: owner.id }
          : { id: null, name: `${owner.name}'s digital card`, sourceLabel: "Digital card", createdById: owner.id },
        payload.data,
        {
          ownerUserId: owner.id,
          leadTitle: event ? `${who} — met at ${event.name}` : `${who} — from your digital card`,
          notifyTitle: event ? `${person.name} left their details at ${event.name}` : `${person.name} shared their details from your card`,
          // Without a lead the share-back notice below says so, pointing at the card's contacts.
          notify: leadsHere && input.via !== "SCAN",
        },
      );
      if (result.status === "created" || result.status === "duplicate") {
        const lead = await db.lead.findUnique({ where: { id: result.leadId }, select: { id: true, leadSeq: true } });
        if (lead) {
          await db.cardContact.update({ where: { id: contact.id }, data: { leadId: lead.id } });
          leadLink = leadPath(lead.leadSeq);
        }
      }
    } catch (err) {
      console.error(`[cards] a card contact could not become a ${leadsHere ? "lead" : "company and contact"}`, err);
    }
  }

  // Somebody who scanned a card knows they did; a share-back is news.
  if (!leadLink && input.via !== "SCAN") {
    await notifyUser({
      userId: owner.id,
      type: "CARD_SHARED_BACK",
      title: event ? `${person.name} left their details at ${event.name}` : `${person.name} shared their details from your card`,
      message: [person.company, person.email, person.phone].filter(Boolean).join(" · ").slice(0, 300),
      link: "/cards?tab=contacts",
    });
  }
  return { contactId: contact.id, leadLink };
}
