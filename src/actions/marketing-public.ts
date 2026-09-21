"use server";

import { createHash } from "node:crypto";
import type { MarketingTopic } from "@prisma/client";
import { db } from "@/lib/db";
import { isResellerManaged } from "@/lib/reseller";
import { getOrganisation } from "@/lib/organisation";
import { normalizeCompanyName } from "@/lib/validation/company";
import {
  firstError,
  parseFields,
  summariseAnswers,
  validateAnswers,
  type Answers,
} from "@/lib/marketing/form-fields";
import { TOPICS } from "@/lib/marketing/topics";
import { notifyUser } from "@/lib/notify";
import type { ActionResult } from "@/actions/company";

/**
 * The customer-facing half: the preference centre, and the forms that turn a stranger into a lead.
 *
 * The third module in this app that serves somebody with no account, after the new-joiner intake
 * and the feedback form, and it follows the same rules:
 *
 *   · The token is the authentication — 192 bits, and it grants exactly one capability.
 *   · Every failure looks identical, so the endpoint cannot be used to work out which tokens exist.
 *   · It returns only what the page needs to render, all of which the holder already knows.
 *
 * With one deliberate difference. A preference token does **not** expire and is **not** one-time:
 * somebody has to be able to come back next month and change their mind, and an unsubscribe link
 * that has gone stale is not an unsubscribe link. What it can do is correspondingly small — it
 * reads a name and sets subscription flags, and that is all.
 */


// ─── The preference centre ────────────────────────────────────────────────────

/**
 * Resolves whichever kind of token arrived.
 *
 * A link in a specific email carries that message's token; a link from anywhere else carries the
 * contact's own long-lived one. Both land here, and the second is minted the first time it is
 * needed rather than for every contact in the database.
 */
async function contactForToken(token: string) {
  if (!token || token.length < 10) return null;

  const message = await db.marketingMessage.findUnique({
    where: { token },
    select: { contactId: true },
  });
  const contactId = message?.contactId ?? null;

  const contact = contactId
    ? await db.contact.findUnique({ where: { id: contactId } })
    : await db.contact.findUnique({ where: { preferenceToken: token } });
  return contact;
}

export async function getPreferences(token: string) {
  const contact = await contactForToken(token);
  if (!contact) return null;

  const [company, consents, org, suppressed] = await Promise.all([
    db.company.findUnique({ where: { id: contact.companyId }, select: { name: true } }),
    db.contactConsent.findMany({ where: { contactId: contact.id, channel: "EMAIL" } }),
    getOrganisation(),
    contact.email
      ? db.suppression.findFirst({
          where: { scope: "EMAIL", value: contact.email.trim().toLowerCase(), reason: "UNSUBSCRIBED" },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  const byTopic = new Map(consents.map((c) => [c.topic, c.status]));
  return {
    firstName: contact.name.trim().split(/\s+/)[0] ?? null,
    email: contact.email,
    companyName: company?.name ?? null,
    ourName: org.tradeName || org.legalName || "us",
    postalAddress: org.marketingPostalAddress,
    unsubscribedFromEverything: !!suppressed,
    topics: TOPICS.map((t) => ({
      ...t,
      subscribed: byTopic.get(t.key) === "SUBSCRIBED",
    })),
  };
}

export async function updatePreferences(input: {
  token: string;
  topics: MarketingTopic[];
}): Promise<ActionResult<{ subscribed: number }>> {
  const contact = await contactForToken(input.token);
  if (!contact) return { ok: false, error: "This link is no longer valid." };

  const chosen = new Set(input.topics);
  const now = new Date();

  const stamp = now.toISOString().slice(0, 10);
  for (const topic of TOPICS) {
    const subscribed = chosen.has(topic.key);
    // The evidence has to describe the status it sits beside. A row reading SUBSCRIBED while its
    // evidence recounts an unsubscribe is the kind of consent record that is worse than none.
    const evidence = subscribed
      ? `Chosen by the contact in the preference centre on ${stamp}.`
      : `Turned off by the contact in the preference centre on ${stamp}.`;
    await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: topic.key } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: topic.key,
        status: subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
        source: "PREFERENCE_CENTRE",
        evidence,
        withdrawnAt: subscribed ? null : now,
      },
      update: {
        status: subscribed ? "SUBSCRIBED" : "UNSUBSCRIBED",
        source: "PREFERENCE_CENTRE",
        evidence,
        withdrawnAt: subscribed ? null : now,
      },
    });
  }

  // Choosing something again lifts a blanket unsubscribe — otherwise the suppression would silently
  // override the preferences they just set, and the page would be a lie.
  if (chosen.size > 0 && contact.email) {
    await db.suppression
      .deleteMany({ where: { scope: "EMAIL", value: contact.email.trim().toLowerCase(), reason: "UNSUBSCRIBED" } })
      .catch(() => undefined);
  }

  return { ok: true, data: { subscribed: chosen.size } };
}

