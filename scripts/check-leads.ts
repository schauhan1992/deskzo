/**
 * The new-lead form: products, a new contact for a company that exists, and who may do either.
 *
 * Three things are checked, each for a reason it could break quietly:
 *
 *   · **Renewal date and remarks on a product line.** A date field is where timezones bite — stored
 *     one way and read another, "1 Oct" becomes "30 Sep" — and the remarks carry the tenant or VIP
 *     reference a renewal is matched on later. Both are round-tripped through the real actions.
 *   · **Scope.** Adding a contact, opening a lead and editing a lead's products all used to accept
 *     any id from any account. The lead page refused an outsider; the actions behind it did not.
 *   · **The form's wiring** — search instead of a dropdown, the new-contact dialog outside the
 *     `<form>` so submitting it cannot submit the lead, and DOM ids that survive hydration.
 *
 * Runs against the development database with its own ZZPROBE_LEADS fixture, removed in a finally.
 *
 *   npm run check:leads
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { createLeadSchema, renewalDateToStore, updateLeadRequirementSchema } from "../src/lib/validation/lead";
import { createCompanySchema } from "../src/lib/validation/company";
import { gradeFor, scoreLead, type LeadSignals } from "../src/lib/leads/score";
import { ruleMatches, type AssignmentSignals, type RuleShape } from "../src/lib/leads/assign";
import { PERMISSION_REGISTRY } from "../src/lib/permissions";

let actorId = "";
let actorRole = "ADMIN";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, refresh() {}, back() {} }) };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => ({ id: actorId, role: actorRole }), currentUser: async () => ({ id: actorId, role: actorRole }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const PREFIX = "ZZPROBE_LEADS";
const REP_EMAIL = "zzprobe.leads@example.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { entityType: "Company", entityId: { in: ids } },
        { entityType: "Lead", entityId: { in: leads.map((l) => l.id) } },
        { entityType: "Contact", entityLabel: { startsWith: "Zzprobe" } },
      ],
    },
  });
  await db.lead.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.user.deleteMany({ where: { email: REP_EMAIL } });
}

async function main() {
  section("A renewal date is a day, and stays that day");

  const parse = (renewalDate: string) =>
    updateLeadRequirementSchema.safeParse({ id: "r", quantity: 1, notes: "", renewalDate }).success;
  ok("a real date is accepted, and blank is fine", parse("2026-10-01") && parse(""));
  ok(
    "a date that does not exist is refused",
    !parse("2026-02-30") && !parse("2026-13-01"),
    "the right shape is not enough — new Date() would roll 30 Feb into March",
  );
  ok("  and so is any other format", !parse("01-10-2026") && !parse("1 Oct 2026"));
  ok(
    "it is stored as UTC midnight of that day",
    renewalDateToStore("2026-10-01")?.toISOString() === "2026-10-01T00:00:00.000Z" && renewalDateToStore("") === null,
    "the same convention as the lead's expected close date, so slice(0, 10) reads it back",
  );
  ok(
    "remarks are bounded",
    !createLeadSchema.safeParse({ companyId: "c", title: "Xy", requirements: [{ itemId: "i", notes: "x".repeat(501) }] }).success,
  );

  section("Through the real actions");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  const item = await db.item.findFirst({ select: { id: true, name: true } });
  if (!admin || !item) throw new Error("needs a super admin and at least one catalogue item");
  actorId = admin.id;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");

  await cleanup();
  try {
    const mine = await companyActions.createCompany({ name: `${PREFIX} Acme ${process.pid}`, location: { label: "HQ", gstTreatment: "UNREGISTERED" } });
    const other = await companyActions.createCompany({ name: `${PREFIX} Other ${process.pid}`, location: { label: "HQ", gstTreatment: "UNREGISTERED" } });
    if (!mine.ok || !other.ok) throw new Error("fixture companies were not created");

    const contact = await companyActions.addContact(mine.data.id, { name: "Zzprobe Newperson", designation: "CIO", email: " ZZ.NewPerson@Example.INVALID ", phone: "" });
    ok("a new contact is added to a company that already exists", contact.ok, contact.ok ? "" : contact.error);
    if (contact.ok) {
      const saved = await db.contact.findUnique({ where: { id: contact.data.id }, select: { email: true } });
      ok(
        "  with the email lowercased, as the importer stores it",
        saved?.email === "zz.newperson@example.invalid",
        `stored ${JSON.stringify(saved?.email)} — typed any other way, an export re-imported as a change`,
      );
    }
    const theirs = await companyActions.addContact(other.data.id, { name: "Zzprobe Elsewhere", designation: "OTHER" });
    if (!contact.ok || !theirs.ok) throw new Error("fixture contacts were not created");

    const lead = await leadActions.createLead({
      companyId: mine.data.id,
      contactId: contact.data.id,
      title: "Zzprobe M365 renewal",
      requirements: [{ itemId: item.id, quantity: 25, notes: "Tenant: zzprobe.onmicrosoft.com", renewalDate: "2026-10-01" }],
    });
    ok("a lead is created with the new contact and a dated product line", lead.ok, lead.ok ? "" : lead.error);
    if (lead.ok) {
      const stored = await db.lead.findUnique({ where: { id: lead.data.id }, include: { requirements: true } });
      const line = stored?.requirements[0];
      ok("  the contact is the one just added", stored?.contactId === contact.data.id);
      ok(
        "  the renewal date reads back as the day that was picked",
        line?.renewalDate?.toISOString().slice(0, 10) === "2026-10-01",
        line?.renewalDate?.toISOString(),
      );
      ok("  and the remarks are kept", line?.notes === "Tenant: zzprobe.onmicrosoft.com");

      const added = await leadActions.addLeadRequirement({ leadId: lead.data.id, itemId: item.id, quantity: 1, notes: "VIP: ZZ-123", renewalDate: "2027-01-15" });
      ok("a product added on the lead page keeps its date too", added.ok);
      if (added.ok) {
        const cleared = await leadActions.updateLeadRequirement({ id: added.data.id, quantity: 2, notes: "VIP: ZZ-456", renewalDate: "" });
        const after = await db.leadRequirement.findUnique({ where: { id: added.data.id } });
        ok("  and editing can clear the date and change the remarks", cleared.ok && after?.renewalDate === null && after?.notes === "VIP: ZZ-456");
      }
    }

    const crossed = await leadActions.createLead({ companyId: mine.data.id, contactId: theirs.data.id, title: "Zzprobe crossed wires" });
    ok(
      "a lead cannot name a contact from another company",
      !crossed.ok && /isn't at this company/.test(crossed.error),
      crossed.ok ? "created — calls and emails on it would go to another customer" : crossed.error,
    );

    // A salesperson who cannot see the admin's accounts.
    const rep = await db.user.create({ data: { name: "Zzprobe Leads Rep", email: REP_EMAIL, role: "SALES", passwordHash: "x".repeat(60) } });
    actorId = rep.id;

    const repContact = await companyActions.addContact(mine.data.id, { name: "Zzprobe Intruder", designation: "OTHER" });
    ok("somebody outside the account cannot add a contact to it", !repContact.ok && repContact.error === "Company not found.", repContact.ok ? "added" : repContact.error);
    const repLead = await leadActions.createLead({ companyId: mine.data.id, title: "Zzprobe from outside" });
    ok("  nor open a lead on it", !repLead.ok && repLead.error === "Company not found.", repLead.ok ? "created" : repLead.error);
    if (lead.ok) {
      const repAdd = await leadActions.addLeadRequirement({ leadId: lead.data.id, itemId: item.id, quantity: 1 });
      ok("  nor add a product to one of its leads", !repAdd.ok && repAdd.error === "Lead not found.", repAdd.ok ? "added" : repAdd.error);
    }
    ok(
      "  and nothing they tried was written",
      (await db.contact.count({ where: { name: "Zzprobe Intruder" } })) === 0 && (await db.lead.count({ where: { title: "Zzprobe from outside" } })) === 0,
    );
  } finally {
    await cleanup();
  }
  ok("the fixture is gone", (await db.company.count({ where: { name: { startsWith: PREFIX } } })) === 0 && (await db.user.count({ where: { email: REP_EMAIL } })) === 0);

  section("New companies pay in advance");

  ok("the company schema defaults to Advance", createCompanySchema.parse({ name: "Xylo Ltd" }).paymentTerms === "ADVANCE");
  const [dbDefault] = await db.$queryRaw<{ column_default: string | null }[]>`
    SELECT column_default FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'paymentTerms'`;
  ok("  and so does the database, for companies made any other way", /ADVANCE/.test(dbDefault?.column_default ?? ""), dbDefault?.column_default);
  ok("  and the form starts on it", /paymentTerms: "ADVANCE"/.test(readFileSync("src/components/companies/new-company-form.tsx", "utf8")));

  section("A lead's score, and why");

  const NOW = new Date("2026-09-23T06:30:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const base: LeadSignals = {
    status: "NEW",
    source: "OTHER",
    estimatedValue: null,
    expectedCloseDate: null,
    createdAt: daysAgo(1),
    employeeCount: null,
    isExistingCustomer: false,
    contactDesignation: null,
    requirementCount: 0,
    nearestRenewal: null,
    touchesLast14Days: 0,
    meetingsHeld: 0,
    lastTouchAt: null,
    now: NOW,
  };
  const hot = scoreLead({
    ...base,
    status: "NEGOTIATION",
    source: "REFERRAL",
    estimatedValue: 1_200_000,
    employeeCount: 300,
    isExistingCustomer: true,
    contactDesignation: "CEO",
    requirementCount: 2,
    nearestRenewal: new Date(NOW.getTime() + 30 * 86_400_000),
    touchesLast14Days: 5,
    meetingsHeld: 1,
    lastTouchAt: daysAgo(2),
  });
  ok("a referred, engaged, decision-maker deal in negotiation is hot", hot.grade === "HOT" && hot.score !== null && hot.score >= 70, `${hot.score}`);
  ok("  and never over 100", (hot.score ?? 0) <= 100);
  ok(
    "  every point it has is explained",
    hot.factors.every((f) => f.label.length > 0) && hot.factors.reduce((s, f) => s + f.points, 0) === hot.score,
    hot.factors.map((f) => `${f.label} ${f.points > 0 ? "+" : ""}${f.points}`).join(" · "),
  );
  const cold = scoreLead({ ...base, createdAt: daysAgo(45), expectedCloseDate: daysAgo(10) });
  ok(
    "a lead nobody has touched in 45 days, past its close date, is cold — and says why",
    cold.grade === "COLD" && cold.factors.some((f) => /Gone quiet: 45 days/.test(f.label)) && cold.factors.some((f) => f.points < 0 && /close date/.test(f.label)),
    `${cold.score} — ${cold.factors.map((f) => `${f.label} ${f.points}`).join(" · ")}`,
  );
  ok("  but a brand-new lead is not called quiet", !scoreLead(base).factors.some((f) => /quiet/.test(f.label)));
  ok(
    "won and lost leads have no score",
    scoreLead({ ...base, status: "WON" }).score === null && scoreLead({ ...base, status: "LOST" }).grade === "CLOSED",
  );
  ok("the grades cut at 70 and 40", gradeFor(70) === "HOT" && gradeFor(69) === "WARM" && gradeFor(40) === "WARM" && gradeFor(39) === "COLD");

  section("Who a lead goes to");

  const rule = (over: Partial<RuleShape>): RuleShape => ({
    id: "r",
    name: "r",
    brandIds: [],
    itemTypes: [],
    designations: [],
    sources: [],
    states: [],
    strategy: "ROUND_ROBIN",
    userIds: [],
    skipOnLeave: true,
    ...over,
  });
  const lead: AssignmentSignals = { brandIds: ["ms"], itemTypes: ["SUBSCRIPTION"], designation: "CEO", source: "WEBSITE", state: "Jammu and Kashmir", companyOwnerId: null };
  ok("a rule with no conditions matches everything", ruleMatches(rule({}), lead));
  ok("  a brand condition is any-of", ruleMatches(rule({ brandIds: ["adobe", "ms"] }), lead) && !ruleMatches(rule({ brandIds: ["adobe"] }), lead));
  ok("  every condition must hold", !ruleMatches(rule({ brandIds: ["ms"], designations: ["HR"] }), lead));
  ok(
    "  a state matches however it is spelled",
    ruleMatches(rule({ states: ["Jammu & Kashmir"] }), lead),
    '"Jammu and Kashmir" on the lead, "Jammu & Kashmir" on the rule — compared by GST code',
  );

  const { chooseOwner } = require("../src/lib/leads/assign") as typeof import("../src/lib/leads/assign");
  const PROBE_RULE = "ZZPROBE_ASSIGN";
  const probeEmails = ["zzprobe.assign1@example.invalid", "zzprobe.assign2@example.invalid", "zzprobe.assign3@example.invalid"];
  const cleanupAssign = async () => {
    await db.leadAssignmentRule.deleteMany({ where: { name: { startsWith: PROBE_RULE } } });
    await db.lead.deleteMany({ where: { title: { startsWith: "Zzprobe load" } } });
    await db.user.deleteMany({ where: { email: { in: probeEmails } } });
    await db.brand.deleteMany({ where: { name: { startsWith: PROBE_RULE } } });
  };
  await cleanupAssign();
  try {
    const brand = await db.brand.create({ data: { name: `${PROBE_RULE} Brand` } });
    const [a, b, c] = await Promise.all(
      probeEmails.map((email, i) => db.user.create({ data: { name: `Zzprobe Assign ${i + 1}`, email, role: "SALES", passwordHash: "x".repeat(60) } })),
    );
    // The fixture's own company — nothing here touches a real one.
    const co = await db.company.create({
      data: { name: `${PREFIX} Owned ${process.pid}`, normalizedName: `${PREFIX} owned ${process.pid}`.toLowerCase(), createdById: a!.id, ownerUserId: a!.id },
    });
    const signals: AssignmentSignals = { brandIds: [brand.id], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: null };
    // Ahead of any real rule, and matching only the probe brand, so real rules are neither
    // disturbed nor able to interfere.
    const rr = await db.leadAssignmentRule.create({
      data: { name: `${PROBE_RULE} rr`, priority: -1000, brandIds: [brand.id], strategy: "ROUND_ROBIN", userIds: [a!.id, b!.id, c!.id], skipOnLeave: false },
    });

    const picks = await Promise.all(Array.from({ length: 30 }, () => chooseOwner(signals)));
    const tally = [a!, b!, c!].map((u) => picks.filter((p) => p?.userId === u.id).length);
    ok(
      "round robin shares 30 leads arriving at once exactly 10 each",
      tally.every((n) => n === 10),
      `${tally.join(" / ")} — the position is advanced in one UPDATE … RETURNING, so none are handed out twice`,
    );
    const before = (await db.leadAssignmentRule.findUnique({ where: { id: rr.id } }))!.rrCursor;
    await chooseOwner(signals, { dryRun: true });
    ok("  and a preview does not use anybody's turn", (await db.leadAssignmentRule.findUnique({ where: { id: rr.id } }))!.rrCursor === before);

    await db.user.update({ where: { id: a!.id }, data: { active: false } });
    const withoutA = await Promise.all(Array.from({ length: 6 }, () => chooseOwner(signals)));
    ok("somebody deactivated is passed over", withoutA.every((p) => p?.userId !== a!.id));
    await db.user.update({ where: { id: a!.id }, data: { active: true } });

    await db.leadAssignmentRule.update({ where: { id: rr.id }, data: { skipOnLeave: true } });
    const leaveType = await db.leaveType.findFirst({ select: { id: true } });
    if (leaveType) {
      const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
      // Today on the workspace's clock (India's here), held as the leave's @db.Date holds a day.
      const today = indiaClock.calendarDate(new Date());
      await db.leaveRequest.create({
        data: { userId: b!.id, typeId: leaveType.id, fromDate: today, toDate: today, days: 1, reason: "Zzprobe", status: "APPROVED" },
      });
      const duringLeave = await Promise.all(Array.from({ length: 6 }, () => chooseOwner(signals)));
      ok("somebody on approved leave today is skipped", duringLeave.every((p) => p?.userId !== b!.id), "India's today, not the server's");
    }

    await db.leadAssignmentRule.update({ where: { id: rr.id }, data: { strategy: "LEAST_LOADED", skipOnLeave: false } });
    await db.lead.createMany({
      data: [
        ...Array.from({ length: 3 }, (_, i) => ({ companyId: co.id, title: `Zzprobe load a${i}`, ownerUserId: a!.id })),
        ...Array.from({ length: 1 }, (_, i) => ({ companyId: co.id, title: `Zzprobe load c${i}`, ownerUserId: c!.id })),
      ],
    });
    const least = await chooseOwner(signals);
    ok("fewest open leads goes to whoever is carrying least", least?.userId === b!.id, "b has none, c one, a three");

    await db.leadAssignmentRule.create({
      data: { name: `${PROBE_RULE} am`, priority: -2000, brandIds: [brand.id], strategy: "ACCOUNT_MANAGER", userIds: [], skipOnLeave: false },
    });
    const am = await chooseOwner({ ...signals, companyOwnerId: c!.id });
    ok("an existing customer's lead goes to their account manager first", am?.userId === c!.id && /account manager/.test(am.note));
    await db.user.update({ where: { id: c!.id }, data: { active: false } });
    const fallThrough = await chooseOwner({ ...signals, companyOwnerId: c!.id });
    ok("  and when they cannot take it, the next rule decides", fallThrough !== null && fallThrough.userId !== c!.id, fallThrough?.note);

    // Who may name the owner of a new lead.
    const leadActions2 = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const permission = PERMISSION_REGISTRY.find((p) => p.key === "leads.assign");
    ok("assigning leads to others is a permission of its own", !!permission);
    await db.user.update({ where: { id: c!.id }, data: { active: true } });
    actorId = a!.id;
    actorRole = "SALES";
    const handed = await leadActions2.createLead({ companyId: co.id, title: "Zzprobe handed", ownerUserId: b!.id });
    ok("a salesperson without it cannot hand a lead to somebody else", !handed.ok && /can't assign/.test(handed.error), handed.ok ? "assigned" : handed.error);
    const own = await leadActions2.createLead({ companyId: co.id, title: "Zzprobe own", source: "REFERRAL", sourceDetail: "Referred by Zzprobe" });
    const ownLead = own.ok ? await db.lead.findUnique({ where: { id: own.data.id } }) : null;
    ok("  but keeps their own when they choose nobody", ownLead?.ownerUserId === a!.id);
    ok("  and the lead records its source and is scored at once", ownLead?.source === "REFERRAL" && ownLead.sourceDetail === "Referred by Zzprobe" && ownLead.score !== null, `score ${ownLead?.score}`);

    // Scope on the status and activity actions.
    actorId = b!.id;
    if (own.ok) {
      const moved = await leadActions2.updateLeadStatus({ leadId: own.data.id, status: "CONTACTED" });
      ok("somebody outside the account cannot move its lead through the pipeline", !moved.ok && moved.error === "Lead not found.");
      const logged = await leadActions2.logActivity({ leadId: own.data.id, type: "CALL", notes: "Zzprobe" });
      ok("  nor log activity on it", !logged.ok && logged.error === "Lead not found.");
    }
    actorId = admin.id;
    actorRole = "ADMIN";
  } finally {
    actorId = admin.id;
    actorRole = "ADMIN";
    await cleanup();
    await cleanupAssign();
  }
  ok("the assignment fixture is gone", (await db.leadAssignmentRule.count({ where: { name: { startsWith: PROBE_RULE } } })) === 0 && (await db.user.count({ where: { email: { in: probeEmails } } })) === 0);

  section("The form");

  /**
   * Read rather than rendered: the rows only exist once "+ Add product" has been clicked, which a
   * static render cannot do. What matters is the wiring, and the wiring is in the source.
   */
  const form = readFileSync("src/components/leads/new-lead-form.tsx", "utf8");
  ok("the product is searched, not picked from a dropdown", /<ItemCombobox/.test(form) && !/Select a product…/.test(form));
  ok("each product line takes a renewal date and remarks", /requirements\.\$\{index\}\.renewalDate/.test(form) && /requirements\.\$\{index\}\.notes/.test(form));
  ok(
    "a new contact can be added without leaving the form",
    /\+ New contact/.test(form) && /<NewContactDialog/.test(form),
  );
  ok(
    "  and its dialog sits outside the lead's <form>",
    form.indexOf("<NewContactDialog") > form.indexOf("</form>"),
    "React bubbles a portal's events up the component tree; inside, submitting it would submit the lead",
  );
  ok("  and stops its own submit either way", /e\.stopPropagation\(\)/.test(readFileSync("src/components/companies/new-contact-dialog.tsx", "utf8")));
  ok(
    "row ids come from useId, not the field array",
    /useId\(\)/.test(form) && !/(?:htmlFor|\bid)=\{`[^`]*\$\{field\.id\}/.test(form),
    "a useFieldArray id is a fresh uuid per render environment, and breaks hydration",
  );

  await db.$disconnect();
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll lead checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await db.$disconnect();
    process.exit(1);
  });
