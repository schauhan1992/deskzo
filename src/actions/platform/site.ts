"use server";

import { cookies, headers } from "next/headers";
import { CONTACT_LIMITS, CONTACT_TOPICS, type ContactInput, type ContactResult, type ContactTopic } from "@/components/site/contact-fields";
import { productByKey } from "@/lib/products";
import { recordLead } from "@/lib/cms/leads";
import { clientIpFrom } from "@/lib/client-ip";
import { parseEmailAddress } from "@/lib/email-verification";
import { addressKey, findLookupsPerHour, siteAllowance, startWorkspaceLookup } from "@/lib/platform/find-workspaces";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { getSiteSettings } from "@/lib/platform/site-content";
import { referralCookieDays } from "@/lib/partners/settings";
import { CONSENT_COOKIE, CONSENT_MAX_AGE, REFERRAL_COOKIE, isReferralCode } from "@/lib/partners/referral-cookie";
import { protocolFor } from "@/lib/tenancy/host";
import { recordPrivacyRequest } from "@/lib/platform/privacy-requests";
import { PRIVACY_LIMITS, isPrivacyKind, isPrivacyRelation, privacyKindLabel, privacyRelationLabel } from "@/components/site/privacy-fields";

/**
 * The public site's forms (src/app/platform-site) — for people without an account anywhere, so
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
 * caller's address only when it is known), and mailed to PLATFORM_SALES_EMAIL (docs/runbook.md). The
 * product it is about (a product page's "Book a demo": `?product=books`) goes with it when products.ts
 * knows it; anything else is no product, never a refusal.
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
  const product = productByKey(text(input?.product).trim().toLowerCase());
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
    stored = !!(await recordLead({ name, email, company: company || null, phone: phone || null, topic, message, ip, productKey: product?.key ?? null }));
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
      subject: oneLine(`Contact form: ${TOPIC_TITLES[topic]}${product ? ` of ${product.name}` : ""} — ${company}`),
      text: [
        `Reply to: ${email}`,
        "(Sent by the website's contact form. Replying to this email does not reach them — write to the address above.)",
        "",
        `Topic:    ${TOPIC_TITLES[topic]}`,
        `Product:  ${product?.name ?? "—"}`,
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

export type PrivacyRequestInput = { kind: string; name: string; email: string; relation: string; company?: string; message: string; website?: string };
export type PrivacyRequestResult = { ok: true; ref: string | null } | { ok: false; field?: "kind" | "name" | "email" | "relation" | "company" | "message"; error: string };

const longDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * A privacy request (owner, 23 Oct 2026; src/lib/platform/privacy-requests.ts): checked, limited as the
 * contact form is, kept for the console's Privacy requests, acknowledged to the person with its reference
 * and the day it is due, and copied to the privacy contact (Settings › General) — else PLATFORM_SALES_EMAIL.
 * Once it is kept, a mail that fails is logged and the person still gets their reference on the page.
 */
