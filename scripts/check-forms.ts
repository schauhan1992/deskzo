/**
 * Forms & Events — the builder, per-form access, invitations, RSVPs and the attendance register.
 *
 *   · The rules, without a database: the field types, the builder's save check, the category
 *     starters, the settings (India time, seats, deadlines), who may do what to a form, invitation
 *     status, the event funnel, and who can be invited at all.
 *   · Through the real actions: building a form, sharing it by person and by role with switches that
 *     do not imply each other, inviting customers — with the send step replaced, so nothing reaches a
 *     real provider — answering by personal link and by public link, the seat limit, changing an
 *     RSVP, attendance, the export, withdrawing an invitation, deleting and copying.
 *   · The screens: the list, the new-form picker, the builder, the form's tabs, the public page, a
 *     personal invitation, and the company page's Forms tab.
 *
 * Everything is named ZZPROBE_FORMS / zzprobe-forms and removed in a finally — found by owner as well
 * as by name, because a check that fails half-way must not leave a fixture that breaks the next run.
 *
 *   npm run check:forms
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  DEFAULT_FIELDS,
  checkFieldsForSave,
  formatAnswer,
  joinPicks,
  keyFromLabel,
  parseFields,
  splitPicks,
  summariseAnswers,
  validateAnswers,
} from "../src/lib/marketing/form-fields";
import { FORM_CATEGORIES, allowsInvites, allowsLink, categoryOf } from "../src/lib/forms/categories";
import { checkFormSettings, slugFromName } from "../src/lib/forms/settings";
import { cleanGrants, formAccessFor, formsWhere, type FormGrant } from "../src/lib/forms/access";
import { eventFunnel, formOpenState, hasSeat, inviteStatus, inviteVerdict, seatsText, tooSoonToResend } from "../src/lib/forms/invites";
import { fieldsUsed, render } from "../src/lib/marketing/merge";
import { mailSource } from "../src/lib/mail-log";
import { istDateTimeInput, parseIstDateTime } from "../src/lib/india-time";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { PERMISSIONS } from "../src/lib/permissions";
import type { RecipientState } from "../src/lib/marketing/suppression";

let actorId = "";
let actorRole = "PROFILE";
let sendAttempts = 0;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: actorRole, name: "Zzprobe Forms", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "next/headers") {
    const head = { get: (k: string) => (k === "host" ? "erp.example" : k === "x-forwarded-proto" ? "https" : null) };
    return { headers: async () => head, cookies: async () => ({ get: () => undefined }) };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/marketing/forms",
    };
  }
  // Never a real email, of either kind.
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  // The real pipeline, except that sending does nothing: this database has live providers enabled,
  // and a check must never put mail on the wire — nor flush anybody else's queue while it runs.
  if (request === "@/lib/marketing/pipeline") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      sendQueued: async () => {
        sendAttempts += 1;
        return { claimed: 0, sent: 0, failed: 0 };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_FORMS";
const SLUG = "zzprobe-forms";
const ROLE = "ZZPROBE_FORMS_ROLE";
const MAIL = "@zzprobe-forms.invalid";
const DAY = 86_400_000;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const forms = await db.inboundForm.findMany({
    where: { OR: [{ slug: { startsWith: SLUG } }, { ownerUserId: { in: userIds } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });
  const formIds = forms.map((f) => f.id);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { ownerUserId: { in: userIds } }, { createdById: { in: userIds } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { sentByUserId: { in: userIds } }] } });
  await db.formSubmission.deleteMany({ where: { OR: [{ formId: { in: formIds } }, { companyId: { in: companyIds } }] } });
  await db.inboundForm.deleteMany({ where: { id: { in: formIds } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.suppression.deleteMany({ where: { value: { endsWith: MAIL.slice(1) } } });
  await db.company.updateMany({ where: { id: { in: companyIds } }, data: { managedByResellerId: null } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

const field = (key: string, type: string, extra: Record<string, unknown> = {}) => ({ key, label: key, type, ...extra });

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("The questions");

  const spec = parseFields([
    field("name", "TEXT"),
    field("email", "EMAIL"),
    { key: "intro", type: "HEADING", label: "About you", required: true, help: "A little context" },
    field("suite", "RADIO", { options: ["Microsoft 365", "Google Workspace"], required: true }),
    field("needs", "MULTISELECT", { options: ["Seats", "Security", "Devices"], required: true }),
    field("seats", "NUMBER"),
    field("renewal", "DATE"),
    field("score", "RATING"),
    field("agree", "CHECKBOX"),
    field("orphan", "RADIO", { options: [] }),
    field("diet", "SELECT", { options: ["Veg", "Non-veg"], required: true }),
  ]);
  const by = (k: string) => spec.find((f) => f.key === k)!;
  ok("every new type is read as itself", ["RADIO", "MULTISELECT", "NUMBER", "DATE", "RATING", "HEADING"].every((t) => spec.some((f) => f.type === t)));
  ok("  a heading is never required, whatever the column says", by("intro").required === false && by("intro").help === "A little context");
  ok("  a choice with nothing to choose becomes a text box", by("orphan").type === "TEXT");
  ok("  a spec of nothing but headings falls back to the defaults", parseFields([{ key: "h", type: "HEADING", label: "Hi" }]).length === DEFAULT_FIELDS.length);

  const good = { name: "Asha", email: "asha@acme.example", suite: "Microsoft 365", needs: joinPicks(["Seats", "Devices"]), seats: "1,20,000", renewal: "2026-12-31", score: "4", agree: "yes", diet: "Veg" };
  ok("a complete set of answers passes", Object.keys(validateAnswers(spec, good)).length === 0, JSON.stringify(validateAnswers(spec, good)));
  ok("  a heading is never asked for", validateAnswers(spec, good).intro === undefined);
  const bad = validateAnswers(spec, { ...good, suite: "Zoho", needs: "Seats\nCatering", seats: "12a", renewal: "2026-02-31", score: "7", agree: "on" });
  ok("an option that was not offered is refused", !!bad.suite && !!bad.needs, JSON.stringify(bad));
  ok("  a number with letters in it is refused, one with Indian grouping is not", !!bad.seats && validateAnswers(spec, good).seats === undefined);
  ok("  31 February is not a date", !!bad.renewal);
  ok("  a rating is 1 to 5, a tick box is a tick", !!bad.score && !!bad.agree);
  ok("a required multiple choice with nothing ticked is refused", !!validateAnswers(spec, { ...good, needs: "" }).needs);
  const declining = validateAnswers(spec, { name: "Asha", email: "asha@acme.example" }, { onlyMandatory: true });
  ok("somebody declining is asked only who they are", Object.keys(declining).length === 0, JSON.stringify(declining));
  ok("  but still has to say who they are", !!validateAnswers(spec, { name: "", email: "asha@acme.example" }, { onlyMandatory: true }).name);
  ok("picks go in one per line and come out as a list", splitPicks(joinPicks(["A", "B"])).join("|") === "A|B");
  ok("an answer reads as a person would say it", formatAnswer(by("needs"), good.needs) === "Seats, Devices" && formatAnswer(by("score"), "4") === "4 / 5" && formatAnswer(by("agree"), "yes") === "Yes");
  ok("the lead description skips headings and writes picks out", !summariseAnswers(spec, good).includes("About you") && summariseAnswers(spec, good).includes("needs: Seats, Devices"));

  ok("a new question's key comes from its wording", keyFromLabel("How many seats?", []) === "howManySeats");
  ok("  and never collides with another", keyFromLabel("How many seats?", ["howManySeats"]) === "howManySeats2");
  ok("  nor takes one the submit path reads", keyFromLabel("Email", []) !== "email" && keyFromLabel("Name", []) !== "name", `${keyFromLabel("Email", [])} ${keyFromLabel("Name", [])}`);
  ok("  and a label with no letters still gets one", /^[A-Za-z]/.test(keyFromLabel("१२३", [])));

  const saveOf = (fields: unknown) => checkFieldsForSave(fields);
  const base = [field("name", "TEXT"), field("email", "EMAIL")];
  ok("the builder refuses a form without the name question", !saveOf([field("email", "EMAIL")]).ok);
  ok("  or with two questions under one key", !saveOf([...base, field("a", "TEXT"), field("a", "NUMBER")]).ok);
  ok("  or a choice with fewer than two options", !saveOf([...base, field("pick", "RADIO", { options: ["Only one"] })]).ok);
  ok("  or an email question that is not an address", !saveOf([field("name", "TEXT"), field("email", "TEXT")]).ok);
  ok("  or a key a person could not have typed", !saveOf([...base, field("1bad key", "TEXT")]).ok);
  ok("  or a question with no wording", !saveOf([...base, { key: "q", type: "TEXT", label: "" }]).ok);
  const saved = saveOf([...base, field("pick", "RADIO", { options: [" A ", "A", "B\nC"] })]);
  ok("it tidies the options it keeps — trimmed, single-line, no repeats", saved.ok && saved.fields[2]!.options.join("|") === "A|B C");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The kinds of form");

  for (const c of FORM_CATEGORIES) {
    const checked = checkFieldsForSave(c.starter);
    ok(`the ${c.label.toLowerCase()} starter saves as it stands`, checked.ok, checked.ok ? "" : checked.error);
    ok("  and reads back unchanged", checked.ok && JSON.stringify(parseFields(checked.fields)) === JSON.stringify(checked.fields));
    const used = fieldsUsed(`${c.invitation.subject} ${c.invitation.body}`);
    ok("  its invitation uses only real merge fields and carries the link", used.unknown.length === 0 && used.known.includes("formLink"), used.unknown.join());
  }
  const eventDef = categoryOf("EVENT");
  ok("an event is invitations and a link, makes no lead, and is filed under events", eventDef.defaults.fillMode === "BOTH" && !eventDef.defaults.createsLead && eventDef.defaults.topic === "EVENTS");
  ok("an assessment makes a lead", categoryOf("ASSESSMENT").defaults.createsLead);
  ok("an enquiry is a public link", categoryOf("ENQUIRY").defaults.fillMode === "LINK");
  ok("fill modes allow what they say", allowsLink("LINK") && !allowsInvites("LINK") && !allowsLink("INVITE") && allowsInvites("INVITE") && allowsLink("BOTH") && allowsInvites("BOTH"));
  const invitation = render(eventDef.invitation.body, {
    firstName: "Asha",
    formName: "Pune roundtable",
    formLink: "https://erp.example/forms/x/tok",
    eventDate: "Thu, 15 Oct 2026, 6:30 pm",
    eventVenue: null,
    inviterName: "Priya",
    ourName: "Acme",
    postalAddress: null,
    unsubscribeUrl: "https://erp.example/preferences/t",
  });
  ok("an event invitation renders with a venue still to be confirmed", invitation.ok && invitation.text.includes("to be confirmed") && invitation.text.includes("https://erp.example/forms/x/tok"));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Settings, in India time");

  const at = parseIstDateTime("2026-10-15T18:30");
  ok("an event at 6:30 pm is 6:30 pm in India, wherever the server is", at?.toISOString() === "2026-10-15T13:00:00.000Z", at?.toISOString());
  ok("  and goes back into the input as it came out", istDateTimeInput(at) === "2026-10-15T18:30");
  ok("  31 February is refused rather than rolled into March", parseIstDateTime("2026-02-31T10:00") === null);
  const settings = (over: Record<string, unknown> = {}) =>
    checkFormSettings({ name: "Roundtable", slug: "pune-roundtable", category: "EVENT", fillMode: "BOTH", createsLead: false, topic: "EVENTS", eventStartsAt: "2026-10-15T18:30", ...over } as never);
  ok("an event with a date saves", settings().ok);
  ok("  without one it does not", !settings({ eventStartsAt: "" }).ok);
  ok("  nor one that finishes before it starts", !settings({ eventEndsAt: "2026-10-15T18:00" }).ok);
  ok("  nor registration closing after it has started", !settings({ closesAt: "2026-10-15T19:00" }).ok);
  ok("  seats are a whole number above nothing", !settings({ capacity: "0" }).ok && !settings({ capacity: "2.5" }).ok && settings({ capacity: "40" }).ok);
  const survey = settings({ category: "SURVEY", capacity: "40", venue: "Hotel" });
  ok("a survey keeps no seat limit or venue from when it was an event", survey.ok && survey.settings.capacity === null && survey.settings.venue === null && survey.settings.eventStartsAt === null);
  ok("a web address is lower case, digits and hyphens", !settings({ slug: "Pune Roundtable" }).ok && !settings({ slug: "ab" }).ok && slugFromName("Pune — CIO Roundtable, Q4!") === "pune-cio-roundtable-q4");
  ok("  an unknown kind or fill mode is refused", !settings({ category: "PARTY" }).ok && !settings({ fillMode: "ANYONE" }).ok);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Who may do what — without a database");

  const g = (over: Partial<FormGrant>): FormGrant => ({ userId: null, roleKey: null, canEdit: false, canViewResponses: false, canInvite: false, ...over });
  const form = { ownerUserId: "owner", grants: [g({ userId: "ed", canEdit: true }), g({ userId: "rd", canViewResponses: true }), g({ roleKey: "SALES", canInvite: true }), g({ userId: "both", canEdit: true })] };
  const as = (id: string, role = "PROFILE", manageAll = false) => formAccessFor({ id, role, manageAll }, form);
  ok("the owner can do everything, sharing included", Object.values(as("owner")).filter((v) => v === true).length === 5 && as("owner").via === "owner");
  ok("a forms admin can too", as("admin", "PROFILE", true).share && as("admin", "PROFILE", true).via === "admin");
  ok("somebody with no grant cannot even see it", !as("stranger").see);
  ok("an editor can change it but not read the answers", as("ed").edit && !as("ed").responses && !as("ed").invite);
  ok("a reader can read the answers but not change it", as("rd").responses && !as("rd").edit);
  ok("a role grant reaches everybody with the role", as("anyone", "SALES").invite && as("anyone", "SALES").see);
  ok("  and a person and their role together get the better of each switch", as("both", "SALES").edit && as("both", "SALES").invite && !as("both", "SALES").responses);
  ok("nobody granted access can pass it on", !as("ed").share && !as("rd").share && !as("anyone", "SALES").share);
  const where = JSON.stringify(formsWhere({ id: "rd", role: "SALES", manageAll: false }, "canViewResponses"));
  ok("the list query asks the same question", where.includes("canViewResponses") && where.includes("\"ownerUserId\":\"rd\"") && JSON.stringify(formsWhere({ id: "a", role: "b", manageAll: true })) === "{}");
  ok("a sharing row naming nobody, or both, is refused", !cleanGrants([{}], "owner").ok && !cleanGrants([{ userId: "a", roleKey: "SALES" }], "owner").ok);
  ok("  the same person twice is refused", !cleanGrants([{ userId: "a" }, { userId: "a" }], "owner").ok);
  const cleaned = cleanGrants([{ userId: "owner", canEdit: true }, { roleKey: "SALES" }], "owner");
  ok("  a row for the owner is dropped, a row with no ticks is kept as see-only", cleaned.ok && cleaned.grants.length === 1 && cleaned.grants[0]!.roleKey === "SALES");

  // ─────────────────────────────────────────────────────────────────────────────
  section("Invitations and events — without a database");

  const inv = (over: Record<string, unknown>) => ({ revokedAt: null, openedAt: null, lastSentAt: new Date(), submission: null, ...over });
  ok("status: sent, opened, answered, withdrawn", [
    inviteStatus(inv({}), "SURVEY") === "SENT",
    inviteStatus(inv({ openedAt: new Date() }), "SURVEY") === "OPENED",
    inviteStatus(inv({ submission: { attending: null } }), "SURVEY") === "ANSWERED",
    inviteStatus(inv({ revokedAt: new Date(), submission: { attending: true } }), "EVENT") === "WITHDRAWN",
    inviteStatus(inv({ lastSentAt: null }), "SURVEY") === "NOT_SENT",
  ].every(Boolean));
  ok("  on an event the answer is the RSVP", inviteStatus(inv({ submission: { attending: true } }), "EVENT") === "COMING" && inviteStatus(inv({ submission: { attending: false } }), "EVENT") === "NOT_COMING");
  const now = new Date("2026-10-10T06:00:00Z");
  const live = { active: true, closesAt: null, category: "EVENT" as const, eventStartsAt: new Date("2026-10-15T13:00:00Z") };
  ok("an open event takes answers", formOpenState(live, now).open);
  ok("  a closed one does not", !formOpenState({ ...live, active: false }, now).open);
  ok("  nor past its deadline — and the deadline itself is too late", !formOpenState({ ...live, closesAt: now }, now).open && formOpenState({ ...live, closesAt: new Date(now.getTime() + 1) }, now).open);
  ok("  nor once the event has started", !formOpenState(live, new Date("2026-10-15T13:00:00Z")).open);
  ok("seats: the last one is there, one more is not, no limit is never full", hasSeat(2, 1) && !hasSeat(2, 2) && hasSeat(null, 10_000));
  ok("  written as '12 of 20', never '12 of null'", seatsText(12, 20) === "12 of 20" && seatsText(12, null) === "12");
  const funnel = eventFunnel({
    invites: [{ revokedAt: null, answered: true }, { revokedAt: null, answered: true }, { revokedAt: null, answered: false }, { revokedAt: new Date(), answered: true }],
    registrations: [
      { attending: true, attendance: "ATTENDED", viaInvite: true },
      { attending: false, attendance: null, viaInvite: true },
      { attending: true, attendance: "NO_SHOW", viaInvite: false },
      { attending: true, attendance: null, viaInvite: false },
    ],
  });
  ok("the funnel counts invited, replied, coming, declined, came and no-show", JSON.stringify(funnel) === JSON.stringify({ invited: 3, replied: 2, coming: 3, declined: 1, comingFromLink: 2, attended: 1, noShow: 1, unmarked: 1 }), JSON.stringify(funnel));
  ok("a reminder inside ten minutes is a double-click", tooSoonToResend(new Date(now.getTime() - 60_000), now) && !tooSoonToResend(new Date(now.getTime() - 11 * 60_000), now) && !tooSoonToResend(null, now));

  const state = (over: Partial<RecipientState> = {}): RecipientState => ({
    company: { managedByResellerId: null },
    contact: { email: "asha@acme.example", phone: null, emailStatus: "UNKNOWN", emailCheckedValue: null },
    suppressions: [],
    consent: null,
    signals: { unansweredFeedback: 2, daysOverdue: 120, breachedTickets: 3, sentInLastWeek: 9 },
    ...over,
  });
  const limits = { maxPerContactPerWeek: 2, overdueDaysBlock: 60, requireVerifiedAddress: true };
  const verdict = (s: RecipientState) => inviteVerdict(s, { topic: "EVENTS", limits });
  ok("an existing customer with no recorded consent can be invited — a personal message, not a mailshot", verdict(state()).ok);
  ok("  and the sales-only brakes (complaints, overdue, the weekly cap) do not stop an invitation", verdict(state()).ok);
  ok("a reseller's customer cannot", !verdict(state({ company: { managedByResellerId: "r" } })).ok);
  ok("  nor a bounced address, or one that complained", !verdict(state({ suppressions: [{ reason: "HARD_BOUNCE" }] })).ok && !verdict(state({ suppressions: [{ reason: "COMPLAINT" }] })).ok);
  ok("  nor somebody who unsubscribed from marketing, or was suppressed by hand", !verdict(state({ suppressions: [{ reason: "UNSUBSCRIBED" }] })).ok && !verdict(state({ suppressions: [{ reason: "MANUAL" }] })).ok);
  const optedOut = verdict(state({ consent: { status: "UNSUBSCRIBED" } }));
  ok("  nor somebody who opted out of events, saying so", !optedOut.ok && optedOut.reason.includes("events and webinars"), optedOut.ok ? "" : optedOut.reason);

  ok("the mail log names an invitation as one", mailSource({ noticeKind: null, messageClass: "TRANSACTIONAL", campaign: null, enrolment: null, sentBy: null, companyProduct: null, formInvite: { form: { name: "Pune roundtable", category: "EVENT" } } }, String) === "Event invitation — Pune roundtable");
  ok("forms have a module, a sidebar link and two permissions", MODULE_REGISTRY.some((m) => m.key === "forms" && m.navItems.some((n) => n.href === "/marketing/forms")) && ["forms.create", "forms.manageAll"].every((k) => PERMISSIONS.some((p) => p.key === k)));

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const forms = require("../src/actions/forms") as typeof import("../src/actions/forms");
  // Links are built on the workspace's own address — never on whatever host a request claimed.
  const { tenantOrigin } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const origin = await tenantOrigin();
  const publicForms = require("../src/actions/marketing-public") as typeof import("../src/actions/marketing-public");
  const { HANDOVER_AREAS } = require("../src/lib/handover/areas") as typeof import("../src/lib/handover/areas");
  const { CompanyDetail } = require("../src/components/companies/company-detail") as typeof import("../src/components/companies/company-detail");
  const page = (path: string) => (require(path) as { default: (p: unknown) => Promise<ReactElement> }).default;
  const ListPage = page("../src/app/(dashboard)/marketing/forms/page");
  const NewPage = page("../src/app/(dashboard)/marketing/forms/new/page");
  const DetailPage = page("../src/app/(dashboard)/marketing/forms/[id]/page");
  const EditPage = page("../src/app/(dashboard)/marketing/forms/[id]/edit/page");
  const PublicPage = page("../src/app/(public)/forms/[slug]/page");
  const InvitedPage = page("../src/app/(public)/forms/[slug]/[token]/page");
  const html = async (el: Promise<ReactElement>) => renderToStaticMarkup((await resolveAsync(await el)) as ReactElement);

  await cleanup();
  try {
    await db.role.create({ data: { key: ROLE, name: "Zzprobe forms role" } });
    const make = (name: string, grants: Record<string, boolean>, role = "PROFILE") =>
      db.user.create({
        data: {
          name: `Zzprobe ${name}`,
          email: `${name}${MAIL}`,
          role,
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const noView = { "companies.viewAll": false, "forms.manageAll": false };
    const owner = await make("owner", { ...noView, "forms.create": true });
    const editor = await make("editor", { ...noView, "forms.create": false });
    const reader = await make("reader", { ...noView, "forms.create": false });
    const inviter = await make("inviter", { ...noView, "forms.create": false, "contacts.view": true });
    const member = await make("member", { ...noView, "forms.create": false }, ROLE);
    const outsider = await make("outsider", { ...noView, "forms.create": false, "contacts.view": true });
    const admin = await make("admin", { "companies.viewAll": true, "forms.manageAll": true, "forms.create": true });
    const act = (u: { id: string; role: string }) => {
      actorId = u.id;
      actorRole = u.role;
    };

    const company = (name: string, ownerId: string, extra: Record<string, unknown> = {}) =>
      db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: ownerId, ownerUserId: ownerId, relationshipType: "CLIENT", stage: "CUSTOMER", ...extra } as never,
      });
    const customer = await company("Acme", inviter.id);
    const reseller = await company("Channel", inviter.id, { relationshipType: "RESELLER" });
    const endCustomer = await company("Reseller End", inviter.id, { managedByResellerId: reseller.id });
    const elsewhere = await company("Elsewhere", outsider.id);
    const contact = (companyId: string, name: string) =>
      db.contact.create({ data: { companyId, name: `Zz ${name}`, email: `${name}${MAIL}`, emailStatus: "VALID", emailCheckedValue: `${name}${MAIL}`, emailCheckedAt: new Date(), emailCheckMethod: "CONFIRMED" } });
    const asha = await contact(customer.id, "asha");
    const ravi = await contact(customer.id, "ravi");
    const bounced = await contact(customer.id, "bounced");
    const unsub = await contact(customer.id, "unsub");
    const optout = await contact(customer.id, "optout");
    const resold = await contact(endCustomer.id, "resold");
    const foreign = await contact(elsewhere.id, "foreign");
    await db.suppression.createMany({
      data: [
        { scope: "EMAIL", value: `bounced${MAIL}`, reason: "HARD_BOUNCE" },
        { scope: "EMAIL", value: `unsub${MAIL}`, reason: "UNSUBSCRIBED" },
      ],
    });
    await db.contactConsent.create({ data: { contactId: optout.id, channel: "EMAIL", topic: "EVENTS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE" } as never });

    // ───────────────────────────────────────────────────────────────────────────
    section("Building a form");

    const starts = istDateTimeInput(new Date(Date.now() + 10 * DAY));
    const eventInput = {
      name: `${TAG} Pune roundtable`,
      slug: `${SLUG}-pune`,
      headline: "Pune CIO roundtable",
      intro: "A closed-door evening.",
      thankYouText: "See you there.",
      category: "EVENT",
      fillMode: "BOTH",
      createsLead: false,
      topic: "EVENTS",
      assignToUserId: owner.id,
      eventStartsAt: starts,
      venue: "The Westin, Koregaon Park",
      capacity: "2",
      fields: categoryOf("EVENT").starter,
    };
    act(editor);
    ok("somebody without 'Build forms' cannot start one", !(await forms.saveForm(eventInput)).ok);
    act(owner);
    const created = await forms.saveForm(eventInput);
    ok("the owner builds an event from the starter", created.ok, created.ok ? "" : created.error);
    const formId = created.ok ? created.data.id : "";
    const stored = await db.inboundForm.findUnique({ where: { id: formId } });
    ok("  owned and built by them, in India time", stored?.ownerUserId === owner.id && stored.createdById === owner.id && istDateTimeInput(stored.eventStartsAt) === starts);
    ok("  a second form cannot take the same address", !(await forms.saveForm({ ...eventInput, name: `${TAG} Clash` })).ok);

    act(outsider);
    ok("a form nobody shared with you is not in your list", !(await forms.listForms())?.rows.some((r) => r.id === formId));
    ok("  and answers as though it did not exist", (await forms.getFormDetail(formId)) === null && (await forms.getFormSharing(formId)) === null);

    // ───────────────────────────────────────────────────────────────────────────
    section("Sharing, by person and by role");

    act(owner);
    const shared = await forms.saveFormSharing(formId, [
      { userId: editor.id, canEdit: true },
      { userId: reader.id, canViewResponses: true },
      { userId: inviter.id, canInvite: true },
      { roleKey: ROLE, canViewResponses: true },
      { userId: owner.id, canEdit: false },
    ]);
    ok("the owner shares it four ways", shared.ok && shared.data.count === 4, shared.ok ? shared.data.count : shared.error);
    ok("  a person who isn't a user is refused", !(await forms.saveFormSharing(formId, [{ userId: "no-such-user" }])).ok);

    act(editor);
    ok("an editor sees it and can change it", (await forms.getFormForEdit(formId)) !== null && (await forms.saveForm({ ...eventInput, id: formId, intro: "Updated by the editor." })).ok);
    ok("  but cannot read the answers or invite anybody", (await forms.listFormResponses(formId)) === null && (await forms.searchInvitees(formId, "zz")) === null);
    ok("  nor change who has it — they see the list, not the controls", (await forms.getFormSharing(formId))?.canShare === false);
    const passedOn = await forms.saveFormSharing(formId, [{ userId: outsider.id, canViewResponses: true }]);
    ok("  and cannot pass it on even though they can edit it — only the owner shares", !passedOn.ok && (await db.formAccessGrant.count({ where: { formId } })) === 4);
    act(reader);
    ok("a reader can read the answers but not change the form", (await forms.listFormResponses(formId)) !== null && (await forms.getFormForEdit(formId)) === null && !(await forms.saveForm({ ...eventInput, id: formId })).ok);
    act(member);
    ok("somebody holding the role reads the answers through it", (await forms.listFormResponses(formId)) !== null);
    act(admin);
    ok("a forms admin sees everything without being given it", (await forms.getFormDetail(formId))?.access.via === "admin");

    // ───────────────────────────────────────────────────────────────────────────
    section("Inviting customers");

    act(inviter);
    const found = await forms.searchInvitees(formId, "Zz");
    ok("the inviter finds their own customers' contacts", !!found?.some((c) => c.id === asha.id));
    ok("  and nobody from an account that isn't theirs", !found?.some((c) => c.id === foreign.id));
    const preview = await forms.previewInvites(formId, [asha.id, bounced.id, unsub.id, optout.id, resold.id, foreign.id]);
    const people = preview.ok ? preview.people : [];
    const reason = (id: string) => people.find((p) => p.id === id)?.blockedBecause ?? null;
    ok("the check before sending drops the account that isn't theirs", preview.ok && !people.some((p) => p.id === foreign.id) && people.length === 5);
    ok("  Asha can be invited", people.find((p) => p.id === asha.id)?.canReceive === true);
    ok("  the bounced, unsubscribed, opted-out and reseller's contacts cannot — each with the reason", [bounced, unsub, optout, resold].every((c) => reason(c.id) !== null), [bounced, unsub, optout, resold].map((c) => reason(c.id)).join(" | "));
    ok("an invitation without {{formLink}} is refused", !(await forms.sendFormInvites(formId, { contactIds: [asha.id], subject: "Hi", body: "Come along." })).ok);
    const typo = await forms.sendFormInvites(formId, { contactIds: [asha.id], subject: "Hi {{frstName}}", body: "{{formLink}}" });
    ok("  and one with a mistyped merge field is refused without leaving a half-made invitation", !typo.ok && (await db.formInvite.count({ where: { formId } })) === 0, typo.ok ? "" : typo.error);

    const sent = await forms.sendFormInvites(formId, { contactIds: [asha.id, ravi.id, bounced.id], subject: eventDef.invitation.subject, body: eventDef.invitation.body });
    ok("inviting Asha, Ravi and the bounced address sends two and skips one", sent.ok && sent.data.queued === 2 && sent.data.skipped.length === 1, sent.ok ? JSON.stringify(sent.data) : sent.error);
    ok("  through the real sender, with nothing put on the wire", sendAttempts === 1);
    const invite = await db.formInvite.findUnique({ where: { formId_contactId: { formId, contactId: asha.id } } });
    const message = await db.marketingMessage.findFirst({ where: { formInviteId: invite?.id } });
    ok("  Asha's message is a personal one from the inviter, logged against the invitation", message?.messageClass === "TRANSACTIONAL" && message.sentByUserId === inviter.id && message.contactId === asha.id);
    ok("  carrying her own link and every merge field filled", !!invite && !!message?.body.includes(`${origin}/forms/${SLUG}-pune/${invite.token}`) && !message.body.includes("{{"));
    ok("  and the date and venue of the event", !!message?.body.includes("The Westin") && !!message?.subject?.includes(`${TAG} Pune roundtable`));
    const again = await forms.sendFormInvites(formId, { contactIds: [asha.id], subject: "Reminder", body: "{{formLink}}" });
    ok("a second send inside ten minutes is refused as a double-click", !again.ok, again.ok ? "" : again.error);

    // ───────────────────────────────────────────────────────────────────────────
    section("Answering an invitation");

    const token = invite!.token;
    ok("the wrong form's address with a real token finds nothing", (await publicForms.getInvitedForm(`${SLUG}-other`, token)) === null);
    ok("  nor does a made-up token", (await publicForms.getInvitedForm(`${SLUG}-pune`, "x".repeat(32))) === null);
    const invitedForm = await publicForms.getInvitedForm(`${SLUG}-pune`, token);
    ok("her link opens the form with her name, address and company filled in", invitedForm?.invitation.email === `asha${MAIL}` && invitedForm.invitation.companyName === `${TAG} Acme`);
    ok("  but not the phone number we hold for her — a forwarded invitation must not hand it on", !!invitedForm && !("phone" in invitedForm.invitation));
    ok("  and notes that the link was opened", !!(await db.formInvite.findUnique({ where: { id: invite!.id } }))?.openedAt);

    const answers = { name: "Asha P", email: "someone-else@evil.example", companyName: "Somebody Else Ltd", designation: "CIO", interests: joinPicks(["Security and compliance"]), dietary: "Vegetarian" };
    const yes = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: answers, attending: true, inviteToken: token });
    ok("she says she is coming", yes.ok, yes.ok ? "" : yes.error);
    const mine = await db.formSubmission.findUnique({ where: { inviteId: invite!.id } });
    ok("  recorded against her invitation, her contact and her company", mine?.attending === true && mine.contactId === asha.id && mine.companyId === customer.id);
    ok("  under the address she was invited at, whatever the page sent", mine?.email === `asha${MAIL}` && mine.companyName === `${TAG} Acme`);
    const storedAnswers = (mine?.payload ?? {}) as Record<string, string>;
    ok("  in the answers as well as the columns", storedAnswers.email === `asha${MAIL}` && storedAnswers.companyName === `${TAG} Acme`, JSON.stringify(storedAnswers));
    ok("  keeping the name she corrected", mine?.name === "Asha P");
    ok("  the inviter hears about it as a form answer", (await db.notification.count({ where: { userId: inviter.id, type: "FORM_RESPONSE" } })) === 1);
    ok("  no lead: an event makes none", mine?.leadId === null);

    const no = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: { name: "Asha P", email: "" }, attending: false, inviteToken: token });
    ok("she changes her mind — declining asks only who she is", no.ok, no.ok ? "" : no.error);
    ok("  and it changes her one answer rather than adding another", (await db.formSubmission.count({ where: { inviteId: invite!.id } })) === 1 && (await db.formSubmission.findUnique({ where: { inviteId: invite!.id } }))?.attending === false);
    await publicForms.submitForm({ slug: `${SLUG}-pune`, values: answers, attending: true, inviteToken: token });
    ok("  and back again", (await db.formSubmission.findUnique({ where: { inviteId: invite!.id } }))?.attending === true);

    // ───────────────────────────────────────────────────────────────────────────
    section("The public link, and the seats");

    const stranger = (who: string, extra: Record<string, string> = {}) => ({
      name: `Zz ${who}`,
      email: `${who}${MAIL}`,
      companyName: `${TAG} ${who} Co`,
      designation: "IT Head",
      panelQuestion: "=HYPERLINK(\"http://evil.example\")",
      ...extra,
    });
    const s1 = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("walkin"), attending: true, elapsedMs: 5000 });
    ok("a stranger registers on the public link — the second of two seats", s1.ok, s1.ok ? "" : s1.error);
    const s2 = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("late"), attending: true, elapsedMs: 5000 });
    ok("  the next one is told the seats have gone", !s2.ok && s2.error.includes("seat"), s2.ok ? "" : s2.error);
    const s3 = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("late"), attending: false, elapsedMs: 5000 });
    ok("  but a 'can't make it' is still taken when it's full", s3.ok);
    const hijack = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("walkin"), attending: false, elapsedMs: 5000 });
    const walkin = await db.formSubmission.findMany({ where: { formId, email: `walkin${MAIL}` } });
    ok("somebody typing a registered address and 'can't make it' cancels nothing", hijack.ok && walkin.length === 1 && walkin[0]!.attending === true);
    ok("  and is thanked exactly as anybody else, so the link says nothing about who registered", hijack.ok && s1.ok && hijack.data.thankYou.length > 0);
    const bot = await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("bot"), attending: true, elapsedMs: 300 });
    ok("a form filled in under two seconds is thanked and ignored", bot.ok && (await db.formSubmission.count({ where: { email: `bot${MAIL}` } })) === 0);

    act(owner);
    ok("the seat limit can't go below the number already coming", !(await forms.saveForm({ ...eventInput, id: formId, capacity: "1" })).ok);
    ok("  and can go up", (await forms.saveForm({ ...eventInput, id: formId, capacity: "5" })).ok);

    act(inviter);
    const raviInvite = await db.formInvite.findUnique({ where: { formId_contactId: { formId, contactId: ravi.id } } });
    const phoned = await forms.recordRsvp(raviInvite!.id, true);
    ok("Ravi's 'yes' on the phone is recorded by the inviter", phoned.ok && (await db.formSubmission.findUnique({ where: { inviteId: raviInvite!.id } }))?.recordedById === inviter.id, phoned.ok ? "" : phoned.error);
    act(reader);
    ok("  somebody who can only read answers cannot record one", !(await forms.recordRsvp(raviInvite!.id, false)).ok);

    // ───────────────────────────────────────────────────────────────────────────
    section("On the day");

    const declined = await db.formSubmission.findFirst({ where: { formId, email: `late${MAIL}` } });
    act(inviter);
    ok("the inviter cannot mark attendance — it is the answers' register", !(await forms.markAttendance(mine!.id, "ATTENDED")).ok);
    act(reader);
    ok("a reader marks Asha as having come", (await forms.markAttendance(mine!.id, "ATTENDED")).ok);
    ok("  and cannot mark somebody who said they weren't coming", !(await forms.markAttendance(declined!.id, "ATTENDED")).ok);
    await forms.markAttendance(walkin[0]!.id, "NO_SHOW");
    act(owner);
    const detail = await forms.getFormDetail(formId);
    ok(
      "the funnel: 2 invited, 2 replied, 3 coming, 1 declined, 1 came, 1 no-show",
      JSON.stringify(detail?.funnel) === JSON.stringify({ invited: 2, replied: 2, coming: 3, declined: 1, comingFromLink: 1, attended: 1, noShow: 1, unmarked: 1 }),
      JSON.stringify(detail?.funnel),
    );

    act(reader);
    const csv = await forms.exportFormResponses(formId);
    ok("the export has every answer, with RSVP and attendance", csv.ok && csv.data.csv.includes('"Coming","Attendance"') && csv.data.csv.includes('"Attended"') && csv.data.csv.includes("Asha P"));
    ok("  and a formula typed into an answer goes out as text", csv.ok && csv.data.csv.includes(`"'=HYPERLINK(""http://evil.example"")"`));
    act(inviter);
    ok("  the inviter cannot export what they cannot read", !(await forms.exportFormResponses(formId)).ok);

    const invitesForInviter = await forms.listFormInvites(formId);
    ok("the inviter sees who was invited, with each person's link to copy", invitesForInviter?.rows.length === 2 && invitesForInviter.rows.every((r) => r.link?.startsWith(`${origin}/forms/`)));
    act(reader);
    ok("  a reader sees the list but not the links, which answer as the customer", (await forms.listFormInvites(formId))?.rows.every((r) => r.link === null) === true);
    act(editor);
    ok("  an editor doesn't see the list at all", (await forms.listFormInvites(formId)) === null);

    // ───────────────────────────────────────────────────────────────────────────
    section("Invitation-only, withdrawing, and the company page");

    act(owner);
    await forms.saveForm({ ...eventInput, id: formId, capacity: "5", fillMode: "INVITE" });
    ok("an invitation-only form's public address answers 'not available'", (await publicForms.getForm(`${SLUG}-pune`)) === null);
    ok("  and refuses a submission to it", !(await publicForms.submitForm({ slug: `${SLUG}-pune`, values: stranger("again"), attending: true, elapsedMs: 5000 })).ok);
    ok("  while a personal link still works", (await publicForms.getInvitedForm(`${SLUG}-pune`, token)) !== null);

    act(inviter);
    const pending = await forms.companyFormResponses(customer.id);
    ok("on the company page the inviter sees no answers — the form's answers aren't theirs to read", pending !== null && pending.responses.length === 0);
    act(admin);
    const adminView = await forms.companyFormResponses(customer.id);
    ok("  a forms admin sees Asha's and Ravi's", adminView?.responses.length === 2);
    act(reader);
    ok("  a reader who can't see the account sees nothing there, even though they can read the form", (await forms.companyFormResponses(customer.id)) === null);

    act(inviter);
    ok("withdrawing Asha's invitation works", (await forms.revokeInvite(invite!.id)).ok);
    ok("  after which her link is 'not available'", (await publicForms.getInvitedForm(`${SLUG}-pune`, token)) === null);
    ok("  and can't be used to answer", !(await publicForms.submitForm({ slug: `${SLUG}-pune`, values: answers, attending: false, inviteToken: token })).ok);
    ok("  while what she already said is kept", (await db.formSubmission.findUnique({ where: { inviteId: invite!.id } }))?.attending === true);

    // ───────────────────────────────────────────────────────────────────────────
    section("An assessment: leads, changed questions, deleting and copying");

    act(owner);
    const assessment = await forms.saveForm({
      name: `${TAG} Assessment`,
      slug: `${SLUG}-assess`,
      category: "ASSESSMENT",
      fillMode: "LINK",
      createsLead: true,
      topic: "OFFERS",
      assignToUserId: owner.id,
      fields: categoryOf("ASSESSMENT").starter,
    });
    const assessmentId = assessment.ok ? assessment.data.id : "";
    const full = { ...stranger("buyer"), employees: "45", needAreas: joinPicks(["Security and backup"]), requirement: "Move to M365 E3", licences: "Google Workspace × 45" };
    ok("a required multiple choice left empty is refused on the server too", !(await publicForms.submitForm({ slug: `${SLUG}-assess`, values: { ...full, needAreas: "" }, elapsedMs: 5000 })).ok);
    const answered = await publicForms.submitForm({ slug: `${SLUG}-assess`, values: full, elapsedMs: 5000 });
    const lead = await db.lead.findFirst({ where: { company: { name: `${TAG} buyer Co` } } });
    ok("a public assessment makes a company, a contact and a lead with the answers in it", answered.ok && !!lead?.description?.includes("Move to M365 E3") && !!lead.description.includes("Security and backup"), answered.ok ? lead?.description : answered.error);

    const trimmed = categoryOf("ASSESSMENT").starter.filter((f) => f.key !== "licences");
    const edited = await forms.saveForm({ id: assessmentId, name: `${TAG} Assessment`, slug: `${SLUG}-assess`, category: "ASSESSMENT", fillMode: "LINK", createsLead: true, topic: "OFFERS", fields: trimmed });
    ok("the owner takes a question off the form", edited.ok, edited.ok ? "" : edited.error);
    const afterEdit = await forms.listFormResponses(assessmentId);
    ok("an answer to a question since removed is kept and shown as such", !!afterEdit?.rows[0]?.retired.some((r) => r.key === "licences" && r.value.includes("45")));
    ok("a form with answers can't be deleted", !(await forms.deleteForm(assessmentId)).ok);
    const copy = await forms.duplicateForm(assessmentId);
    const copied = copy.ok ? await db.inboundForm.findUnique({ where: { id: copy.data.id }, include: { grants: true } }) : null;
    ok("a copy starts closed, owned by whoever copied it, shared with nobody", !!copied && !copied.active && copied.ownerUserId === owner.id && copied.grants.length === 0 && copied.slug.startsWith(`${SLUG}-assess-copy`));
    act(editor);
    ok("  only its owner can delete it", !(await forms.deleteForm(copied!.id)).ok);
    act(owner);
    ok("  and an unanswered form can be", (await forms.deleteForm(copied!.id)).ok && (await db.inboundForm.count({ where: { id: copied!.id } })) === 0);

    // ───────────────────────────────────────────────────────────────────────────
    section("Handing over a leaver's forms");

    const area = HANDOVER_AREAS.find((a) => a.key === "inbound-forms")!;
    const held = await area.hold(db, owner.id);
    ok("the owner's forms are in their handover", held.some((h) => h.id === formId) && held.some((h) => h.id === assessmentId));
    await db.$transaction((tx) => area.give(tx, [formId], admin.id, { actorId: admin.id, fromUserId: owner.id }));
    const moved = await db.inboundForm.findUnique({ where: { id: formId } });
    ok("  and move to the successor — owner and routing both", moved?.ownerUserId === admin.id && moved.assignToUserId === admin.id);
    await db.inboundForm.update({ where: { id: formId }, data: { ownerUserId: owner.id, assignToUserId: owner.id } });

    // ───────────────────────────────────────────────────────────────────────────
    section("The screens");

    act(owner);
    const list = await html(ListPage({ searchParams: Promise.resolve({}) }));
    ok("the list shows the forms with their kind and the seats taken", list.includes(`${TAG} Pune roundtable`) && list.includes("Event or roundtable") && list.includes("3 of 5"));
    const picker = await html(NewPage({ searchParams: Promise.resolve({}) }));
    ok("a new form starts by picking what it is", picker.includes("What are you making?") && picker.includes("Requirement assessment"));
    const builder = await html(NewPage({ searchParams: Promise.resolve({ category: "ASSESSMENT" }) }));
    ok("  and opens the builder with that kind's questions", builder.includes("How many people use a computer at work?") && builder.includes("Who can fill it in"));
    const edit = await html(EditPage({ params: Promise.resolve({ id: formId }) }));
    ok("the edit screen has the event's date and venue", edit.includes("The Westin") && edit.includes(starts));
    const overview = await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({}) }));
    ok("the form's overview has the funnel", overview.includes("Replied") && overview.includes("No-show") && overview.includes("3 of 5"));
    const answersTab = await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({ tab: "responses" }) }));
    ok("  its Answers tab lists who is coming, with the register", answersTab.includes("Asha P") && answersTab.includes("On the day") && answersTab.includes("Export all to CSV"));
    const invitesTab = await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({ tab: "invites" }) }));
    ok("  its Invitations tab lists who was invited and where they got to", invitesTab.includes("Zz ravi") && invitesTab.includes("Withdrawn") && invitesTab.includes("Coming"));
    const sharingTab = await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({ tab: "sharing" }) }));
    ok("  its Sharing tab has the people and the role", sharingTab.includes("Zzprobe reader") && sharingTab.includes("Zzprobe forms role") && sharingTab.includes("Save sharing"));
    act(editor);
    const editorView = await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({ tab: "responses" }) }));
    ok("an editor gets no Answers tab, and asking for it shows the overview", !editorView.includes(">Answers") && !editorView.includes("Asha P"));
    act(outsider);
    let hidden = false;
    try {
      await html(DetailPage({ params: Promise.resolve({ id: formId }), searchParams: Promise.resolve({}) }));
    } catch (err) {
      hidden = String(err).includes("notFound");
    }
    ok("somebody with no access gets 'not found'", hidden);

    act(owner);
    await forms.saveForm({ ...eventInput, id: formId, capacity: "5", fillMode: "BOTH" });
    const publicPage = await html(PublicPage({ params: Promise.resolve({ slug: `${SLUG}-pune` }) }));
    ok("the public page shows the event, its venue and the RSVP", publicPage.includes("Pune CIO roundtable") && publicPage.includes("The Westin") && publicPage.includes("Will you be there?"));
    const raviToken = raviInvite!.token;
    const invitedPage = await html(InvitedPage({ params: Promise.resolve({ slug: `${SLUG}-pune`, token: raviToken }) }));
    ok("a personal invitation page greets the person it is for", invitedPage.includes("Invitation for Zz ravi") && invitedPage.includes(`ravi${MAIL}`));
    const deadLink = await html(InvitedPage({ params: Promise.resolve({ slug: `${SLUG}-pune`, token }) }));
    ok("  and a withdrawn one says it isn't available", deadLink.includes("This invitation isn"));

    act(admin);
    const companyTab = renderToStaticMarkup((await CompanyDetail({ id: customer.id, tab: "forms" })) as ReactElement);
    ok("the company page has a Forms tab with what they answered", companyTab.includes(">Forms</a>") && companyTab.includes(`${TAG} Pune roundtable`) && companyTab.includes("Came"));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll forms checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
