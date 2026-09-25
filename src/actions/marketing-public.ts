"use server";

import { createHash } from "node:crypto";
import type { FormCategory, MarketingTopic, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isResellerManaged } from "@/lib/reseller";
import { getOrganisation } from "@/lib/organisation";
import { normalizeCompanyName } from "@/lib/validation/company";
import {
  firstError,
  parseFields,
  questionsOf,
  summariseAnswers,
  validateAnswers,
  type Answers,
} from "@/lib/marketing/form-fields";
import { TOPICS } from "@/lib/marketing/topics";
// Whichever kind of token arrived — a message's, or the contact's own long-lived one.
import { contactForToken, unsubscribeByToken } from "@/lib/marketing/unsubscribe";
import { notifyUser } from "@/lib/notify";
import type { ActionResult } from "@/actions/company";
import { chooseOwner } from "@/lib/leads/assign";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { allowsLink } from "@/lib/forms/categories";
import { formOpenState, hasSeat } from "@/lib/forms/invites";
import { formatIstDateTime, formatIstTime, istDateParts } from "@/lib/india-time";

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

/** The preference centre's "unsubscribe from everything" — see src/lib/marketing/unsubscribe.ts. */
export async function unsubscribeAll(token: string): Promise<ActionResult<null>> {
  if (!(await unsubscribeByToken(token, "PREFERENCE_CENTRE"))) return { ok: false, error: "This link is no longer valid." };
  return { ok: true, data: null };
}

// ─── Inbound forms ────────────────────────────────────────────────────────────

/**
 * What the page needs to show a form: the questions, and for an event, when and where.
 *
 * Parsed here rather than in the component: the page and the submit handler have to agree on what
 * the questions are, and the only way to guarantee that is for both to read them through the same
 * function.
 */
async function presentForm(form: {
  id: string;
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  fields: unknown;
  thankYouText: string | null;
  topic: MarketingTopic;
  category: FormCategory;
  active: boolean;
  closesAt: Date | null;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  venue: string | null;
  capacity: number | null;
}) {
  const org = await getOrganisation();
  const open = formOpenState(form, new Date());
  const coming =
    form.category === "EVENT" && form.capacity !== null
      ? await db.formSubmission.count({ where: { formId: form.id, OR: [{ attending: true }, { attending: null }] } })
      : 0;
  return {
    id: form.id,
    slug: form.slug,
    name: form.name,
    headline: form.headline,
    intro: form.intro,
    thankYouText: form.thankYouText,
    topic: form.topic,
    category: form.category,
    eventStartsAt: form.eventStartsAt,
    eventEndsAt: form.eventEndsAt,
    venue: form.venue,
    /** Written out on the server, in India time, so the page and the browser cannot disagree. */
    eventWhen: form.eventStartsAt ? eventWhenText(form.eventStartsAt, form.eventEndsAt) : null,
    fields: parseFields(form.fields),
    ourName: org.tradeName || org.legalName || "us",
    /** Why it isn't taking answers, or null when it is. */
    closedMessage: open.open ? null : open.message,
    /** Every seat taken. A "can't make it" is still accepted. */
    full: form.category === "EVENT" && !hasSeat(form.capacity, coming),
  };
}

/** "Thu, 15 Oct 2026, 6:30 pm – 9:00 pm", or both dates in full when it runs past midnight. */
function eventWhenText(starts: Date, ends: Date | null): string {
  if (!ends) return formatIstDateTime(starts);
  const sameDay = istDateParts(starts).day === istDateParts(ends).day && ends.getTime() - starts.getTime() < 86_400_000;
  return `${formatIstDateTime(starts)} – ${sameDay ? formatIstTime(ends) : formatIstDateTime(ends)}`;
}

const publicFormSelect = {
  id: true,
  slug: true,
  name: true,
  headline: true,
  intro: true,
  fields: true,
  thankYouText: true,
  active: true,
  topic: true,
  category: true,
  fillMode: true,
  closesAt: true,
  eventStartsAt: true,
  eventEndsAt: true,
  venue: true,
  capacity: true,
} as const;

/**
 * The form behind a public link.
 *
 * An invitation-only form answers exactly as a closed one does: its address is a slug, which is
 * guessable, and "this one exists but you weren't invited" would say so to anybody who tried.
 */
export async function getForm(slug: string) {
  if (!slug) return null;
  const form = await db.inboundForm.findUnique({ where: { slug }, select: publicFormSelect });
  if (!form || !form.active || !allowsLink(form.fillMode)) return null;
  return presentForm(form);
}

