"use server";

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { isDisposableDomain, parseEmailAddress } from "@/lib/email-verification";
import { resolveSignupAttribution } from "@/lib/partners/attribution";
import { findActiveReferral, partnerInviteProblem } from "@/lib/partners/referrals";
import { controlDb } from "@/lib/platform/control-db";
import { createHandoffTicket } from "@/lib/platform/handoff";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { signupOpen } from "@/lib/platform/settings";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { inviteHold, judgeName, type InviteHold } from "@/lib/platform/name-rules";
import { ProvisioningRefused, startProvisioning } from "@/lib/platform/provisioning";
import { signupNameVerdict } from "@/lib/workspace-names";
import { lockoutState, recordFailure } from "@/lib/security/lockout";
import {
  CODE_ATTEMPTS_USED,
  CODE_EXPIRED,
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  codeShapeProblem,
  companyNameProblem,
  countryProblem,
  disposableEmailMessage,
  emailShapeProblem,
  firstIssue,
  ownerNameProblem,
  passwordProblem,
  slugRequiredProblem,
  wrongCodeMessage,
  type SignupIssueField,
  type SignupIssues,
} from "@/lib/signup-fields";
import { clientIpFrom } from "@/lib/client-ip";
import { protocolFor, requestHost } from "@/lib/tenancy/host";
import { newSignupCode, signupCodeMail } from "@/lib/platform/signup-code";
import { SIGNUP_BROWSER_MS } from "@/lib/console-shared/signup-browser";
import { subdomainHost } from "@/lib/tenancy/registry";
import { templateOf } from "@/lib/industry-templates/catalogue";

/**
 * Signing up for a workspace — the public site on the platform's own address (src/app/platform-site).
 *
 *   1. `startSignup`: the form. By invitation until staff open signup in the console (src/lib/
 *      platform/settings.ts); after that an invitation is optional, and names the plan when given.
 *      Refuses a disposable address, a name that is taken or reserved, a short password. Emails a
 *      six-digit code and remembers the browser (a cookie whose secret only this browser has).
 *   2. `verifySignup`: the code. Spends the invitation if there is one, reserves the name, queues
 *      the workspace on a free trial (src/lib/platform/provisioning.ts) and starts the worker.
 *   3. `signupProgress`: what the progress page polls. Once the workspace is up, it hands the owner
 *      a one-time pass to it — once, to this browser only — and the page follows it straight in.
 *
 * An invitation may hold an address for the customer it is for (made in the console): its signup gets
 * exactly that address — filled in and locked on the form (`heldAddress`) — without the signup rules,
 * and provisioning checks it again with the same hold. Nobody else may take it while it is open.
 *
 * Partners (src/lib/partners): a partner's invitation code works only while its partner is ACTIVE,
 * and a partner's referral code on the form must be live. Verifying works out which partner the
 * workspace belongs to (attribution.ts) and provisioning records it with the workspace.
 *
 * None of this touches a workspace's database: there is none yet. Attempts are limited per address
 * (src/lib/security/lockout.ts, under "platform|"), codes per signup.
 *
 * A refusal names every problem at once, field by field (`issues`, in the words of src/lib/signup-fields.ts
 * — the same rules the form runs as each field is left), with `formError` for what is no one field's: too
 * many attempts from here, or signup by invitation only and no code given. `error` repeats the first of
 * them, for callers that read one line. None of it says more than before: not whether an address already
 * owns a workspace, and not which way an invitation code is wrong.
 */

const COOKIE = "deskzo.signup";
const CODE_TTL_MS = CODE_TTL_MINUTES * 60_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type SignupResult<T = null> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** The first problem — kept for callers that read one line. */
      error: string;
      /** Every field's problem, in plain words. */
      issues?: SignupIssues;
      /** What isn't one field's: too many attempts, signup by invitation only with no code, an expired signup. */
      formError?: string;
    };

/** A refusal: every field's problem, and the form's own if there is one. */
function refused(issues: SignupIssues, formError?: string): { ok: false; error: string; issues: SignupIssues; formError?: string } {
  const first = firstIssue(issues);
  return { ok: false, error: formError ?? (first ? issues[first]! : "Check the form and try again."), issues, ...(formError ? { formError } : {}) };
}

/**
 * Signups are limited per caller — or, when the caller's address cannot be known (no trusted proxy,
 * src/lib/client-ip.ts), per address being signed up: one shared bucket would let anybody stop
 * everybody signing up.
 */
async function callerKey(email: string): Promise<string> {
  const ip = clientIpFrom(await headers());
  return ip ? `platform|signup:${ip}` : `platform|signup-email:${String(email ?? "").trim().toLowerCase()}`;
}

