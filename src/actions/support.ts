"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";
import type { Prisma } from "@wroffy/control-client";
import { auth } from "@/lib/auth";
import { clientIpFrom } from "@/lib/client-ip";
import { throttle } from "@/lib/security/throttle";
import { acknowledgementMail, deliver, notificationMail, type RequestMailFacts } from "@/lib/support/mail";
import { SupportRefused } from "@/lib/support/refused";
import { resolveRequester, type RequesterResult } from "@/lib/support/requester";
import { cleanSubmission, createSupportRequest, stagedAttachments, type CleanClientContext } from "@/lib/support/requests";
import { cachedSupportConfig } from "@/lib/support/settings";
import { SUPPORT_EMAIL_PLACEHOLDER, type LauncherState, type PerfSnapshot, type SupportContact, type SupportSubmitInput, type SupportSubmitResult } from "@/lib/support/types";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Contact Support, from inside a workspace: the button's state for the dashboard layout, and sending
 * a request. The platform's support desk — not the workspace's own helpline (src/actions/help.ts),
 * which its admins set for their own people.
 *
 * Who may ask, and whether recording is offered, is src/lib/support/requester.ts. Requests are kept in
 * the control plane and answered from the console's Support page; the files were uploaded beforehand
 * (src/app/api/support/uploads/route.ts) and are claimed here.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PER_USER_PER_HOUR = 5;
const PER_WORKSPACE_PER_DAY = 40;
const THROTTLED = "You've sent several requests recently — please wait a few minutes, or call the helpline.";
const FAILED = "Your request couldn't be sent just now. Please try again in a minute, or call the helpline.";

/** Somebody signed in first — as every action checks — then the rules of src/lib/support/requester.ts. */
async function asker(fresh: boolean): Promise<RequesterResult> {
  if (!(await auth())?.user) return { ok: false, status: 401, error: "Sign in first." };
  return resolveRequester({ fresh });
}

/**
 * What the launcher needs, or null — nothing rendered — for nobody signed in, a view-as, a support
 * account, support switched off, no control plane, or a control plane that isn't answering. Never
 * throws and never waits long: the settings come from a minute-long shared copy with a 1.5 s limit.
 */
export async function supportLauncherState(): Promise<LauncherState | null> {
  try {
    const who = await asker(false);
    if (!who.ok) return null;
    const { user, config, recording } = who.requester;
    return {
      email: user.email,
      phone: user.phone,
      helpline: config.helpline,
      hours: config.hours,
      recordingAllowed: recording.allowed,
      recordingBlockedReason: recording.blockedReason,
      brandName: config.brandName,
    };
  } catch {
    return null;
  }
}

/**
 * The platform's support contact, as a workspace shows it: the dashboard's greeting and the Help panel
 * on the rail. From the console's Support settings, the same for every workspace — the vendor's desk,
 * not the customer's own (which is why the workspace's old helpline, src/actions/help.ts, is no longer
 * shown). Null when support is switched off, when there is neither a number nor a real address, or when
 * the settings can't be read. Never throws.
 */
export async function getSupportContact(): Promise<SupportContact | null> {
  try {
    const session = await auth();
    if (!session?.user) return null;
    const config = await cachedSupportConfig();
    if (!config?.enabled) return null;
    // The placeholder is the console's reminder to set one, not an address to give customers.
    const email = config.email !== SUPPORT_EMAIL_PLACEHOLDER ? config.email : null;
    if (!config.helpline && !email) return null;
    return { label: `${config.brandName} Support`, phone: config.helpline, hours: config.hours, languages: config.languages, email };
  } catch {
    return null;
  }
}