/**
 * The form behind a personal invitation — who they are, and what they said last time.
 *
 * Every failure — no such token, the wrong form's slug, a withdrawn invitation, a closed form —
 * answers the same null, so the endpoint cannot be used to work out which tokens exist. Loading the
 * page notes that the link was opened; a mail scanner following links counts too, which is why the
 * list says "link opened" and never "read".
 */
export async function getInvitedForm(slug: string, token: string) {
  if (!slug || !token || token.length < 20) return null;
  const invite = await db.formInvite.findUnique({
    where: { token },
    select: {
      id: true,
      email: true,
      openedAt: true,
      revokedAt: true,
      form: { select: publicFormSelect },
      contact: { select: { name: true } },
      company: { select: { name: true } },
      submission: { select: { payload: true, attending: true } },
    },
  });
  if (!invite || invite.revokedAt || invite.form.slug !== slug || !invite.form.active) return null;

  if (!invite.openedAt) {
    await db.formInvite.update({ where: { id: invite.id }, data: { openedAt: new Date() } });
  }

  const previous =
    invite.submission && invite.submission.payload && typeof invite.submission.payload === "object" && !Array.isArray(invite.submission.payload)
      ? Object.fromEntries(
          Object.entries(invite.submission.payload as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
        )
      : null;

  return {
    ...(await presentForm(invite.form)),
    invitation: {
      token,
      /** Fixed: the invitation is to this person, at this address, from this company. */
      name: invite.contact.name,
      email: invite.email,
      companyName: invite.company.name,
      /** Their last answer, so coming back changes it rather than starting again. */
      previous,
      attending: invite.submission?.attending ?? null,
    },
  };
}

/** One seat-check at a time per form, so two people cannot both take the last place. */
async function lockSeats(tx: Prisma.TransactionClient, formId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`form-seats:${formId}`}))`;
}

const COMING_WHERE = { OR: [{ attending: true }, { attending: null }] } satisfies Prisma.FormSubmissionWhereInput;

/**
 * Somebody fills a form in — a stranger on the public link, or an invited customer on their own.
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
  /** An event's RSVP. Required on an event, ignored everywhere else. */
  attending?: boolean;
  /** The personal invitation this came through, when it did. */
  inviteToken?: string;
  /** Hidden field. A real person never fills it in. */
  website?: string;
  /** Milliseconds the form was on screen. */
  elapsedMs?: number;
}): Promise<ActionResult<{ thankYou: string }>> {
  if (input.inviteToken) return submitInvited({ ...input, inviteToken: input.inviteToken });

  const form = await db.inboundForm.findUnique({ where: { slug: input.slug } });
  if (!form || !form.active || !allowsLink(form.fillMode)) return { ok: false, error: "This form is closed." };
  const open = formOpenState(form, new Date());
  if (!open.open) return { ok: false, error: open.message };

  const event = form.category === "EVENT";
  if (event && typeof input.attending !== "boolean") return { ok: false, error: "Let us know whether you can come." };
  const attending = event ? input.attending! : null;

  const thankYou =
    attending === false
      ? "Thanks for letting us know — we'll keep you in mind for the next one."
      : (form.thankYouText ?? "Thank you — somebody will be in touch.");

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
  const answers: Answers = Object.fromEntries(questionsOf(fields).map((f) => [f.key, (input.values[f.key] ?? "").trim()]));
  const refusal = firstError(validateAnswers(fields, answers, { onlyMandatory: attending === false }));
  if (refusal) return { ok: false, error: refusal };

  // Present and valid, because `parseFields` guarantees both fields exist and are required.
  const email = answers.email!.toLowerCase();
  const name = answers.name!;

  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } });
  const companyName = answers.companyName || email.split("@")[1]!;
  /**
   * A person named on the form wins; otherwise the lead assignment rules decide, as they do for
   * the website API; an admin only when no rule fits — so a form lead never lands on nobody.
   */
  const knownCompany = await db.company.findUnique({
    where: { normalizedName: normalizeCompanyName(companyName) },
    select: { ownerUserId: true },
  });
  const ruled = form.assignToUserId
    ? null
    : await chooseOwner({
        brandIds: [],
        itemTypes: [],
        designation: null,
        source: "WEBSITE",
        state: null,
        companyOwnerId: knownCompany?.ownerUserId ?? null,
      });
  const ownerId = form.assignToUserId ?? ruled?.userId ?? admin?.id;
  if (!ownerId) return { ok: false, error: "This form isn't set up properly yet." };

  const normalizedName = normalizeCompanyName(companyName);

  // Rate limiting needs to know how often, never who — so the same hash whichever path is taken.
  const submissionHash = createHash("sha256").update(`${email}:${form.id}`).digest("hex").slice(0, 32);

  const result = await db.$transaction(async (tx) => {
    if (event) {
      await lockSeats(tx, form.id);
      /**
       * An address already registered is left exactly as it was, and answered with the same
       * thank-you. The public link proves nothing about who is typing, so it must not let a stranger
       * cancel somebody's place by entering their address and "can't make it" — nor book a second
       * seat for them. Somebody genuinely changing their mind uses their invitation, or tells us.
       */
      const already = await tx.formSubmission.findFirst({ where: { formId: form.id, email, ...COMING_WHERE }, select: { id: true } });
      if (already) return { kind: "unchanged" as const };
      if (attending) {
        const coming = await tx.formSubmission.count({ where: { formId: form.id, ...COMING_WHERE } });
        if (!hasSeat(form.capacity, coming)) return { kind: "full" as const };
      }
    }

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
          attending,
        },
      });
      return { kind: "reseller" as const };
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

    // Nobody saying "can't make it" to an event is a sales opportunity.
    const lead =
      form.createsLead && attending !== false
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
              source: "WEBSITE",
              sourceDetail: `Form: ${form.name}`,
              assignmentNote: ruled?.note ?? null,
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

    await tx.formSubmission.create({
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
        attending,
      },
      select: { id: true },
    });

    return { kind: "created" as const, company, lead };
  });

  if (result.kind === "full") return { ok: false, error: "Sorry — every seat has been taken." };
  // The same thank-you either way, so the link cannot be used to learn who has registered.
  if (result.kind === "unchanged") return { ok: true, data: { thankYou } };

  /**
   * The same thank-you either way.
   *
   * A form that answered differently for a reseller-managed company would tell any stranger which
   * of our customers belong to a reseller, one company name at a time.
   */
  if (result.kind === "reseller") {
    await notifyUser({
      userId: ownerId,
      type: "LEAD_ASSIGNED",
      title: `Enquiry from ${companyName} — reseller-managed`,
      message: `${name} filled in "${form.name}". This account belongs to a reseller, so nothing was created and nobody should contact them directly. Route it through the reseller.`,
      link: `/marketing/forms/${form.id}`,
    });
    return { ok: true, data: { thankYou } };
  }

  if (result.lead) await refreshLeadScore(result.lead.id);

  // A lead goes to whoever owns it. Without one the link is to the form's answers, so it goes to
  // somebody chosen to see them — the person the form routes to, else its owner — rather than to
  // whoever the lead rules happened to pick, who may not be able to open the form at all.
  await notifyUser({
    userId: result.lead ? ownerId : (form.assignToUserId ?? form.ownerUserId),
    type: result.lead ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
    title: event
      ? attending
        ? `${name} (${companyName}) is coming to ${form.name}`
        : `${name} (${companyName}) can't make ${form.name}`
      : `New answer from ${companyName}`,
    message: `${name} filled in "${form.name}".`,
    link: result.lead ? `/leads/${result.lead.id}` : `/marketing/forms/${form.id}?tab=responses`,
  });

  return { ok: true, data: { thankYou } };
}

