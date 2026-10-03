import { parseEmailAddress } from "@/lib/email-verification";
import { MIN_SIGNUP_NAME } from "@/lib/workspace-names";

/**
 * Signup's field-by-field rules and what is said about each, in plain words that give the reason —
 * pure, so the form (src/components/platform/signup-flow.tsx) checks a field as it is left and
 * `startSignup` / `verifySignup` (src/actions/platform/signup.ts) say the same things about every
 * field at once. Outside src/lib/platform on purpose: client code may not import from there.
 *
 * Only what the visitor typed is talked about. Nothing here — or in the actions' other answers — says
 * whether an address already owns a workspace, or which way an invitation code is wrong.
 */

export const MIN_PASSWORD = 10;
export const MAX_NAME = 120;
export const CODE_LENGTH = 6;
export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;

export type SignupField = "companyName" | "slug" | "ownerName" | "email" | "password" | "country" | "industry" | "invite" | "referral";
export type SignupIssueField = SignupField | "code";
export type SignupIssues = Partial<Record<SignupIssueField, string>>;

/** The form's order, top to bottom: the first problem is the one focused, and the one `error` repeats. */
export const SIGNUP_FIELD_ORDER: readonly SignupIssueField[] = ["companyName", "slug", "ownerName", "email", "password", "country", "industry", "invite", "referral", "code"];

export const firstIssue = (issues: SignupIssues): SignupIssueField | null => SIGNUP_FIELD_ORDER.find((f) => issues[f]) ?? null;

const tooLong = (n: number) => `Keep it to ${MAX_NAME} characters — this one has ${n}.`;

export function companyNameProblem(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return "Enter your registered business name — exactly as on your GST registration or certificate of incorporation.";
  if (value.length < 2) return "That's too short for a registered business name — write it in full, like Acme Technologies Pvt Ltd.";
  return value.length > MAX_NAME ? tooLong(value.length) : null;
}

export function ownerNameProblem(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return "Enter your name — it goes on your account as the workspace's owner.";
  if (value.length < 2) return "Enter your full name — one letter isn't enough for your colleagues to know you by.";
  return value.length > MAX_NAME ? tooLong(value.length) : null;
}

/** What is wrong with an email address's shape — the reason, where one can be told. */
export function emailShapeProblem(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return "Enter your work email — your sign-in code is sent there.";
  if (/\s/.test(value)) return "An email address can't have spaces in it.";
  const ats = value.split("@").length - 1;
  if (ats === 0) return "An email address needs an @ — like name@yourcompany.com.";
  if (ats > 1) return "An email address has just one @.";
  const [local, domain] = value.split("@") as [string, string];
  if (!local) return "Add the part before the @ — like name@yourcompany.com.";
  if (!domain) return "Add your company's domain after the @ — like name@yourcompany.com.";
  if (!domain.includes(".")) return `"${domain}" is missing its ending, like .com or .in.`;
  if (value.length > 254) return "That address is too long to be a real one — check it for a paste accident.";
  return parseEmailAddress(value) ? null : "That doesn't look like an email address — check it for a typo.";
}

export const disposableEmailMessage = (domain: string) => `Use your work address — throwaway addresses like ${domain} can't own a workspace.`;

export function passwordProblem(raw: string): string | null {
  const value = String(raw ?? "");
  if (!value) return `Choose a password — at least ${MIN_PASSWORD} characters.`;
  return value.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters — this one has ${value.length}.` : null;
}

export function countryProblem(raw: string, known: (code: string) => boolean): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return value && known(value) ? null : "Choose the country your business is registered in.";
}

export function slugRequiredProblem(raw: string): string | null {
  return String(raw ?? "").trim() ? null : `Choose your address — at least ${MIN_SIGNUP_NAME} letters or digits, made from your registered name.`;
}

/** Only that one is needed: whether a code is any good is the server's to say, and it says it one way. */
export function inviteRequiredProblem(raw: string, required: boolean): string | null {
  return required && !String(raw ?? "").trim() ? "Enter the code from your invitation — signing up is by invitation for now." : null;
}

export function codeShapeProblem(raw: string): string | null {
  const value = String(raw ?? "").replace(/\s+/g, "");
  if (!value) return `Enter the ${CODE_LENGTH}-digit code from the email.`;
  if (!/^\d+$/.test(value)) return `The code is digits only — ${CODE_LENGTH} of them.`;
  return value.length === CODE_LENGTH ? null : `The code is ${CODE_LENGTH} digits — this one has ${value.length}.`;
}

export const CODE_EXPIRED = `That code has expired — codes work for ${CODE_TTL_MINUTES} minutes. Send yourself a new one.`;
export const CODE_ATTEMPTS_USED = `That's ${MAX_CODE_ATTEMPTS} wrong codes, so this one no longer works. Send yourself a new one.`;
export function wrongCodeMessage(triesLeft: number): string {
  if (triesLeft <= 0) return "That isn't the code we sent, and it was the last try — send yourself a new one.";
  return `That isn't the code we sent — check the latest email from us. ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`;
}

export type SignupFormValues = {
  companyName: string;
  slug: string;
  ownerName: string;
  email: string;
  password: string;
  country: string;
  invite: string;
};

/** The checks that need nothing but the form — what the browser runs before sending it. */
export function simpleSignupIssues(form: SignupFormValues, opts: { inviteRequired: boolean; countryKnown: (code: string) => boolean }): SignupIssues {
  const issues: SignupIssues = {};
  const put = (field: SignupIssueField, problem: string | null) => {
    if (problem) issues[field] = problem;
  };
  put("companyName", companyNameProblem(form.companyName));
  put("slug", slugRequiredProblem(form.slug));
  put("ownerName", ownerNameProblem(form.ownerName));
  put("email", emailShapeProblem(form.email));
  put("password", passwordProblem(form.password));
  put("country", countryProblem(form.country, opts.countryKnown));
  put("invite", inviteRequiredProblem(form.invite, opts.inviteRequired));
  return issues;
}
