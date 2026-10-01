"use server";

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
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
import { ProvisioningRefused, SLUG_TAKEN, slugProblem, startProvisioning } from "@/lib/platform/provisioning";
import { signupNameProblem } from "@/lib/workspace-names";
import { lockoutState, recordFailure } from "@/lib/security/lockout";
import { clientIpFrom } from "@/lib/client-ip";
import { PLATFORM_DOMAIN, protocolFor, requestHost } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";

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
 * Partners (src/lib/partners): a partner's invitation code works only while its partner is ACTIVE,
 * and a partner's referral code on the form must be live. Verifying works out which partner the
 * workspace belongs to (attribution.ts) and provisioning records it with the workspace.
 *
 * None of this touches a workspace's database: there is none yet. Attempts are limited per address
 * (src/lib/security/lockout.ts, under "platform|"), codes per signup.
 */

const COOKIE = "wroffy.signup";
const CODE_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const MIN_PASSWORD = 10;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type SignupResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

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
 * Signup's whole answer about an address: the rules for every workspace (pattern, reserved, our name
 * and competitors'), then what a business signing itself up must also meet — eight letters at least,
 * made from its registered name (src/lib/workspace-names.ts) — and only then whether it is free.
 */
async function signupSlugProblem(slug: string, legalName: string): Promise<string | null> {
  const general = await slugProblem(slug);
  if (general && general !== SLUG_TAKEN) return general;
  return signupNameProblem(slug, legalName) ?? general;
}

/** The live check beside the address field, against the registered name typed above it. */
export async function checkWorkspaceName(input: string, legalName = ""): Promise<SignupResult<{ host: string }>> {
  const slug = String(input ?? "").trim().toLowerCase();
  const problem = await signupSlugProblem(slug, String(legalName ?? "").trim().slice(0, 120));
  return problem ? { ok: false, error: problem } : { ok: true, data: { host: subdomainHost(slug) } };
}

export type SignupForm = {
  companyName: string;
  slug: string;
  ownerName: string;
  email: string;
  password: string;
  country: string;
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
  if (slow) return { ok: false, error: slow };

  const companyName = String(form.companyName ?? "").trim();
  const ownerName = String(form.ownerName ?? "").trim();
  const slug = String(form.slug ?? "").trim().toLowerCase();
  const parsed = parseEmailAddress(form.email);
  const email = parsed ? { ...parsed, address: `${parsed.local}@${parsed.domain}` } : null;
  const country = WORLD_COUNTRIES.find((c) => c.code === String(form.country ?? "").toUpperCase());
  const password = String(form.password ?? "");

  if (companyName.length < 2 || companyName.length > 120) return { ok: false, error: "Give your registered business name." };
  if (ownerName.length < 2 || ownerName.length > 120) return { ok: false, error: "Give your name." };
  if (!email) return { ok: false, error: "That doesn't look like an email address." };
  if (isDisposableDomain(email.domain)) return { ok: false, error: "Use your work address — throwaway addresses can't own a workspace." };
  if (!country) return { ok: false, error: "Choose your country." };
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Choose a password of at least ${MIN_PASSWORD} characters.` };
  const nameProblem = await signupSlugProblem(slug, companyName);
  if (nameProblem) return { ok: false, error: nameProblem };
  // Without an invitation only once signup is open; one given is checked either way.
  const inviteCode = String(form.invite ?? "").trim();
  const open = await signupOpen();
  if (!open || inviteCode) {
    const badInvite = await inviteProblem(inviteCode, open);
    if (badInvite) return { ok: false, error: badInvite };
  }
  // A partner's code on the form must be live; an empty one is simply no partner code.
  const referralInput = String(form.referral ?? "").trim();
  const referral = referralInput ? await findActiveReferral(referralInput, new Date()) : null;
  if (referralInput && !referral) return { ok: false, error: "That partner code isn't valid — clear it to sign up without one." };
  const referralVia = referral ? ((REFERRAL_VIA as readonly string[]).includes(String(form.referralVia)) ? String(form.referralVia) : "typed") : null;

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
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
    },
    select: { id: true },
  });

  const host = requestHost(head);
  (await cookies()).set(COOKIE, `${pending.id}.${secret}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: typeof host === "string" && protocolFor(host) === "https",
    maxAge: 24 * 60 * 60,
  });

  await sendPlatformMail({
    to: email.address,
    subject: `Your code for ${slug}.${PLATFORM_DOMAIN}: ${code}`,
    text: [`Hello ${ownerName},`, "", `Your code to finish setting up ${companyName} is ${code}.`, "", "It works for 15 minutes. If you didn't ask for this, ignore it."].join("\n"),
  });
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

export async function verifySignup(input: string): Promise<SignupResult> {
  const pending = await thisBrowsersSignup();
  if (!pending) return { ok: false, error: "This signup has expired. Start again." };
  if (pending.verifiedAt) return { ok: true, data: null };
  if (pending.attempts >= MAX_CODE_ATTEMPTS || pending.codeExpiresAt < new Date()) return { ok: false, error: "That code has expired. Start again." };

  const code = String(input ?? "").replace(/\s+/g, "");
  if (sha256(code) !== pending.codeHash) {
    await controlDb().pendingSignup.update({ where: { id: pending.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: "That isn't the code we sent." };
  }

  // The invitation is spent now — conditionally, so two signups on one single-use code get one workspace.
  const inviteCodeHash = pending.inviteCodeHash;
  if (inviteCodeHash) {
    const spent = await controlDb().$executeRaw`
      UPDATE "signup_invites" SET "uses" = "uses" + 1
      WHERE "codeHash" = ${inviteCodeHash} AND "uses" < "maxUses" AND ("expiresAt" IS NULL OR "expiresAt" > now())`;
    if (spent !== 1) return { ok: false, error: "That invitation has been used in the meantime." };
  } else if (!(await signupOpen())) {
    return { ok: false, error: "Signing up is by invitation for now." };
  }

  const invite = inviteCodeHash ? await controlDb().signupInvite.findUnique({ where: { codeHash: inviteCodeHash }, select: { planKey: true } }) : null;
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
    }));
  } catch (err) {
    // The invitation goes back: nothing was made with it.
    if (inviteCodeHash) await controlDb().signupInvite.update({ where: { codeHash: inviteCodeHash }, data: { uses: { decrement: 1 } } });
    if (err instanceof ProvisioningRefused) return { ok: false, error: err.message };
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