/**
 * The invited path: the token says who they are, so nothing is matched on a typed company name.
 *
 * Answering again changes the one answer rather than adding a second — somebody who said yes and
 * then can't make it presses the same link and says so. Their name, address and company are the
 * invitation's, whatever the page sends: the link is theirs, not a way to register somebody else.
 */
async function submitInvited(input: {
  slug: string;
  values: Answers;
  attending?: boolean;
  inviteToken: string;
  website?: string;
}): Promise<ActionResult<{ thankYou: string }>> {
  const invite = await db.formInvite.findUnique({
    where: { token: input.inviteToken },
    select: {
      id: true,
      email: true,
      revokedAt: true,
      invitedById: true,
      form: true,
      contact: { select: { id: true, name: true } },
      company: { select: { id: true, name: true, managedByResellerId: true, ownerUserId: true } },
      submission: { select: { id: true, attending: true } },
    },
  });
  // One refusal for every way this can be wrong, as for any token.
  if (!invite || invite.revokedAt || invite.form.slug !== input.slug || !invite.form.active) {
    return { ok: false, error: "This invitation isn't available." };
  }
  const form = invite.form;
  const open = formOpenState(form, new Date());
  if (!open.open) return { ok: false, error: open.message };

  const event = form.category === "EVENT";
  if (event && typeof input.attending !== "boolean") return { ok: false, error: "Let us know whether you can come." };
  const attending = event ? input.attending! : null;
  const thankYou =
    attending === false
      ? "Thanks for letting us know — we'll keep you in mind for the next one."
      : (form.thankYouText ?? "Thank you — somebody will be in touch.");

  if (input.website?.trim()) return { ok: true, data: { thankYou } };

  const fields = parseFields(form.fields);
  const answers: Answers = Object.fromEntries(questionsOf(fields).map((f) => [f.key, (input.values[f.key] ?? "").trim()]));
  // Who they are comes from the invitation. A name they corrected is kept on the answer; the
  // address and company never change — those are what the invitation was to.
  answers.email = invite.email;
  answers.name = answers.name || invite.contact.name;
  if (questionsOf(fields).some((f) => f.key === "companyName")) answers.companyName = invite.company.name;
  const refusal = firstError(validateAnswers(fields, answers, { onlyMandatory: attending === false }));
  if (refusal) return { ok: false, error: refusal };

  const first = invite.submission === null;
  const reseller = isResellerManaged(invite.company);

  const outcome = await db.$transaction(async (tx) => {
    if (event) {
      await lockSeats(tx, form.id);
      if (attending) {
        const coming = await tx.formSubmission.count({
          where: { formId: form.id, ...COMING_WHERE, ...(invite.submission ? { id: { not: invite.submission.id } } : {}) },
        });
        if (!hasSeat(form.capacity, coming)) return { kind: "full" as const };
      }
    }

    const lead =
      first && form.createsLead && attending !== false && !reseller
        ? await tx.lead.create({
            data: {
              companyId: invite.company.id,
              contactId: invite.contact.id,
              title: `${form.name} — ${invite.company.name}`,
              description: summariseAnswers(fields, answers) || null,
              status: "NEW",
              ownerUserId: form.assignToUserId ?? invite.company.ownerUserId ?? invite.invitedById ?? form.ownerUserId,
              sourcedByUserId: invite.invitedById ?? form.ownerUserId,
              source: "WEBSITE",
              sourceDetail: `Form: ${form.name} (invited)`,
            },
            select: { id: true },
          })
        : null;

    const data = {
      payload: answers,
      name: answers.name!,
      email: invite.email,
      phone: answers.phone || null,
      companyName: invite.company.name,
      attending,
      // They answered it themselves, so nobody here "recorded" it any more.
      recordedById: null,
      // A "no" after a "yes" takes them off the register; there is nothing left to mark.
      ...(attending === false ? { attendance: null, attendanceMarkedAt: null, attendanceMarkedById: null } : {}),
    };
    if (invite.submission) {
      await tx.formSubmission.update({ where: { id: invite.submission.id }, data });
    } else {
      await tx.formSubmission.create({
        data: {
          ...data,
          formId: form.id,
          inviteId: invite.id,
          companyId: invite.company.id,
          contactId: invite.contact.id,
          leadId: lead?.id ?? null,
          sourceHash: createHash("sha256").update(`${invite.email}:${form.id}`).digest("hex").slice(0, 32),
        },
      });
    }
    return { kind: "saved" as const, lead };
  });

  if (outcome.kind === "full") {
    return { ok: false, error: "Sorry — every seat has been taken. Your account manager can let you know if one frees up." };
  }
  if (outcome.lead) await refreshLeadScore(outcome.lead.id);

  // Whoever sent the invitation hears about it, then whoever the form routes to, then its owner.
  const tell = invite.invitedById ?? form.assignToUserId ?? form.ownerUserId;
  const changed = !first && event && invite.submission?.attending !== attending;
  if (first || changed) {
    await notifyUser({
      userId: tell,
      type: outcome.lead ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
      title: event
        ? attending
          ? `${answers.name} (${invite.company.name}) is coming to ${form.name}`
          : `${answers.name} (${invite.company.name}) can't make ${form.name}`
        : `${answers.name} (${invite.company.name}) answered ${form.name}`,
      message: changed ? "They changed their answer." : "They answered the invitation you sent.",
      link: `/marketing/forms/${form.id}?tab=${event ? "invites" : "responses"}`,
    });
  }
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
