import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { STILL_THERE } from "@/lib/contacts/left";
import { moduleAccessFor } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow, emailRouteFor, marketingSettings, resolveRecipients } from "@/lib/marketing/pipeline";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { ActionError, defineAction, type ActionContext } from "@/lib/automate/action-types";
import { priorOutput, withOutsideEffect } from "@/lib/automate/effects";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { activePerson, byWorkflow, notReached, personField, reach, type Person } from "@/lib/automate/actions/shared";

/**
 * Send an email (Deskzo Automate, Phase 2) — to a lead's contact, another contact, or a colleague.
 *
 * It goes out from a person's own mailbox — the workflow's owner's, or the lead owner's as a pipeline
 * automation's email does, because it is to their customer and the reply should come to them — or
 * through the company's mail server (Settings › Mail & messaging, transactional mail), in the owner's
 * name with replies to them.
 *
 * A customer's contact is held to the rules every transactional email keeps (src/lib/marketing/
 * suppression.ts): somebody still at the company, an address that works and hasn't bounced or
 * complained, and never a reseller's customer. It's a reminder, not business they're part of (owner,
 * 18 Oct 2026), so their own opt-outs stop it too — unsubscribed from everything, suppressed here by
 * hand, or its topic (service notices, renewal reminders) unticked — and it carries the link to choose:
 * stopped that way, the step finishes without sending (`sent: false`), as nothing went wrong. The workflow's owner must be able to see contacts'
 * details, and reach the lead or contact. What went out is logged as the document emails are: on the
 * contact's mail log, and on the lead's timeline when there is a lead.
 *
 * Sent at most once: if the worker stops after sending and before recording it, the run waits for a
 * person rather than send it again (src/lib/automate/effects.ts).
 */

type Output =
  | { sent: true; via: "mailbox" | "company"; from: string; recipient: "contact" | "person"; contactId: string | null; userId: string | null }
  | { sent: false; skipped: string; recipient: "contact"; contactId: string; userId: null };

const optionalId = z.string().trim().min(1).max(60).optional();

const input = z
  .object({
    /**
     * Who to: the lead's contact, a contact by id, a customer's main contact (the primary one, else
     * whoever receives documents), or a colleague by id ("owner" for the workflow's owner).
     */
    to: z.enum(["lead_contact", "contact", "company_contact", "person"]).default("lead_contact"),
    leadId: optionalId,
    contactId: optionalId,
    companyId: optionalId,
    userId: personField.optional(),
    /** From: the workflow owner's mailbox, the lead owner's, or the company's mail server. */
    from: z.enum(["owner", "lead_owner", "company"]).default("owner"),
    /** What a customer can stop it as in the preference centre: a service notice, or a renewal reminder. */
    topic: z.enum(["SERVICE", "RENEWALS"]).default("SERVICE"),
    subject: z
      .string()
      .trim()
      .min(1, "Give the email a subject.")
      .max(200)
      .refine((s) => !/[\r\n]/.test(s), "The subject has to be one line."),
    body: z.string().trim().min(1, "Write the message.").max(10_000),
  })
  .strict()
  .superRefine((i, issue) => {
    if ((i.to === "lead_contact" || i.from === "lead_owner") && !i.leadId) issue.addIssue({ code: "custom", path: ["leadId"], message: "Say which lead." });
    if (i.to === "contact" && !i.contactId) issue.addIssue({ code: "custom", path: ["contactId"], message: "Say which contact." });
    if (i.to === "company_contact" && !i.companyId) issue.addIssue({ code: "custom", path: ["companyId"], message: "Say which customer." });
    if (i.to === "person" && !i.userId) issue.addIssue({ code: "custom", path: ["userId"], message: "Say which person." });
  });

type Input = z.infer<typeof input>;
type Recipient =
  | { kind: "contact"; contactId: string; companyId: string; name: string; email: string }
  | { kind: "person"; userId: string; name: string; email: string }
  | { kind: "opted_out"; contactId: string; reason: string };

