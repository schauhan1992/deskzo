"use server";

import { headers } from "next/headers";
import { CONTACT_LIMITS, CONTACT_TOPICS, type ContactInput, type ContactResult, type ContactTopic } from "@/components/site/contact-fields";
import { recordLead } from "@/lib/cms/leads";
import { clientIpFrom } from "@/lib/client-ip";
import { parseEmailAddress } from "@/lib/email-verification";
import { addressKey, findLookupsPerHour, siteAllowance, startWorkspaceLookup } from "@/lib/platform/find-workspaces";
import { sendPlatformMail } from "@/lib/platform/mailer";

/**
 * The public site's two forms (src/app/platform-site) — for people without an account anywhere, so
 * nothing here needs one, and nothing here reads or writes a workspace's data except the one lookup
 * `findMyWorkspaces` starts.
 *
 * Both have a honeypot field (`website`): people leave it empty, form-filling bots do not, and a
 * filled one gets the normal answer and nothing else. Both are limited per address and per caller —
 * the caller only when its address is known (src/lib/client-ip.ts), never one "unknown" bucket that
 * would let anybody stop everybody — and in all (src/lib/platform/find-workspaces.ts siteAllowance).
 * Neither writes an email address to a log or the audit log.
 */

const answer = { ok: true } as const;
const text = (value: unknown) => (typeof value === "string" ? value : "");
/** A single line: no line breaks for a mail header or a log to be split by. */
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();

async function caller(): Promise<string | null> {
  return clientIpFrom(await headers());
}

/**
 * "Find my workspaces": emails the address a link to every workspace it can sign in to.
 *
 * Always `{ ok: true }` — for an address with workspaces, one without, one that is not an address,
 * a bot, and a request over the limits alike — and in about the same time: the lookup and the mail
 * are started, not awaited, so how long this takes says nothing about what was found.
 */
export async function findMyWorkspaces(input: { email: string; website?: string }): Promise<{ ok: true }> {
  try {
    if (text(input?.website).trim()) return answer;
    const parsed = parseEmailAddress(text(input?.email));
    if (!parsed) return answer;
    const email = `${parsed.local}@${parsed.domain}`;
    const ip = await caller();
    const ceiling = await findLookupsPerHour();
    const allowed = siteAllowance([
      { key: `platform|find:${addressKey(email)}`, max: 3 },
      ...(ip ? [{ key: `platform|find-caller:${ip}`, max: 10 }] : []),
      // A ceiling for the whole process: 60 an hour while each lookup queries every workspace's database,
      // 300 once the email index is built and a lookup asks only the workspaces that name the address
      // (owner decision 6).
      { key: "platform|find:all", max: ceiling },
    ]);
    if (allowed) startWorkspaceLookup(email);
  } catch (err) {
    console.error(`[site] find my workspaces: ${err instanceof Error ? err.name : "error"}`);
  }
  return answer;
}

const TOPIC_TITLES: Record<ContactTopic, string> = { demo: "Demo", sales: "Sales", support: "Support", other: "Other" };

/**
 * The contact form: checked, limited, kept in the CMS's leads inbox (src/lib/cms/leads.ts — with the
 * caller's address only when it is known), and mailed to PLATFORM_SALES_EMAIL (docs/runbook.md).
 * Without one set the message is not mailed anywhere — a line is logged saying so, and the visitor is
 * still thanked. Once the lead is kept, a mail that fails is logged and the visitor is still thanked.
 * The platform's mailer sets no reply-to, so the visitor's address leads the message.
 */
export async function sendContactRequest(input: ContactInput): Promise<ContactResult> {
  if (text(input?.website).trim()) return answer;

  const name = oneLine(text(input?.name));
  const company = oneLine(text(input?.company));
  const phone = oneLine(text(input?.phone));
  const topic = text(input?.topic) as ContactTopic;
  const message = text(input?.message).replace(/\r\n?/g, "\n").trim();
  const parsed = parseEmailAddress(text(input?.email));
  const email = parsed ? `${parsed.local}@${parsed.domain}` : null;

  if (name.length < 2 || name.length > CONTACT_LIMITS.name) return { ok: false, field: "name", error: "Tell us your name." };
  if (!email) return { ok: false, field: "email", error: "Enter a valid email address." };
  if (company.length < 2 || company.length > CONTACT_LIMITS.company) return { ok: false, field: "company", error: "Tell us your company's name." };
  if (phone && (phone.length > CONTACT_LIMITS.phone || !/^[+()\-.\s\d]+$/.test(phone) || phone.replace(/\D/g, "").length < 6)) {
    return { ok: false, field: "phone", error: "Enter a phone number, or leave it empty." };
  }
  if (!CONTACT_TOPICS.includes(topic)) return { ok: false, field: "topic", error: "Choose what your message is about." };
  if (message.length < CONTACT_LIMITS.messageMin) return { ok: false, field: "message", error: "Write a little more about what you need." };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, field: "message", error: `Keep your message under ${CONTACT_LIMITS.message.toLocaleString("en-IN")} characters.` };

  const ip = await caller();
  const allowed = siteAllowance([
    { key: `platform|contact:${addressKey(email)}`, max: 3 },
    ...(ip ? [{ key: `platform|contact-caller:${ip}`, max: 5 }] : []),
    { key: "platform|contact:all", max: 100 },
  ]);
  if (!allowed) return { ok: false, error: "Several messages have been sent from here in the last hour. Please try again later." };

  let stored = false;
  try {
    stored = !!(await recordLead({ name, email, company: company || null, phone: phone || null, topic, message, ip }));
  } catch (err) {
    console.error(`[site] a contact request could not be kept in the leads inbox: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  }

  const to = process.env.PLATFORM_SALES_EMAIL?.trim();
  if (!to) {
    console.warn(`[site] a contact request arrived, but PLATFORM_SALES_EMAIL is not set — it was not mailed (docs/runbook.md)${stored ? "; it is in the CMS's leads inbox" : ""}.`);
    return answer;
  }
  try {
    await sendPlatformMail({
      type: "ALERTS",
      to,
      subject: oneLine(`Contact form: ${TOPIC_TITLES[topic]} — ${company}`),
      text: [
        `Reply to: ${email}`,
        "(Sent by the website's contact form. Replying to this email does not reach them — write to the address above.)",
        "",
        `Topic:    ${TOPIC_TITLES[topic]}`,
        `Name:     ${name}`,
        `Company:  ${company}`,
        `Email:    ${email}`,
        `Phone:    ${phone || "—"}`,
        "",
        message,
      ].join("\n"),
    });
  } catch (err) {
    console.error(`[site] a contact request could not be mailed: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
    if (stored) return answer;
    return { ok: false, error: "Your message couldn't be sent just now. Please try again in a few minutes." };
  }
  return answer;
}