/** The running build, when there is one to name: the package version and Next's build id. Never throws. */
async function appVersion(): Promise<string | null> {
  const version = process.env.npm_package_version?.trim() || null;
  let build: string | null = null;
  try {
    const id = (await readFile(path.join(process.cwd(), process.env.NEXT_DIST_DIR?.trim() || ".next", "BUILD_ID"), "utf8")).trim();
    build = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    // `next dev` writes none.
  }
  const parts = [version, build ? `build ${build}` : null].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** What the server knows, beside what the browser said (capped) — the request's `context`. */
function contextOf(args: {
  workspace: { id: string; slug: string; name: string };
  user: { id: string; name: string; email: string; role: string };
  appVersion: string | null;
  client: CleanClientContext;
  perf: PerfSnapshot | null;
}): Prisma.InputJsonValue {
  return {
    v: 1,
    workspace: args.workspace,
    user: args.user,
    appVersion: args.appVersion,
    ...args.client,
    ...(args.perf ? { perf: args.perf } : {}),
  };
}

/**
 * Sends a request: checked, throttled (5 an hour per person, 40 a day per workspace), written with
 * its attachments, and announced by two emails — an acknowledgement to the person, a notification to
 * the support address. A mail that fails never fails the request. Returns its number and the address
 * the answer will go to.
 */
export async function submitSupportRequest(input: SupportSubmitInput): Promise<SupportSubmitResult> {
  try {
    const who = await asker(true);
    if (!who.ok) return { ok: false, error: who.error };
    const { tenant, user, config, recording } = who.requester;

    const sent = cleanSubmission(input);
    if (sent.recording && !recording.allowed) {
      throw new SupportRefused(
        recording.blockedReason === "dlp" ? "Your organisation's security settings don't allow screen recording." : "Screen recording isn't available right now — attach a screenshot instead.",
        403,
      );
    }

    // Counted per person first, so one person's burst doesn't use up the whole workspace's day.
    const mine = throttle(`${await tenantKey()}|support-submit:${user.id}`, HOUR_MS);
    if (!mine.write && mine.suppressedSince >= PER_USER_PER_HOUR) throw new SupportRefused(THROTTLED, 429);
    const ours = throttle(`${await tenantKey()}|support-submit`, DAY_MS);
    if (!ours.write && ours.suppressedSince >= PER_WORKSPACE_PER_DAY) throw new SupportRefused(THROTTLED, 429);

    const attachments = await stagedAttachments(tenant.id, user.id, sent.uploadIds, sent.recording);
    const context = contextOf({
      workspace: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      appVersion: await appVersion(),
      client: sent.client,
      perf: sent.recording?.perf ?? null,
    });
    const created = await createSupportRequest({
      tenantId: tenant.id,
      requester: { userId: user.id, name: user.name, email: user.email, role: user.role },
      mobile: sent.mobile,
      subject: sent.subject,
      body: sent.body,
      priority: sent.priority,
      context,
      consoleLog: sent.recording ? sent.recording.consoleLog : null,
      recordingConsentAt: sent.recording ? new Date() : null,
      ip: clientIpFrom(await headers()),
      attachments,
    });

    const facts: RequestMailFacts = {
      number: created.number,
      subject: sent.subject,
      body: sent.body,
      priority: sent.priority,
      requester: { name: user.name, email: user.email, role: user.role, mobile: sent.mobile },
      workspace: { name: tenant.name, slug: tenant.slug },
      files: attachments.filter((a) => a.kind === "FILE").length,
      recording: attachments.some((a) => a.kind === "RECORDING"),
      brandName: config.brandName,
      supportEmail: config.email,
      helpline: config.helpline,
      hours: config.hours,
    };
    // Awaited, so the dialog's "we've emailed a copy" is true when it can be — but `deliver` never throws.
    await Promise.all([deliver(acknowledgementMail(facts), "acknowledgement", created.number), deliver(notificationMail(facts), "notification", created.number)]);

    return { ok: true, number: created.number, email: user.email };
  } catch (err) {
    if (err instanceof SupportRefused) return { ok: false, error: err.message };
    // Ids only: what somebody wrote to support never goes to the log.
    console.error(`[support] a request could not be sent: ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, error: FAILED };
  }
}