export async function sendPrivacyRequest(input: PrivacyRequestInput): Promise<PrivacyRequestResult> {
  if (text(input?.website).trim()) return { ok: true, ref: null };

  const kind = text(input?.kind);
  const relation = text(input?.relation);
  const name = oneLine(text(input?.name));
  const company = oneLine(text(input?.company));
  const message = text(input?.message).replace(/\r\n?/g, "\n").trim();
  const parsed = parseEmailAddress(text(input?.email));
  const email = parsed ? `${parsed.local}@${parsed.domain}` : null;

  if (!isPrivacyKind(kind)) return { ok: false, field: "kind", error: "Choose what you'd like us to do." };
  if (name.length < 2 || name.length > PRIVACY_LIMITS.name) return { ok: false, field: "name", error: "Tell us your name." };
  if (!email) return { ok: false, field: "email", error: "Enter a valid email address — we reply there." };
  if (!isPrivacyRelation(relation)) return { ok: false, field: "relation", error: "Tell us how you know Deskzo." };
  if ((relation === "user" || relation === "customer") && company.length < 2) {
    return { ok: false, field: "company", error: "Name the company whose Deskzo holds your data." };
  }
  if (company.length > PRIVACY_LIMITS.company) return { ok: false, field: "company", error: "Keep the company's name shorter." };
  if (message.length < PRIVACY_LIMITS.messageMin) return { ok: false, field: "message", error: "Tell us a little about your request." };
  if (message.length > PRIVACY_LIMITS.message) return { ok: false, field: "message", error: `Keep it under ${PRIVACY_LIMITS.message.toLocaleString("en-IN")} characters.` };

  const ip = await caller();
  const allowed = siteAllowance([
    { key: `platform|privacy:${addressKey(email)}`, max: 3 },
    ...(ip ? [{ key: `platform|privacy-caller:${ip}`, max: 5 }] : []),
    { key: "platform|privacy:all", max: 60 },
  ]);
  if (!allowed) return { ok: false, error: "Several requests have been sent from here in the last hour. Please try again later." };

  let kept: Awaited<ReturnType<typeof recordPrivacyRequest>> = null;
  try {
    kept = await recordPrivacyRequest({ kind, name, email, relation, company: company || null, message, ip });
  } catch (err) {
    console.error(`[site] a privacy request could not be kept: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  }

  const settings = await getSiteSettings();
  const contact = settings.privacy.email.trim() || process.env.PLATFORM_SALES_EMAIL?.trim() || "";
  const ref = kept?.ref ?? null;
  const due = kept ? longDate(kept.dueAt) : null;

  if (!kept && !contact) {
    console.warn("[site] a privacy request arrived, but it could not be kept and no privacy contact or PLATFORM_SALES_EMAIL is set — it went nowhere.");
    return { ok: false, error: "Your request couldn't be sent just now. Please try again in a few minutes, or write to us." };
  }

  try {
    await sendPlatformMail({
      type: "ACCOUNT",
      to: email,
      subject: oneLine(`We've received your privacy request${ref ? ` ${ref}` : ""}`),
      text: [
        `Dear ${name},`,
        "",
        `We've received your request: ${privacyKindLabel(kind)}.${ref ? ` Its reference is ${ref} — please quote it if you write to us about it.` : ""}`,
        due ? `We will reply by ${due} at the latest.` : "We will reply within 30 days.",
        relation === "user" || relation === "customer"
          ? `If the data is kept by ${company || "a company"} in its own Deskzo workspace, that company decides what happens to it; we'll tell you how to reach them, or pass your request on.`
          : "",
        "",
        "We may need to confirm it's you before we act on a request about your data.",
        contact ? `Questions: ${contact}` : "",
        "",
        `— ${settings.siteName}`,
      ]
        .filter((line, i, all) => line !== "" || all[i - 1] !== "")
        .join("\n"),
    });
  } catch (err) {
    console.error(`[site] a privacy request's acknowledgement could not be mailed: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  }

  if (contact) {
    try {
      await sendPlatformMail({
        type: "ALERTS",
        to: contact,
        subject: oneLine(`Privacy request${ref ? ` ${ref}` : ""}: ${privacyKindLabel(kind)} — ${name}`),
        text: [
          `Reply to: ${email}`,
          "(Sent by the website's privacy request form. Replying to this email does not reach them — write to the address above.)",
          kept ? "It is in the console's Privacy requests." : "It could not be kept in the console — this email is the only copy.",
          "",
          `Reference: ${ref ?? "—"}`,
          `Due:       ${due ?? "within 30 days"}`,
          `Request:   ${privacyKindLabel(kind)}`,
          `Name:      ${name}`,
          `Email:     ${email}`,
          `Who:       ${privacyRelationLabel(relation)}`,
          `Company:   ${company || "—"}`,
          "",
          message,
        ].join("\n"),
      });
    } catch (err) {
      console.error(`[site] a privacy request could not be mailed to the privacy contact: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
      if (!kept) return { ok: false, error: "Your request couldn't be sent just now. Please try again in a few minutes." };
    }
  }
  return { ok: true, ref };
}

/**
 * The cookie notice's answer (owner, 23 Oct 2026; src/components/site/cookie-notice.tsx): remembered for a
 * year in a cookie the page can read. Agreeing sets the partner referral cookie — when the programme has it
 * switched on and a partner's link brought the visitor (`ref`) — as the proxy would have, had it been
 * allowed to; declining takes back one set before. Nothing else on the site waits for consent.
 */
export async function setCookieConsent(input: { choice: string; ref?: string }): Promise<{ ok: true }> {
  const choice = input?.choice === "accepted" ? "accepted" : "declined";
  const jar = await cookies();
  const host = (await headers()).get("host") ?? "";
  const secure = protocolFor(host) === "https";
  jar.set(CONSENT_COOKIE, choice, { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: CONSENT_MAX_AGE });
  if (choice === "declined") {
    if (jar.has(REFERRAL_COOKIE)) jar.delete(REFERRAL_COOKIE);
    return answer;
  }
  const ref = text(input?.ref).trim();
  if (ref && isReferralCode(ref) && !jar.has(REFERRAL_COOKIE)) {
    const days = await referralCookieDays();
    if (days > 0) jar.set(REFERRAL_COOKIE, ref, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: days * 86_400 });
  }
  return answer;
}
