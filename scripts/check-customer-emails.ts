/**
 * check:customer-emails — what a workspace's customers get by email, and what stops it (owner, 18 Oct
 * 2026): src/lib/customer-emails.ts, Settings › Customer emails.
 *
 *   · Reminders follow the customer's own choices, business mail doesn't: unsubscribed from everything,
 *     suppressed by hand, or the topic unticked stops a renewal reminder or a workflow's email — never an
 *     invoice, a ticket reply or a meeting invitation. A bounce, a spam complaint or a reseller's customer
 *     stops everything.
 *   · The preference page shows reminders ticked until they're turned off, a box left ticked records
 *     nothing, and an opt-out saved on it before it showed them honestly isn't held against anybody.
 *   · Support mail is screened like the rest: the acknowledgement and replies; somebody copied who can't
 *     be is left off. Meetings in a connected calendar are screened as Deskzo's own are.
 *   · The page: every customer email, automatic or by hand, where it's sent from; switches for the
 *     ticket acknowledgement, the booking invitation and each workflow that emails customers — only for
 *     whoever changes settings, never while viewing as somebody else, audited.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:customer-emails
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { canSend, type RecipientState, type SendContext } from "../src/lib/marketing/suppression";
import { REMINDER_OPT_OUTS_FROM, REMINDER_TOPICS, countsAsOptOut } from "../src/lib/marketing/topics";
import type { PlatformMail } from "../src/lib/platform/mailer";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
let viewingAs = false;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ── Without a database ──────────────────────────────────────────────────────────────────────────

const LIMITS = { maxPerContactPerWeek: 3, overdueDaysBlock: 0, requireVerifiedAddress: false };
const state = (over: Partial<RecipientState> = {}): RecipientState => ({
  company: { managedByResellerId: null },
  contact: { email: "zz@acme.in", phone: null, emailStatus: "UNKNOWN", emailCheckedValue: null },
  suppressions: [],
  consent: null,
  signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
  ...over,
});
const business: SendContext = { messageClass: "TRANSACTIONAL", channel: "EMAIL", topic: "SERVICE", limits: LIMITS };
const reminder: SendContext = { ...business, topic: "RENEWALS", optOuts: true };

function pure() {
  section("1. Reminders follow the customer's choices; business mail doesn't");
  const unsubscribed = state({ suppressions: [{ reason: "UNSUBSCRIBED" }] });
  const handSuppressed = state({ suppressions: [{ reason: "MANUAL" }] });
  const optedOut = state({ consent: { status: "UNSUBSCRIBED" } });
  ok("an invoice, a ticket reply, a meeting: unsubscribed, suppressed by hand or opted out of the topic, it still goes", canSend(unsubscribed, business).ok && canSend(handSuppressed, business).ok && canSend(optedOut, { ...business, topic: "RENEWALS" }).ok);
  const u = canSend(unsubscribed, reminder);
  ok("a reminder: not to somebody unsubscribed from everything", !u.ok && u.reason === "UNSUBSCRIBED" && u.detail.includes("everything"), u.ok ? "" : u.detail);
  ok("  nor somebody suppressed here by hand", !canSend(handSuppressed, reminder).ok);
  const o = canSend(optedOut, reminder);
  ok("  nor somebody who unticked its topic", !o.ok && o.reason === "NO_CONSENT", o.ok ? "" : o.detail);
  ok("  but no opt-in is asked for, unlike marketing", canSend(state(), reminder).ok && !canSend(state(), { ...reminder, messageClass: "MARKETING" }).ok);
  ok("  and not one of the hard stops is soft", ["HARD_BOUNCE", "COMPLAINT"].every((reason) => !canSend(state({ suppressions: [{ reason: reason as never }] }), business).ok) && !canSend(state({ company: { managedByResellerId: "zz" } }), business).ok);
  const findings = canSend(unsubscribed, reminder);
  ok("  a choice of theirs is a soft stop — a workflow finishes without sending, rather than failing", !findings.ok && findings.findings.every((f) => !f.hard));

  section("2. Which opt-outs count");
  const at = (iso: string) => new Date(iso);
  const after = new Date(REMINDER_OPT_OUTS_FROM.getTime() + 60_000);
  const before = new Date(REMINDER_OPT_OUTS_FROM.getTime() - 60_000);
  ok("reminders: renewal reminders and service notices", [...REMINDER_TOPICS].sort().join() === "RENEWALS,SERVICE");
  ok("turned off on the preference page since it showed reminders honestly: counts", countsAsOptOut({ status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: after }));
  ok("  before it, when every box showed unticked: doesn't", !countsAsOptOut({ status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: before }) && !countsAsOptOut({ status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: null }));
  ok("  any other way — an import, a campaign's unsubscribe link — whenever: counts", countsAsOptOut({ status: "UNSUBSCRIBED", source: "IMPORT", withdrawnAt: at("2026-01-01T00:00:00Z") }) && countsAsOptOut({ status: "UNSUBSCRIBED", source: "CAMPAIGN_LINK", withdrawnAt: before }));
  ok("  subscribed or pending never does", !countsAsOptOut({ status: "SUBSCRIBED", source: "IMPORT", withdrawnAt: null }) && !countsAsOptOut({ status: "PENDING", source: "FORM", withdrawnAt: null }));

  section("3. Where the rules are asked");
  const notice = read("src/lib/marketing/order-notice.ts");
  ok("the renewal reminder asks for opt-outs; the confirmations don't", notice.includes(`const optOuts = kind === "RENEWAL";`) && notice.includes("      optOuts,"));
  ok("the shipped renewal workflow is a renewal reminder", /topic: "RENEWALS"/.test(read("src/lib/automate/templates.ts")));
  ok("a workflow's email asks for opt-outs", read("src/lib/automate/actions/email-send.ts").includes("optOuts: true"));
  ok("support mail is screened", read("src/lib/support-mail/send.ts").includes("await screenAddresses([input.to, ...cc])"));
  const meetings = read("src/lib/calendar/meetings.ts");
  ok("a connected calendar's meetings are screened, new and moved", (meetings.match(/refusalAmong\(await screenInvitees\(/g) ?? []).length === 2);
}

// ── In a scratch workspace ──────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_custemails`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    process.env.INBOUND_MAIL_DOMAIN = "tickets.zzcustemails.test";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const publicActions = require("../src/actions/marketing-public") as typeof import("../src/actions/marketing-public");
    const { resolveRecipients, marketingSettings } = require("../src/lib/marketing/pipeline") as typeof import("../src/lib/marketing/pipeline");
    const { sendSupportEmail } = require("../src/lib/support-mail/send") as typeof import("../src/lib/support-mail/send");
    const bookingServer = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
    const actions = require("../src/actions/customer-emails") as typeof import("../src/actions/customer-emails");
    const lib = require("../src/lib/customer-emails") as typeof import("../src/lib/customer-emails");
    const settings = require("../src/lib/customer-email-settings") as typeof import("../src/lib/customer-email-settings");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const caught: PlatformMail[] = [];
    mailer.setTestPlatformMailer(async (m) => void caught.push(m));

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-custemails.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const member = await person("Zz Member");
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = null;
      });
    };
    ok("the admin changes the workspace's settings; the member doesn't", (await can(boss.id, "settings.manage")) && !(await can(member.id, "settings.manage")));
    const acme = await db.company.create({ data: { name: "Zz Acme", normalizedName: "zz acme", createdById: boss.id }, select: { id: true } });
    const contact = (name: string, email: string) => db.contact.create({ data: { companyId: acme.id, name, email }, select: { id: true, preferenceToken: true } });

    section("4. The preference page");
    const priya = await contact("Priya Zz", "priya@zz-acme.in");
    const token = priya.preferenceToken ?? (await db.contact.update({ where: { id: priya.id }, data: { preferenceToken: "zz-pref-priya-0000000000000000000000000000" }, select: { preferenceToken: true } })).preferenceToken!;
    const prefs = await publicActions.getPreferences(token);
    const topic = (key: string) => prefs?.topics.find((t) => t.key === key);
    ok("reminders show ticked until turned off", topic("RENEWALS")?.subscribed === true && topic("SERVICE")?.subscribed === true && topic("RENEWALS")?.reminder === true);
    ok("  news and offers only when opted into", topic("NEWSLETTER")?.subscribed === false && topic("OFFERS")?.subscribed === false && topic("OFFERS")?.reminder === false);
    await publicActions.updatePreferences({ token, topics: ["RENEWALS", "SERVICE", "NEWSLETTER"] });
    const rows = await db.contactConsent.findMany({ where: { contactId: priya.id }, select: { topic: true, status: true } });
    const statusOf = (t: string) => rows.find((r) => r.topic === t)?.status ?? null;
    ok("saved with the reminders left ticked: nothing recorded for them — no opt-in from a box ticked by default", statusOf("RENEWALS") === null && statusOf("SERVICE") === null, rows);
    ok("  the newsletter ticked is an opt-in; the rest unticked are opted out", statusOf("NEWSLETTER") === "SUBSCRIBED" && statusOf("OFFERS") === "UNSUBSCRIBED");
    const sendTo = async (contactId: string, topicKey: "RENEWALS" | "SERVICE", optOuts = true) =>
      (await resolveRecipients({ contactIds: [contactId], channel: "EMAIL", topic: topicKey, messageClass: "TRANSACTIONAL", settings: await marketingSettings(), optOuts }))[0]?.verdict;
    ok("  so their renewal reminders still go", (await sendTo(priya.id, "RENEWALS"))?.ok === true);
    await publicActions.updatePreferences({ token, topics: ["SERVICE", "NEWSLETTER"] });
    const renewalVerdict = await sendTo(priya.id, "RENEWALS");
    ok("renewal reminders unticked: none sent", renewalVerdict?.ok === false && renewalVerdict.reason === "NO_CONSENT", renewalVerdict);
    ok("  service notices still go", (await sendTo(priya.id, "SERVICE"))?.ok === true);
    ok("  and business mail still goes", (await sendTo(priya.id, "RENEWALS", false))?.ok === true);
    ok("  the page shows it unticked", (await publicActions.getPreferences(token))?.topics.find((t) => t.key === "RENEWALS")?.subscribed === false);
    await publicActions.updatePreferences({ token, topics: ["RENEWALS", "SERVICE", "NEWSLETTER"] });
    ok("ticked again: they're sent again", (await sendTo(priya.id, "RENEWALS"))?.ok === true && (await db.contactConsent.findFirst({ where: { contactId: priya.id, topic: "RENEWALS" }, select: { status: true } }))?.status === "SUBSCRIBED");
    await publicActions.unsubscribeAll(token);
    ok("unsubscribed from everything: no reminder of either kind", (await sendTo(priya.id, "RENEWALS"))?.ok === false && (await sendTo(priya.id, "SERVICE"))?.ok === false);
    ok("  business mail still goes", (await sendTo(priya.id, "SERVICE", false))?.ok === true);
    ok("  and the page shows the reminders unticked", (await publicActions.getPreferences(token))?.topics.filter((t) => t.reminder).every((t) => !t.subscribed) === true);
    const legacy = await contact("Legacy Zz", "legacy@zz-acme.in");
    await db.contactConsent.create({ data: { contactId: legacy.id, topic: "RENEWALS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date(REMINDER_OPT_OUTS_FROM.getTime() - 86_400_000) } });
    ok("renewal reminders left unticked on the page before it showed them honestly: still sent", (await sendTo(legacy.id, "RENEWALS"))?.ok === true);
    const page = read("src/components/marketing/preference-centre.tsx");
    ok("  the page says business mail still comes, whatever they choose", page.includes("still reaches you: an invoice or") && page.includes("Reminders about what you have with us"));

    section("5. Support mail, screened");
    const ticket = await db.ticket.create({ data: { companyId: acme.id, title: "Zz printer", createdByUserId: boss.id }, select: { id: true, ticketSeq: true, title: true } });
    await contact("Bounced Zz", "bounced@zz-acme.in");
    await db.suppression.create({ data: { scope: "EMAIL", value: "bounced@zz-acme.in", reason: "HARD_BOUNCE" } });
    await db.suppression.create({ data: { scope: "EMAIL", value: "spam@zz-acme.in", reason: "COMPLAINT" } });
    const before = caught.length;
    const toBounced = await sendSupportEmail({ ticket, to: "bounced@zz-acme.in", body: "We've opened your ticket.", sentByUserId: null });
    const kept = await db.supportEmail.findFirst({ where: { ticketId: ticket.id, toAddresses: { has: "bounced@zz-acme.in" } }, select: { state: true, note: true } });
    ok("an acknowledgement to an address that bounced isn't sent", !toBounced.ok && caught.length === before && toBounced.error.includes("bounced"), toBounced.ok ? "SENT" : toBounced.error);
    ok("  it's kept on the ticket as not sent, with the reason", kept?.state === "FAILED" && !!kept.note?.includes("bounced"), kept);
    const reply = await sendSupportEmail({ ticket, to: "priya@zz-acme.in", cc: ["spam@zz-acme.in", "ravi@zz-acme.in"], body: "Fixed now.", sentByUserId: boss.id });
    const replyMail = caught.at(-1);
    ok("a reply goes to the customer — business they're part of, whatever they unsubscribed from", reply.ok && replyMail?.to === "priya@zz-acme.in", reply.ok ? "" : reply.error);
    ok("  somebody copied who reported spam is left off; the others copied", JSON.stringify(replyMail?.cc) === JSON.stringify(["ravi@zz-acme.in"]), replyMail?.cc);
    const replyRow = await db.supportEmail.findFirst({ where: { ticketId: ticket.id, state: "SENT" }, orderBy: { createdAt: "desc" }, select: { note: true, ccAddresses: true } });
    ok("  and the email says so", !!replyRow?.note?.includes("Not copied to spam@zz-acme.in") && JSON.stringify(replyRow.ccAddresses) === JSON.stringify(["ravi@zz-acme.in"]), replyRow?.note);
    const reseller = await db.company.create({ data: { name: "Zz Reseller", normalizedName: "zz reseller", createdById: boss.id }, select: { id: true } });
    const theirs = await db.company.create({ data: { name: "Zz Their Customer", normalizedName: "zz their customer", createdById: boss.id, managedByResellerId: reseller.id }, select: { id: true } });
    await db.contact.create({ data: { companyId: theirs.id, name: "Theirs Zz", email: "theirs@zz-other.in" } });
    const toTheirs = await sendSupportEmail({ ticket, to: "theirs@zz-other.in", body: "Hello", sentByUserId: boss.id });
    ok("  nor to a reseller's customer", !toTheirs.ok && toTheirs.error.toLowerCase().includes("reseller"), toTheirs.ok ? "SENT" : toTheirs.error);

    section("6. The booking invitation switch");
    const host = await person("Zz Host");
    const allWeek = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((d) => [d, [["00:00", "23:30"]]]));
    await db.bookingPage.create({ data: { slug: "zz-custemails", title: "Intro call", durationMinutes: 30, hostUserIds: [host.id], hours: allWeek, daysAhead: 7, minNoticeHours: 0, bufferMinutes: 0, online: false, active: true, createdById: boss.id } });
    const now = new Date();
    const slots = (await bookingServer.publicBookingPage("zz-custemails", now))?.days.flatMap((d) => d.slots) ?? [];
    ok("(the page offers times)", slots.length > 2, slots.length);
    const invitedBefore = caught.length;
    const first = await bookingServer.bookSlot("zz-custemails", { start: slots[1]!, name: "Meera Zz", email: "meera@zz-guest.in" }, "198.51.100.21", now);
    ok("on by default: the guest is emailed an invitation", first.ok && first.invited && first.invites && caught.slice(invitedBefore).some((m) => m.to === "meera@zz-guest.in" || m.moreTo?.includes("meera@zz-guest.in")), JSON.stringify(first));
    const offRefused = await as(member, () => actions.setCustomerEmailSwitch({ kind: "booking", on: false }));
    ok("somebody who doesn't change settings can't switch it off", !offRefused.ok && (await settings.bookingInvitesOn()));
    viewingAs = true;
    const masked = await as(boss, () => actions.setCustomerEmailSwitch({ kind: "booking", on: false }));
    viewingAs = false;
    ok("  nor an admin viewing as somebody else", !masked.ok && (await settings.bookingInvitesOn()));
    const off = await as(boss, () => actions.setCustomerEmailSwitch({ kind: "booking", on: false }));
    ok("the admin switches it off, audited", off.ok && !(await settings.bookingInvitesOn()) && (await db.auditLog.count({ where: { entityType: "CustomerEmailSettings", userId: boss.id } })) === 1);
    const quietBefore = caught.length;
    const second = await bookingServer.bookSlot("zz-custemails", { start: slots[3]!, name: "Ravi Zz", email: "ravi@zz-guest.in" }, "198.51.100.22", now);
    const bookedId = (await db.booking.findFirst({ where: { email: "ravi@zz-guest.in" }, select: { calendarEventId: true } }))?.calendarEventId;
    const event = bookedId ? await db.calendarEvent.findUnique({ where: { id: bookedId }, select: { attendees: true, description: true } }) : null;
    ok("off: the time is booked, and the guest isn't emailed", second.ok && !second.invited && !second.invites && !caught.slice(quietBefore).some((m) => JSON.stringify(m).includes("ravi@zz-guest.in")), JSON.stringify(second));
    ok("  it's in the host's calendar with the guest's details, nobody invited", !!event && JSON.stringify(event.attendees ?? []) === "[]" && !!event.description?.includes("ravi@zz-guest.in"), event);
    ok("  and the page tells them so", read("src/components/booking/booking-widget.tsx").includes("It's in ${done.host}'s calendar."));
    await as(boss, () => actions.setCustomerEmailSwitch({ kind: "booking", on: true }));

    section("7. The page");
    const view = await as(boss, () => actions.getCustomerEmails());
    const keys = view.ok ? view.data.rows.map((r) => r.key) : [];
    ok("every customer email this workspace's modules send", view.ok && ["ticket-acknowledgement", "booking-invitation", "journeys", "documents", "order-notices", "ticket-replies", "meetings", "form-invitations", "campaigns"].every((k) => keys.includes(k)), keys);
    const row = (key: string) => (view.ok ? view.data.rows.find((r) => r.key === key) : undefined);
    ok("  the automatic ones with their switch, on", row("ticket-acknowledgement")?.automatic === true && row("ticket-acknowledgement")?.toggle?.on === true && row("booking-invitation")?.toggle?.kind === "booking");
    ok("  the ones a person sends without one", ["documents", "ticket-replies", "meetings", "order-notices"].every((k) => row(k)?.automatic === false && row(k)?.toggle === null));
    ok("  each with what stops it", row("documents")?.stops === "hard" && row("form-invitations")?.stops === "choices" && row("campaigns")?.stops === "marketing");
    ok("  with no mail server set up, it says so", view.ok && view.data.companyServer === null && !!row("order-notices")?.from.includes("aren't sent"));
    ok("somebody who doesn't change settings can't read it", !(await as(member, () => actions.getCustomerEmails())).ok);
    const ack = await as(boss, () => actions.setCustomerEmailSwitch({ kind: "acknowledge", on: false }));
    ok("the ticket acknowledgement switched off here is off on Support email too", ack.ok && (await db.supportMailSettings.findUnique({ where: { id: "global" }, select: { acknowledge: true } }))?.acknowledge === false);
    ok("  an unknown switch is refused", !(await as(boss, () => actions.setCustomerEmailSwitch({ kind: "everything", on: false }))).ok);

    const mailSteps = [{ id: "mail", type: "branch", paths: [{ name: "Always", if: { all: [] }, steps: [{ id: "tell", type: "action", action: "email.send", input: { to: "contact", contactId: priya.id, from: "company", subject: "Zz hello", body: "Hello" } }] }] }];
    const colleagueSteps = [{ id: "tell", type: "action", action: "email.send", input: { to: "person", userId: "owner", subject: "Zz note", body: "Note" } }];
    ok("a workflow's step to a contact, even inside a branch, is an email to a customer", lib.customerEmailsIn(mailSteps as never).join() === "email");
    ok("  one to a colleague isn't", lib.customerEmailsIn(colleagueSteps as never).length === 0);
    ok("  a document is, and a meeting with its contact invited", lib.customerEmailsIn([{ id: "d", type: "action", action: "document.email", input: {} }, { id: "m", type: "action", action: "meeting.schedule", input: { inviteContact: true } }] as never).sort().join() === "document,meeting");
    ok("  a meeting without its contact isn't", lib.customerEmailsIn([{ id: "m", type: "action", action: "meeting.schedule", input: { inviteContact: false } }] as never).length === 0);
    const draftFor = (steps: unknown[]) => ({ schema: 1, trigger: { type: "manual" }, steps });
    const customerFlow = await store.createWorkflow({ name: "Zz greets customers", ownerUserId: boss.id, createdById: boss.id, draft: draftFor(mailSteps) as never });
    const internalFlow = await store.createWorkflow({ name: "Zz tells the team", ownerUserId: boss.id, createdById: boss.id, draft: draftFor(colleagueSteps) as never });
    const published = [await store.publishWorkflow(customerFlow.id, boss.id), await store.publishWorkflow(internalFlow.id, boss.id)];
    ok("(two workflows published)", published.every((p) => p.ok), published.map((p) => (p.ok ? "ok" : `${p.error} ${JSON.stringify(p.problems ?? [])}`)));
    const listed = await lib.workflowsEmailingCustomers();
    ok("the page lists the workflow that emails customers, not the one that tells colleagues", listed.length === 1 && listed[0]!.name === "Zz greets customers" && listed[0]!.kinds.join() === "email" && listed[0]!.owner === "Zz Boss", listed);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} customer email checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
