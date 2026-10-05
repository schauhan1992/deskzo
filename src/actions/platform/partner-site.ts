"use server";

import { headers } from "next/headers";
import { APPLICATION_LIMITS, type PartnerApplicationField, type PartnerApplicationInput, type PartnerApplicationResult } from "@/components/site/partners/application-fields";
import { clientIpFrom } from "@/lib/client-ip";
import { isDisposableDomain, parseEmailAddress } from "@/lib/email-verification";
import { COUNTRIES } from "@/lib/geo/countries";
import { partnerAudit } from "@/lib/partners/audit";
import { cleanWebsite, manyLines, oneLine } from "@/lib/partners/registry";
import { ApplicationRefused, recordApplication, type ApplicationInput } from "@/lib/partners/requests";
import { applicationsOpen } from "@/lib/partners/settings";
import { PartnerRefused } from "@/lib/partners/types";
import { addressKey, siteAllowance } from "@/lib/platform/find-workspaces";
import { sendPlatformMail } from "@/lib/platform/mailer";

/**
 * The public site's "Become a partner" form (src/app/platform-site/partners, spec §10) — for people
 * without an account anywhere, so nothing here needs one, and nothing here reads or writes a
 * workspace's data: an application is a row in the control plane (partner_applications), reviewed by
 * staff in the console, never the CMS's leads inbox.
 *
 * As the site's other forms (src/actions/platform/site.ts): a honeypot field (`website`) — a filled
 * one gets the normal answer and nothing else; checked before anything is counted, so a typo costs
 * nothing; limited per address (3 an hour), per caller only when its address is known (5), and in all
 * (50) — src/lib/platform/find-workspaces.ts siteAllowance. Refused while an owner has closed
 * applications (partners.applications). No email address is ever written to a log or the audit log.
 */