/** The one-click case, and what the `List-Unsubscribe` header points at. */
export async function unsubscribeAll(token: string): Promise<ActionResult<null>> {
  const contact = await contactForToken(token);
  if (!contact) return { ok: false, error: "This link is no longer valid." };

  const now = new Date();
  for (const topic of TOPICS) {
    await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: topic.key } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: topic.key,
        status: "UNSUBSCRIBED",
        source: "PREFERENCE_CENTRE",
        evidence: `Unsubscribed from everything on ${now.toISOString().slice(0, 10)}.`,
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
      create: {
        scope: "EMAIL",
        value: contact.email.trim().toLowerCase(),
        reason: "UNSUBSCRIBED",
        note: "Unsubscribed from the preference centre.",
      },
      update: { reason: "UNSUBSCRIBED" },
    });
  }

  // Any sequence they were in ends now, rather than at its next step.
  await db.journeyEnrolment.updateMany({
    where: { contactId: contact.id, status: "ACTIVE" },
    data: { status: "EXITED", exitedAt: now, exitReason: "They unsubscribed", nextRunAt: null },
  });

  return { ok: true, data: null };
}

// ─── Inbound forms ────────────────────────────────────────────────────────────

export async function getForm(slug: string) {
  if (!slug) return null;
  const form = await db.inboundForm.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      headline: true,
      intro: true,
      fields: true,
      thankYouText: true,
      active: true,
      topic: true,
    },
  });
  if (!form || !form.active) return null;

  const org = await getOrganisation();
  // Parsed here rather than in the component: the page and the submit handler have to agree on
  // what the questions are, and the only way to guarantee that is for both to read them through
  // the same function.
  return {
    ...form,
    fields: parseFields(form.fields),
    ourName: org.tradeName || org.legalName || "us",
  };
}

/**
 * A stranger fills the form in.
 *
 * No CAPTCHA. A honeypot field plus a minimum fill time stops the automated traffic a form this
 * obscure actually attracts, and a CAPTCHA taxes every real person to inconvenience a bot that
 * mostly isn't there. The source is hashed rather than stored: rate limiting needs to know how
 * often, never who.
 */
