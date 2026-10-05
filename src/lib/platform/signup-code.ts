import { createHash, randomInt } from "node:crypto";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { ConsoleRefused } from "@/lib/platform/refused";
import type { Staff } from "@/lib/platform/staff-session";
import { SIGNUP_BROWSER_MS } from "@/lib/console-shared/signup-browser";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";
import { COMPANY_NAME } from "@/lib/brand-names";

/**
 * The code that proves a signup's email address (src/actions/platform/signup.ts), and staff sending a
 * new one when the first never arrived (owner, 5 Oct 2026 — console › Signups, "Send a new code").
 *
 * Only a hash of a code is kept, so staff never see one: a new code replaces the old, with its tries
 * counted afresh, and goes to the address the signup was made with — no other. It is entered where
 * the person started, in the same browser (that browser alone follows the signup and is signed in at
 * the end), so it is only worth sending while that browser's signup lasts: a day. After that the
 * person signs up again.
 */

/** A code staff send lasts an hour — they're usually on the phone, and the person goes back to the page — never past the browser's day. */
export const RESENT_CODE_MS = 60 * 60_000;
/** Staff wait this long between new codes for one signup. */
export const RESEND_EVERY_MS = 2 * 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const newSignupCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** The code's email. `resent`: staff sent it — it says so, and where to enter it. */
export function signupCodeMail(input: { ownerName: string; companyName: string; slug: string; code: string; minutes: number; resent?: boolean }): { subject: string; logSubject: string; text: string } {
  const host = `${input.slug}.${PLATFORM_DOMAIN}`;
  const lasts = input.minutes >= 60 && input.minutes % 60 === 0 ? `${input.minutes / 60} hour${input.minutes === 60 ? "" : "s"}` : `${input.minutes} minutes`;
  return {
    subject: `Your code for ${host}: ${input.code}`,
    logSubject: `Your code for ${host}: ••••••`,
    text: input.resent
      ? [
          `Hello ${input.ownerName},`,
          "",
          `${COMPANY_NAME} support sent you a new code to finish setting up ${input.companyName}: ${input.code}`,
          "",
          `Enter it on the signup page, in the browser where you started. It works for ${lasts}; any code we sent before no longer does.`,
          "",
          "If you didn't ask for this, ignore it.",
        ].join("\n")
      : [`Hello ${input.ownerName},`, "", `Your code to finish setting up ${input.companyName} is ${input.code}.`, "", `It works for ${lasts}. If you didn't ask for this, ignore it.`].join("\n"),
  };
}

/**
 * A new code for a signup whose address was never confirmed, emailed to that address. Refused once
 * the address is confirmed, once the signing-up browser's day is over, or within two minutes of the
 * last one. Recorded in the audit log (`signup.code.resend`) — the code never is.
 */
export async function resendSignupCode(staff: Staff, signupId: string, now = new Date()): Promise<{ email: string; until: Date }> {
  const control = controlDb();
  const pending = await control.pendingSignup.findUnique({
    where: { id: String(signupId ?? "") },
    select: { id: true, email: true, ownerName: true, companyName: true, slug: true, verifiedAt: true, createdAt: true },
  });
  if (!pending) throw new ConsoleRefused("That signup no longer exists.");
  if (pending.verifiedAt) throw new ConsoleRefused("Their address is confirmed already — this signup doesn't need a code.");
  const browserEnds = pending.createdAt.getTime() + SIGNUP_BROWSER_MS;
  if (browserEnds - now.getTime() < 5 * 60_000) {
    throw new ConsoleRefused("Their signup page has run out (it lasts a day), so a code can't finish it. Ask them to sign up again — with the same invitation, if it still has uses.");
  }
  const last = await control.platformAuditLog.findFirst({
    where: { action: "signup.code.resend", at: { gt: new Date(now.getTime() - RESEND_EVERY_MS) }, detail: { path: ["signupId"], equals: pending.id } },
    select: { id: true },
  });
  if (last) throw new ConsoleRefused("A new code went to them a moment ago. Give it a couple of minutes to arrive.");

  const code = newSignupCode();
  const until = new Date(Math.min(now.getTime() + RESENT_CODE_MS, browserEnds));
  await control.pendingSignup.update({ where: { id: pending.id }, data: { codeHash: sha256(code), codeExpiresAt: until, attempts: 0 } });
  const mail = signupCodeMail({ ownerName: pending.ownerName, companyName: pending.companyName, slug: pending.slug, code, minutes: Math.max(1, Math.round((until.getTime() - now.getTime()) / 60_000)), resent: true });
  try {
    await sendPlatformMail({ type: "ACCOUNT", to: pending.email, ...mail });
  } catch {
    // The code that never went is no use to anybody; the person's earlier code (if any) has been replaced either way.
    throw new ConsoleRefused("The email couldn't be sent — the Mail log says why. Fix the mail account and try again.");
  }
  await control.platformAuditLog.create({ data: { actorKind: "STAFF", actor: staff.id, action: "signup.code.resend", detail: { signupId: pending.id, slug: pending.slug } } });
  return { email: pending.email, until };
}