const answer = { ok: true } as const;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const errorCode = (err: unknown) => (err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error");
const UNAVAILABLE = "Your application couldn't be sent just now. Please try again in a few minutes.";
const L = APPLICATION_LIMITS;

type Checked = { ok: true; application: ApplicationInput; email: string; countryName: string } | { ok: false; field: PartnerApplicationField; error: string };

const refuse = (field: PartnerApplicationField, error: string): Checked => ({ ok: false, field, error });

/** The form's fields, checked the way recordApplication checks them — here first, so a refusal is counted against no limit. */
function check(input: PartnerApplicationInput): Checked {
  const companyName = oneLine(text(input?.companyName));
  if (companyName.length < 2 || companyName.length > L.company) return refuse("companyName", `Give your company's name (2 to ${L.company} characters).`);
  let website: string | null;
  try {
    website = cleanWebsite(text(input?.companyWebsite));
  } catch (err) {
    return refuse("companyWebsite", err instanceof PartnerRefused ? err.message : "That doesn't look like a website address.");
  }
  const country = COUNTRIES.find((c) => c.code === text(input?.country).trim().toUpperCase());
  if (!country) return refuse("country", "Choose your country.");
  const kindWanted = text(input?.kindWanted).trim().toUpperCase();
  if (kindWanted !== "RESELLER" && kindWanted !== "DISTRIBUTOR") return refuse("kindWanted", "Choose reseller or distributor.");
  const contactName = oneLine(text(input?.contactName));
  if (contactName.length < 2 || contactName.length > L.name) return refuse("contactName", `Give your name (2 to ${L.name} characters).`);
  const parsed = parseEmailAddress(text(input?.contactEmail));
  const email = parsed ? `${parsed.local}@${parsed.domain}` : "";
  if (!parsed || email.length > L.email) return refuse("contactEmail", "That doesn't look like an email address.");
  if (isDisposableDomain(parsed.domain)) return refuse("contactEmail", "Use your work address — throwaway addresses can't apply.");
  const contactPhone = oneLine(text(input?.contactPhone));
  if (contactPhone && (contactPhone.length > L.phone || !/^[+()\-.\s\d]+$/.test(contactPhone) || contactPhone.replace(/\D/g, "").length < 6)) {
    return refuse("contactPhone", "Enter a phone number, or leave it empty.");
  }
  const message = manyLines(text(input?.message));
  if (message.length < L.messageMin || message.length > L.message) return refuse("message", `Tell us about your company in ${L.messageMin} to ${L.message.toLocaleString("en-IN")} characters.`);
  return {
    ok: true,
    application: { companyName, website, country: country.code, kindWanted, contactName, contactEmail: email, contactPhone: contactPhone || null, message },
    email,
    countryName: country.name,
  };
}

/** Sales hears of it — PLATFORM_SALES_EMAIL (docs/runbook.md). Never throws: the application is already kept. */
async function mailSales(application: ApplicationInput, countryName: string): Promise<void> {
  const to = process.env.PLATFORM_SALES_EMAIL?.trim();
  if (!to) {
    console.warn("[site] a partner application arrived, but PLATFORM_SALES_EMAIL is not set — it was not mailed (docs/runbook.md); it is in the console's partner requests.");
    return;
  }
  try {
    await sendPlatformMail({
      type: "ALERTS",
      to,
      subject: oneLine(`Partner application: ${application.companyName}`),
      replyTo: application.contactEmail,
      text: [
        "A new application to the partner programme, from the website's \"Become a partner\" page.",
        "Review it in the console: Partners, then Requests, then Applications.",
        "",
        `Company:      ${application.companyName}`,
        `Website:      ${application.website ?? "—"}`,
        `Country:      ${countryName}`,
        `Wants to be:  ${application.kindWanted === "DISTRIBUTOR" ? "a distributor" : "a reseller"}`,
        `Name:         ${application.contactName}`,
        `Email:        ${application.contactEmail}`,
        `Phone:        ${application.contactPhone || "—"}`,
        "",
        application.message,
      ].join("\n"),
    });
  } catch (err) {
    console.error(`[site] a partner application could not be mailed: ${errorCode(err)}`);
  }
}

/**
 * "Become a partner": checked, limited, kept (recordApplication — with the caller's address only when
 * it is known), written to the partner audit (`application.submit`, by the website, belonging to no
 * partner, not visible to any), and mailed to sales. Once it is kept, a mail or audit row that fails
 * is logged and the applicant is still thanked.
 */
export async function applyToPartnerProgramme(input: PartnerApplicationInput): Promise<PartnerApplicationResult> {
  if (text(input?.website).trim()) return answer;

  let open: boolean;
  try {
    open = await applicationsOpen();
  } catch (err) {
    console.error(`[site] partner applications: the setting could not be read: ${errorCode(err)}`);
    return { ok: false, error: UNAVAILABLE };
  }
  if (!open) return { ok: false, error: "Applications are closed for now." };

  const checked = check(input);
  if (!checked.ok) return { ok: false, field: checked.field, error: checked.error };
  const { application, email, countryName } = checked;

  const ip = clientIpFrom(await headers());
  const allowed = siteAllowance([
    { key: `platform|partner-apply:${addressKey(email)}`, max: 3 },
    ...(ip ? [{ key: `platform|partner-apply-caller:${ip}`, max: 5 }] : []),
    { key: "platform|partner-apply:all", max: 50 },
  ]);
  if (!allowed) return { ok: false, error: "Several applications have been sent from here in the last hour. Please try again later." };

  let id: string;
  try {
    id = (await recordApplication(application, ip)).id;
  } catch (err) {
    if (err instanceof ApplicationRefused) return { ok: false, field: err.field === "website" ? "companyWebsite" : err.field, error: err.message };
    console.error(`[site] a partner application could not be kept: ${errorCode(err)}`);
    return { ok: false, error: UNAVAILABLE };
  }

  try {
    await partnerAudit({ kind: "public" }, null, "application.submit", "application", id, { company: application.companyName, kind: application.kindWanted, country: application.country }, { visibleToPartner: false });
  } catch (err) {
    console.error(`[site] a partner application was kept, but its audit row could not be written: ${errorCode(err)}`);
  }
  await mailSales(application, countryName);
  return answer;
}