/** Who it goes to, checked — or refused with the reason. */
async function recipientFor(ctx: ActionContext, i: Input): Promise<Recipient> {
  if (i.to === "person") {
    const person = await activePerson(ctx, i.userId!, "person to email");
    if (!person.email) throw new ActionError(`${person.name} has no email address.`, "PERMANENT");
    return { kind: "person", userId: person.id, name: person.name, email: person.email };
  }
  let contactId = i.contactId ?? null;
  if (i.to === "lead_contact") {
    await reach(ctx, "leads", "view", i.leadId!, "lead");
    contactId = (await db.lead.findUnique({ where: { id: i.leadId! }, select: { contactId: true } }))?.contactId ?? null;
    if (!contactId) throw new ActionError("The lead has no contact to email.", "PERMANENT");
  } else if (i.to === "company_contact") {
    await reach(ctx, "companies", "view", i.companyId!, "customer");
    const main = await db.contact.findFirst({
      where: { companyId: i.companyId!, email: { not: null }, ...STILL_THERE },
      orderBy: [{ isPrimary: "desc" }, { receivesDocuments: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!main) throw new ActionError("The customer has nobody with an email address to send it to.", "PERMANENT");
    contactId = main.id;
  } else {
    await reach(ctx, "contacts", "view", contactId!, "contact");
  }
  if (!(await can(ctx.actorId, "contacts.view"))) throw new ActionError("The workflow's owner can't see contacts' details, so can't email one.", "PERMANENT");

  const [resolved] = await resolveRecipients({
    contactIds: [contactId!],
    channel: "EMAIL",
    topic: i.topic,
    messageClass: "TRANSACTIONAL",
    settings: await marketingSettings(),
    optOuts: true,
  });
  // Not found by name: they have left their company (src/lib/contacts/left.ts).
  if (!resolved) throw new ActionError("The contact has left their company, so wasn't emailed.", "PERMANENT");
  if (!resolved.verdict.ok) {
    // Their own choice — nothing wrong with the workflow: not sent, and the run goes on.
    if (resolved.verdict.findings.every((f) => !f.hard)) return { kind: "opted_out", contactId: resolved.recipient.contactId, reason: `${resolved.recipient.name} wasn't emailed: ${resolved.verdict.detail}` };
    throw new ActionError(`${resolved.recipient.name} can't be emailed: ${resolved.verdict.detail}`, "PERMANENT");
  }
  const r = resolved.recipient;
  return { kind: "contact", contactId: r.contactId, companyId: r.companyId, name: r.name, email: r.email!.trim() };
}

/** Whose mailbox it goes from, connected — or refused. Null for the company's mail server. */
async function senderFor(ctx: ActionContext, i: Input): Promise<Person | null> {
  if (i.from === "company") {
    if (!(await emailRouteFor("TRANSACTIONAL"))) throw new ActionError("No mail server is set up for transactional mail — add one in Settings › Mail & messaging.", "PERMANENT");
    return null;
  }
  let who = "owner";
  if (i.from === "lead_owner") {
    const owner = (await db.lead.findUnique({ where: { id: i.leadId! }, select: { ownerUserId: true } }))?.ownerUserId;
    if (!owner) throw new ActionError("The lead has no owner to send it from.", "PERMANENT");
    who = owner;
  }
  const person = await activePerson(ctx, who, i.from === "lead_owner" ? "lead's owner" : "workflow's owner");
  const mailbox = await mailboxState(person.id);
  if (mailbox.state !== "connected") throw new ActionError(`${person.name} hasn't a working mailbox connected (My profile), so nothing was sent.`, "PERMANENT");
  return person;
}

export const emailSend = defineAction({
  key: "email.send",
  label: "Send an email",
  description: "Emails a lead's contact, another contact or a colleague, from a person's mailbox or the company's mail server.",
  module: "companies",
  permission: null,
  risk: "irreversible",
  input,
  outputs: ["sent", "skipped", "via", "from", "recipient", "contactId", "userId"],
  preview: (i) =>
    `Would email ${i.to === "lead_contact" ? "the lead's contact" : i.to === "contact" ? "a contact" : i.to === "company_contact" ? "the customer's main contact" : "a colleague"} from ${i.from === "company" ? "the company's mail server" : i.from === "lead_owner" ? "the lead owner's mailbox" : "the workflow owner's mailbox"}: "${i.subject}".`,
  async run(ctx, i): Promise<Output> {
    // Sent on an earlier try: that stands, whatever has changed since.
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    // A lead named is one the owner may open now — in a workspace whose plan and switch have Leads.
    if (i.leadId && (await moduleAccessFor(ctx.actorId, "leads")) !== "available") throw new ActionError("The workflow's owner can't use Leads, so can't email from a lead.", "PERMANENT");
    if (i.leadId && i.to !== "lead_contact") await reach(ctx, "leads", "view", i.leadId, "lead");
    const recipient = await recipientFor(ctx, i);
    if (recipient.kind === "opted_out") return { sent: false, skipped: recipient.reason, recipient: "contact", contactId: recipient.contactId, userId: null };
    const sender = await senderFor(ctx, i);
    const actor = await db.user.findUnique({ where: { id: ctx.actorId }, select: { name: true, email: true } });
    if (!actor) throw notReached("workflow's owner");
    // To a customer: the link to choose what they're sent, as every reminder carries — this email's own.
    const token = randomBytes(24).toString("base64url");
    const text = recipient.kind === "contact" ? `${i.body}\n\n—\nManage what we send you: ${await tenantOrigin()}/preferences/${token}` : i.body;
    const html = textToHtml(text);

    const { output, fresh } = await withOutsideEffect<Extract<Output, { sent: true }>>(ctx, async () => {
      const base = { sent: true as const, recipient: recipient.kind, contactId: recipient.kind === "contact" ? recipient.contactId : null, userId: recipient.kind === "person" ? recipient.userId : null };
      if (sender) {
        const sent = await sendAsUser(sender.id, { subject: i.subject, html, to: [{ name: recipient.name, email: recipient.email }], attachments: [] });
        if (!sent.ok) return { ok: false, error: `${sender.name}'s mailbox didn't send it: ${sent.error}`, kind: sent.reconnect ? "PERMANENT" : "TRANSIENT" };
        return { ok: true, output: { ...base, via: "mailbox", from: sent.mailbox } };
      }
      const org = await getOrganisation();
      const sent = await deliverNow(
        {
          to: recipient.email,
          toName: recipient.name,
          fromName: senderDisplayName(actor.name, org.tradeName || org.legalName || ""),
          replyTo: actor.email,
          subject: i.subject,
          html,
          text,
        },
        "TRANSACTIONAL",
        { delivering: true },
      );
      if (!sent.ok) return { ok: false, error: `The company's mail server didn't take it: ${sent.error}`, kind: "TRANSIENT" };
      return { ok: true, output: { ...base, via: "company", from: sent.fromEmail ?? sent.provider } };
    });

    if (fresh) {
      const senderId = sender?.id ?? ctx.actorId;
      const now = new Date();
      // The contact's mail log, as an emailed document is logged.
      if (recipient.kind === "contact") {
        await db.marketingMessage.create({
          data: {
            token,
            companyId: recipient.companyId,
            contactId: recipient.contactId,
            channel: "EMAIL",
            messageClass: "TRANSACTIONAL",
            subject: i.subject,
            body: html,
            textBody: text,
            toEmail: recipient.email,
            status: "SENT",
            scheduledFor: now,
            sentAt: now,
            attempts: 1,
            sentByUserId: senderId,
            fromEmail: output.from,
          },
        });
      }
      if (i.leadId) {
        await db.activity.create({ data: { leadId: i.leadId, userId: senderId, type: "EMAIL", notes: `Sent ${byWorkflow(ctx)}: ${i.subject}`.slice(0, 2000) } });
      }
    }
    return output;
  },
});
