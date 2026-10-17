/**
 * check:automate-builder — Deskzo Automate, Phase 3: the builder, templates and test runs (plan of 17 Oct
 * 2026: "Publishing refuses each validation failure and names the step and field. Test runs show what
 * each action would do and create nothing unless the live tick box is set. The 8 templates publish and
 * run.").
 *
 * Builds a scratch workspace and control plane beside the real database, drives the real store, engine
 * and actions, and drops both at the end. Mail goes to a stand-in provider, PDFs come from a stand-in.
 *
 *   · what publishing refuses, by step and field — and an action's own merge fields let through;
 *   · the builder's catalogue: every action's fields from its schema, people and record pickers, the
 *     trigger fields the data picker offers;
 *   · pipeline automations' text converted, unknown tags left visible;
 *   · every template made, published and run end to end on real records;
 *   · test runs: reads for real, the rest said and not done, the safe steps done only when asked;
 *   · a workflow that carries on past a failed step; a wait on a time in the data, gone or to come;
 *   · a send cut off part way, retried by a person, sent once; copies and versions brought back.
 *
 *   npm run check:automate-builder
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import { clockFor } from "../src/lib/time/zone";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const DAY = 86_400_000;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const india = clockFor("Asia/Kolkata");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const real = new URL(url).pathname.slice(1);
  section("A scratch workspace and control plane");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so scratch databases may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const names = { a: `${real}_autobld_a`, control: `${real}_autobld_ctl` };
  const admin = directClient(withDatabase(url, "postgres"));
  let close: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.a}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, names.a) }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.control}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: withDatabase(url, names.control) }, timeout: 5 * 60_000 });
    process.env.TENANT_DB_ZZBLD_A = withDatabase(url, names.a);
    process.env.CONTROL_DATABASE_URL = withDatabase(url, names.control);
    ok("built from the migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    close = async () => {
      await closeAllClients();
      await closeControlDb();
    };
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const engine = require("../src/lib/automate/engine") as typeof import("../src/lib/automate/engine");
    const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
    const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
    const { builderCatalog } = require("../src/lib/automate/catalog") as typeof import("../src/lib/automate/catalog");
    const { TEMPLATES } = require("../src/lib/automate/templates") as typeof import("../src/lib/automate/templates");
    const { convertMergeText, definitionFromPipelineAutomation } = require("../src/lib/automate/migrate-pipeline") as typeof import("../src/lib/automate/migrate-pipeline");
    const { emitDateEvents } = require("../src/lib/automate/dates") as typeof import("../src/lib/automate/dates");
    const { emitLeadCreated } = require("../src/lib/automate/emit-leads") as typeof import("../src/lib/automate/emit-leads");
    const { emitBookingMade } = require("../src/lib/automate/emit-records") as typeof import("../src/lib/automate/emit-records");
    const { writeTicket } = require("../src/lib/ticket-open") as typeof import("../src/lib/ticket-open");
    const { intakeLead, leadPayloadSchema } = require("../src/lib/lead-capture/intake") as typeof import("../src/lib/lead-capture/intake");
    const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
    const pdf = require("../src/lib/documents/pdf") as typeof import("../src/lib/documents/pdf");
    type Outbound = import("../src/lib/marketing/providers/types").OutboundMessage;
    type Definition = import("../src/lib/automate/definition").Definition;

    const A = (await registry.tenantBySlug("zzbld-a"))!;
    const inA = <T,>(work: () => Promise<T>) => runAsTenant(A, work);
    const sent: Outbound[] = [];
    providerByKey.zztest = {
      key: "zztest",
      label: "ZZ stand-in",
      kind: "EMAIL",
      needs: [],
      send: async (message) => {
        sent.push(message);
        return { ok: true, providerMessageId: `zz-${sent.length}` };
      },
      verify: async () => ({ ok: true, detail: "stand-in" }),
    };
    pdf.setTestPdfRenderer(async () => Buffer.from("%PDF-1.4\n% zzbld stand-in\n%%EOF\n"));

    // ─── Fixtures ───────────────────────────────────────────────────────────────────────────────
    const person = (email: string, role: string, extra: Record<string, unknown> = {}) =>
      inA(() => db.user.create({ data: { name: email.split("@")[0]!, email, passwordHash: "!", role, ...extra }, select: { id: true } }).then((u) => u.id));
    const owner = await person("zzowner@zzbld.invalid", "ADMIN", { isSuperAdmin: true });
    const colleague = await person("zzcolleague@zzbld.invalid", "SALES");
    const support = await inA(() => db.department.create({ data: { name: "ZZ Support", isSupportTeam: true }, select: { id: true } }));
    const agent = await person("zzagent@zzbld.invalid", "SUPPORT", { departmentId: support.id });
    const acme = await inA(() =>
      db.company.create({
        data: { name: "ZZ Acme", normalizedName: "zz acme", createdById: owner, ownerUserId: owner, locations: { create: { label: "Head Office", isPrimary: true, isBilling: true, isShipping: true } } },
        select: { id: true, locations: { select: { id: true } } },
      }),
    );
    const asha = await inA(() => db.contact.create({ data: { companyId: acme.id, name: "Asha ZZ", email: "asha@zzbld.invalid", isPrimary: true, receivesDocuments: true }, select: { id: true } }).then((c) => c.id));
    await inA(() => db.messagingProvider.create({ data: { key: "zztest", label: "ZZ stand-in", kind: "EMAIL", enabled: true, priority: 1, classes: ["TRANSACTIONAL"], fromEmail: "crm@zzbld.invalid" } }));
    await inA(() => db.documentMailSettings.upsert({ where: { id: "global" }, create: { id: "global", sendFrom: "COMPANY", updatedById: owner }, update: { sendFrom: "COMPANY" } }));
    await inA(() => db.leadAssignmentRule.create({ data: { name: "ZZ everything to the colleague", strategy: "SPECIFIC_USER", userIds: [colleague], skipOnLeave: false } }));

    const drain = () =>
      inA(async () => {
        for (let i = 0; i < 40; i++) {
          await engine.workTenant({ budgetMs: 15_000 });
          const due = (await db.automationRun.count({ where: { status: "QUEUED", runAfter: { lte: new Date() } } })) + (await db.automationEvent.count({ where: { matchedAt: null } }));
          if (!due) break;
        }
      });
    /** Waiting runs of a workflow, due now — as if the time had come. */
    const fastForward = (workflowId: string) => inA(() => db.automationRun.updateMany({ where: { workflowId, status: "WAITING" }, data: { runAfter: new Date() } }));
    const runsOf = (workflowId: string) => inA(() => db.automationRun.findMany({ where: { workflowId, isTest: false }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, error: true, runAfter: true } }));
    const told = (userId: string) => inA(() => db.notification.findMany({ where: { userId }, select: { title: true, message: true } }));

    // ─── Publishing names the step and the field ────────────────────────────────────────────────
    section("What publishing refuses, by step and field");
    const problemsOf = (d: unknown) => {
      const v = inA(async () => validateDefinition(d));
      return v.then((r) => (r.ok ? [] : r.problems));
    };
    const manual = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ schema: 1, trigger: { type: "manual" }, steps, ...extra });
    const blankTitle = await problemsOf(manual([{ id: "make", type: "action", action: "task.create", input: { title: "" } }]));
    ok("a task with no title: the step and the field", blankTitle.some((p) => p.stepId === "make" && p.field === "title"), JSON.stringify(blankTitle));
    const noContact = await problemsOf(manual([{ id: "mail", type: "action", action: "email.send", input: { to: "contact", subject: "Hi", body: "Hello" } }]));
    ok("an email to a contact with none named: contactId", noContact.some((p) => p.stepId === "mail" && p.field === "contactId"), JSON.stringify(noContact));
    const badWait = await problemsOf(manual([{ id: "wait", type: "delay", on: { value: "{{trgger.booking.startsAt}}" } }]));
    ok("a wait on a time that isn't a reference", badWait.some((p) => p.stepId === "wait" && p.message.includes("isn't a reference")), JSON.stringify(badWait));
    const twoWays = await problemsOf(manual([{ id: "wait", type: "delay", for: { hours: 1 }, until: { at: "09:00" } }]));
    ok("a wait two ways at once", twoWays.length > 0);
    const docMerge = await problemsOf({ schema: 1, trigger: { type: "invoice.overdue" }, steps: [{ id: "send", type: "action", action: "document.email", input: { documentId: "{{trigger.document.id}}", subject: "{{document.number}} for {{trigger.company.name}}", body: "Dear {{recipient.names}}" } }] });
    ok("a document email's own merge fields are its own, not references", docMerge.length === 0, JSON.stringify(docMerge));
    const docTypo = await problemsOf({ schema: 1, trigger: { type: "invoice.overdue" }, steps: [{ id: "send", type: "action", action: "document.email", input: { documentId: "{{trigger.document.id}}", subject: "{{documnt.number}}" } }] });
    ok("  but a misspelt one still is caught", docTypo.some((p) => p.message.includes("documnt.number")), JSON.stringify(docTypo));
    const elsewhere = await problemsOf(manual([{ id: "tell", type: "action", action: "notify.person", input: { title: "{{document.number}}" } }]));
    ok("  and only in that action's own fields", elsewhere.length === 1);

    // ─── The catalogue ──────────────────────────────────────────────────────────────────────────
    section("The builder's catalogue");
    const catalog = await inA(() => builderCatalog(owner));
    const actionSpec = (key: string) => catalog.actions.find((a) => a.key === key);
    ok("every action, each with fields from its own schema", catalog.actions.length >= 14 && catalog.actions.every((a) => a.fields.length > 0), catalog.actions.length);
    const assignTo = actionSpec("task.create")?.fields.find((f) => f.name === "assignTo");
    ok("  a person field, with its special values first", assignTo?.kind === "person" && !!assignTo.special?.some((s) => s.value === "lead_owner"), JSON.stringify(assignTo));
    const contactField = actionSpec("email.send")?.fields.find((f) => f.name === "contactId");
    ok("  a field shown only when another holds a value", JSON.stringify(contactField?.showWhen) === '{"to":["contact"]}');
    ok("  the owner may use all of them (an admin)", catalog.actions.every((a) => a.available), catalog.actions.filter((a) => !a.available).map((a) => a.key).join(", "));
    const leadPaths = catalog.triggers.find((t) => t.type === "lead.created")?.paths.map((p) => p.ref) ?? [];
    ok("the data picker offers a lead's fields on lead.created", leadPaths.includes("trigger.lead.title") && leadPaths.includes("trigger.lead.ownerUserId") && leadPaths.includes("trigger.via"), leadPaths.slice(0, 5).join(", "));
    const movePaths = catalog.triggers.find((t) => t.type === "lead.stage_changed")?.paths.map((p) => p.ref) ?? [];
    ok("  and a move's from and to as stages", movePaths.includes("trigger.to.stageId") && movePaths.includes("trigger.from.status"));
    ok("people and pipelines to choose from", catalog.people.length >= 3 && catalog.pipelines.length >= 1);

    // ─── Converting a pipeline automation's words ───────────────────────────────────────────────
    section("A pipeline automation's words, converted");
    ok("its tags become the lead read last", convertMergeText("Call {{contact}} at {{company}} ({{value}})", "lead2") === "Call {{steps.lead2.output.contact}} at {{steps.lead2.output.company}} ({{steps.lead2.output.valueText}})");
    ok("  an unknown tag stays visible, not read as a reference", convertMergeText("Hi {{nickname}}", "lead") === "Hi { {nickname} }");
    const converted = definitionFromPipelineAutomation({ name: "Onboard", trigger: "LEAD_CREATED", pipelineId: "pl1", stageId: null, actions: [{ type: "ASSIGN", userId: "RULES" }, { type: "TASK", title: "Onboard {{company}}", dueInDays: 0, assignTo: "OWNER" }] });
    ok("  a lead read again after it is handed on, and the task for whoever has it then", converted.steps.map((s) => s.id).join() === "lead,assign1,lead1,task2" && JSON.stringify(converted.steps[3]).includes("steps.lead1.output.company") && JSON.stringify(converted.steps[3]).includes("lead_owner"));
    ok("  and it publishes as it is", (await problemsOf(converted)).length === 0, JSON.stringify(await problemsOf(converted)));

    // ─── Templates ──────────────────────────────────────────────────────────────────────────────
    section("Every template: made, published");
    const blanks: Record<string, Record<string, unknown>> = { "ticket-escalation": { tell: colleague, hours: 4 }, "lead-quiet": { days: 5 }, "daily-sales-report": { to: ["owner"], at: "09:00" } };
    const made: Record<string, string[]> = {};
    for (const t of TEMPLATES) {
      const result = await inA(() => store.createFromTemplate(t.key, blanks[t.key] ?? {}, owner));
      if (!result.ok) {
        ok(`${t.name}: made`, false, result.error);
        continue;
      }
      made[t.key] = result.data.ids;
      const published = await Promise.all(result.data.ids.map((id) => inA(() => store.publishWorkflow(id, owner))));
      ok(`${t.name}: made and published (${result.data.ids.length})`, published.every((p) => p.ok), published.map((p) => (p.ok ? "" : `${p.error} ${JSON.stringify(p.problems)}`)).join(" "));
    }
    const missing = await inA(() => store.createFromTemplate("ticket-escalation", { hours: 4 }, owner));
    ok("a template's required blank left empty is refused", !missing.ok && missing.error.includes("Tell"));
    const template = (key: string, i = 0) => made[key]![i]!;

    section("Every template: run on real records");
    // Website enquiry: assigned by the rules, thanked (the owner has no mailbox: noted, the rest done), then a task.
    const enquiry = await inA(() =>
      intakeLead({ id: null, name: "api", sourceLabel: "ZZ website", createdById: owner }, leadPayloadSchema.parse({ name: "Ravi ZZ", email: "ravi@zzbld.invalid", company: "ZZ Beta", product_interest: "Laptops", source: "WEBSITE" })),
    );
    const enquiryId = enquiry.status === "created" ? enquiry.leadId : "";
    await drain();
    const enquiryRuns = await runsOf(template("website-enquiry"));
    ok("website enquiry: waits two hours after the thank-you", enquiryRuns.length === 1 && enquiryRuns[0]!.status === "WAITING" && Math.abs(enquiryRuns[0]!.runAfter.getTime() - Date.now() - 2 * 3_600_000) < 120_000, JSON.stringify(enquiryRuns));
    await fastForward(template("website-enquiry"));
    await drain();
    const callTask = await inA(() => db.task.findFirst({ where: { leadId: enquiryId, title: { startsWith: "Call Ravi ZZ" } }, select: { assignedToUserId: true } }));
    const enquiryDone = (await runsOf(template("website-enquiry")))[0];
    ok("  then, still New: a task to call, for the owner the rules chose", callTask?.assignedToUserId === colleague, JSON.stringify(callTask));
    ok("  the thank-you it couldn't send noted, the rest done", enquiryDone?.status === "SUCCEEDED" && /mailbox/.test(enquiryDone.error ?? ""), enquiryDone?.error);

    // New lead assignment: a lead with nobody on it.
    const orphan = await inA(() => db.lead.create({ data: { companyId: acme.id, title: "ZZ orphan", source: "OTHER", createdByUserId: owner }, select: { id: true } }));
    await inA(() => db.$transaction((tx) => emitLeadCreated(tx, orphan.id, owner, "person")));
    await drain();
    ok("new lead assignment: given by the rules, its owner told", (await inA(() => db.lead.findUnique({ where: { id: orphan.id }, select: { ownerUserId: true } })))?.ownerUserId === colleague && (await told(colleague)).some((n) => n.title === "A new lead is yours" && n.message?.includes("ZZ orphan")));

    // The date checks: quiet lead, invoice due soon and overdue, renewal.
    const todayKey = india.dateKey(new Date());
    const [y, m, d] = todayKey.split("-").map(Number);
    const typedDay = (offset: number) => new Date(Date.UTC(y!, m! - 1, d! + offset));
    const quiet = await inA(() => db.lead.create({ data: { companyId: acme.id, title: "ZZ quiet one", source: "OTHER", ownerUserId: colleague, createdByUserId: owner, stageChangedAt: new Date(Date.now() - 5 * DAY - 3_600_000) }, select: { id: true } }));
    const dueSoon = await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-SOON", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: typedDay(-27), dueDate: typedDay(3) }, select: { id: true } }));
    const overdue = await inA(() => db.tradeDocument.create({ data: { docNumber: "ZZ-LATE", docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: acme.id, createdById: owner, issueDate: typedDay(-31), dueDate: typedDay(-1) }, select: { id: true } }));
    const plan = await inA(() => db.item.create({ data: { name: "ZZ Cloud", sku: "ZZ-CLOUD", type: "SUBSCRIPTION", sellingPrice: 1000, createdById: owner }, select: { id: true } }));
    await inA(() => db.companyProduct.create({ data: { companyId: acme.id, locationId: acme.locations[0]!.id, itemId: plan.id, addedByUserId: owner, quantity: 3, endDate: typedDay(30) } }));
    const before = sent.length;
    // Today's checks already ran, on the engine's first pass, before these records existed: as if it were tomorrow.
    await inA(() => db.dailyJobRun.deleteMany({ where: { job: "automate-dates" } }));
    await inA(() => emitDateEvents(india));
    await drain();
    ok("quiet leads: a follow-up task for its owner", (await inA(() => db.task.count({ where: { leadId: quiet.id, assignedToUserId: colleague, title: { contains: "quiet for 5 days" } } }))) === 1);
    const mails = sent.slice(before);
    const soonMail = mails.find((x) => x.subject.includes("ZZ-SOON"));
    ok("invoice reminder before: the invoice again, with its PDF, three days before", !!soonMail && soonMail.to === "asha@zzbld.invalid" && (soonMail.attachments?.length ?? 0) === 1 && soonMail.subject.includes("due in 3 days"), soonMail?.subject);
    ok("  its own merge fields filled by the document mail", !!soonMail && !soonMail.text?.includes("{{") && !!soonMail.text?.includes("Asha"), soonMail?.text?.slice(0, 80));
    const lateMail = mails.find((x) => x.subject.includes("ZZ-LATE"));
    ok("invoice reminder after: on the first day overdue, and somebody told", !!lateMail && (await told(owner)).some((n) => n.title === "An invoice is overdue" && n.message?.includes("ZZ-LATE")), lateMail?.subject);
    void dueSoon;
    void overdue;
    const renewalMail = mails.find((x) => x.subject.includes("ZZ Cloud renews in 30 days"));
    ok("renewal notice: the customer's main contact, through the company's mail server, and the account manager", renewalMail?.to === "asha@zzbld.invalid" && (await told(owner)).some((n) => n.title === "A renewal is coming up"), renewalMail?.subject);

    // Ticket escalation: one answered in time, one not.
    const openTicket = (title: string) =>
      inA(() => db.$transaction((tx) => writeTicket(tx, owner, { companyId: acme.id, contactId: "", companyProductId: "", title, description: "", ticketType: "PRODUCT_SUPPORT", priority: "MEDIUM", assignedToUserId: "" }, "person")));
    const silent = await openTicket("ZZ nobody answered");
    const answered = await openTicket("ZZ answered in time");
    await drain();
    await inA(() => db.ticketComment.create({ data: { ticketId: answered.id, userId: agent, body: "On it" } }));
    await fastForward(template("ticket-escalation"));
    await drain();
    const priorities = await inA(() => db.ticket.findMany({ where: { id: { in: [silent.id, answered.id] } }, select: { id: true, priority: true } }));
    ok("ticket escalation: the unanswered one raised to high, the person named told", priorities.find((p) => p.id === silent.id)?.priority === "HIGH" && (await told(colleague)).some((n) => n.title === "A ticket is waiting for an answer"), JSON.stringify(priorities));
    ok("  the answered one left alone", priorities.find((p) => p.id === answered.id)?.priority === "MEDIUM");

    // Booking confirmation: one in three days (waits), one in two hours (the reminder's time has gone).
    const book = (hours: number, id: string) =>
      inA(() => db.$transaction((tx) => emitBookingMade(tx, { id, pageId: "zz-page", pageTitle: "ZZ demo", hostUserId: owner, startsAt: new Date(Date.now() + hours * 3_600_000), endsAt: new Date(Date.now() + (hours + 1) * 3_600_000) }, { companyId: acme.id, contactId: asha, leadId: null })));
    const beforeBook = sent.length;
    await book(72, "zz-booking-later");
    await book(2, "zz-booking-soon");
    await drain();
    const bookingRuns = await runsOf(template("booking-confirmation"));
    const confirmations = sent.slice(beforeBook).filter((x) => x.subject.startsWith("Your booking"));
    const reminders = () => sent.slice(beforeBook).filter((x) => x.subject.startsWith("Tomorrow"));
    ok("booking confirmation: both confirmed at once", confirmations.length === 2, confirmations.length);
    ok("  the slot's time as people read it, not a timestamp", confirmations.every((x) => !/\d{4}-\d\d-\d\dT/.test(x.text ?? "") && /\d{1,2}:\d\d/.test(x.text ?? "")), confirmations[0]?.text?.split("\n")[2]);
    ok("  the one in two hours: its reminder's time has gone, so no wait", bookingRuns.filter((r) => r.status === "SUCCEEDED").length === 1 && reminders().length === 1, JSON.stringify(bookingRuns.map((r) => r.status)));
    const later = bookingRuns.find((r) => r.status === "WAITING");
    ok("  the one in three days waits until a day before it", !!later && Math.abs(later.runAfter.getTime() - (Date.now() + 48 * 3_600_000)) < 5 * 60_000, later?.runAfter.toISOString());
    await fastForward(template("booking-confirmation"));
    await drain();
    ok("  then reminded", reminders().length === 2);

    // Daily sales report: the schedule comes due.
    await inA(() => db.automationTrigger.update({ where: { workflowId: template("daily-sales-report") }, data: { nextFireAt: new Date(Date.now() - 60_000) } }));
    const beforeReport = sent.length;
    await inA(() => engine.fireSchedules(india));
    await drain();
    const report = sent.slice(beforeReport).find((x) => x.subject === "Yesterday's sales");
    ok("daily sales report: emailed when its time comes", report?.to === "zzowner@zzbld.invalid", report?.to);

    // ─── Test runs ──────────────────────────────────────────────────────────────────────────────
    section("Test runs");
    const testDraft: Definition = {
      schema: 1,
      trigger: { type: "lead.created" },
      steps: [
        { id: "read", type: "action", action: "lead.get", input: { leadId: "{{trigger.lead.id}}" } },
        { id: "make", type: "action", action: "task.create", input: { title: "ZZ test task for {{steps.read.output.title}}", leadId: "{{trigger.lead.id}}" } },
        { id: "mail", type: "action", action: "email.send", input: { to: "lead_contact", leadId: "{{trigger.lead.id}}", from: "company", subject: "ZZ test mail", body: "Hello" } },
        { id: "wait", type: "delay", for: { days: 3 } },
        { id: "tell", type: "action", action: "notify.person", input: { title: "ZZ test told" } },
      ],
    };
    const tested = await inA(() => store.createWorkflow({ name: "ZZ tested", ownerUserId: owner, createdById: owner, draft: testDraft }));
    const tasksBefore = await inA(() => db.task.count({ where: { title: { startsWith: "ZZ test task" } } }));
    const mailsBefore = sent.length;
    const dry = await inA(() => store.testDraft(tested.id, owner, false));
    const drySteps = dry.ok ? await inA(() => db.automationRunStep.findMany({ where: { runId: dry.data.runId }, select: { stepId: true, status: true, outputSummary: true } })) : [];
    const out = (id: string) => JSON.stringify(drySteps.find((s) => s.stepId === id)?.outputSummary ?? null);
    if (dry.ok && dry.data.status !== "SUCCEEDED") console.log("  test run steps:", JSON.stringify(await inA(() => db.automationRunStep.findMany({ where: { runId: dry.data.runId }, select: { stepId: true, status: true, error: true } }))), JSON.stringify(await inA(() => db.automationRun.findUnique({ where: { id: dry.data.runId }, select: { error: true, status: true } }))));
    ok("a test of a draft runs straight away, on the latest lead", dry.ok && dry.data.status === "SUCCEEDED" && !!dry.data.about?.includes("lead"), dry.ok ? `${dry.data.status} ${dry.data.about}` : dry.error);
    ok("  the read done for real", out("read").includes('"title"') && out("read").includes("ZZ"), out("read"));
    ok("  the task and the email said, not done", out("make").includes("Would create") && out("mail").includes("Would email") && (await inA(() => db.task.count({ where: { title: { startsWith: "ZZ test task" } } }))) === tasksBefore && sent.length === mailsBefore);
    ok("  the wait not waited for", out("wait").includes("waited") && drySteps.length === 5);
    const dryRun = dry.ok ? await inA(() => db.automationRun.findUnique({ where: { id: dry.data.runId }, select: { isTest: true, versionId: true, stepsUsed: true } })) : null;
    ok("  a test of the draft: no version, no steps counted", dryRun?.isTest === true && dryRun.versionId === null && dryRun.stepsUsed === 0);
    const liveTest = await inA(() => store.testDraft(tested.id, owner, true));
    ok("with \"do the safe steps for real\": the task made, the email still not sent", liveTest.ok && (await inA(() => db.task.count({ where: { title: { startsWith: "ZZ test task" } } }))) === tasksBefore + 1 && sent.length === mailsBefore);
    ok("  and the workflow still a draft, with no failures counted", (await inA(() => db.automationWorkflow.findUnique({ where: { id: tested.id }, select: { status: true, failureStreak: true } })))?.status === "DRAFT");
    const broken = await inA(() => store.createWorkflow({ name: "ZZ broken", ownerUserId: owner, createdById: owner, draft: { schema: 1, trigger: { type: "manual" }, steps: [{ id: "x", type: "action", action: "task.create", input: { title: "" } }] } as Definition }));
    const brokenTest = await inA(() => store.testDraft(broken.id, owner, false));
    ok("a draft with problems isn't tested; the problems come back", !brokenTest.ok && (brokenTest.problems?.length ?? 0) > 0);

    // ─── A send cut off, retried by a person ────────────────────────────────────────────────────
    section("A send cut off part way, retried by a person");
    const cut = await inA(() => store.createWorkflow({ name: "ZZ cut", ownerUserId: owner, createdById: owner, draft: { schema: 1, trigger: { type: "manual" }, steps: [{ id: "send", type: "action", action: "email.send", input: { to: "contact", contactId: asha, from: "company", subject: "ZZ cut send", body: "Once" } }] } as Definition }));
    await inA(() => store.publishWorkflow(cut.id, owner));
    const cutRun = await inA(() => store.startManualRun(cut.id, owner));
    if (cutRun.ok) {
      await inA(() => db.automationEffect.create({ data: { key: `${cutRun.data.runId}:send`, runId: cutRun.data.runId, output: { $sending: true } } }));
      await drain();
      const waiting = await inA(() => db.automationRun.findUnique({ where: { id: cutRun.data.runId }, select: { status: true } }));
      const sentBefore = sent.filter((x) => x.subject === "ZZ cut send").length;
      const retried = await inA(() => store.retryRun(cutRun.data.runId));
      await drain();
      const after = await inA(() => db.automationRun.findUnique({ where: { id: cutRun.data.runId }, select: { status: true } }));
      ok("waits for a person; retried, it is sent once", waiting?.status === "NEEDS_ATTENTION" && retried.ok && after?.status === "SUCCEEDED" && sentBefore === 0 && sent.filter((x) => x.subject === "ZZ cut send").length === 1, `${waiting?.status} → ${after?.status}`);
    }

    // ─── Copies and versions ────────────────────────────────────────────────────────────────────
    section("Copies and versions");
    const copy = await inA(() => store.duplicateWorkflow(template("lead-quiet"), owner));
    const copyRow = copy.ok ? await inA(() => db.automationWorkflow.findUnique({ where: { id: copy.data.id }, select: { name: true, status: true, draft: true, workflowSeq: true } })) : null;
    ok("a copy is a new draft with the same steps, and its own number", copyRow?.status === "DRAFT" && copyRow.name.startsWith("Copy of") && JSON.stringify(copyRow.draft).includes("quiet for") && copyRow.workflowSeq > 0);
    const quietId = template("lead-quiet");
    const v1 = await inA(() => db.automationVersion.findFirst({ where: { workflowId: quietId, number: 1 }, select: { id: true } }));
    await inA(() => store.saveDraft(quietId, { schema: 1, trigger: { type: "manual" }, steps: [{ id: "only", type: "stop", outcome: "succeeded" }] }));
    const restored = await inA(() => store.restoreVersion(quietId, v1!.id));
    const back = await inA(() => db.automationWorkflow.findUnique({ where: { id: quietId }, select: { draft: true } }));
    ok("an earlier version brought back into the draft", restored.ok && JSON.stringify(back?.draft).includes("lead.quiet"));
  } finally {
    if (close) await close().catch(() => undefined);
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((err) => console.error(`could not drop ${name}`, err));
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname IN (${Object.values(names).map((n) => `'${n}'`).join(", ")})`);
    ok("every scratch database dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} Automate builder checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