async function limited(email: string): Promise<string | null> {
  const key = await callerKey(email);
  const state = lockoutState([key]);
  if (state.lockedOut) return `Too many attempts from here. Try again in ${Math.ceil(state.retryInSeconds / 60)} minute(s).`;
  recordFailure([key]);
  return null;
}

/**
 * Signup's whole answer about an address: the rules for every workspace (pattern, platform addresses,
 * staff's blocks, reserved words, our name and competitors'), then what a business signing itself up
 * must also meet — eight letters at least, made from its registered name — and only then whether it
 * is free (src/lib/workspace-names.ts `signupNameVerdict`). With an invitation that holds an address
 * for its customer: that address exactly, without the signup rules.
 */
async function signupSlugProblem(slug: string, legalName: string, hold: InviteHold | null = null): Promise<string | null> {
  const verdict = await judgeName(slug, hold, (facts) => signupNameVerdict(slug, legalName, facts));
  return verdict.ok ? null : verdict.message;
}

/**
 * The live check beside the address field, against the registered name typed above it. Never with an
 * invitation's hold: an address held for the visitor is filled in and locked, and not checked live
 * (`heldAddress` is the one, limited, way to ask about a code).
 */
export async function checkWorkspaceName(input: string, legalName = ""): Promise<SignupResult<{ host: string }>> {
  const slug = String(input ?? "").trim().toLowerCase();
  const problem = await signupSlugProblem(slug, String(legalName ?? "").trim().slice(0, 120));
  return problem ? { ok: false, error: problem } : { ok: true, data: { host: subdomainHost(slug) } };
}

/** How often one caller, and the whole process, may ask which address a code holds — an hour at a time. */
const HELD_LOOKUPS = { perCaller: 30, all: 1000 } as const;

/**
 * The address an invitation code holds for its customer, for the form to fill in and lock — typed, or
 * from the signup link (`?invite=`). Only a live code that holds one is answered; anything else — a
 * wrong code, one used up, expired or ended, one that holds nothing, a partner's — is the same `null`,
 * so this says nothing about codes beyond what they hold. Limited per caller (when known) and for the
 * whole process, like the site's other lookups; past the limit the answer is `null` too, and signup
 * still works — `startSignup` names the held address if a different one is sent.
 */
export async function heldAddress(code: string): Promise<{ slug: string } | null> {
  const value = String(code ?? "").trim();
  if (value.length < 6 || value.length > 100) return null;
  const ip = clientIpFrom(await headers());
  const allowed = siteAllowance([...(ip ? [{ key: `platform|held-lookup-caller:${ip}`, max: HELD_LOOKUPS.perCaller }] : []), { key: "platform|held-lookup:all", max: HELD_LOOKUPS.all }]);
  if (!allowed) return null;
  const hold = await inviteHold(sha256(value));
  return hold ? { slug: hold.slug } : null;
}

export type SignupForm = {
  companyName: string;
  slug: string;
  ownerName: string;
  email: string;
  password: string;
  country: string;
  /** An industry template's key (src/lib/industry-templates/catalogue.ts), or empty for none. Optional, so a form without it still works. */
  industry?: string;
  invite: string;
  /** A partner's referral code — from a /signup?ref= link, the referral cookie, or typed. Optional, so a form without it still works. */
  referral?: string;
  referralVia?: "link" | "cookie" | "typed" | "";
};

const inviteRefusal = (open: boolean) =>
  open ? "That invitation code isn't valid — leave it empty to sign up without one." : "That invitation code isn't valid. Signing up is by invitation for now.";

async function inviteProblem(code: string, open: boolean): Promise<string | null> {
  const invite = await controlDb().signupInvite.findUnique({ where: { codeHash: sha256(code.trim()) } });
  if (!invite || invite.uses >= invite.maxUses || (invite.expiresAt && invite.expiresAt < new Date())) {
    return inviteRefusal(open);
  }
  // A partner's code works only while its partner is ACTIVE — refused in the same words.
  if (await partnerInviteProblem(invite.codeHash, new Date())) return inviteRefusal(open);
  return null;
}

const REFERRAL_VIA = ["link", "cookie", "typed"] as const;