export async function submitForm(input: {
  slug: string;
  /**
   * Every answer, keyed by the field it answers.
   *
   * Not a fixed set of named arguments: the form decides what it asks, so the handler cannot know
   * the shape in advance. It reads the same spec the page rendered from and validates against it.
   */
  values: Answers;
  /** Hidden field. A real person never fills it in. */
  website?: string;
  /** Milliseconds the form was on screen. */
  elapsedMs?: number;
}): Promise<ActionResult<{ thankYou: string }>> {
  const form = await db.inboundForm.findUnique({ where: { slug: input.slug } });
  if (!form || !form.active) return { ok: false, error: "This form is closed." };

  const thankYou = form.thankYouText ?? "Thank you — somebody will be in touch.";

  // Both bot checks answer with success. Telling a bot it was detected only teaches it.
  if (input.website?.trim()) return { ok: true, data: { thankYou } };
  if (typeof input.elapsedMs === "number" && input.elapsedMs < 2000) return { ok: true, data: { thankYou } };

  /**
   * The page validated too, and this is the copy that counts.
   *
   * A browser can be made to post anything, so a required question is only required because the
   * server says so. Answers are also narrowed to the questions the form actually asks: a payload
   * carrying extra keys is either a stale page or somebody probing, and neither should end up
   * stored as though it had been asked for.
   */
  const fields = parseFields(form.fields);
  const answers: Answers = Object.fromEntries(fields.map((f) => [f.key, (input.values[f.key] ?? "").trim()]));
  const refusal = firstError(validateAnswers(fields, answers));
  if (refusal) return { ok: false, error: refusal };

  // Present and valid, because `parseFields` guarantees both fields exist and are required.
  const email = answers.email!.toLowerCase();
  const name = answers.name!;

  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } });
  const ownerId = form.assignToUserId ?? admin?.id;
  if (!ownerId) return { ok: false, error: "This form isn't set up properly yet." };

  const companyName = answers.companyName || email.split("@")[1]!;
  const normalizedName = normalizeCompanyName(companyName);

  // Rate limiting needs to know how often, never who — so the same hash whichever path is taken.
  const submissionHash = createHash("sha256").update(`${email}:${form.id}`).digest("hex").slice(0, 32);

  const result = await db.$transaction(async (tx) => {
    // An existing company is reused rather than duplicated — the global uniqueness rule this whole
    // CRM is built on. A form must not be the one thing that gets round it.
    const company =
      (await tx.company.findUnique({ where: { normalizedName }, select: { id: true, managedByResellerId: true } })) ??
      (await tx.company.create({
        data: {
          name: companyName,
          normalizedName,
          source: "INBOUND",
          stage: "LEAD",
          createdById: ownerId,
          ownerUserId: ownerId,
        },
        select: { id: true, managedByResellerId: true },
      }));

    /**
     * A reseller's end customer is not ours to write to.
     *
     * `src/lib/reseller.ts` states the rule the arrangement rests on — no direct calls, no direct
     * email — and an anonymous form matched on company name could walk straight past it, creating a
     * contact, a lead and a consent row against a company we are contractually not to approach. The
     * submission is still recorded, because "who filled this in" is worth keeping either way, and
     * it is linked to the company so whoever reviews it can route it to the reseller.
     */
    if (isResellerManaged(company)) {
      await tx.formSubmission.create({
        data: {
          formId: form.id,
          payload: answers,
          name,
          email,
          phone: answers.phone || null,
          companyName,
          companyId: company.id,
          sourceHash: submissionHash,
        },
      });
      return { resellerManaged: true as const, company: null, contact: null, lead: null };
    }

    const contact =
      (await tx.contact.findFirst({ where: { companyId: company.id, email }, select: { id: true } })) ??
      (await tx.contact.create({
        data: {
          companyId: company.id,
          name,
          email,
          phone: answers.phone || null,
          createdByUserId: ownerId,
        },
        select: { id: true },
      }));

    const lead = form.createsLead
      ? await tx.lead.create({
          data: {
            companyId: company.id,
            contactId: contact.id,
            title: `${form.name} — ${companyName}`,
            // Everything the form asked that is not already a column of its own, so whoever
            // picks this up reads the answers instead of opening the submission to find them.
            description: summariseAnswers(fields, answers) || null,
            status: "NEW",
            ownerUserId: ownerId,
            sourcedByUserId: ownerId,
          },
          select: { id: true },
        })
      : null;

    /**
     * Recorded as **PENDING**, never as consent.
     *
     * This wrote `SUBSCRIBED`, which is a claim the submission cannot support. Nobody proved they
     * own the address they typed: anyone who knows a customer's company name and a colleague's
     * email address could post this form and have the app record, in that person's name, that they
     * asked to be marketed to — with an evidence string saying so. That is a forged consent
     * artefact, and DPDP asks for the artefact precisely because it is the thing that must be true.
     *
     * `PENDING` is the honest state and it already works: `suppressionReasons` treats anything that
     * is not `SUBSCRIBED` as "No recorded consent for this topic" and withholds the message, so
     * this closes the hole without inventing any new machinery.
     *
     * `update: {}` stays deliberately empty — an existing row, in either direction, is a decision
     * the contact themselves made, and a stranger's form submission must not disturb it. In
     * particular it must never turn an UNSUBSCRIBED back on.
     *
     * The missing piece is double opt-in: a confirmation link that promotes PENDING to SUBSCRIBED.
     * The preference-centre token machinery in `src/lib/marketing/tracking.ts` is what it would be
     * built on. Until then, an inbound form generates a lead and no marketing permission.
     */
    await tx.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: form.topic } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: form.topic,
        status: "PENDING",
        source: "FORM",
        evidence: `Submitted "${form.name}" (${form.slug}) — address not confirmed.`,
      },
      update: {},
    });

    const submission = await tx.formSubmission.create({
      data: {
        formId: form.id,
        // Every answer as given. The named columns beside it are for searching and matching;
        // this is the record of what was actually filled in, including questions that have
        // since been taken off the form.
        payload: answers,
        name,
        email,
        phone: answers.phone || null,
        companyName,
        companyId: company.id,
        contactId: contact.id,
        leadId: lead?.id ?? null,
        sourceHash: submissionHash,
      },
      select: { id: true },
    });

    return { resellerManaged: false as const, company, contact, lead, submission };
  });

  /**
   * The same thank-you either way.
   *
   * A form that answered differently for a reseller-managed company would tell any stranger which
   * of our customers belong to a reseller, one company name at a time.
   */
  if (result.resellerManaged) {
    await notifyUser({
      userId: ownerId,
      type: "LEAD_ASSIGNED",
      title: `Enquiry from ${companyName} — reseller-managed`,
      message: `${name} filled in "${form.name}". This account belongs to a reseller, so nothing was created and nobody should contact them directly. Route it through the reseller.`,
      link: `/marketing/forms`,
    });
    return { ok: true, data: { thankYou } };
  }

  await notifyUser({
    userId: ownerId,
    type: "LEAD_ASSIGNED",
    title: `New enquiry from ${companyName}`,
    message: `${name} filled in "${form.name}".`,
    link: result.lead ? `/leads/${result.lead.id}` : `/companies/${result.company!.id}`,
  });

  return { ok: true, data: { thankYou } };
}

/*
 * `preferenceLinkFor` was here.
 *
 * It took a contact id from an unauthenticated caller and returned that contact's long-lived
 * preference token — a permanent credential for somebody else's communication settings, handed out
 * to anybody who could guess or scrape an id. It had no callers: every real send path mints its own
 * per-message token (see `newToken` in src/lib/marketing/pipeline.ts).
 *
 * If the capability is wanted, it belongs in a plain module rather than a "use server" one, where
 * it is not an endpoint, and its caller should hold a session and a marketing permission.
 */