export async function startSignup(form: SignupForm): Promise<SignupResult<{ email: string }>> {
  const slow = await limited(form.email);
  if (slow) return refused({}, slow);

  const companyName = String(form.companyName ?? "").trim();
  const ownerName = String(form.ownerName ?? "").trim();
  const slug = String(form.slug ?? "").trim().toLowerCase();
  const parsed = parseEmailAddress(form.email);
  const email = parsed ? { ...parsed, address: `${parsed.local}@${parsed.domain}` } : null;
  const country = WORLD_COUNTRIES.find((c) => c.code === String(form.country ?? "").toUpperCase());
  const password = String(form.password ?? "");

  // Every field is looked at, and every problem said at once.
  const issues: SignupIssues = {};
  const put = (field: SignupIssueField, problem: string | null) => {
    if (problem && !issues[field]) issues[field] = problem;
  };
  put("companyName", companyNameProblem(companyName));
  put("ownerName", ownerNameProblem(ownerName));
  put("email", emailShapeProblem(String(form.email ?? "")) ?? (email ? null : "That doesn't look like an email address — check it for a typo."));
  if (email && isDisposableDomain(email.domain)) put("email", disposableEmailMessage(email.domain));
  put("country", country ? null : countryProblem("", () => false));
  put("password", passwordProblem(password));
  const industryInput = String(form.industry ?? "").trim();
  const industry = industryInput ? templateOf(industryInput) : null;
  if (industryInput && !industry) put("industry", "Choose your kind of business from the list — or leave it for later.");
  // An invitation that holds an address for its customer: this signup gets exactly it, without the
  // signup rules. The registered name is still asked for, and kept — just not matched against it.
  const inviteCode = String(form.invite ?? "").trim();
  const hold = inviteCode ? await inviteHold(sha256(inviteCode)) : null;
  put("slug", slug ? await signupSlugProblem(slug, companyName, hold) : slugRequiredProblem(slug));
  // Without an invitation only once signup is open; one given is checked either way — and refused in
  // the same words whether it is mistyped, used up, expired or a suspended partner's.
  const open = await signupOpen();
  const formError = !open && !inviteCode ? "Signing up is by invitation for now — enter the code from your invitation." : undefined;
  if (inviteCode) put("invite", await inviteProblem(inviteCode, open));
  // A partner's code on the form must be live; an empty one is simply no partner code.
  const referralInput = String(form.referral ?? "").trim();
  const referral = referralInput ? await findActiveReferral(referralInput, new Date()) : null;
  if (referralInput && !referral) put("referral", "That partner code isn't valid — clear it to sign up without one.");
  if (formError || firstIssue(issues) || !email || !country) return refused(issues, formError);
  const referralVia = referral ? ((REFERRAL_VIA as readonly string[]).includes(String(form.referralVia)) ? String(form.referralVia) : "typed") : null;

  const code = newSignupCode();
  const secret = randomBytes(24).toString("base64url");
  const head = await headers();
  const pending = await controlDb().pendingSignup.create({
    data: {
      email: email.address,
      ownerName,
      companyName,
      slug,
      country: country.code,
      passwordHash: await bcrypt.hash(password, 10),
      inviteCodeHash: inviteCode ? sha256(inviteCode) : null,
      codeHash: sha256(code),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      browserSecretHash: sha256(secret),
      ip: clientIpFrom(head),
      referralCode: referral?.code ?? null,
      referralVia,
      industryTemplate: industry?.key ?? null,
    },
    select: { id: true },
  });

  const host = requestHost(head);
  (await cookies()).set(COOKIE, `${pending.id}.${secret}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: typeof host === "string" && protocolFor(host) === "https",
    // The signup's day: staff's "Send a new code" is offered for as long (src/lib/console-shared/signup-browser.ts).
    maxAge: SIGNUP_BROWSER_MS / 1000,
  });

  await sendPlatformMail({ type: "ACCOUNT", to: email.address, ...signupCodeMail({ ownerName, companyName, slug, code, minutes: CODE_TTL_MINUTES }) });
  return { ok: true, data: { email: email.address } };
}

/** The signup this browser started, when its cookie is genuine. */
async function thisBrowsersSignup() {
  const raw = (await cookies()).get(COOKIE)?.value ?? "";
  const [id, secret] = raw.split(".");
  if (!id || !secret) return null;
  const pending = await controlDb().pendingSignup.findUnique({ where: { id } });
  if (!pending) return null;
  const a = Buffer.from(pending.browserSecretHash);
  const b = Buffer.from(sha256(secret));
  return a.length === b.length && timingSafeEqual(a, b) ? pending : null;
}

const WORKER = path.join(process.cwd(), "scripts", "platform-worker.ts");
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

/**
 * The emailed code. What is wrong with it is said at the code field — wrong (with the tries left),
 * expired, or used up — and the form offers to send a new one (`startSignup` again). A code that isn't
 * six digits is refused without costing a try: it can't be the one.
 */
export async function verifySignup(input: string): Promise<SignupResult> {
  const pending = await thisBrowsersSignup();
  if (!pending) return refused({}, "This signup has expired — start again, and we'll send you a new code.");
  if (pending.verifiedAt) return { ok: true, data: null };
  if (pending.codeExpiresAt < new Date()) return refused({ code: CODE_EXPIRED });
  if (pending.attempts >= MAX_CODE_ATTEMPTS) return refused({ code: CODE_ATTEMPTS_USED });

  const code = String(input ?? "").replace(/\s+/g, "");
  const shape = codeShapeProblem(code);
  if (shape) return refused({ code: shape });
  if (sha256(code) !== pending.codeHash) {
    await controlDb().pendingSignup.update({ where: { id: pending.id }, data: { attempts: { increment: 1 } } });
    return refused({ code: wrongCodeMessage(MAX_CODE_ATTEMPTS - pending.attempts - 1) });
  }

  // The invitation is spent now — conditionally, so two signups on one single-use code get one workspace.
  const inviteCodeHash = pending.inviteCodeHash;
  if (inviteCodeHash) {
    const spent = await controlDb().$executeRaw`
      UPDATE "signup_invites" SET "uses" = "uses" + 1
      WHERE "codeHash" = ${inviteCodeHash} AND "uses" < "maxUses" AND ("expiresAt" IS NULL OR "expiresAt" > now())`;
    if (spent !== 1) return refused({}, "That invitation has been used in the meantime — ask for a new one.");
  } else if (!(await signupOpen())) {
    return refused({}, "Signing up is by invitation for now.");
  }

  const invite = inviteCodeHash ? await controlDb().signupInvite.findUnique({ where: { codeHash: inviteCodeHash }, select: { planKey: true } }) : null;
  // The address it holds, if any — though spending it may have just used it up, this signup is the one it was for.
  const hold = inviteCodeHash ? await inviteHold(inviteCodeHash, { open: false }) : null;
  let tenantId: string;
  try {
    // A partner's invitation whose partner is no longer ACTIVE is refused in the usual words — and goes back, below.
    if (inviteCodeHash && (await partnerInviteProblem(inviteCodeHash, new Date()))) throw new ProvisioningRefused(inviteRefusal(await signupOpen()));
    const now = new Date();
    const attribution = await resolveSignupAttribution({ inviteCodeHash, referralCode: pending.referralCode, email: pending.email, country: pending.country }, now);
    // The referral link is read again now: the plan it names applies when the invitation names none.
    const referral = pending.referralCode ? await findActiveReferral(pending.referralCode, now, pending.country) : null;
    ({ tenantId } = await startProvisioning({
      slug: pending.slug,
      companyName: pending.companyName,
      ownerName: pending.ownerName,
      ownerEmail: pending.email,
      ownerPasswordHash: pending.passwordHash,
      country: pending.country,
      planKey: invite?.planKey ?? referral?.planKey ?? null,
      attribution,
      hold,
      industryTemplate: pending.industryTemplate,
    }));
  } catch (err) {
    // The invitation goes back: nothing was made with it.
    if (inviteCodeHash) await controlDb().signupInvite.update({ where: { codeHash: inviteCodeHash }, data: { uses: { decrement: 1 } } });
    if (err instanceof ProvisioningRefused) return refused({}, err.message);
    throw err;
  }
  // The password now lives only on the job, which clears it once the owner exists.
  await controlDb().pendingSignup.update({ where: { id: pending.id }, data: { verifiedAt: new Date(), tenantId, passwordHash: "" } });

  // A worker for this job now, so nobody has to have set one up; a running one finds nothing left.
  try {
    spawn(process.execPath, [TSX_CLI, WORKER, "--once"], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
  } catch (err) {
    console.error("[signup] could not start the worker; a running one will take the job", err);
  }
  return { ok: true, data: null };
}

export type SignupProgress =
  | { state: "setting-up"; step: string }
  | { state: "ready"; url: string }
  | { state: "failed"; message: string }
  | { state: "gone" };

export async function signupProgress(): Promise<SignupProgress> {
  const pending = await thisBrowsersSignup();
  if (!pending?.tenantId) return { state: "gone" };
  const control = controlDb();
  const [tenant, job] = await Promise.all([
    control.tenant.findUnique({ where: { id: pending.tenantId }, select: { id: true, slug: true, status: true } }),
    control.provisioningJob.findFirst({ where: { tenantId: pending.tenantId }, orderBy: { createdAt: "desc" }, select: { status: true, step: true } }),
  ]);
  if (!tenant) return { state: "gone" };
  if (job?.status === "FAILED") return { state: "failed", message: job.step };
  if (tenant.status !== "ACTIVE") return { state: "setting-up", step: job?.step ?? "Waiting to start" };

  const host = subdomainHost(tenant.slug);
  const origin = `${protocolFor(host)}://${host}`;
  // The pass, once: a second look (a refresh) is sent to the sign-in page instead.
  const claimed = await control.pendingSignup.updateMany({ where: { id: pending.id, handedOffAt: null }, data: { handedOffAt: new Date() } });
  if (claimed.count !== 1) return { state: "ready", url: `${origin}/login` };
  const ticket = await createHandoffTicket(tenant.id, pending.email, "owner-signup");
  return { state: "ready", url: `${origin}/handoff?t=${encodeURIComponent(ticket)}` };
}
