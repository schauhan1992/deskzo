import {
  Prisma,
  type CallOutcome,
  type CallerAllocationMethod,
  type CompanyType,
  type ContactDesignation,
  type CustomFieldEntity,
  type CustomFieldType,
  type EmailCheckStatus,
  type GstTreatment,
  type LeadSource,
  type LeadStatus,
  type PrismaClient,
  type StickyNoteColor,
  type StickyNoteVisibility,
  type VisitPurpose,
} from "@prisma/client";
import type { DemoContext } from "../context";
import { COMPANY_AGE_DAYS, DEMO_TAG, chance, int, log, normalise, personName, phone, pick, rnd, slugOf, some } from "../shared";
import { indiaClock } from "../../../src/lib/time/zone";
import { gstinCheckCharacter } from "../../../src/lib/gst-engine";
import { isStageColor, stageChangeNote, stageForStatus, type LeadStageDef } from "../../../src/lib/pipeline/rules";
import { coerceValue, keyFromLabel, readValues, type CustomFieldDef, type CustomFieldOption, type CustomFieldValues } from "../../../src/lib/custom-fields/rules";
import { allocate, trackedGap } from "../../../src/lib/workspace/allocation";
import { buildWhere, type WorkbookFilters } from "../../../src/lib/workspace/filters";
import { companyFamily, domainOf, duplicatePairs, pairKey, phoneKey, type DuplicateCandidate } from "../../../src/lib/companies/duplicates";
import { emailProviderFromMx } from "../../../src/lib/domain-intel/signatures";
import { isDisposableDomain, isFreeMailbox, isRoleAddress, parseEmailAddress } from "../../../src/lib/email-verification";
import type { Tenant } from "../../../src/lib/tenancy/state";

/**
 * The CRM, every way a record in it can be: companies of every type, rating, treatment and terms;
 * contacts with every email verdict; leads in every stage and from every source, some just moved and
 * some stuck; inbound calls and voicemails; visits planned, under way, called off and missed; the
 * meetings people scheduled from their records; duplicates merged and dismissed; each salesperson's
 * monthly commit; the workspace's own fields; sticky notes for everybody; calling lists split in
 * blocks and by account owner.
 *
 * ## The app decides, not this file
 *
 * Where the app has a function for it, that function is called, so the row is the one the app would
 * have written: credit ratings come from the credit engine run over the real payment history
 * (src/lib/credit), merges are `executeMerge` itself (src/lib/companies/merge.ts), what a meeting is
 * linked to and called is `meetingRecordFor` (src/lib/calendar/records.ts), who may post a note to
 * everybody or stick one to an account is `can` and `mayAttachTo`, a calling list is `buildWhere` and
 * `allocate`, a stage-change note is `stageChangeNote`, a custom field's key and every value is
 * `keyFromLabel` and `coerceValue`, and lead scores are `refreshLeadScore`. Those that read through
 * `db` run as this workspace (`runAsTenant`, on the address the seed itself was given), never as
 * whichever workspace a script would otherwise fall back to.
 *
 * ## Running it twice
 *
 * Each part looks for what it added before and steps aside; a second run adds nothing. What it adds
 * hangs off a demo company, person, lead or item and goes with it — except custom field definitions,
 * duplicate dismissals and the company lock row, which `resetCrm` below removes.
 */

type Person = DemoContext["people"][number];
type Db = PrismaClient;

// ── Time, on the workspace's clock ──────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const MINUTE = 60_000;
const clock = indiaClock;
const NOW = new Date();
const [TY, TM, TD] = clock.today(NOW).split("-").map(Number) as [number, number, number];

/** hh:mm here, `offset` days from today. */
const at = (offset: number, hour: number, minute = 0) => clock.at(TY, TM - 1, TD + offset, hour, minute);
/** Off a Sunday: forward for the future, back to the Saturday for the past. */
function offSunday(offset: number): number {
  if (clock.parts(at(offset, 12)).weekday !== 0) return offset;
  return offset >= 0 ? offset + 1 : offset - 1;
}
/** Somewhere in the working day `back` days ago — and never later than a few minutes ago. */
function workedAt(back: number, from = 10, to = 18): Date {
  const days = Math.max(0, Math.min(Math.round(back), COMPANY_AGE_DAYS - 2));
  const t = at(offSunday(-days), int(from, to - 1), int(0, 59));
  return t.getTime() < NOW.getTime() - MINUTE ? t : new Date(NOW.getTime() - int(5, 120) * MINUTE);
}
/** A slot in the working day `ahead` days from now, on the quarter hour. */
const slotAhead = (ahead: number, from = 10, to = 18) => at(offSunday(ahead), int(from, to - 1), pick([0, 15, 30, 45]));
const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MINUTE);
/** A moment in working hours somewhere between two others — or halfway, when only a night lies between them. */
function between(from: Date, to: Date): Date {
  const span = to.getTime() - from.getTime();
  for (let tries = 0; tries < 8; tries++) {
    const p = clock.parts(new Date(from.getTime() + span * (0.1 + rnd() * 0.8)));
    const t = clock.at(p.year, p.month, p.day, int(10, 17), int(0, 59));
    if (clock.parts(t).weekday !== 0 && t > from && t < to) return t;
  }
  return new Date(from.getTime() + span / 2);
}
/** The day an instant falls on here, held as a calendar day (midnight UTC) — close dates, due dates. */
const dayOf = (d: Date) => clock.calendarDate(d);
const daysSince = (d: Date) => (NOW.getTime() - d.getTime()) / DAY;
const nowHour = () => clock.parts(NOW).hour;
/** Later today when there is any of it left, otherwise within the next couple of hours. */
function laterToday(): Date {
  const t = at(0, Math.min(Math.max(nowHour() + int(1, 3), 10), 20), pick([0, 30]));
  return t.getTime() > NOW.getTime() + 20 * MINUTE ? t : plus(NOW, int(45, 150));
}
/** Earlier today, in working hours when the day has had any. */
function earlierToday(): Date {
  const h = nowHour();
  if (h < 10) return plus(NOW, -int(15, 45));
  const t = at(0, int(9, h - 1), pick([0, 15, 30]));
  return t.getTime() < NOW.getTime() - 10 * MINUTE ? t : plus(NOW, -int(15, 45));
}

// ── Identifiers ─────────────────────────────────────────────────────────────────────────────────

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const token = (n: number, alphabet = B64) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join("");
const guid = () => [8, 4, 4, 4, 12].map((n) => token(n, "0123456789abcdef")).join("-");

/** A PAN of the right shape: the fourth letter says who holds it (C company, F firm, P person, T trust, G government, A association). */
function panOf(holder: string, name: string): string {
  const initial = (name.replace(/[^A-Za-z]/g, "")[0] ?? "X").toUpperCase();
  return `${token(3, UPPER)}${holder}${initial}${int(1000, 9999)}${token(1, UPPER)}`;
}
/** A GSTIN with a real check character — state, PAN, which registration in that state, Z. */
function gstinOf(state: string, pan: string, entity = "1"): string {
  const first14 = `${state}${pan}${entity}Z`;
  return `${first14}${gstinCheckCharacter(first14) ?? "0"}`;
}
const PAN_IN_GSTIN = /^\d{2}([A-Z]{5}\d{4}[A-Z])[0-9A-Z]Z[0-9A-Z]$/;

// ── The workspace, for the app's own functions that read through `db` ───────────────────────────

function demoTenant(): Tenant {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL — the CRM cover seed runs against the database the demo seed was given.");
  return {
    id: "demo-seed-crm",
    slug: "demo",
    name: "Demo",
    status: "ACTIVE",
    dbUrl: url,
    primaryHost: "demo.localhost",
    hosts: ["demo.localhost"],
    source: "env",
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    timezone: clock.zone,
    entitlements: { v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
}

type App = {
  ws: <T>(fn: () => Promise<T>) => Promise<T>;
  can: (userId: string, key: string) => Promise<boolean>;
  merge: typeof import("../../../src/lib/companies/merge");
  credit: typeof import("../../../src/lib/credit/load");
  mayAttachTo: typeof import("../../../src/lib/authz/attachments").mayAttachTo;
  meetingRecordFor: typeof import("../../../src/lib/calendar/records").meetingRecordFor;
  refreshLeadScore: typeof import("../../../src/lib/leads/score-store").refreshLeadScore;
  close: () => Promise<void>;
};

async function appFunctions(): Promise<App> {
  // Loaded here rather than at the top: they bring the request machinery with them, which a seed
  // only needs once it is actually running.
  const [{ runAsTenant }, clients, authz, merge, credit, attachments, records, scores] = await Promise.all([
    import("../../../src/lib/tenancy/resolve"),
    import("../../../src/lib/tenancy/clients"),
    import("../../../src/lib/authz/resolve"),
    import("../../../src/lib/companies/merge"),
    import("../../../src/lib/credit/load"),
    import("../../../src/lib/authz/attachments"),
    import("../../../src/lib/calendar/records"),
    import("../../../src/lib/leads/score-store"),
  ]);
  const tenant = demoTenant();
  const ws = <T,>(fn: () => Promise<T>) => runAsTenant(tenant, async () => await fn());
  return {
    ws,
    can: (userId, key) => ws(() => authz.can(userId, key)),
    merge,
    credit,
    mayAttachTo: attachments.mayAttachTo,
    meetingRecordFor: records.meetingRecordFor,
    refreshLeadScore: scores.refreshLeadScore,
    close: () => clients.closeAllClients(),
  };
}

// ── Who is who ──────────────────────────────────────────────────────────────────────────────────

type Cast = {
  admin: { id: string; name: string };
  accountManagers: Person[];
  presales: Person[];
  callers: Person[];
  insideLead: { id: string; name: string };
  headOfSales: { id: string; name: string };
  regional: Person[];
  support: Person[];
  field: Person[];
  profilers: Person[];
  /** Who runs sales and the company: head of sales, general manager, director — by title, since HR holds a management role too. */
  leadership: { id: string; name: string }[];
  gm: { id: string; name: string };
  director: { id: string; name: string };
  emails: Map<string, string>;
  departments: Map<string, string | null>;
};

async function castOf(db: Db, ctx: DemoContext): Promise<Cast> {
  const p = ctx.people;
  const titled = (t: string) => p.filter((x) => x.title === t);
  const or = <T,>(list: T[], fallback: T[]): T[] => (list.length ? list : fallback);
  const admin = ctx.admin;
  const sales = or(p.filter((x) => x.dept === "Sales" && x.role === "SALES"), p.filter((x) => x.role === "SALES"));
  const users = await db.user.findMany({ where: { id: { in: [admin.id, ...p.map((x) => x.id)] } }, select: { id: true, email: true, departmentId: true } });
  return {
    admin,
    accountManagers: or(sales, [{ ...admin, role: "ADMIN", dept: "", title: "", isManager: true } as Person]),
    presales: or(titled("Presales Consultant"), sales),
    callers: or(p.filter((x) => x.role === "CALLING"), sales),
    insideLead: titled("Inside Sales Lead")[0] ?? sales[0] ?? admin,
    headOfSales: titled("Head of Sales")[0] ?? p.find((x) => x.role === "MANAGEMENT") ?? admin,
    regional: or(titled("Regional Sales Manager"), sales),
    support: or(p.filter((x) => x.dept === "Support"), sales),
    field: or(titled("Field Engineer"), p.filter((x) => x.dept === "Support")),
    profilers: or(p.filter((x) => x.role === "PROFILE"), p.filter((x) => x.role === "CALLING")),
    leadership: or<{ id: string; name: string }>([...titled("Head of Sales"), ...titled("General Manager"), ...titled("Director")], [admin]),
    gm: titled("General Manager")[0] ?? titled("Head of Sales")[0] ?? admin,
    director: titled("Director")[0] ?? p.find((x) => x.role === "ADMIN") ?? admin,
    emails: new Map(users.map((u) => [u.id, u.email])),
    departments: new Map(users.map((u) => [u.id, u.departmentId])),
  };
}

// ── The book as it stands ───────────────────────────────────────────────────────────────────────

async function loadBook(db: Db) {
  return db.company.findMany({
    where: { tags: { has: DEMO_TAG } },
    orderBy: { companySeq: "asc" },
    select: {
      id: true,
      companySeq: true,
      name: true,
      relationshipType: true,
      stage: true,
      ownerUserId: true,
      assignedToUserId: true,
      managedByResellerId: true,
      createdById: true,
      createdAt: true,
      employeeCount: true,
      panNumber: true,
      website: true,
      locations: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { id: true, label: true, address: true, city: true, state: true, country: true, gstNumber: true, isPrimary: true },
      },
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { id: true, name: true, email: true, phone: true, designation: true, emailStatus: true },
      },
      _count: { select: { products: true, leads: true } },
    },
  });
}
type BookCompany = Awaited<ReturnType<typeof loadBook>>[number];

/** Where a company can be dealt with directly: not a reseller's end customer (src/lib/reseller.ts). */
const direct = (c: BookCompany) => !c.managedByResellerId;
const addressOf = (c: BookCompany) => {
  const l = c.locations[0];
  return l ? [l.address, l.city].filter(Boolean).join(", ") || null : null;
};
/** The company's mail domain: from its people's addresses, else its website. */
function domainFor(c: BookCompany): string {
  for (const x of c.contacts) {
    const d = x.email ? domainOf(x.email) : null;
    if (d && !isFreeMailbox(d)) return d;
  }
  return (c.website ? domainOf(c.website) : null) ?? `${slugOf(c.name).split(" ")[0]}.example`;
}
const emailFrom = (name: string, domain: string) => `${name.toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".")}@${domain}`;
const landline = (std = "20") => `+91 ${std} ${int(2000, 6999)} ${int(1000, 9999)}`;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Companies
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** What the name says the business is. A seed name is "<Prefix> <Line> <Suffix>". */
function typeFromName(name: string, employees: number | null): CompanyType {
  if (/\bLLP$/.test(name)) return "LLP";
  if (/& Co$/.test(name)) return "PARTNERSHIP";
  if (/Enterprises$/.test(name)) return (employees ?? 0) <= 90 ? "PROPRIETORSHIP" : "PRIVATE_LIMITED";
  if (/Pvt Ltd$/.test(name)) return "PRIVATE_LIMITED";
  if (/\b(Ltd|Limited)$/.test(name)) return "PUBLIC_LIMITED";
  return "PRIVATE_LIMITED";
}

type NewContact = { name: string | null; designation: ContactDesignation; email?: string | null; local?: string; phone?: string | null; receivesDocuments?: boolean };
type NewCompany = {
  name: string;
  relationship: "CLIENT" | "OTHER";
  stage: "PROSPECT" | "LEAD" | "CUSTOMER";
  companyType: CompanyType;
  employees: number | null;
  industry: string | null;
  source: "LINKEDIN" | "REFERRAL" | "INBOUND" | "OTHER";
  terms: "ADVANCE" | "DUE_ON_RECEIPT";
  owner: "key" | "account" | "regional" | null;
  caller?: boolean;
  ageDays: number;
  panHolder: string | null;
  domain: string | null;
  vendorStatus?: "ACTIVE";
  category?: string;
  location: { label: string; address: string; city: string; state: string; country: string; pincode: string | null; treatment: GstTreatment; gstState: string | null };
  contacts: NewContact[];
};

/**
 * Companies the demo's name generator can't make: a proprietor, a doctor buying for her clinic, two
 * customers abroad, an NGO, a government society, a listed company, and two relationships that are
 * neither customer nor supplier. Between them every company type and every GST treatment a primary
 * address can have.
 */
const NEW_COMPANIES: NewCompany[] = [
  {
    name: "Shree Ganesh Computers", relationship: "CLIENT", stage: "PROSPECT", companyType: "PROPRIETORSHIP", employees: 8, industry: "Retail",
    source: "INBOUND", terms: "ADVANCE", owner: null, caller: true, ageDays: 75, panHolder: "P", domain: null,
    location: { label: "Shop", address: "14, Lohar Patti, Rajwada", city: "Indore", state: "Madhya Pradesh", country: "India", pincode: "452002", treatment: "REGISTERED_COMPOSITION", gstState: "23" },
    contacts: [{ name: "Mahesh Agrawal", designation: "OTHER", email: "shreeganesh.computers@gmail.com" }],
  },
  {
    name: "Dr Kavita Menon", relationship: "CLIENT", stage: "LEAD", companyType: "OTHER", employees: null, industry: "Healthcare",
    source: "REFERRAL", terms: "ADVANCE", owner: "account", ageDays: 22, panHolder: null, domain: null,
    location: { label: "Residence", address: "22/1, Panampilly Nagar", city: "Kochi", state: "Kerala", country: "India", pincode: "682036", treatment: "CONSUMER", gstState: null },
    contacts: [{ name: "Kavita Menon", designation: "OTHER", email: "kavita.menon.clinic@gmail.com" }],
  },
  {
    name: "Bluefin Analytics Inc", relationship: "CLIENT", stage: "LEAD", companyType: "OTHER", employees: 140, industry: "IT Services",
    source: "LINKEDIN", terms: "ADVANCE", owner: "key", ageDays: 70, panHolder: null, domain: "bluefinanalytics.example",
    location: { label: "Head office", address: "201 South Market Street, Suite 400", city: "San Jose", state: "California", country: "United States", pincode: "95113", treatment: "OVERSEAS", gstState: null },
    contacts: [
      { name: "Emily Carter", designation: "CIO", phone: "+1 408 555 0142" },
      { name: "Daniel Brooks", designation: "IT_MANAGER", phone: "+1 408 555 0178" },
    ],
  },
  {
    name: "Gulf Crest Trading LLC", relationship: "CLIENT", stage: "PROSPECT", companyType: "OTHER", employees: 40, industry: "Logistics",
    source: "LINKEDIN", terms: "ADVANCE", owner: null, ageDays: 45, panHolder: null, domain: "gulfcrest.example",
    location: { label: "Head office", address: "Office 1204, Al Reem Tower, Sheikh Zayed Road", city: "Dubai", state: "Dubai", country: "United Arab Emirates", pincode: null, treatment: "OVERSEAS", gstState: null },
    contacts: [{ name: "Faisal Rahman", designation: "PURCHASE_MANAGER", phone: "+971 50 555 0187" }],
  },
  {
    name: "Asha Shiksha Foundation", relationship: "CLIENT", stage: "LEAD", companyType: "NGO", employees: 65, industry: "Education",
    source: "REFERRAL", terms: "ADVANCE", owner: "account", ageDays: 35, panHolder: "T", domain: "ashashiksha.example",
    location: { label: "Head office", address: "3rd floor, Seva Sadan, Karve Road", city: "Pune", state: "Maharashtra", country: "India", pincode: "411004", treatment: "UNREGISTERED", gstState: null },
    contacts: [{ name: null, designation: "DIRECTOR" }, { name: "Accounts desk", designation: "OTHER", local: "accounts", phone: landline("20"), receivesDocuments: true }],
  },
  {
    name: "Kaveri District e-Governance Society", relationship: "CLIENT", stage: "LEAD", companyType: "GOVERNMENT", employees: 220, industry: null,
    source: "OTHER", terms: "ADVANCE", owner: "regional", ageDays: 130, panHolder: "G", domain: "kaveriegov.example",
    location: { label: "Collectorate campus", address: "e-Governance Cell, District Collectorate, Mysuru Road", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560026", treatment: "REGISTERED_REGULAR", gstState: "29" },
    contacts: [{ name: null, designation: "IT_HEAD" }, { name: null, designation: "PURCHASE_MANAGER" }],
  },
  {
    name: "Sahyadri Power Ltd", relationship: "CLIENT", stage: "PROSPECT", companyType: "PUBLIC_LIMITED", employees: 1200, industry: "Manufacturing",
    source: "LINKEDIN", terms: "ADVANCE", owner: null, ageDays: 25, panHolder: "C", domain: "sahyadripower.example",
    location: { label: "Corporate office", address: "Sahyadri House, Senapati Bapat Road", city: "Pune", state: "Maharashtra", country: "India", pincode: "411016", treatment: "REGISTERED_REGULAR", gstState: "27" },
    contacts: [{ name: null, designation: "CIO" }],
  },
  {
    name: "Summit Business Centres LLP", relationship: "OTHER", stage: "CUSTOMER", companyType: "LLP", employees: 35, industry: "Real Estate",
    source: "OTHER", terms: "DUE_ON_RECEIPT", owner: null, ageDays: 300, panHolder: "F", domain: "summitcentres.example", vendorStatus: "ACTIVE", category: "Office space",
    location: { label: "Baner centre", address: "Level 5, Summit Square, Baner Road", city: "Pune", state: "Maharashtra", country: "India", pincode: "411045", treatment: "REGISTERED_REGULAR", gstState: "27" },
    contacts: [{ name: "Accounts desk", designation: "OTHER", local: "accounts", phone: landline("20") }, { name: null, designation: "OTHER" }],
  },
  {
    name: "Indus Chamber of IT Industry", relationship: "OTHER", stage: "CUSTOMER", companyType: "NGO", employees: 18, industry: "IT Services",
    source: "OTHER", terms: "ADVANCE", owner: null, ageDays: 340, panHolder: "A", domain: "induschamber.example", vendorStatus: "ACTIVE", category: "Industry association",
    location: { label: "Secretariat", address: "Chamber House, Ballard Estate", city: "Mumbai", state: "Maharashtra", country: "India", pincode: "400001", treatment: "REGISTERED_REGULAR", gstState: "27" },
    contacts: [{ name: null, designation: "OTHER", local: "membership" }],
  },
];

/** Second registrations: SEZ units and export-oriented units on existing customers, with their own GSTIN under the same PAN. */
const EXTRA_UNITS: { label: string; address: string; city: string; state: string; code: string; pincode: string; treatment: GstTreatment }[] = [
  { label: "SEZ unit — Magarpatta Cybercity", address: "Tower 7, Magarpatta Cybercity SEZ, Hadapsar", city: "Pune", state: "Maharashtra", code: "27", pincode: "411013", treatment: "SEZ" },
  { label: "SEZ unit — Mindspace Madhapur", address: "Building 12A, Mindspace IT SEZ, Madhapur", city: "Hyderabad", state: "Telangana", code: "36", pincode: "500081", treatment: "SEZ" },
  { label: "Export-oriented unit — Chakan", address: "Plot B-14, MIDC Chakan Phase II", city: "Pune", state: "Maharashtra", code: "27", pincode: "410501", treatment: "DEEMED_EXPORT" },
  { label: "Export-oriented unit — Sriperumbudur", address: "SIPCOT Industrial Park, Sriperumbudur", city: "Sriperumbudur", state: "Tamil Nadu", code: "33", pincode: "602105", treatment: "DEEMED_EXPORT" },
];

async function coverCompanies(db: Db, cast: Cast) {
  // ── Every company type ──
  const untyped = await db.company.findMany({ where: { tags: { has: DEMO_TAG }, companyType: null }, select: { id: true, name: true, employeeCount: true } });
  for (const c of untyped) await db.company.update({ where: { id: c.id }, data: { companyType: typeFromName(c.name, c.employeeCount) } });

  // ── The ones the generator can't make ──
  const industries = new Map((await db.industry.findMany({ select: { id: true, name: true } })).map((i) => [i.name, i.id]));
  let added = 0;
  for (const spec of NEW_COMPANIES) {
    const normalizedName = normalise(spec.name);
    if (await db.company.findUnique({ where: { normalizedName }, select: { id: true } })) continue;
    const createdAt = workedAt(spec.ageDays);
    const owner =
      spec.owner === "key" ? pick(cast.accountManagers.filter((p) => p.title === "Key Account Manager").concat(cast.accountManagers).slice(0, 3))
      : spec.owner === "regional" ? pick(cast.regional)
      : spec.owner === "account" ? pick(cast.accountManagers)
      : null;
    const caller = spec.caller ? pick(cast.callers) : null;
    const assignee = owner ?? caller;
    const pan = spec.panHolder ? panOf(spec.panHolder, spec.name) : null;
    const company = await db.company.create({
      data: {
        name: spec.name,
        normalizedName,
        relationshipType: spec.relationship,
        stage: spec.stage,
        companyType: spec.companyType,
        industryId: spec.industry ? (industries.get(spec.industry) ?? null) : null,
        category: spec.category ?? null,
        employeeCount: spec.employees,
        website: spec.domain ? `https://www.${spec.domain}` : null,
        panNumber: pan,
        paymentTerms: spec.terms,
        vendorStatus: spec.vendorStatus ?? null,
        source: spec.source,
        tags: [DEMO_TAG],
        createdById: cast.admin.id,
        ownerUserId: owner?.id ?? null,
        assignedToUserId: assignee?.id ?? null,
        assignedByUserId: assignee ? cast.headOfSales.id : null,
        assignedAt: assignee ? createdAt : null,
        createdAt,
        locations: {
          create: {
            label: spec.location.label,
            address: spec.location.address,
            city: spec.location.city,
            state: spec.location.state,
            country: spec.location.country,
            pincode: spec.location.pincode,
            gstNumber: spec.location.gstState && pan ? gstinOf(spec.location.gstState, pan) : null,
            gstTreatment: spec.location.treatment,
            isPrimary: true,
            isBilling: true,
            isShipping: true,
            createdAt,
          },
        },
      },
      select: { id: true },
    });
    for (const [i, c] of spec.contacts.entries()) {
      const name = c.name ?? personName();
      const email = c.email !== undefined ? c.email : spec.domain ? (c.local ? `${c.local}@${spec.domain}` : emailFrom(name, spec.domain)) : null;
      await db.contact.create({
        data: {
          companyId: company.id,
          name,
          designation: c.designation,
          email,
          phone: c.phone !== undefined ? c.phone : phone(),
          isPrimary: i === 0,
          receivesDocuments: c.receivesDocuments ?? false,
          createdByUserId: cast.admin.id,
          createdAt,
        },
      });
    }
    added += 1;
  }

  // ── Terms: advance for prospects nobody has sold to, sixty days from the distributors and OEMs we buy from ──
  // Advance is what a customer without a record is given (src/lib/credit/engine.ts) and what the
  // company form defaults to; a vendor's terms are what we owe them, so no credit rule applies.
  const advance = await db.company.updateMany({
    where: { tags: { has: DEMO_TAG }, relationshipType: "CLIENT", stage: "PROSPECT", products: { none: {} }, tradeDocuments: { none: {} }, paymentTerms: { not: "ADVANCE" } },
    data: { paymentTerms: "ADVANCE" },
  });
  const net60 = await db.company.updateMany({
    where: { tags: { has: DEMO_TAG }, relationshipType: { in: ["DISTRIBUTOR", "OEM"] }, paymentTerms: { not: "NET_60" } },
    data: { paymentTerms: "NET_60" },
  });

  // ── Second registrations ──
  const book = await loadBook(db);
  const registered = book.filter((c) => c.relationshipType === "CLIENT" && c.stage === "CUSTOMER" && direct(c) && PAN_IN_GSTIN.test(c.locations[0]?.gstNumber ?? ""));
  let units = 0;
  const placed = new Set((await db.companyLocation.findMany({ where: { label: { in: EXTRA_UNITS.map((u) => u.label) }, company: { tags: { has: DEMO_TAG } } }, select: { label: true } })).map((l) => l.label));
  for (const [i, unit] of EXTRA_UNITS.entries()) {
    const owner = registered[(i * 7 + 3) % Math.max(1, registered.length)];
    if (!owner) break;
    if (placed.has(unit.label)) continue;
    const primary = owner.locations[0]!.gstNumber!;
    const pan = PAN_IN_GSTIN.exec(primary)![1]!;
    // A second registration in the same state is that PAN's entity 2 there; in another state, its first.
    const entity = primary.slice(0, 2) === unit.code ? "2" : "1";
    await db.companyLocation.create({
      data: {
        companyId: owner.id,
        label: unit.label,
        address: unit.address,
        city: unit.city,
        state: unit.state,
        country: "India",
        pincode: unit.pincode,
        gstNumber: gstinOf(unit.code, pan, entity),
        gstTreatment: unit.treatment,
        isPrimary: false,
        isBilling: true,
        isShipping: true,
        createdAt: workedAt(int(30, 200)),
      },
    });
    units += 1;
  }
  log("CRM: companies", `${untyped.length} typed, ${added} added (abroad, consumer, NGO, government, other), ${units} SEZ/EOU units, ${advance.count} prospects to advance, ${net60.count} suppliers on net 60`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Contacts and their email verdicts
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The people at a customer who aren't on the buying committee — the desk that gets the invoices, reception, admin. */
const OTHER_PEOPLE: { name: string | null; local?: string; receivesDocuments?: boolean; std?: boolean }[] = [
  { name: "Accounts desk", local: "accounts", receivesDocuments: true, std: true },
  { name: "Front office", local: "info", std: true },
  { name: null },
  { name: null, receivesDocuments: true },
  { name: "IT helpdesk", local: "helpdesk", std: true },
];

const MX_CHOICES = (domain: string) => [
  [`${domain.split(".")[0]}-example.mail.protection.outlook.com`],
  [`${domain.split(".")[0]}-example.mail.protection.outlook.com`],
  ["aspmx.l.google.com", "alt1.aspmx.l.google.com"],
  ["mx.zoho.in", "mx2.zoho.in"],
  [`mail.${domain}`],
];

/**
 * What `checkEmailAddress` (src/lib/email-verification-lookup.ts) says about an address, given the
 * mail hosts its domain publishes — the same branches in the same order, with the lookup's answer
 * supplied rather than asked for. `folded` is a domain that has stopped resolving.
 */
function machineVerdict(email: string, mx: string[], folded: boolean): { status: EmailCheckStatus; detail: string } {
  const parsed = parseEmailAddress(email);
  if (!parsed) return { status: "INVALID", detail: "Not a valid email address — check it for a typo or a stray space." };
  const { local, domain } = parsed;
  if (isDisposableDomain(domain)) return { status: "INVALID", detail: `${domain} is a throwaway address service. Nobody reads it.` };
  if (folded) return { status: "INVALID", detail: `${domain} publishes no mail server and does not resolve — mail to it will bounce.` };
  const hosts = isFreeMailbox(domain) ? ["gmail-smtp-in.l.google.com"] : mx;
  const provider = emailProviderFromMx(hosts);
  const named = provider && provider !== "Self-hosted or other" ? provider : null;
  const where = hosts.length === 0 ? `${domain} has no MX and would fall back to its web server` : named ? `${named} accepts mail for ${domain}` : `${domain} accepts mail at ${hosts[0]}`;
  if (isRoleAddress(local)) return { status: "RISKY", detail: `${where}, but ${local}@ is a shared inbox, not a person.` };
  if (isFreeMailbox(domain)) return { status: "RISKY", detail: `A personal ${domain} mailbox, not a company address.` };
  return { status: "VALID", detail: `${where}. The mailbox itself can only be confirmed by a reply.` };
}

async function coverContacts(db: Db, cast: Cast) {
  const book = await loadBook(db);
  const nameOf = new Map<string, string>([[cast.admin.id, cast.admin.name], ...[...cast.accountManagers, ...cast.callers, ...cast.presales, ...cast.regional, ...cast.support].map((p) => [p.id, p.name] as const)]);
  const userName = async (id: string | null | undefined) => (id ? (nameOf.get(id) ?? (await db.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "Someone") : "Someone");

  // ── People who aren't the buyer (designation Other) ──
  // The throwaway addresses below are added last, so finding one means this part has run.
  const addedBefore = (await db.contact.count({ where: { email: { endsWith: "@mailinator.com" }, company: { tags: { has: DEMO_TAG } } } })) > 0;
  const working = addedBefore ? [] : book.filter((c) => c.relationshipType === "CLIENT" && (c.stage === "CUSTOMER" || c.stage === "LEAD") && direct(c) && c.employeeCount && c.employeeCount >= 24);
  let others = 0;
  for (const [i, c] of working.filter((_, j) => j % 3 === 0).slice(0, 24).entries()) {
    if (c.contacts.some((x) => x.designation === "OTHER")) continue;
    const role = OTHER_PEOPLE[i % OTHER_PEOPLE.length]!;
    const name = role.name ?? personName();
    const domain = domainFor(c);
    await db.contact.create({
      data: {
        companyId: c.id,
        name,
        designation: "OTHER",
        email: role.local ? `${role.local}@${domain}` : emailFrom(name, domain),
        phone: role.std ? landline(pick(["20", "22", "80", "40", "44", "11"])) : phone(),
        receivesDocuments: role.receivesDocuments ?? false,
        createdByUserId: c.ownerUserId ?? cast.admin.id,
        createdAt: workedAt(int(10, Math.max(11, Math.floor(daysSince(c.createdAt))))),
      },
    });
    others += 1;
  }
  // Two addresses somebody gave to get off the phone, on prospects the calling team found.
  const prospects = addedBefore ? [] : book.filter((c) => c.relationshipType === "CLIENT" && c.stage === "PROSPECT" && direct(c));
  for (const c of prospects.slice(-2)) {
    const name = personName();
    await db.contact.create({
      data: { companyId: c.id, name, designation: "OTHER", email: `${name.toLowerCase().replace(" ", "")}${int(10, 99)}@mailinator.com`, phone: phone(), createdByUserId: pick(cast.callers).id, createdAt: workedAt(int(5, 60)) },
    });
    others += 1;
  }

  // The verdicts below go on together; a "reported wrong" from the last block means they are there.
  if (await db.contact.count({ where: { emailCheckMethod: "REPORTED", emailCheckDetail: { endsWith: "reported this address as wrong." }, company: { tags: { has: DEMO_TAG } } } })) {
    log("CRM: contacts", `${others} not on the buying committee; email verdicts already given`);
    return;
  }

  // ── Verdicts the calling team already gave, written to the contact as the app writes them ──
  // (src/actions/verification.ts): a caller's word on an address outranks any lookup.
  const verifications = await db.contactVerification.findMany({
    where: { field: "EMAIL", contactId: { not: null }, company: { tags: { has: DEMO_TAG } } },
    select: {
      status: true, originalValue: true, correctedValue: true, verifiedAt: true, appliedAt: true, appliedByUserId: true,
      verifiedBy: { select: { id: true, name: true } },
      contact: { select: { id: true, email: true, emailStatus: true } },
    },
  });
  let fromCalls = 0;
  for (const v of verifications) {
    const contact = v.contact;
    if (!contact || contact.emailStatus !== "UNCHECKED" || contact.email !== v.originalValue) continue;
    if (v.status === "CORRECTED" && v.appliedAt && v.correctedValue) {
      // Accepted onto the contact (`applyVerification`): the new address, already confirmed.
      await db.contact.update({
        where: { id: contact.id },
        data: {
          email: v.correctedValue,
          emailStatus: "VALID",
          emailCheckMethod: "CONFIRMED",
          emailCheckDetail: "Given on a call and accepted here.",
          emailCheckedValue: v.correctedValue,
          emailCheckedAt: v.appliedAt,
          emailCheckedByUserId: v.appliedByUserId ?? v.verifiedBy.id,
        },
      });
    } else {
      await db.contact.update({
        where: { id: contact.id },
        data: {
          emailStatus: v.status === "CORRECT" ? "VALID" : "INVALID",
          emailCheckMethod: v.status === "CORRECT" ? "CONFIRMED" : "REPORTED",
          emailCheckDetail:
            v.status === "CORRECT"
              ? `${v.verifiedBy.name} confirmed this address on a call.`
              : v.status === "CORRECTED"
                ? `${v.verifiedBy.name} was given a different address on a call — waiting for review.`
                : `${v.verifiedBy.name} was told this address is wrong.`,
          emailCheckedValue: v.originalValue,
          emailCheckedAt: v.verifiedAt,
          emailCheckedByUserId: v.verifiedBy.id,
        },
      });
    }
    fromCalls += 1;
  }

  // ── "Check every address" pressed on some accounts: the machine's verdict ──
  const profiles = new Map((await db.domainProfile.findMany({ select: { companyId: true, mxHosts: true } })).map((p) => [p.companyId, p.mxHosts]));
  const fresh = await loadBook(db);
  const checkedCompanies = fresh.filter((c, i) => c.stage === "DISQUALIFIED" ? i % 2 === 0 : (c.stage === "CUSTOMER" || c.stage === "LEAD" || c.stage === "PROSPECT") && i % 5 < 2);
  let automatic = 0;
  for (const c of checkedCompanies) {
    const domain = domainFor(c);
    const mx = profiles.get(c.id) ?? pick(MX_CHOICES(domain));
    // Written off and no longer trading: the domain has lapsed.
    const folded = c.stage === "DISQUALIFIED" && chance(0.6);
    const by = c.ownerUserId ?? c.assignedToUserId ?? pick(cast.callers).id;
    const when = workedAt(int(2, Math.max(3, Math.min(150, Math.floor(daysSince(c.createdAt))))));
    for (const x of c.contacts) {
      if (!x.email || x.emailStatus !== "UNCHECKED") continue;
      const outcome = machineVerdict(x.email, mx, folded && !isFreeMailbox(domainOf(x.email) ?? ""));
      await db.contact.update({
        where: { id: x.id },
        data: { emailStatus: outcome.status, emailCheckDetail: outcome.detail, emailCheckMethod: "AUTOMATIC", emailCheckedValue: x.email, emailCheckedAt: when, emailCheckedByUserId: by },
      });
      automatic += 1;
    }
  }

  // ── A person's own word: confirmed by the account manager, or reported wrong by a caller ──
  const after = await loadBook(db);
  const confirmable = after.filter((c) => c.stage === "CUSTOMER" && c.relationshipType === "CLIENT" && c.ownerUserId).flatMap((c) => c.contacts.filter((x) => x.email && x.emailStatus === "UNCHECKED").map((x) => ({ c, x })));
  let confirmed = 0;
  for (const { c, x } of some(confirmable, 12)) {
    await db.contact.update({
      where: { id: x.id },
      data: {
        emailStatus: "VALID", emailCheckMethod: "CONFIRMED", emailCheckDetail: `${await userName(c.ownerUserId)} confirmed this address reaches them.`,
        emailCheckedValue: x.email, emailCheckedAt: workedAt(int(3, 120)), emailCheckedByUserId: c.ownerUserId,
      },
    });
    confirmed += 1;
  }
  const reportable = after.filter((c) => c.stage === "PROSPECT" || c.stage === "LEAD").flatMap((c) => c.contacts.filter((x) => x.email && x.emailStatus === "UNCHECKED").map((x) => ({ c, x })));
  let reported = 0;
  for (const { x } of some(reportable, 6)) {
    const caller = pick(cast.callers);
    await db.contact.update({
      where: { id: x.id },
      data: {
        emailStatus: "INVALID", emailCheckMethod: "REPORTED", emailCheckDetail: `${caller.name} reported this address as wrong.`,
        emailCheckedValue: x.email, emailCheckedAt: workedAt(int(2, 90)), emailCheckedByUserId: caller.id,
      },
    });
    reported += 1;
  }
  log("CRM: contacts", `${others} not on the buying committee, ${fromCalls} verdicts from calls, ${automatic} checked automatically, ${confirmed} confirmed, ${reported} reported wrong`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Duplicates: merged, and dismissed
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The same company as somebody else typed it. */
function variantName(name: string): string {
  if (/ Pvt Ltd$/.test(name)) return name.replace(/ Pvt Ltd$/, " Private Limited");
  if (/ LLP$/.test(name)) return name.replace(/ LLP$/, " L.L.P.");
  if (/ & Co$/.test(name)) return name.replace(/ & Co$/, " and Company");
  if (/ Enterprises$/.test(name)) return name.replace(/ Enterprises$/, " Enterprise");
  return `${name} (India)`;
}

type DupPlan = {
  keep: BookCompany;
  dropName: string;
  relationship: BookCompany["relationshipType"];
  createdBy: string;
  assignedTo: string | null;
  createdDaysAgo: number;
  mergedDaysAgo: number;
  merger: { id: string; name: string };
  extras: (dropId: string, contacts: string[]) => Promise<void>;
  contacts: { name: string; email: string | null; phone: string | null; designation: ContactDesignation }[];
  vendor?: { vendorCode: string; bankAccountName: string; bankAccountNumber: string; bankIfsc: string; bankName: string };
};

async function coverDuplicates(db: Db, cast: Cast, app: App) {
  const book = await loadBook(db);
  const mergers: { id: string; name: string }[] = [];
  for (const m of [...cast.leadership, cast.admin]) if (!mergers.some((x) => x.id === m.id) && (await app.can(m.id, "companies.merge"))) mergers.push(m);
  const merger = (i: number) => mergers[i % Math.max(1, mergers.length)] ?? cast.admin;

  const usable = (c: BookCompany) => direct(c) && !/ (Private Limited|L\.L\.P\.|and Company|Enterprise|\(India\))$/.test(c.name);
  const k1 = book.find((c) => usable(c) && c.relationshipType === "CLIENT" && c.stage === "CUSTOMER" && c.contacts.some((x) => x.email) && PAN_IN_GSTIN.test(c.locations[0]?.gstNumber ?? ""));
  const k2 = book.find((c) => usable(c) && c.relationshipType === "CLIENT" && c.stage === "LEAD" && c.id !== k1?.id && c.contacts.some((x) => x.phone));
  const k3 = book.find((c) => usable(c) && c.relationshipType === "VENDOR");

  const plans: DupPlan[] = [];
  if (k1) {
    const person = k1.contacts.find((x) => x.email)!;
    const domain = domainFor(k1);
    plans.push({
      keep: k1,
      dropName: variantName(k1.name),
      relationship: "CLIENT",
      createdBy: pick(cast.profilers).id,
      assignedTo: pick(cast.callers).id,
      createdDaysAgo: 160,
      mergedDaysAgo: 118,
      merger: merger(0),
      contacts: [
        { name: person.name, email: person.email, phone: phone(), designation: person.designation },
        { name: "Accounts desk", email: `accounts@${domain}`, phone: landline(), designation: "OTHER" },
      ],
      extras: async (dropId, contacts) => {
        const caller = pick(cast.callers);
        const startedAt = workedAt(150);
        await db.callLog.create({
          data: {
            companyId: dropId, contactId: contacts[0] ?? null, phoneNumber: phone(), direction: "OUTBOUND", outcome: "CONNECTED", startedAt, durationSeconds: int(60, 180),
            notes: "Says they already buy from us — looks like this account is on file twice.", userId: caller.id, createdAt: startedAt,
          },
        });
      },
    });
  }
  if (k2) {
    const person = k2.contacts.find((x) => x.phone)!;
    const stages = await pipeline(db);
    plans.push({
      keep: k2,
      dropName: `${k2.name.split(" ").slice(0, 2).join(" ")}`,
      relationship: "CLIENT",
      createdBy: k2.ownerUserId ?? cast.admin.id,
      assignedTo: k2.ownerUserId,
      createdDaysAgo: 52,
      mergedDaysAgo: 44,
      merger: merger(1),
      contacts: [{ name: person.name, email: null, phone: person.phone, designation: person.designation }],
      extras: async (dropId, contacts) => {
        const createdAt = workedAt(51);
        const entry = stages ? stageForStatus(stages, "NEW") : null;
        await db.lead.create({
          data: {
            companyId: dropId, contactId: contacts[0] ?? null, title: "Website enquiry — laptops for a new branch", status: "NEW",
            ...(entry ? { stageId: entry.id, stageChangedAt: createdAt } : {}),
            source: "WEBSITE", sourceDetail: "Contact us form — /contact", ownerUserId: k2.ownerUserId, createdByUserId: k2.ownerUserId,
            estimatedValue: int(4, 12) * 75_000, createdAt,
          },
        });
      },
    });
  }
  if (k3) {
    plans.push({
      keep: k3,
      dropName: variantName(k3.name),
      relationship: "VENDOR",
      createdBy: pick(cast.accountManagers).id,
      assignedTo: null,
      createdDaysAgo: 40,
      mergedDaysAgo: 9,
      merger: merger(2),
      contacts: [{ name: personName(), email: null, phone: phone(), designation: "OTHER" }],
      vendor: { vendorCode: `V-${int(1000, 1999)}`, bankAccountName: k3.name, bankAccountNumber: String(int(10000000, 99999999)) + String(int(1000, 9999)), bankIfsc: `HDFC0${int(100000, 999999)}`, bankName: "HDFC Bank" },
      extras: async () => {},
    });
  }

  let merged = 0;
  // Which companies qualify moves as deals are won, so a second run would find other pairs: once is enough.
  const mergedBefore = (await db.companyMerge.count({ where: { into: { tags: { has: DEMO_TAG } } } })) > 0;
  for (const plan of mergedBefore ? [] : plans) {
    if (await db.companyMerge.findFirst({ where: { fromName: plan.dropName }, select: { id: true } })) continue;
    const normalizedName = normalise(plan.dropName);
    // A company already under that name is somebody else's record, not a duplicate this made — leave it be.
    if (await db.company.findUnique({ where: { normalizedName }, select: { id: true } })) {
      log("CRM: merge skipped", `${plan.dropName} is already a company of its own`);
      continue;
    }
    let drop: { id: string } | null = null;
    {
      const createdAt = workedAt(plan.createdDaysAgo);
      const keepLoc = plan.keep.locations[0];
      drop = await db.company.create({
        data: {
          name: plan.dropName,
          normalizedName,
          relationshipType: plan.relationship,
          stage: plan.relationship === "CLIENT" ? "PROSPECT" : "CUSTOMER",
          vendorStatus: plan.relationship === "CLIENT" ? null : "ONBOARDING",
          companyType: typeFromName(plan.keep.name, plan.keep.employeeCount),
          employeeCount: plan.keep.employeeCount,
          panNumber: plan.keep.panNumber,
          paymentTerms: "ADVANCE",
          source: "OTHER",
          tags: [DEMO_TAG],
          createdById: plan.createdBy,
          ownerUserId: plan.relationship === "CLIENT" && plan.assignedTo === plan.keep.ownerUserId ? plan.keep.ownerUserId : null,
          assignedToUserId: plan.assignedTo,
          assignedByUserId: plan.assignedTo ? cast.insideLead.id : null,
          assignedAt: plan.assignedTo ? createdAt : null,
          createdAt,
          ...(plan.vendor ?? {}),
          locations: keepLoc
            ? {
                create: {
                  label: "Head office", address: keepLoc.address, city: keepLoc.city, state: keepLoc.state, country: keepLoc.country ?? "India",
                  gstNumber: keepLoc.gstNumber, gstTreatment: keepLoc.gstNumber ? "REGISTERED_REGULAR" : "UNREGISTERED", isPrimary: true, isBilling: true, isShipping: true, createdAt,
                },
              }
            : undefined,
        },
        select: { id: true },
      });
      const contactIds: string[] = [];
      for (const [i, c] of plan.contacts.entries()) {
        const row = await db.contact.create({ data: { companyId: drop.id, name: c.name, email: c.email, phone: c.phone, designation: c.designation, isPrimary: i === 0, createdByUserId: plan.createdBy, createdAt }, select: { id: true } });
        contactIds.push(row.id);
      }
      await plan.extras(drop.id, contactIds);
    }

    // What the merge screen would have offered, taken as offered: its suggested side for every detail
    // that differs, and every pair of people it found in both.
    if (!drop) continue;
    const dropId = drop.id;
    const preview = await app.ws(() => app.merge.planMerge(plan.keep.id, dropId));
    if (!preview || preview.blockers.length) {
      log("CRM: merge skipped", `${plan.dropName}: ${preview?.blockers[0] ?? "not found"}`);
      continue;
    }
    const choices = Object.fromEntries(preview.fields.map((f) => [f.key, f.suggested])) as Record<string, "keep" | "drop">;
    let outcome: Awaited<ReturnType<App["merge"]["executeMerge"]>>;
    try {
      outcome = await app.ws(() => app.merge.executeMerge({ keepId: plan.keep.id, dropId, choices, combine: preview.contactPairs.map((p) => p.id), userId: plan.merger.id }));
    } catch (err) {
      if (err instanceof app.merge.MergeRefused) {
        log("CRM: merge refused", `${plan.dropName}: ${err.message}`);
        continue;
      }
      throw err;
    }
    const mergedAt = workedAt(plan.mergedDaysAgo);
    await db.companyMerge.update({ where: { id: outcome.mergeId }, data: { mergedAt } });
    // The two lines the merge action writes to the audit log (src/actions/company-merge.ts).
    const keepRef = `COM-${String(plan.keep.companySeq).padStart(6, "0")}`;
    const movedCount = outcome.moved.reduce((t, m) => t + m.count, 0);
    await db.auditLog.createMany({
      data: [
        { userId: plan.merger.id, action: "DELETE", entityType: "Company", entityId: dropId, entityLabel: `${outcome.fromRef} ${outcome.fromName} — merged into ${keepRef}`, createdAt: mergedAt },
        { userId: plan.merger.id, action: "UPDATE", entityType: "Company", entityId: plan.keep.id, entityLabel: `${plan.keep.name} — ${outcome.fromRef} ${outcome.fromName} merged into it, ${movedCount} records moved`, createdAt: plus(mergedAt, 0.1) },
      ],
    });
    merged += 1;
  }

  // ── "These two are not the same company" ──
  const all = await db.company.findMany({
    where: { tags: { has: DEMO_TAG } },
    select: { id: true, name: true, relationshipType: true, managedByResellerId: true, panNumber: true, website: true, locations: { select: { gstNumber: true } }, contacts: { select: { email: true, phone: true } } },
  });
  const candidates: DuplicateCandidate[] = all.map((c) => {
    const domains = new Set<string>();
    const site = c.website ? domainOf(c.website) : null;
    if (site) domains.add(site);
    for (const x of c.contacts) {
      const d = x.email ? domainOf(x.email) : null;
      if (d && !isFreeMailbox(d)) domains.add(d);
    }
    return {
      id: c.id,
      name: c.name,
      family: companyFamily(c.relationshipType),
      managedByResellerId: c.managedByResellerId,
      gstins: [...new Set(c.locations.map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g))],
      pan: c.panNumber?.trim().toUpperCase() || null,
      domains: [...domains],
      phones: [...new Set(c.contacts.map((x) => (x.phone ? phoneKey(x.phone) : null)).filter((p): p is string => !!p))],
    };
  });
  const existing = await db.companyDuplicateDismissal.findMany({ select: { companyAId: true, companyBId: true } });
  const dismissed = new Set(existing.map((d) => pairKey(d.companyAId, d.companyBId)));
  // Only pairs the registration numbers say are different businesses — a shared GSTIN or PAN is the same one.
  const different = existing.length ? [] : duplicatePairs(candidates, dismissed).filter((p) => !p.reasons.some((r) => r.startsWith("Same GSTIN") || r.startsWith("Same PAN")));
  const chosen = [...different.filter((p) => p.strength === "strong").slice(0, 3), ...different.filter((p) => p.strength === "likely").slice(0, 2)];
  let dismissals = 0;
  for (const p of chosen) {
    const by = merger(dismissals + 1);
    await db.companyDuplicateDismissal.upsert({
      where: { companyAId_companyBId: { companyAId: p.aId, companyBId: p.bId } },
      create: { companyAId: p.aId, companyBId: p.bId, dismissedById: by.id, createdAt: workedAt(int(3, 60)) },
      update: {},
    });
    dismissals += 1;
  }
  log("CRM: duplicates", `${merged} merged through executeMerge, ${dismissals} pairs dismissed as different businesses`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Leads
// ════════════════════════════════════════════════════════════════════════════════════════════════

async function pipeline(db: Db): Promise<LeadStageDef[] | null> {
  const rows = await db.leadStage.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  if (!rows.length) return null;
  return rows.map((r) => ({ id: r.id, key: r.key, label: r.label, status: r.status, color: isStageColor(r.color) ? r.color : "default", archived: r.archivedAt !== null }));
}

const OPEN: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"];
const ALL_STATUSES: LeadStatus[] = [...OPEN, "WON", "LOST", "DISQUALIFIED"];
const SOURCES: LeadSource[] = ["WEBSITE", "REFERRAL", "LINKEDIN", "CALLING", "EMAIL", "EVENT", "PARTNER", "ADVERTISEMENT", "EXISTING_CUSTOMER", "WALK_IN", "OTHER"];
const LOST_REASONS = ["Price — went with a cheaper quote", "Stayed with their incumbent partner", "Budget pulled for this year", "No response after the proposal"];
const DISQUALIFIED_REASONS = ["Student project, not a business", "Outside the regions we serve", "Wants on-premise only — not something we sell", "Duplicate of an enquiry already open"];

/** The stages a lead passed through to end where it is — a deal qualified on the first call skips Qualifying. */
function pathTo(status: LeadStatus): LeadStatus[] {
  const upto = (s: LeadStatus) => OPEN.slice(0, OPEN.indexOf(s) + 1);
  let path: LeadStatus[];
  if (OPEN.includes(status)) path = upto(status);
  else if (status === "WON") path = [...OPEN, "WON"];
  else if (status === "LOST") path = [...upto(pick(["CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"] as const)), "LOST"];
  else path = [...upto(pick(["NEW", "CONTACTED", "QUALIFYING"] as const)), "DISQUALIFIED"];
  if (path.length > 4 && chance(0.35)) path = path.filter((s, i) => !(s === "QUALIFYING" && i < path.length - 1));
  return path;
}

function sourceDetail(source: LeadSource, book: BookCompany[], company: BookCompany): string {
  const customers = book.filter((c) => c.stage === "CUSTOMER" && c.relationshipType === "CLIENT" && c.id !== company.id && c.contacts.length);
  const partners = book.filter((c) => c.relationshipType === "PARTNER" || c.relationshipType === "RESELLER");
  switch (source) {
    case "WEBSITE": return pick(["Contact us form — /contact", "Pricing page enquiry — /microsoft-365", "Live chat on the website", "Downloaded the Microsoft 365 licensing guide"]);
    case "REFERRAL": {
      const ref = customers.length ? pick(customers) : null;
      return ref ? `Referred by ${ref.contacts[0]!.name} at ${ref.name}` : "Referred by an existing customer";
    }
    case "LINKEDIN": return pick(["Replied to a LinkedIn InMail", "LinkedIn campaign — security month", "Connected after a LinkedIn post"]);
    case "CALLING": return pick(["Cold call — Mumbai manufacturing list", "Cold call — Pune IT services list", "Cold call — Bengaluru mid-market list"]);
    case "EMAIL": return pick(["Replied to the Microsoft 365 renewal mailer", "Answered the Copilot launch email", "Wrote in to the sales inbox"]);
    case "EVENT": return pick(["Partner day, Pune", "CIO roundtable, Mumbai", "Cybersecurity summit, Bengaluru"]);
    case "PARTNER": return partners.length ? `Registered by ${pick(partners).name}` : "Registered by a partner";
    case "ADVERTISEMENT": return pick(["Search ad — Microsoft 365 reseller", "Sponsored LinkedIn post", "Print ad in the chamber newsletter"]);
    case "EXISTING_CUSTOMER": return pick(["Came up in the renewal call", "Asked for it at the quarterly review", "Raised by their IT head on a support call"]);
    case "WALK_IN": return pick(["Walked into the Pune office", "Stopped at our stall at the IT mall"]);
    case "OTHER": return pick(["Trade directory listing", "Old enquiry found in the shared inbox"]);
  }
}

const LEAD_TITLES = [
  "Intune rollout for 300 laptops", "Microsoft 365 E3 upgrade — 180 seats", "Firewall refresh at two plants",
  "Backup and DR for the ERP servers", "Adobe Acrobat Pro for the legal team", "Wi-Fi 6 for the new office floor",
  "Endpoint protection renewal — 250 seats", "Teams Rooms for four meeting rooms", "AutoCAD LT for the design studio",
  "Google Workspace to Microsoft 365 migration", "Server room UPS and racks", "Zero-trust remote access for field staff",
  "Laptop lease — 60 units", "SIEM and log retention", "Annual maintenance for 40 desktops",
  "SharePoint intranet build", "Business Central pilot for finance", "Copilot for Microsoft 365 trial — 25 users",
  "CCTV and access control for the warehouse", "Email security add-on", "Network audit across branches",
  "Rugged tablets for the field team", "Azure landing zone and migration", "Printer fleet consolidation",
  "Data-loss prevention for HR and finance", "Video-conferencing kit for the board room", "Office licences for the new branch",
];

const TOUCH_NOTES = {
  EMAIL: ["Sent the comparison sheet they asked for.", "Shared the licensing options by email.", "Followed up on the quote from last week."],
  NOTE: ["Their financial year closes in March — budget is there till then.", "IT head is the champion; purchase signs off.", "Waiting on their internal audit before anything moves."],
  CALL: ["Walked through the quote on the phone", "Asked for a revised price for 3 years", "Confirmed the seat count", "Agreed a demo slot"],
};

/** A call against a lead: the call log, and the line it puts on the lead's timeline (src/actions/call.ts). */
async function leadCall(db: Db, o: { companyId: string; contactId: string | null; phoneNumber: string; leadId: string; userId: string; at: Date; outcome: CallOutcome; notes: string | null; direction?: "INBOUND" | "OUTBOUND" }): Promise<string> {
  const talked = o.outcome === "CONNECTED" || o.outcome === "CALLBACK_REQUESTED" || o.outcome === "NOT_INTERESTED";
  const call = await db.callLog.create({
    data: {
      companyId: o.companyId, contactId: o.contactId, leadId: o.leadId, phoneNumber: o.phoneNumber, direction: o.direction ?? "OUTBOUND", outcome: o.outcome,
      startedAt: o.at, durationSeconds: talked ? int(90, 900) : o.outcome === "LEFT_VOICEMAIL" ? int(18, 45) : 0, notes: o.notes, userId: o.userId, createdAt: o.at,
    },
    select: { id: true },
  });
  await db.activity.create({
    data: { leadId: o.leadId, userId: o.userId, type: "CALL", notes: `${o.outcome.replaceAll("_", " ").toLowerCase()}${o.notes ? ` — ${o.notes}` : ""}`, occurredAt: o.at, createdAt: o.at },
  });
  return call.id;
}

/** How many of an item a company this size asks for — the demo's own rule (activity.ts `quantityFor`): seats scale, big tickets don't. */
function quantityFor(item: DemoContext["items"][number], employees: number): number {
  if (item.type === "SUBSCRIPTION") return item.price > 40_000 ? int(1, 4) : Math.min(Math.max(3, Math.round(employees * (0.3 + rnd() * 0.6))), int(5, 160));
  if (item.type === "SERVICE") return item.price <= 3_000 ? int(10, Math.max(20, employees)) : 1;
  if (item.price > 250_000) return int(1, 2);
  if (item.price > 80_000) return int(1, 4);
  if (item.price > 30_000) return int(1, 12);
  return int(2, 40);
}

function requirementsFor(ctx: DemoContext, employees: number) {
  return some(ctx.items, int(1, 3)).map((item) => ({ itemId: item.id, quantity: quantityFor(item, employees), price: item.price, type: item.type }));
}

async function coverLeads(db: Db, ctx: DemoContext, cast: Cast) {
  const stages = await pipeline(db);
  if (!stages) {
    log("CRM: leads", "no pipeline stages in this workspace — left as they are");
    return;
  }
  const stageOf = (status: LeadStatus) => stageForStatus(stages, status)!;

  // ── Every lead in the stage its status means, moved there when its history last says it moved ──
  // The rule migration 20261015100000_lead_pipeline applied to every lead that was already there.
  const unstaged = await db.lead.findMany({ where: { stageId: null, company: { tags: { has: DEMO_TAG } } }, select: { id: true, status: true, createdAt: true } });
  const moves = new Map(
    (await db.activity.groupBy({ by: ["leadId"], where: { type: "STAGE_CHANGE", leadId: { in: unstaged.map((l) => l.id) } }, _max: { occurredAt: true } })).map((r) => [r.leadId, r._max.occurredAt]),
  );
  for (const l of unstaged) {
    // Never before the lead existed: a few of the demo's own stage-change notes are dated earlier.
    const last = moves.get(l.id);
    await db.lead.update({ where: { id: l.id }, data: { stageId: stageOf(l.status).id, stageChangedAt: last && last > l.createdAt ? last : l.createdAt } });
  }

  // ── Where each lead came from ──
  const book = await loadBook(db);
  const byId = new Map(book.map((c) => [c.id, c]));
  const callerIds = new Set(cast.callers.map((c) => c.id));
  const unsourced = await db.lead.findMany({
    where: { company: { tags: { has: DEMO_TAG } }, source: "OTHER", sourceDetail: null, captureKeyId: null },
    orderBy: { leadSeq: "asc" },
    select: { id: true, sourcedByUserId: true, companyId: true },
  });
  const weighted: LeadSource[] = ["WEBSITE", "WEBSITE", "REFERRAL", "REFERRAL", "LINKEDIN", "LINKEDIN", "EMAIL", "EVENT", "PARTNER", "ADVERTISEMENT", "WALK_IN", "OTHER"];
  for (const l of unsourced) {
    const company = byId.get(l.companyId);
    if (!company) continue;
    const source: LeadSource =
      l.sourcedByUserId && callerIds.has(l.sourcedByUserId) ? "CALLING"
      : company.stage === "CUSTOMER" && chance(0.3) ? "EXISTING_CUSTOMER"
      : pick(weighted);
    await db.lead.update({ where: { id: l.id }, data: { source, sourceDetail: sourceDetail(source, book, company) } });
  }

  // ── Leads with their whole story: every status three times — just moved, a few weeks on, stuck ──
  if (await db.lead.count({ where: { title: { in: LEAD_TITLES }, company: { tags: { has: DEMO_TAG } } } })) {
    log("CRM: leads", `${unstaged.length} staged, ${unsourced.length} sourced; the storied leads are already there`);
    return;
  }
  const used = new Set<string>();
  const take = (pool: BookCompany[]) => {
    const free = pool.filter((c) => !used.has(c.id));
    const c = free.length ? free[Math.floor(rnd() * free.length)]! : null;
    if (c) used.add(c.id);
    return c;
  };
  const isClient = (c: BookCompany) => c.relationshipType === "CLIENT" && direct(c);
  const prospects = book.filter((c) => isClient(c) && c.stage === "PROSPECT" && c._count.leads === 0 && c.locations[0]?.country !== "United Arab Emirates");
  const leadCos = book.filter((c) => isClient(c) && c.stage === "LEAD");
  const customers = book.filter((c) => isClient(c) && c.stage === "CUSTOMER");
  // The new companies at the Lead stage need the lead that put them there.
  const bound = new Map<LeadStatus, BookCompany>();
  for (const [name, status] of [["Bluefin Analytics Inc", "QUALIFIED"], ["Asha Shiksha Foundation", "NEW"], ["Kaveri District e-Governance Society", "PROPOSAL_SENT"], ["Dr Kavita Menon", "CONTACTED"]] as const) {
    const c = book.find((x) => x.name === name && x._count.leads === 0);
    if (c) {
      bound.set(status, c);
      used.add(c.id);
    }
  }
  const salesIds = new Set([...cast.accountManagers, ...cast.presales].map((p) => p.id));

  let created = 0;
  const moved = { recent: 0, stalled: 0 };
  for (const [i, title] of LEAD_TITLES.entries()) {
    const status = ALL_STATUSES[Math.floor(i / 3)]!;
    const variant = (["recent", "mid", "stalled"] as const)[i % 3];
    let source = SOURCES[i % SOURCES.length]!;
    let company: BookCompany | null = null;
    if (bound.has(status)) {
      company = bound.get(status)!;
      bound.delete(status);
      source = NEW_COMPANIES.find((n) => n.name === company!.name)?.source === "REFERRAL" ? "REFERRAL" : source === "EXISTING_CUSTOMER" ? "LINKEDIN" : source;
    } else if (source === "EXISTING_CUSTOMER") company = take(customers);
    else if (status === "WON") company = variant === "recent" ? take(leadCos) : take(customers);
    else if (status === "NEW" || status === "DISQUALIFIED") company = take(prospects) ?? take(leadCos);
    else company = take(leadCos) ?? take(prospects);
    if (!company) continue;

    // The account gets an owner once there is a deal on it, if it had none.
    const ownerId = company.ownerUserId && salesIds.has(company.ownerUserId) ? company.ownerUserId : (company.ownerUserId ?? pick(cast.accountManagers).id);
    const path = pathTo(status);
    const closed = !OPEN.includes(status);
    const lastAgo = variant === "recent" ? int(0, 4) : variant === "mid" ? int(8, 25) : closed ? int(30, 160) : int(40, 110);
    const gaps = path.slice(1).map(() => int(3, 12));
    const room = Math.max(lastAgo + 1, Math.min(COMPANY_AGE_DAYS - 5, Math.floor(daysSince(company.createdAt)) - 1));
    const span = gaps.reduce((t, g) => t + g, 0);
    const scale = lastAgo + span > room ? Math.max(0, room - lastAgo) / Math.max(1, span) : 1;
    // Days ago of each step, newest last; then moments in working hours, kept in order.
    const ago: number[] = [];
    let cursor = lastAgo;
    ago.unshift(cursor);
    for (const g of [...gaps].reverse()) {
      cursor += g * scale;
      ago.unshift(cursor);
    }
    const times: Date[] = [];
    for (const [k, d] of ago.entries()) {
      let t = workedAt(d);
      const prev = times[k - 1];
      if (prev && t.getTime() <= prev.getTime()) t = new Date(Math.min(prev.getTime() + int(30, 240) * MINUTE, NOW.getTime() - (ago.length - k) * MINUTE));
      times.push(t);
    }
    const createdAt = times[0]!;
    const lastMove = times[times.length - 1]!;
    const qualifierAt = path.indexOf("QUALIFIED");
    const qualifier = qualifierAt > 0 ? (chance(0.3) ? pick(cast.presales).id : ownerId) : null;
    const reason = status === "LOST" ? pick(LOST_REASONS) : status === "DISQUALIFIED" ? pick(DISQUALIFIED_REASONS) : null;
    const reqs = requirementsFor(ctx, company.employeeCount ?? 30);
    const value = Math.round(reqs.reduce((t, r) => t + r.price * r.quantity, 0) / 1000) * 1000;
    const contact = company.contacts[0] ?? null;
    const closeDay = closed ? dayOf(lastMove) : dayOf(new Date(lastMove.getTime() + int(10, 75) * DAY));
    const sourcedBy = source === "CALLING" ? pick(cast.callers).id : company.createdById;

    const lead = await db.lead.create({
      data: {
        companyId: company.id,
        contactId: contact?.id ?? null,
        title,
        description: `${company.name}: ${title.toLowerCase()}.`,
        status,
        stageId: stageOf(status).id,
        stageChangedAt: lastMove,
        lostReason: reason,
        sourcedByUserId: sourcedBy,
        qualifiedByUserId: qualifier,
        ownerUserId: ownerId,
        estimatedValue: value,
        expectedCloseDate: closeDay,
        createdByUserId: source === "CALLING" ? sourcedBy : ownerId,
        source,
        sourceDetail: sourceDetail(source, book, company),
        createdAt,
        requirements: {
          create: reqs.map((r) => ({
            itemId: r.itemId,
            quantity: r.quantity,
            notes: chance(0.3) ? "Confirmed on the call" : null,
            renewalDate: r.type === "SUBSCRIPTION" && source === "EXISTING_CUSTOMER" ? dayOf(new Date(NOW.getTime() + int(20, 120) * DAY)) : null,
            createdAt,
          })),
        },
      },
      select: { id: true },
    });

    // The trail: every move with the note the app writes, and the work between moves.
    for (let k = 1; k < path.length; k++) {
      const mover = k === qualifierAt && qualifier ? qualifier : ownerId;
      await db.activity.create({
        data: {
          leadId: lead.id, userId: mover, type: "STAGE_CHANGE",
          notes: stageChangeNote(stageOf(path[k - 1]!), stageOf(path[k]!), k === path.length - 1 ? reason : null),
          occurredAt: times[k]!, createdAt: times[k]!,
        },
      });
      // Something happened between the two moves, most of the time.
      const from = times[k - 1]!.getTime();
      const to = times[k]!.getTime();
      if (to - from > 2 * 3600_000 && chance(0.75)) {
        const when = between(times[k - 1]!, times[k]!);
        const kind = pick(["CALL", "CALL", "EMAIL", "NOTE"] as const);
        if (kind === "CALL") {
          await leadCall(db, { companyId: company.id, contactId: contact?.id ?? null, phoneNumber: contact?.phone ?? phone(), leadId: lead.id, userId: ownerId, at: when, outcome: pick(["CONNECTED", "CONNECTED", "NO_ANSWER", "LEFT_VOICEMAIL"] as const), notes: pick(TOUCH_NOTES.CALL) });
        } else {
          await db.activity.create({ data: { leadId: lead.id, userId: ownerId, type: kind, notes: pick(TOUCH_NOTES[kind]), occurredAt: when, createdAt: when } });
        }
      }
    }
    // A lead still moving has been touched since; a stuck one has not.
    if (!closed && variant !== "stalled" && chance(0.7)) {
      const when = between(lastMove, plus(NOW, -10));
      await db.activity.create({ data: { leadId: lead.id, userId: ownerId, type: "EMAIL", notes: pick(TOUCH_NOTES.EMAIL), occurredAt: when, createdAt: when } });
    }
    // The thin proposal record, once one went out.
    const sentAt = times[path.indexOf("PROPOSAL_SENT")];
    if (sentAt) {
      await db.proposal.create({
        data: {
          leadId: lead.id, sentByUserId: ownerId, sentAt, validUntil: new Date(sentAt.getTime() + 30 * DAY), createdAt: sentAt,
          status: status === "WON" ? "ACCEPTED" : status === "LOST" ? "REJECTED" : sentAt.getTime() < NOW.getTime() - 30 * DAY ? "EXPIRED" : "SENT",
          notes: "Pricing held for thirty days.",
        },
      });
    }
    // The company moves with it: a prospect with a lead is a lead, a won one is a customer.
    const stage = status === "WON" ? "CUSTOMER" : company.stage === "PROSPECT" ? "LEAD" : null;
    if (stage || !company.ownerUserId) {
      await db.company.update({
        where: { id: company.id },
        data: {
          ...(stage ? { stage } : {}),
          ...(!company.ownerUserId ? { ownerUserId: ownerId, assignedToUserId: company.assignedToUserId ?? ownerId, assignedByUserId: cast.headOfSales.id, assignedAt: createdAt } : {}),
        },
      });
    }
    created += 1;
    if (!closed && variant === "recent") moved.recent += 1;
    if (!closed && variant === "stalled") moved.stalled += 1;
  }

  // ── Some of the demo's own open deals moved this week ──
  const older = await db.lead.findMany({
    where: { company: { tags: { has: DEMO_TAG }, managedByResellerId: null }, status: { in: ["CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"] }, title: { notIn: LEAD_TITLES }, stageChangedAt: { lt: new Date(NOW.getTime() - 14 * DAY) } },
    orderBy: { leadSeq: "asc" },
    select: { id: true, status: true, ownerUserId: true, qualifiedByUserId: true },
  });
  let nudged = 0;
  for (const l of older.filter((_, i) => i % 4 === 0).slice(0, 8)) {
    const prev = OPEN[OPEN.indexOf(l.status) - 1]!;
    const when = workedAt(int(0, 5));
    const by = l.ownerUserId ?? pick(cast.accountManagers).id;
    await db.activity.create({ data: { leadId: l.id, userId: by, type: "STAGE_CHANGE", notes: stageChangeNote(stageOf(prev), stageOf(l.status)), occurredAt: when, createdAt: when } });
    await db.lead.update({ where: { id: l.id }, data: { stageChangedAt: when, ...(l.status === "QUALIFIED" && !l.qualifiedByUserId ? { qualifiedByUserId: by } : {}) } });
    nudged += 1;
  }
  log("CRM: leads", `${unstaged.length} staged, ${unsourced.length} sourced, ${created} with their full trail (${moved.recent} open ones just moved, ${moved.stalled} stuck), ${nudged} older deals moved this week`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Calls: customers ringing in, and voicemails left
// ════════════════════════════════════════════════════════════════════════════════════════════════

async function callback(db: Db, o: { callId: string; companyName: string; contactName: string | null; phoneNumber: string; notes: string | null; due: Date; userId: string; companyId: string; leadId?: string | null; ticketId?: string | null; at: Date; done: boolean }) {
  const task = await db.task.create({
    data: {
      title: `Call back ${o.contactName ?? o.companyName}${o.contactName ? ` at ${o.companyName}` : ""}`,
      description: o.notes ? `Promised on the call: ${o.notes}` : `Promised during a call to ${o.phoneNumber}.`,
      dueDate: o.due, assignedToUserId: o.userId, createdByUserId: o.userId, companyId: o.companyId, leadId: o.leadId ?? null, ticketId: o.ticketId ?? null,
      done: o.done, doneAt: o.done ? plus(o.due, int(-60, 240)) : null, createdAt: o.at,
    },
    select: { id: true },
  });
  await db.callLog.update({ where: { id: o.callId }, data: { followUpTaskId: task.id, followUpDone: o.done } });
}

const VOICEMAIL_NOTES = ["Left a voicemail asking for a call back", "Left a voicemail about the renewal quote", "Voicemail — said I'd try again Thursday", "Left my number and the reason for the call"];

async function coverCalls(db: Db, cast: Cast) {
  if (await db.callLog.count({ where: { outcome: "LEFT_VOICEMAIL", notes: { in: VOICEMAIL_NOTES }, company: { tags: { has: DEMO_TAG } } } })) {
    log("CRM: calls", "inbound calls and voicemails already there");
    return;
  }
  const book = await loadBook(db);
  const byId = new Map(book.map((c) => [c.id, c]));
  let inbound = 0;
  let voicemails = 0;
  let callbacks = 0;

  // Support lines: customers ringing about their tickets.
  const tickets = await db.ticket.findMany({
    where: { company: { tags: { has: DEMO_TAG }, managedByResellerId: null }, status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD", "RESOLVED"] } },
    orderBy: { ticketSeq: "asc" },
    select: { id: true, companyId: true, contactId: true, assignedToUserId: true, createdAt: true, resolvedAt: true },
  });
  for (const t of some(tickets, 10)) {
    const c = byId.get(t.companyId);
    if (!c) continue;
    const contact = c.contacts.find((x) => x.id === t.contactId) ?? c.contacts[0] ?? null;
    const startedAt = between(t.createdAt, t.resolvedAt ?? plus(NOW, -10));
    await db.callLog.create({
      data: {
        companyId: c.id, contactId: contact?.id ?? null, ticketId: t.id, phoneNumber: contact?.phone ?? landline(), direction: "INBOUND", outcome: "CONNECTED",
        startedAt, durationSeconds: int(120, 900), userId: t.assignedToUserId ?? pick(cast.support).id, createdAt: startedAt,
        notes: pick(["Rang in for an update on the ticket", "Called to say the problem is back after the restart", "Called to confirm the engineer's visit time", "Wants it escalated — their CFO can't send mail"]),
      },
    });
    inbound += 1;
  }

  // Customers ringing about their orders.
  const orders = await db.companyProduct.findMany({
    where: { company: { tags: { has: DEMO_TAG }, managedByResellerId: null, relationshipType: "CLIENT" }, orderStatus: { in: ["APPROVED", "PROCESSING"] } },
    orderBy: { orderSeq: "asc" },
    select: { id: true, companyId: true, createdAt: true },
  });
  for (const o of some(orders, 8)) {
    const c = byId.get(o.companyId);
    if (!c?.ownerUserId) continue;
    const contact = c.contacts[0] ?? null;
    const startedAt = workedAt(int(1, Math.max(2, Math.min(90, Math.floor(daysSince(o.createdAt))))));
    await db.callLog.create({
      data: {
        companyId: c.id, contactId: contact?.id ?? null, companyProductId: o.id, phoneNumber: contact?.phone ?? landline(), direction: "INBOUND", outcome: "CONNECTED",
        startedAt, durationSeconds: int(60, 420), userId: c.ownerUserId, createdAt: startedAt,
        notes: pick(["Asked when the licences will be assigned", "Wanted the delivery date for the laptops", "Called about the invoice on this order", "Wants the order split across two locations"]),
      },
    });
    inbound += 1;
  }

  // Prospects and customers ringing about a deal: on the lead's timeline as well.
  // Only deals that are moving — a customer ringing in is not what a stuck deal looks like.
  const deals = await db.lead.findMany({
    where: { title: { in: LEAD_TITLES }, status: { in: OPEN }, stageChangedAt: { gte: new Date(NOW.getTime() - 30 * DAY) }, company: { tags: { has: DEMO_TAG } } },
    orderBy: { leadSeq: "asc" },
    select: { id: true, companyId: true, contactId: true, ownerUserId: true, stageChangedAt: true },
  });
  for (const [i, d] of deals.slice(0, 8).entries()) {
    const c = byId.get(d.companyId);
    if (!c || !d.ownerUserId) continue;
    const contact = c.contacts.find((x) => x.id === d.contactId) ?? c.contacts[0] ?? null;
    const startedAt = between(d.stageChangedAt!, plus(NOW, -10));
    const outcome: CallOutcome = i % 4 === 3 ? "CALLBACK_REQUESTED" : "CONNECTED";
    const notes = outcome === "CALLBACK_REQUESTED"
      ? "Rang while I was with another customer — wants a call back with the revised numbers"
      : pick(["Called back after our email — wants pricing for 50 more seats", "Rang to ask for a demo next week", "Called to check the delivery lead time before they approve"]);
    const callId = await leadCall(db, { companyId: c.id, contactId: contact?.id ?? null, phoneNumber: contact?.phone ?? phone(), leadId: d.id, userId: d.ownerUserId, at: startedAt, outcome, notes, direction: "INBOUND" });
    if (outcome === "CALLBACK_REQUESTED") {
      const due = slotAhead(int(1, 3), 11, 13);
      await db.callLog.update({ where: { id: callId }, data: { followUpAt: due } });
      await callback(db, { callId, companyName: c.name, contactName: contact?.name ?? null, phoneNumber: contact?.phone ?? "", notes, due, userId: d.ownerUserId, companyId: c.id, leadId: d.id, at: startedAt, done: false });
      callbacks += 1;
    }
    inbound += 1;
  }

  // Voicemails: the calling team on prospects, account managers on their customers.
  const prospectCos = book.filter((c) => direct(c) && c.relationshipType === "CLIENT" && (c.stage === "PROSPECT" || c.stage === "LEAD"));
  const customerCos = book.filter((c) => direct(c) && c.relationshipType === "CLIENT" && c.stage === "CUSTOMER" && c.ownerUserId);
  const voicemailFor = [...some(prospectCos, 12).map((c) => ({ c, by: c.assignedToUserId && cast.callers.some((x) => x.id === c.assignedToUserId) ? c.assignedToUserId : pick(cast.callers).id })), ...some(customerCos, 12).map((c) => ({ c, by: c.ownerUserId! }))];
  for (const [i, { c, by }] of voicemailFor.entries()) {
    const contact = c.contacts[0] ?? null;
    const startedAt = workedAt(i % 3 === 0 ? int(0, 6) : int(7, 120));
    const notes = pick(VOICEMAIL_NOTES);
    const call = await db.callLog.create({
      data: {
        companyId: c.id, contactId: contact?.id ?? null, phoneNumber: contact?.phone ?? phone(), direction: "OUTBOUND", outcome: "LEFT_VOICEMAIL",
        startedAt, durationSeconds: int(18, 45), notes, userId: by, createdAt: startedAt,
      },
      select: { id: true },
    });
    voicemails += 1;
    if (i % 5 < 2) {
      // A callback promised for later: some still to come, some done, a couple let slip.
      const due = startedAt.getTime() > NOW.getTime() - 5 * DAY ? slotAhead(int(1, 4), 10, 17) : plus(startedAt, int(2, 5) * 24 * 60);
      const done = due.getTime() < NOW.getTime() && chance(0.7);
      await db.callLog.update({ where: { id: call.id }, data: { followUpAt: due } });
      await callback(db, { callId: call.id, companyName: c.name, contactName: contact?.name ?? null, phoneNumber: contact?.phone ?? "", notes, due, userId: by, companyId: c.id, at: startedAt, done });
      callbacks += 1;
    }
  }
  log("CRM: calls", `${inbound} inbound (tickets, orders, deals), ${voicemails} voicemails, ${callbacks} callbacks promised`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Visits
// ════════════════════════════════════════════════════════════════════════════════════════════════

const AGENDA: Record<VisitPurpose, string[]> = {
  INTRO_MEETING: ["First meeting with the IT head — who we are and what they run today", "Introductions with the new CIO"],
  REQUIREMENT_GATHERING: ["Walk the server room and list what's out of warranty", "Count seats per department for the licence quote"],
  PRODUCT_DEMO: ["Demo Intune enrolment on two of their laptops", "Show Teams Rooms in their board room"],
  PROPOSAL_DISCUSSION: ["Go through the quotation line by line with purchase", "Walk the director through the three-year option"],
  NEGOTIATION: ["Close out pricing and payment terms with the director", "Agree the discount for a three-year commitment"],
  ORDER_COLLECTION: ["Collect the signed PO and the advance cheque", "Pick up the signed order form"],
  PAYMENT_FOLLOW_UP: ["Collect the cheque for the overdue invoice", "Meet accounts about the two unpaid invoices"],
  SUPPORT_ESCALATION: ["On-site fix for the recurring Outlook sync issue", "Look at the Wi-Fi drops on the second floor"],
  RELATIONSHIP_BUILDING: ["Quarterly review with the CIO", "Lunch with the IT team after the go-live"],
  DELIVERY_INSTALLATION: ["Deliver and install the switches at the plant", "Hand over and set up 20 laptops"],
  OTHER: ["Drop off the signed NDA and collect the vendor registration form", "Attend their vendor meet"],
};
const DONE_NOTES: Record<VisitPurpose, string[]> = {
  INTRO_MEETING: ["Good first meeting. They run Google Workspace; renewal in February. Sending a comparison."],
  REQUIREMENT_GATHERING: ["Listed 14 machines out of warranty and two switches. Quote by Friday."],
  PRODUCT_DEMO: ["Demo went well — IT head wants a 10-user pilot."],
  PROPOSAL_DISCUSSION: ["Went through the quote; they want the AMC priced separately."],
  NEGOTIATION: ["Agreed 6% off for three years, advance payment. PO next week."],
  ORDER_COLLECTION: ["Collected the signed PO. Advance cheque comes on Monday."],
  PAYMENT_FOLLOW_UP: ["Collected the cheque for one invoice; the other is with their CFO."],
  SUPPORT_ESCALATION: ["Fixed — the old profile was syncing twice. Customer happy."],
  RELATIONSHIP_BUILDING: ["Quarterly review done; they'll add the new branch next quarter."],
  DELIVERY_INSTALLATION: ["Delivered and installed. Sign-off received."],
  OTHER: ["Handed over the NDA, collected the registration form."],
};
const SALES_PURPOSES: VisitPurpose[] = ["INTRO_MEETING", "REQUIREMENT_GATHERING", "PROPOSAL_DISCUSSION", "NEGOTIATION", "ORDER_COLLECTION", "PAYMENT_FOLLOW_UP", "RELATIONSHIP_BUILDING", "OTHER"];
const FIELD_PURPOSES: VisitPurpose[] = ["DELIVERY_INSTALLATION", "SUPPORT_ESCALATION"];

/** What the app asks for when a visit is called off or nobody was there (src/actions/visit.ts `setVisitStatus`). */
const CANCELLED_NOTES = ["Customer asked to move it — their CFO is travelling.", "Postponed: their office is shut for an audit this week.", "Cancelled — they want a call first, not a visit.", "Customer cancelled; the IT head has left the company.", "Rescheduled at the customer's request."];
const NO_SHOW_NOTES = ["Reached at 11; reception had no record of the meeting and the contact wasn't answering.", "Contact was out on site — nobody else could take the meeting.", "Waited 40 minutes, then left. Rebooking by phone.", "Office closed for a local holiday nobody mentioned."];

async function coverVisits(db: Db, cast: Cast) {
  if (await db.visit.count({ where: { outcome: { in: [...CANCELLED_NOTES, ...NO_SHOW_NOTES] }, company: { tags: { has: DEMO_TAG } } } })) {
    log("CRM: visits", "planned, checked-in, cancelled and missed visits already there");
    return;
  }
  const book = (await loadBook(db)).filter((c) => direct(c) && c.relationshipType === "CLIENT" && c.locations[0] && c.locations[0].country !== "United States" && c.locations[0].country !== "United Arab Emirates");
  const openLeads = await db.lead.findMany({
    where: { company: { tags: { has: DEMO_TAG }, managedByResellerId: null }, status: { in: ["QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON"] } },
    select: { id: true, companyId: true, status: true, ownerUserId: true, contactId: true },
  });
  const leadAt = (companyId: string, statuses: LeadStatus[]) => openLeads.find((l) => l.companyId === companyId && statuses.includes(l.status));
  const ownedBy = (userId: string) => book.filter((c) => c.ownerUserId === userId);
  const customers = book.filter((c) => c.stage === "CUSTOMER");
  const purposeLeads: Partial<Record<VisitPurpose, LeadStatus[]>> = { PROPOSAL_DISCUSSION: ["PROPOSAL_SENT"], NEGOTIATION: ["NEGOTIATION"], ORDER_COLLECTION: ["WON"], PRODUCT_DEMO: ["QUALIFIED"] };

  /** Who goes, and where: account managers to their own accounts, engineers to customers. */
  const placeFor = (purpose: VisitPurpose) => {
    if (FIELD_PURPOSES.includes(purpose)) return { userId: pick(cast.field).id, company: pick(customers) };
    const wanted = purposeLeads[purpose];
    if (wanted) {
      const l = some(openLeads.filter((x) => wanted.includes(x.status) && x.ownerUserId && book.some((c) => c.id === x.companyId)), 1)[0];
      if (l) return { userId: purpose === "PRODUCT_DEMO" ? pick(cast.presales).id : l.ownerUserId!, company: book.find((c) => c.id === l.companyId)! };
    }
    const person = pick(cast.accountManagers);
    const mine = ownedBy(person.id);
    return { userId: person.id, company: mine.length ? pick(mine) : pick(customers) };
  };

  let count = 0;
  const tally: Record<string, number> = {};
  const add = async (o: { purpose: VisitPurpose; status: "PLANNED" | "CHECKED_IN" | "COMPLETED" | "CANCELLED" | "NO_SHOW"; scheduledFor: Date; outcome?: string; createdAt?: Date }) => {
    const { userId, company } = placeFor(o.purpose);
    const wanted = purposeLeads[o.purpose];
    const lead = wanted ? leadAt(company.id, wanted) : undefined;
    const contact = company.contacts.find((x) => x.id === lead?.contactId) ?? company.contacts[0] ?? null;
    const checkInAt = o.status === "COMPLETED" || o.status === "CHECKED_IN" ? plus(o.scheduledFor, int(-10, 20)) : null;
    const inAt = checkInAt && checkInAt.getTime() > NOW.getTime() - 2 * MINUTE ? plus(NOW, -int(3, 15)) : checkInAt;
    await db.visit.create({
      data: {
        companyId: company.id,
        contactId: contact?.id ?? null,
        leadId: lead?.id ?? null,
        locationId: company.locations[0]!.id,
        purpose: o.purpose,
        status: o.status,
        agenda: pick(AGENDA[o.purpose]),
        scheduledFor: o.scheduledFor,
        checkInAt: inAt,
        checkOutAt: o.status === "COMPLETED" && inAt ? plus(inAt, int(30, 150)) : null,
        address: addressOf(company),
        outcome: o.outcome ?? (o.status === "COMPLETED" ? pick(DONE_NOTES[o.purpose]) : null),
        distanceKm: o.status === "COMPLETED" || o.status === "CHECKED_IN" || o.status === "NO_SHOW" ? int(4, 45) : null,
        userId,
        createdAt: o.createdAt ?? new Date(Math.min(NOW.getTime() - MINUTE, o.scheduledFor.getTime() - int(1, 6) * DAY)),
      },
    });
    count += 1;
    tally[o.status] = (tally[o.status] ?? 0) + 1;
  };
  const purposes = (list: VisitPurpose[], i: number) => list[i % list.length]!;
  const everyPurpose = Object.keys(AGENDA) as VisitPurpose[];

  // Planned over the next three weeks, three of them later today.
  for (let i = 0; i < 3; i++) await add({ purpose: purposes(everyPurpose, i * 4), status: "PLANNED", scheduledFor: laterToday(), createdAt: workedAt(int(1, 6)) });
  for (let i = 0; i < 19; i++) await add({ purpose: purposes(everyPurpose, i), status: "PLANNED", scheduledFor: slotAhead(int(1, 21)), createdAt: workedAt(int(0, 8)) });
  // Out on one right now: checked in this morning, not written up yet.
  for (let i = 0; i < 3; i++) await add({ purpose: purposes(["DELIVERY_INSTALLATION", "REQUIREMENT_GATHERING", "SUPPORT_ESCALATION"], i), status: "CHECKED_IN", scheduledFor: earlierToday(), createdAt: workedAt(int(1, 5)) });
  // Done, across every purpose — the demo's own visits leave five of them out.
  for (let i = 0; i < everyPurpose.length + 3; i++) await add({ purpose: purposes(everyPurpose, i), status: "COMPLETED", scheduledFor: workedAt(int(1, 120)) });
  // Called off, with the reason the app asks for.
  const cancelled = CANCELLED_NOTES;
  for (let i = 0; i < 6; i++) {
    const past = i < 4;
    await add({ purpose: purposes(SALES_PURPOSES, i + 2), status: "CANCELLED", scheduledFor: past ? workedAt(int(2, 60)) : slotAhead(int(2, 14)), outcome: cancelled[i % cancelled.length]!, createdAt: past ? undefined : workedAt(int(1, 5)) });
  }
  // Went, and nobody was there.
  const noShows = NO_SHOW_NOTES;
  for (let i = 0; i < 4; i++) await add({ purpose: purposes(SALES_PURPOSES, i), status: "NO_SHOW", scheduledFor: workedAt(int(2, 75)), outcome: noShows[i]! });
  log("CRM: visits", `${count} — ${Object.entries(tally).map(([k, n]) => `${n} ${k.toLowerCase().replace("_", " ")}`).join(", ")}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Meetings scheduled from records (calendar events)
// ════════════════════════════════════════════════════════════════════════════════════════════════

const TEAMS_TENANT = "6f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f";

async function coverMeetings(db: Db, cast: Cast, app: App) {
  if (await db.calendarEvent.count({ where: { fromDeskzo: true, joinUrl: { contains: TEAMS_TENANT } } })) {
    log("CRM: meetings", "meetings scheduled from records already there");
    return;
  }
  const people = [...cast.accountManagers, ...cast.presales.slice(0, 2), ...(cast.headOfSales.id !== cast.admin.id ? [cast.headOfSales as Person] : [])];
  const book = await loadBook(db);
  const byId = new Map(book.map((c) => [c.id, c]));
  const objectIds = new Map(people.map((p) => [p.id, guid()]));
  const busy = new Set<string>();
  /** A free slot in this person's day — nobody books two meetings on top of each other. */
  const slot = (userId: string, dayOffset: number, minutes: number) => {
    for (let tries = 0; tries < 12; tries++) {
      const off = offSunday(dayOffset + (tries > 5 ? tries - 5 : 0));
      const start = at(off, int(10, 17), pick([0, 30]));
      const key = `${userId}|${clock.dateKey(start)}|${clock.parts(start).hour}`;
      if (busy.has(key)) continue;
      busy.add(key);
      return { start, end: plus(start, minutes) };
    }
    const start = at(offSunday(dayOffset), 19, 0);
    return { start, end: plus(start, minutes) };
  };
  const teamsLink = (userId: string) =>
    `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${token(48)}%40thread.v2/0?context=%7b%22Tid%22%3a%22${TEAMS_TENANT}%22%2c%22Oid%22%3a%22${objectIds.get(userId) ?? guid()}%22%7d`;

  let created = 0;
  let held = 0;
  let cancelledCount = 0;
  const tally: Record<string, number> = {};
  type Draft = {
    userId: string;
    kind: "lead" | "company" | "contact" | "ticket" | "visit";
    links: { companyId: string | null; contactId: string | null; leadId: string | null; ticketId: string | null; visitId: string | null };
    title: string;
    agenda: string | null;
    location: string | null;
    online: boolean;
    startsAt: Date;
    endsAt: Date;
    attendees: { email: string; name: string | null }[];
    cancelled?: boolean;
    tentative?: boolean;
  };
  const write = async (d: Draft) => {
    const past = d.endsAt.getTime() < NOW.getTime();
    const scheduledAt = past ? workedAt(Math.max(daysSince(d.startsAt) + int(2, 10), 0)) : workedAt(int(0, 7));
    const organizer = cast.emails.get(d.userId) ?? null;
    const responses = past ? ["accepted", "accepted", "accepted", "tentative", "declined"] : ["none", "none", "accepted", "tentative"];
    const attendees = d.attendees.filter((a) => a.email && a.email !== organizer).map((a) => ({ email: a.email, name: a.name, response: pick(responses) }));
    const status = d.cancelled ? "CANCELLED" : d.tentative ? "TENTATIVE" : "CONFIRMED";
    const heldAt = past && !d.cancelled && d.links.leadId ? plus(d.endsAt, int(1, 6)) : null;
    await db.calendarEvent.create({
      data: {
        userId: d.userId,
        provider: "MICROSOFT",
        externalId: `AAMkAD${token(6)}LTUyNmMtNGI${token(98)}=`,
        etag: `DwAAABYAAAA${token(28)}`,
        title: d.title.slice(0, 500),
        description: d.agenda,
        location: d.online ? "Microsoft Teams Meeting" : d.location,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        allDay: false,
        joinUrl: d.online ? teamsLink(d.userId) : null,
        status,
        busy: true,
        isOrganizer: true,
        organizerEmail: organizer,
        attendees: attendees as unknown as Prisma.InputJsonValue,
        fromDeskzo: true,
        ...d.links,
        heldLoggedAt: heldAt,
        syncedAt: d.cancelled ? (past ? plus(d.startsAt, -int(60, 2000)) : workedAt(int(0, 2))) : scheduledAt,
        createdAt: scheduledAt,
      },
    });
    // A meeting from a lead that took place goes on its timeline once — what logHeldMeetings writes.
    if (heldAt && d.links.leadId) {
      await db.activity.create({ data: { leadId: d.links.leadId, userId: d.userId, type: "MEETING", notes: `Meeting held — ${d.title.slice(0, 500)}`, occurredAt: d.startsAt, createdAt: heldAt } });
      held += 1;
    }
    created += 1;
    if (d.cancelled) cancelledCount += 1;
    tally[d.kind] = (tally[d.kind] ?? 0) + 1;
  };
  /** What the app makes of a record as a meeting: its links, its default title and length, who could be invited. */
  const fromRecord = async (userId: string, kind: Draft["kind"], id: string) => app.ws(() => app.meetingRecordFor(userId, { kind, id }));
  const invitees = (rec: NonNullable<Awaited<ReturnType<typeof fromRecord>>>) => {
    if (rec.noDirectContact) return [];
    const preferred = rec.contacts.filter((c) => rec.preferredContactIds.includes(c.id));
    const others = rec.contacts.filter((c) => !rec.preferredContactIds.includes(c.id));
    return [...(preferred.length ? preferred : others.slice(0, 1)), ...(chance(0.4) ? others.slice(0, 1) : [])].map((c) => ({ email: c.email, name: c.name }));
  };
  const colleague = (userId: string) => {
    const p = pick(cast.presales.filter((x) => x.id !== userId));
    const email = p ? cast.emails.get(p.id) : null;
    return p && email && chance(0.35) ? [{ email, name: p.name }] : [];
  };

  for (const [pi, person] of people.entries()) {
    const leads = await db.lead.findMany({
      where: { ownerUserId: person.id, company: { tags: { has: DEMO_TAG }, managedByResellerId: null } },
      orderBy: [{ stageChangedAt: "desc" }],
      select: { id: true, status: true, title: true },
      take: 30,
    });
    const open = leads.filter((l) => OPEN.includes(l.status) && l.status !== "NEW");
    const won = leads.filter((l) => l.status === "WON");
    // Deals: one that took place, one coming up, and now and then one called off.
    for (const [j, l] of [...open.slice(0, 2), ...won.slice(0, 1)].entries()) {
      const rec = await fromRecord(person.id, "lead", l.id);
      if (!rec) continue;
      const upcoming = l.status !== "WON" && j === 1;
      const minutes = pick([30, 30, 45, 60]);
      const { start, end } = upcoming ? slot(person.id, int(1, 20), minutes) : slot(person.id, -int(2, 50), minutes);
      await write({
        userId: person.id, kind: "lead", links: rec.links, title: rec.defaults.title, agenda: pick(["Walk through the proposal", "Scope and pricing", "Technical deep-dive with their IT team", "Next steps and timelines"]),
        location: rec.defaults.location, online: rec.defaults.online, startsAt: start, endsAt: end,
        attendees: [...invitees(rec), ...colleague(person.id)], cancelled: (pi + j) % 9 === 4, tentative: upcoming && (pi + j) % 7 === 3,
      });
    }
    // Accounts: a quarterly review, past or to come.
    const accounts = book.filter((c) => c.ownerUserId === person.id && c.stage === "CUSTOMER" && direct(c));
    for (const c of accounts.slice(0, 1)) {
      const rec = await fromRecord(person.id, "company", c.id);
      if (!rec) continue;
      const upcoming = pi % 2 === 0;
      const { start, end } = upcoming ? slot(person.id, int(2, 18), 60) : slot(person.id, -int(5, 70), 60);
      await write({ userId: person.id, kind: "company", links: rec.links, title: `Quarterly review — ${c.name}`, agenda: "Usage, renewals coming up, anything new they need", location: rec.defaults.location, online: true, startsAt: start, endsAt: end, attendees: invitees(rec), cancelled: pi % 6 === 5 });
    }
    // A person: catching up with one contact.
    const contactAt = accounts[1] ?? book.find((c) => c.ownerUserId === person.id && direct(c) && c.contacts.length > 1);
    if (contactAt && pi % 2 === 1) {
      const target = contactAt.contacts.find((x) => x.email) ?? null;
      const rec = target ? await fromRecord(person.id, "contact", target.id) : null;
      if (rec) {
        const { start, end } = slot(person.id, chance(0.5) ? int(1, 14) : -int(3, 40), 30);
        await write({ userId: person.id, kind: "contact", links: rec.links, title: rec.defaults.title, agenda: "Catch-up", location: null, online: rec.defaults.online, startsAt: start, endsAt: end, attendees: invitees(rec) });
      }
    }
  }

  // Tickets: an account manager pulling the customer in when a problem drags on.
  const tickets = await db.ticket.findMany({
    where: { company: { tags: { has: DEMO_TAG }, managedByResellerId: null, ownerUserId: { in: people.map((p) => p.id) } }, status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] } },
    orderBy: { ticketSeq: "asc" },
    take: 5,
    select: { id: true, company: { select: { ownerUserId: true } } },
  });
  for (const [i, t] of tickets.entries()) {
    const userId = t.company.ownerUserId!;
    const rec = await fromRecord(userId, "ticket", t.id);
    if (!rec) continue;
    const { start, end } = i % 2 ? slot(userId, int(1, 7), 30) : slot(userId, -int(1, 20), 30);
    const support = pick(cast.support);
    const supportEmail = cast.emails.get(support.id);
    await write({ userId, kind: "ticket", links: rec.links, title: rec.defaults.title, agenda: "Escalation review with their IT team and our support lead", location: null, online: true, startsAt: start, endsAt: end, attendees: [...invitees(rec), ...(supportEmail ? [{ email: supportEmail, name: support.name }] : [])] });
  }

  // Visits put in the calendar: the planned ones by whoever is going, and some that have since happened or been called off.
  const plannedVisits = await db.visit.findMany({
    where: { status: "PLANNED", scheduledFor: { gt: NOW }, userId: { in: people.map((p) => p.id) }, company: { tags: { has: DEMO_TAG }, managedByResellerId: null } },
    orderBy: { scheduledFor: "asc" },
    select: { id: true, userId: true },
  });
  for (const v of plannedVisits.filter((_, i) => i % 3 !== 2)) {
    const rec = await fromRecord(v.userId, "visit", v.id);
    if (!rec || !rec.defaults.startsAt) continue;
    await write({ userId: v.userId, kind: "visit", links: rec.links, title: rec.defaults.title, agenda: rec.defaults.agenda, location: rec.defaults.location, online: false, startsAt: rec.defaults.startsAt, endsAt: plus(rec.defaults.startsAt, rec.defaults.durationMinutes), attendees: invitees(rec) });
  }
  // Since then: a visit that took place, and one called off with its meeting (followVisitCancel).
  const pastVisits = await db.visit.findMany({
    where: { status: { in: ["COMPLETED", "CANCELLED"] }, scheduledFor: { gt: new Date(NOW.getTime() - 45 * DAY) }, userId: { in: people.map((p) => p.id) }, company: { tags: { has: DEMO_TAG }, managedByResellerId: null } },
    orderBy: { scheduledFor: "desc" },
    take: 6,
    select: { id: true, userId: true, status: true, scheduledFor: true, address: true, agenda: true, companyId: true, contactId: true, leadId: true },
  });
  for (const v of pastVisits) {
    const company = byId.get(v.companyId);
    if (!company) continue;
    const contact = company.contacts.find((x) => x.id === v.contactId && x.email);
    await write({
      userId: v.userId, kind: "visit", links: { companyId: v.companyId, contactId: v.contactId, leadId: v.leadId, ticketId: null, visitId: v.id },
      title: `Visit — ${company.name}`, agenda: v.agenda, location: v.address, online: false, startsAt: v.scheduledFor, endsAt: plus(v.scheduledFor, 60),
      attendees: contact?.email ? [{ email: contact.email, name: contact.name }] : [], cancelled: v.status === "CANCELLED",
    });
  }
  log("CRM: meetings", `${created} scheduled from records (${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ")}), ${held} held and on their leads' timelines, ${cancelledCount} cancelled`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Forecast commits
// ════════════════════════════════════════════════════════════════════════════════════════════════

const round5k = (n: number) => Math.max(50_000, Math.round(n / 5_000) * 5_000);
const COMMIT_NOTES = ["Two renewals may slip to next month", "Counting on the plant firewall deal", "Includes the government society if their budget clears", "Big one is with their CFO — 50/50", "Conservative: one deal is waiting on a board meeting", null, null, null];

async function coverForecast(db: Db, cast: Cast) {
  const people = cast.accountManagers;
  const months: { key: string; from: Date; to: Date; offset: number }[] = [];
  for (let offset = -6; offset <= 2; offset++) {
    const window = clock.monthWindow(NOW, offset);
    months.push({ key: clock.monthKey(window.from), ...window, offset });
  }
  const leads = await db.lead.findMany({
    where: { ownerUserId: { in: people.map((p) => p.id) } },
    select: { ownerUserId: true, status: true, estimatedValue: true, expectedCloseDate: true, stageChangedAt: true },
  });
  const weight: Record<string, number> = { NEW: 0.05, CONTACTED: 0.1, QUALIFYING: 0.2, QUALIFIED: 0.35, PROPOSAL_SENT: 0.5, NEGOTIATION: 0.7 };
  const rows: Prisma.ForecastCommitCreateManyInput[] = [];
  for (const person of people) {
    const mine = leads.filter((l) => l.ownerUserId === person.id);
    for (const m of months) {
      const won = mine.filter((l) => l.status === "WON" && l.stageChangedAt && l.stageChangedAt >= m.from && l.stageChangedAt < m.to).reduce((t, l) => t + Number(l.estimatedValue ?? 0), 0);
      // A close date is a calendar day: compared as one.
      const [fromDay, toDay] = [dayOf(m.from), dayOf(m.to)];
      const pipe = mine.filter((l) => OPEN.includes(l.status) && l.expectedCloseDate && l.expectedCloseDate >= fromDay && l.expectedCloseDate < toDay).reduce((t, l) => t + Number(l.estimatedValue ?? 0) * (weight[l.status] ?? 0), 0);
      // A past month's call was made before the month knew how it would end.
      const basis = m.offset < 0 ? won * (0.7 + rnd() * 0.6) : m.offset === 0 ? won + pipe * (0.8 + rnd() * 0.4) : pipe * (0.8 + rnd() * 0.5);
      const commit = round5k(basis || int(2, 12) * 50_000);
      const bestCase = round5k(commit * (1.15 + rnd() * 0.45));
      const made = m.offset <= 0 ? new Date(Math.min(plus(m.from, (int(0, 2) * 24 + int(10, 17)) * 60).getTime(), NOW.getTime() - MINUTE)) : workedAt(int(0, 4));
      const revised = m.offset < 0 && chance(0.4) ? plus(made, int(6, 18) * 24 * 60) : made;
      rows.push({ userId: person.id, month: m.key, commit, bestCase, note: pick(COMMIT_NOTES), createdAt: made, updatedAt: revised.getTime() < m.to.getTime() && revised.getTime() < NOW.getTime() ? revised : made });
    }
  }
  const added = await db.forecastCommit.createMany({ data: rows, skipDuplicates: true });
  log("CRM: forecast commits", `${added.count} for ${people.length} salespeople, ${months[0]!.key} to ${months[months.length - 1]!.key}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Custom fields
// ════════════════════════════════════════════════════════════════════════════════════════════════

type FieldSpec = {
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: (string | { label: string; archived: true })[];
  group?: string;
  helpText?: string;
  restricted?: boolean;
  showInList?: boolean;
  archived?: boolean;
};

const FIELDS: FieldSpec[] = [
  { entity: "COMPANY", label: "Account tier", type: "SELECT", options: ["Strategic", "Key", "Growth", "Standard", { label: "Silver (old scheme)", archived: true }], group: "Account profile", showInList: true },
  { entity: "COMPANY", label: "Annual IT budget", type: "MONEY", group: "Account profile", helpText: "What they spend on IT in a year, as they told us — not our estimate." },
  { entity: "COMPANY", label: "Executive sponsor", type: "USER", group: "Account profile", helpText: "Who at our end their leadership deals with." },
  { entity: "COMPANY", label: "Preferred support channels", type: "MULTI_SELECT", options: ["Phone", "Email", "WhatsApp", "On-site visit", "Customer portal"] },
  { entity: "COMPANY", label: "IT service desk URL", type: "URL" },
  { entity: "COMPANY", label: "NDA signed", type: "CHECKBOX", group: "Compliance", showInList: true },
  { entity: "COMPANY", label: "Last security audit", type: "DATE", group: "Compliance" },
  { entity: "COMPANY", label: "Collections notes", type: "LONG_TEXT", group: "Finance", restricted: true, helpText: "How they pay, for whoever chases them. Accounts and management only." },
  { entity: "CONTACT", label: "Decision role", type: "SELECT", options: ["Decision maker", "Influencer", "Evaluator", "User", "Gatekeeper"], showInList: true },
  { entity: "CONTACT", label: "Preferred language", type: "SELECT", options: ["English", "Hindi", "Marathi", "Tamil", "Kannada", "Telugu", "Bengali", "Gujarati", "Malayalam"] },
  { entity: "CONTACT", label: "Birthday", type: "DATE" },
  { entity: "CONTACT", label: "Alternate mobile", type: "PHONE" },
  { entity: "CONTACT", label: "Personal email", type: "EMAIL", restricted: true },
  { entity: "CONTACT", label: "WhatsApp opt-in", type: "CHECKBOX" },
  { entity: "LEAD", label: "Competitor in the deal", type: "SELECT", options: ["Incumbent partner", "Buying direct from the OEM", "Another reseller", "None known"], showInList: true },
  { entity: "LEAD", label: "Budget approved", type: "CHECKBOX", showInList: true },
  { entity: "LEAD", label: "Seats in scope", type: "NUMBER" },
  { entity: "LEAD", label: "Decision date", type: "DATE" },
  { entity: "LEAD", label: "Presales owner", type: "USER" },
  { entity: "LEAD", label: "Use cases", type: "MULTI_SELECT", options: ["Email & collaboration", "Endpoint security", "Backup & DR", "Design software", "Networking", "Infrastructure", "AI & Copilot"] },
  { entity: "LEAD", label: "Margin notes", type: "LONG_TEXT", group: "Commercials", restricted: true },
  { entity: "ORDER", label: "Customer PO number", type: "TEXT", group: "Paperwork", showInList: true },
  { entity: "ORDER", label: "Special price approval no.", type: "TEXT", group: "Paperwork", restricted: true },
  { entity: "ORDER", label: "Installation date", type: "DATE", group: "Delivery" },
  { entity: "ORDER", label: "Site contact phone", type: "PHONE", group: "Delivery" },
  { entity: "ORDER", label: "Freight charged", type: "MONEY", group: "Delivery" },
  { entity: "ORDER", label: "Tracking link", type: "URL", group: "Delivery" },
  { entity: "ITEM", label: "Warranty (months)", type: "NUMBER", showInList: true },
  { entity: "ITEM", label: "Licence model", type: "SELECT", options: ["Per user", "Per device", "Per site", "Not a licence"] },
  { entity: "ITEM", label: "Works with", type: "MULTI_SELECT", options: ["Windows", "macOS", "Linux", "iOS", "Android"] },
  { entity: "ITEM", label: "Datasheet", type: "URL" },
  { entity: "ITEM", label: "Landed cost", type: "MONEY", group: "Purchasing", restricted: true },
  { entity: "ITEM", label: "Old SKU code", type: "TEXT", archived: true, helpText: "From the spreadsheet we used before — retired once every item had its new SKU." },
];

const yyyyMmDd = (d: Date) => d.toISOString().slice(0, 10);
const LANGUAGE_BY_STATE: Record<string, string[]> = {
  Maharashtra: ["Marathi", "Hindi", "English"], Karnataka: ["Kannada", "English"], "Tamil Nadu": ["Tamil", "English"], Telangana: ["Telugu", "English"],
  "West Bengal": ["Bengali", "English"], Gujarat: ["Gujarati", "Hindi"], Kerala: ["Malayalam", "English"],
};

async function coverCustomFields(db: Db, ctx: DemoContext, cast: Cast) {
  // ── The definitions, made as the settings screen makes them (src/actions/custom-fields.ts) ──
  const defs = new Map<string, CustomFieldDef & { entity: CustomFieldEntity }>();
  let made = 0;
  const byEntity = new Map<CustomFieldEntity, FieldSpec[]>();
  for (const f of FIELDS) byEntity.set(f.entity, [...(byEntity.get(f.entity) ?? []), f]);
  for (const [entity, specs] of byEntity) {
    const existing = await db.customFieldDefinition.findMany({ where: { entity }, select: { id: true, key: true, label: true, type: true, options: true, required: true, helpText: true, group: true, restricted: true, archivedAt: true, sortOrder: true } });
    let sortOrder = existing.reduce((m, d) => Math.max(m, d.sortOrder), -1);
    for (const spec of specs) {
      let row = existing.find((d) => d.label.toLowerCase() === spec.label.toLowerCase() && d.type === spec.type);
      if (!row) {
        const taken = new Set<string>();
        const options: CustomFieldOption[] = (spec.options ?? []).map((o) => {
          const label = typeof o === "string" ? o : o.label;
          const value = keyFromLabel(label, taken);
          taken.add(value);
          return { value, label, ...(typeof o === "string" ? {} : { archived: true }) };
        });
        const created = await db.customFieldDefinition.create({
          data: {
            entity, key: keyFromLabel(spec.label, existing.map((d) => d.key)), label: spec.label, type: spec.type, options: options as unknown as Prisma.InputJsonValue,
            helpText: spec.helpText ?? null, group: spec.group ?? null, restricted: spec.restricted ?? false, showInList: spec.showInList ?? false,
            sortOrder: ++sortOrder, archivedAt: spec.archived ? workedAt(1) : null, createdById: cast.admin.id, updatedById: cast.admin.id, createdAt: workedAt(2),
          },
          select: { id: true, key: true, label: true, type: true, options: true, required: true, helpText: true, group: true, restricted: true, archivedAt: true, sortOrder: true },
        });
        existing.push(created);
        row = created;
        made += 1;
      }
      defs.set(`${entity}:${spec.label}`, {
        entity, key: row.key, label: row.label, type: row.type, options: (Array.isArray(row.options) ? row.options : []) as unknown as CustomFieldOption[],
        required: row.required, helpText: row.helpText, group: row.group, restricted: row.restricted, archived: row.archivedAt !== null,
      });
    }
  }
  const def = (entity: CustomFieldEntity, label: string) => defs.get(`${entity}:${label}`)!;

  /** Every answer through `coerceValue`, as a form or an import would send it; only keys a record doesn't hold yet are written. */
  const fill = (entity: CustomFieldEntity, existingRaw: unknown, answers: Record<string, unknown>): CustomFieldValues | null => {
    const existing = readValues(existingRaw);
    const out: CustomFieldValues = { ...existing };
    let changed = false;
    for (const [label, raw] of Object.entries(answers)) {
      if (raw === undefined || raw === null) continue;
      const d = def(entity, label);
      if (out[d.key] !== undefined) continue;
      // A retired option can only be kept, never newly chosen — these records held it before it was retired.
      const held = d.type === "SELECT" && typeof raw === "string" && d.options.some((o) => o.archived && o.label === raw) ? d.options.find((o) => o.label === raw)!.value : undefined;
      const coerced = coerceValue(d, raw, held);
      if (!coerced.ok) throw new Error(`Custom field ${entity} ${label}: ${coerced.error}`);
      if (coerced.value === null) continue;
      out[d.key] = coerced.value;
      changed = true;
    }
    return changed ? out : null;
  };
  const optionLabels = (entity: CustomFieldEntity, label: string) => def(entity, label).options.filter((o) => !o.archived).map((o) => o.label);
  const sponsors = [cast.headOfSales, ...cast.regional].map((p) => p.id);
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  /** Whether this kind of record already carries these fields' values — then a second run leaves them as they are. */
  const holds = (entity: CustomFieldEntity, rows: { customFields: unknown }[]) => {
    const keys = FIELDS.filter((f) => f.entity === entity).map((f) => def(entity, f.label).key);
    return rows.some((r) => keys.some((k) => readValues(r.customFields)[k] !== undefined));
  };

  // Companies.
  const companies = await db.company.findMany({
    where: { tags: { has: DEMO_TAG } },
    select: { id: true, name: true, stage: true, relationshipType: true, employeeCount: true, creditRating: true, customFields: true, contacts: { select: { email: true }, take: 3 }, website: true },
  });
  for (const [i, c] of (holds("COMPANY", companies) ? [] : companies).entries()) {
    const isCustomer = c.stage === "CUSTOMER" && (c.relationshipType === "CLIENT" || c.relationshipType === "RESELLER");
    if (!(isCustomer ? chance(0.85) : c.stage === "LEAD" ? chance(0.6) : chance(0.25))) continue;
    const size = c.employeeCount ?? 20;
    const domain = (c.website ? domainOf(c.website) : null) ?? `${slugOf(c.name).split(" ")[0]}.example`;
    const tier = i % 23 === 0 && isCustomer ? "Silver (old scheme)" : !isCustomer ? "Standard" : size >= 600 ? "Strategic" : size >= 140 ? "Key" : "Growth";
    const values = fill("COMPANY", c.customFields, {
      "Account tier": tier,
      "Annual IT budget": c.relationshipType === "CLIENT" && chance(0.7) ? String(Math.round((size * int(18_000, 45_000)) / 50_000) * 50_000 || 150_000) : undefined,
      "Executive sponsor": isCustomer && size >= 140 ? pick(sponsors) : undefined,
      "Preferred support channels": isCustomer ? some(optionLabels("COMPANY", "Preferred support channels"), int(1, 3)) : undefined,
      "IT service desk URL": isCustomer && size >= 90 && chance(0.5) ? `servicedesk.${domain}` : undefined,
      "NDA signed": isCustomer ? chance(0.6) : chance(0.2) ? "yes" : undefined,
      "Last security audit": isCustomer && chance(0.5) ? yyyyMmDd(dayOf(workedAt(int(20, 340)))) : undefined,
      "Collections notes": c.creditRating === "RISKY" || (isCustomer && chance(0.15)) ? pick(["Pays only after three reminders; the cheque usually lands around the 10th.", "Their accounts team needs the PO number on every invoice or it is sent back.", "Disputes freight every time — quote it separately."]) : undefined,
    });
    if (!values) continue;
    await db.company.update({ where: { id: c.id }, data: { customFields: values as Prisma.InputJsonValue } });
    bump("companies");
  }

  // Contacts.
  const contacts = await db.contact.findMany({
    where: { company: { tags: { has: DEMO_TAG } } },
    select: { id: true, name: true, designation: true, customFields: true, company: { select: { stage: true, locations: { where: { isPrimary: true }, select: { state: true } } } } },
  });
  const ROLE: Partial<Record<ContactDesignation, string[]>> = { CEO: ["Decision maker"], DIRECTOR: ["Decision maker", "Influencer"], CIO: ["Decision maker", "Influencer"], IT_HEAD: ["Influencer", "Evaluator"], IT_MANAGER: ["Evaluator", "User"], PURCHASE_MANAGER: ["Gatekeeper"], HR: ["User"], OTHER: ["Gatekeeper", "User"] };
  for (const x of holds("CONTACT", contacts) ? [] : contacts) {
    if (!chance(x.company.stage === "CUSTOMER" ? 0.7 : 0.4)) continue;
    const [first, last] = x.name.toLowerCase().replace(/[^a-z ]/g, "").split(" ");
    const state = x.company.locations[0]?.state ?? "";
    const values = fill("CONTACT", x.customFields, {
      "Decision role": pick(ROLE[x.designation] ?? ["User"]),
      "Preferred language": chance(0.6) ? pick(LANGUAGE_BY_STATE[state] ?? ["English", "Hindi"]) : undefined,
      Birthday: chance(0.35) ? `${int(1965, 1996)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}` : undefined,
      "Alternate mobile": chance(0.3) ? phone() : undefined,
      "Personal email": x.designation !== "OTHER" && last && chance(0.2) ? `${first}.${last}${int(1, 99)}@gmail.com` : undefined,
      "WhatsApp opt-in": chance(0.5) ? chance(0.7) : undefined,
    });
    if (!values) continue;
    await db.contact.update({ where: { id: x.id }, data: { customFields: values as Prisma.InputJsonValue } });
    bump("contacts");
  }

  // Leads.
  const leads = await db.lead.findMany({
    where: { company: { tags: { has: DEMO_TAG } } },
    select: { id: true, status: true, expectedCloseDate: true, customFields: true, company: { select: { employeeCount: true } }, requirements: { select: { quantity: true } } },
  });
  for (const l of holds("LEAD", leads) ? [] : leads) {
    if (!chance(l.status === "NEW" ? 0.3 : 0.65)) continue;
    const advanced = ["QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "WON"].includes(l.status);
    const seats = Math.max(...l.requirements.map((r) => r.quantity), 0) || Math.round((l.company.employeeCount ?? 30) * 0.6);
    const values = fill("LEAD", l.customFields, {
      "Competitor in the deal": pick(optionLabels("LEAD", "Competitor in the deal")),
      "Budget approved": advanced ? chance(0.75) : chance(0.2),
      "Seats in scope": String(seats),
      "Decision date": l.expectedCloseDate && chance(0.6) ? yyyyMmDd(new Date(l.expectedCloseDate.getTime() - int(0, 10) * DAY)) : undefined,
      "Presales owner": advanced && chance(0.6) ? pick(cast.presales).id : undefined,
      "Use cases": some(optionLabels("LEAD", "Use cases"), int(1, 3)),
      "Margin notes": advanced && chance(0.35) ? pick(["Distributor special pricing approved at 8% — don't go below 6% without asking.", "Bundled the AMC at cost to win the hardware.", "OEM deal registration approved; protects our price for 90 days."]) : undefined,
    });
    if (!values) continue;
    await db.lead.update({ where: { id: l.id }, data: { customFields: values as Prisma.InputJsonValue } });
    bump("leads");
  }

  // Orders.
  const orders = await db.companyProduct.findMany({
    where: { company: { tags: { has: DEMO_TAG } } },
    select: { id: true, orderStatus: true, createdAt: true, customFields: true, item: { select: { type: true } } },
  });
  for (const o of holds("ORDER", orders) ? [] : orders) {
    if (!chance(0.6)) continue;
    const goods = o.item.type === "GOOD";
    const yy = clock.parts(o.createdAt).year % 100;
    const values = fill("ORDER", o.customFields, {
      "Customer PO number": `PO/${yy}-${yy + 1}/${int(1000, 9999)}`,
      "Special price approval no.": chance(0.25) ? `SPA-${int(100000, 999999)}` : undefined,
      "Installation date": goods && o.orderStatus === "FULFILLED" ? yyyyMmDd(dayOf(new Date(Math.min(o.createdAt.getTime() + int(5, 25) * DAY, NOW.getTime())))) : undefined,
      "Site contact phone": goods && chance(0.6) ? phone() : undefined,
      "Freight charged": goods && chance(0.5) ? String(int(4, 60) * 100) : undefined,
      "Tracking link": goods && o.orderStatus !== "APPROVED" && chance(0.6) ? `https://tracking.courier.example/awb/${int(10000000, 99999999)}` : undefined,
    });
    if (!values) continue;
    await db.companyProduct.update({ where: { id: o.id }, data: { customFields: values as Prisma.InputJsonValue } });
    bump("orders");
  }

  // Products.
  const itemRows = new Map((await db.item.findMany({ where: { id: { in: ctx.items.map((i) => i.id) } }, select: { id: true, customFields: true, sku: true } })).map((r) => [r.id, r]));
  for (const it of holds("ITEM", [...itemRows.values()]) ? [] : ctx.items) {
    if (!chance(0.8)) continue;
    const row = itemRows.get(it.id);
    if (!row) continue;
    const brand = slugOf(it.brand || "vendor").split(" ")[0] || "vendor";
    const values = fill("ITEM", row.customFields, {
      "Warranty (months)": it.type === "GOOD" ? String(pick([12, 12, 24, 36])) : undefined,
      "Licence model": it.type === "SUBSCRIPTION" ? pick(["Per user", "Per user", "Per device", "Per site"]) : "Not a licence",
      "Works with": it.type !== "SERVICE" ? some(optionLabels("ITEM", "Works with"), int(1, 4)) : undefined,
      Datasheet: it.type !== "SERVICE" ? `https://www.${brand}.example/datasheets/${row.sku.toLowerCase()}` : undefined,
      "Landed cost": it.cost > 0 ? String(Math.round(it.cost * 1.04 * 100) / 100) : undefined,
      "Old SKU code": chance(0.5) ? `OLD-${int(10000, 99999)}` : undefined,
    });
    if (!values) continue;
    await db.item.update({ where: { id: it.id }, data: { customFields: values as Prisma.InputJsonValue } });
    bump("products");
  }
  log("CRM: custom fields", `${made} defined (${defs.size} in all, every type), values on ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "the records already (left as they are)"}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Sticky notes
// ════════════════════════════════════════════════════════════════════════════════════════════════

type NoteSpec = {
  owner: { id: string; name: string };
  title: string | null;
  body: string;
  color: StickyNoteColor;
  visibility: StickyNoteVisibility;
  pinned?: boolean;
  remindInDays?: number;
  archivedDaysAgo?: number;
  attach?: { companyId?: string; leadId?: string; ticketId?: string };
  ageDays: number;
};

async function coverNotes(db: Db, cast: Cast, app: App) {
  if (await db.stickyNote.count({ where: { body: { startsWith: "Every renewal due before 31 October" } } })) {
    log("CRM: sticky notes", "purple, orange and grey notes already there");
    return;
  }
  const book = await loadBook(db);
  const am = cast.accountManagers;
  const myCustomer = (userId: string) => book.find((c) => c.ownerUserId === userId && c.stage === "CUSTOMER" && direct(c));
  // On an account of their own: a note can only be stuck to what its writer can see.
  const myLead = async (userId: string) => db.lead.findFirst({ where: { ownerUserId: userId, status: { in: OPEN }, company: { ownerUserId: userId } }, orderBy: { stageChangedAt: "desc" }, select: { id: true } });
  const risky = book.find((c) => c.ownerUserId && c.stage === "CUSTOMER" && direct(c) && c.relationshipType === "CLIENT");
  const ticket = await db.ticket.findFirst({ where: { company: { tags: { has: DEMO_TAG } }, status: { in: ["OPEN", "IN_PROGRESS"] }, assignedToUserId: { not: null } }, orderBy: { ticketSeq: "asc" }, select: { id: true, assignedToUserId: true } });
  const supportOwner = cast.support.find((p) => p.id === ticket?.assignedToUserId) ?? cast.support[0]!;
  const supportLead = cast.support.find((p) => p.title === "Support Lead") ?? cast.support[0]!;
  const { gm, director } = cast;

  const specs: NoteSpec[] = [
    { owner: cast.headOfSales, title: "October renewals", body: "Every renewal due before 31 October needs a quote out by Friday. Work from the renewals board, not your inbox.", color: "ORANGE", visibility: "EVERYONE", pinned: true, ageDays: 3 },
    { owner: gm, title: "Price change", body: "The new OEM price list applies to orders punched from 1 November. Quote this month's renewals on the current list and say so on the quote.", color: "PURPLE", visibility: "EVERYONE", ageDays: 6 },
    { owner: director, title: "Office closed", body: "The office is closed on Monday 9 November for Diwali. Field visits that day need your manager's okay.", color: "GREY", visibility: "EVERYONE", ageDays: 2 },
    { owner: cast.headOfSales, title: "Copilot demos", body: "Presales can now run Copilot for Microsoft 365 demos. Schedule them from the lead so the meeting lands on its timeline.", color: "PURPLE", visibility: "EVERYONE", ageDays: 12 },
    { owner: cast.insideLead, title: "Calling hours", body: "Manufacturing prospects pick up between 11 and 1, hardly ever after 4. Plan the blitz list around it.", color: "ORANGE", visibility: "TEAM", pinned: true, ageDays: 20 },
    { owner: supportLead, title: "Escalations", body: "Anything open more than five days on a key account comes to me before it goes back to the customer.", color: "GREY", visibility: "TEAM", ageDays: 40 },
    { owner: cast.regional[0] ?? am[0]!, title: "Monday pipeline review", body: "Bring every deal in Negotiation with a next step and a date. No date, no forecast.", color: "PURPLE", visibility: "TEAM", ageDays: 9 },
    { owner: cast.regional[1] ?? am[1] ?? am[0]!, title: null, body: "Distributor credit limit is nearly used up this month — check with Purchase before promising delivery dates.", color: "ORANGE", visibility: "TEAM", ageDays: 5 },
    { owner: am[0]!, title: "Budget cycle", body: "They always order in March — their budget closes on 31 January. Get the quote in before then.", color: "ORANGE", visibility: "PRIVATE", attach: { companyId: myCustomer(am[0]!.id)?.id }, ageDays: 60 },
    { owner: am[1] ?? am[0]!, title: null, body: "Decision maker is the CFO, not IT. Get the meeting with him before the proposal goes.", color: "PURPLE", visibility: "PRIVATE", pinned: true, attach: { leadId: (await myLead((am[1] ?? am[0]!).id))?.id }, ageDays: 8 },
    { owner: am[2] ?? am[0]!, title: "Chase the PO", body: "Signed PO promised by the end of the week — chase if it hasn't come.", color: "GREY", visibility: "PRIVATE", remindInDays: 3, attach: { leadId: (await myLead((am[2] ?? am[0]!).id))?.id }, ageDays: 4 },
    { owner: supportOwner, title: null, body: "Customer prefers WhatsApp updates on this one — they don't read the ticket emails.", color: "GREY", visibility: "PRIVATE", attach: { ticketId: ticket?.id }, ageDays: 3 },
    { owner: am[3] ?? am[0]!, title: "Diwali gifting", body: "Send the AMC renewal before Diwali, with the gift hamper.", color: "ORANGE", visibility: "PRIVATE", archivedDaysAgo: 12, ageDays: 40 },
    { owner: am[4] ?? am[0]!, title: "Tomorrow", body: "Call the IT head first thing about the firewall quote.", color: "PURPLE", visibility: "PRIVATE", pinned: true, remindInDays: 1, ageDays: 1 },
    { owner: risky ? { id: risky.ownerUserId!, name: "" } : am[0]!, title: "Talk to Accounts first", body: "Payments are running late here — check with Accounts before punching anything new.", color: "GREY", visibility: "TEAM", attach: { companyId: risky?.id }, ageDays: 15 },
    { owner: cast.headOfSales, title: "Reference customer", body: "Happy to be a reference — ask the account manager before giving their name to a prospect.", color: "ORANGE", visibility: "EVERYONE", attach: { companyId: book.find((c) => c.stage === "CUSTOMER" && direct(c) && (c.employeeCount ?? 0) >= 380)?.id }, ageDays: 30 },
    { owner: cast.insideLead, title: null, body: "New calling scripts are in the shared drive. Old ones are retired.", color: "GREY", visibility: "TEAM", archivedDaysAgo: 30, ageDays: 70 },
    { owner: pick(cast.presales), title: "Demo kit", body: "The demo laptop's Intune enrolment expires on the 20th — renew it before the next demo.", color: "PURPLE", visibility: "PRIVATE", remindInDays: 9, ageDays: 6 },
  ];

  let written = 0;
  let refused = 0;
  const positions = new Map<string, number>();
  for (const n of specs) {
    const attach = { companyId: n.attach?.companyId ?? null, leadId: n.attach?.leadId ?? null, ticketId: n.attach?.ticketId ?? null };
    // The same two checks the note action makes: broadcasting needs notes.broadcast, and a note
    // can only be stuck to a record its writer can see.
    if (n.visibility === "EVERYONE" && !(await app.can(n.owner.id, "notes.broadcast"))) {
      refused += 1;
      continue;
    }
    if (!(await app.ws(() => app.mayAttachTo(n.owner.id, attach)))) {
      refused += 1;
      continue;
    }
    // TEAM means the writer's department; with none it would be nobody's, so it isn't written as one.
    const visibility = n.visibility === "TEAM" && !cast.departments.get(n.owner.id) ? "PRIVATE" : n.visibility;
    const createdAt = workedAt(n.ageDays);
    const position = positions.get(n.owner.id) ?? 0;
    positions.set(n.owner.id, position + 1);
    await db.stickyNote.create({
      data: {
        title: n.title, body: n.body, color: n.color, visibility, pinned: n.pinned ?? false, position, ownerUserId: n.owner.id, ...attach,
        remindAt: n.remindInDays ? slotAhead(n.remindInDays, 9, 11) : null,
        archivedAt: n.archivedDaysAgo ? workedAt(n.archivedDaysAgo) : null,
        createdAt,
      },
    });
    written += 1;
  }
  log("CRM: sticky notes", `${written} (purple, orange, grey; to everyone, a team, or one person; on accounts, deals and tickets)${refused ? `, ${refused} the app would have refused` : ""}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Calling lists
// ════════════════════════════════════════════════════════════════════════════════════════════════

const CALL_OUTCOMES: CallOutcome[] = ["CONNECTED", "CONNECTED", "CONNECTED", "CONNECTED", "NO_ANSWER", "NO_ANSWER", "NO_ANSWER", "BUSY", "SWITCHED_OFF", "LEFT_VOICEMAIL", "LEFT_VOICEMAIL", "CALLBACK_REQUESTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "WRONG_NUMBER"];
const SKIP_REASONS = ["Duplicate of an account already on file", "Number is a fax line", "Closed down — the office is empty", "Asked not to be called again"];

type Campaign = {
  name: string;
  description: string;
  filters: WorkbookFilters;
  owner: { id: string; name: string };
  callers: { id: string; name: string }[];
  method: CallerAllocationMethod;
  startedDaysAgo: number;
  dueInDays: number;
  note: string | null;
  connectedNotes: string[];
  progress: number[];
};

async function coverWorkbooks(db: Db, cast: Cast) {
  // ── Saved lists: segments people browse and work from ──
  const lists: { name: string; description: string; filters: WorkbookFilters; owner: { id: string }; shared: boolean; opened: number | null }[] = [
    { name: "Pune & Mumbai prospects nobody owns", description: "Unowned prospects in the two Maharashtra cities — the pool new callers start from.", filters: { relationshipType: ["CLIENT"], stage: ["PROSPECT"], city: ["Pune", "Mumbai"], unowned: true }, owner: cast.insideLead, shared: true, opened: 1 },
    { name: "Customers renewing in the next 60 days", description: "Subscriptions falling due — every one needs a quote out.", filters: { relationshipType: ["CLIENT"], stage: ["CUSTOMER"], renewalWithinDays: 60 }, owner: cast.headOfSales, shared: true, opened: 0 },
    { name: "Lost deals worth another run", description: "Every lead lost or disqualified. Budgets change.", filters: { relationshipType: ["CLIENT"], allLeadsLost: true }, owner: cast.regional[0] ?? cast.headOfSales, shared: false, opened: 6 },
    { name: "Big companies we've never pitched", description: "200+ people and not one lead on file.", filters: { relationshipType: ["CLIENT"], neverHadLead: true, employeeMin: 200 }, owner: cast.accountManagers[0]!, shared: true, opened: null },
  ];
  let saved = 0;
  for (const l of lists) {
    if (await db.workbook.findFirst({ where: { name: l.name, ownerUserId: l.owner.id }, select: { id: true } })) continue;
    await db.workbook.create({
      data: { name: l.name, description: l.description, filters: l.filters as Prisma.InputJsonValue, ownerUserId: l.owner.id, shared: l.shared, mode: "LIST", createdAt: workedAt(int(15, 90)), lastOpenedAt: l.opened === null ? null : workedAt(l.opened) },
    });
    saved += 1;
  }

  // ── Calling activities: frozen, shared out, and worked ──
  const executives = cast.callers.slice(0, 3);
  const owners = cast.accountManagers;
  const campaigns: Campaign[] = [
    {
      name: "Unowned prospects — October blitz", description: "Every prospect nobody owns, split in equal alphabetical blocks.", filters: { relationshipType: ["CLIENT"], stage: ["PROSPECT"], unowned: true },
      owner: cast.insideLead, callers: executives, method: "BLOCKS", startedDaysAgo: 6, dueInDays: 8, note: "Qualify the IT contact and the renewal month; log everything.",
      connectedNotes: ["Interested — wants a quote for Microsoft 365", "On Google Workspace; renewal in March", "Spoke to the IT manager, sending the deck", "Has a partner already; happy to compare prices"],
      progress: [0.8, 0.55, 0.35],
    },
    {
      name: "Renewal check-in calls — account owners", description: "Each customer called by whoever owns the account; anything unowned shared round robin.", filters: { relationshipType: ["CLIENT"], stage: ["CUSTOMER"] },
      owner: cast.headOfSales, callers: owners, method: "BY_ACCOUNT_OWNER", startedDaysAgo: 12, dueInDays: 3, note: "Ask about renewals, new seats and anything that is bothering them.",
      connectedNotes: ["Renewal confirmed for next month", "Wants to add 10 seats at renewal", "Asked for a Copilot call with presales", "Happy — no changes this year"],
      progress: [1, 0.9, 0.7, 0.6, 0.5, 0.4],
    },
  ];
  let started = 0;
  let worked = 0;
  for (const camp of campaigns) {
    if (!camp.callers.length || (await db.workbook.findFirst({ where: { name: camp.name, ownerUserId: camp.owner.id }, select: { id: true } }))) continue;
    const companies = await db.company.findMany({
      where: { AND: [buildWhere(camp.filters, clock), { tags: { has: DEMO_TAG } }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true, ownerUserId: true, contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1, select: { id: true, name: true, phone: true } } },
    });
    if (!companies.length) continue;
    // By account owner, the callers are the owners of what is on the list.
    const callerIds = camp.method === "BY_ACCOUNT_OWNER" ? [...new Set(companies.map((c) => c.ownerUserId).filter((id): id is string => !!id && camp.callers.some((p) => p.id === id)))] : camp.callers.map((c) => c.id);
    if (!callerIds.length) continue;
    const allocations = allocate(companies, callerIds, camp.method);
    const startedAt = workedAt(camp.startedDaysAgo, 10, 12);
    const dueAt = dayOf(at(camp.dueInDays, 12));
    const book = await db.workbook.create({
      data: {
        name: camp.name, description: camp.description, filters: camp.filters as Prisma.InputJsonValue, ownerUserId: camp.owner.id, shared: true,
        mode: "COLD_CALLING", allocationMethod: camp.method, startedAt, dueAt, createdAt: plus(startedAt, -int(1, 3) * 24 * 60), lastOpenedAt: workedAt(int(0, 2)),
      },
      select: { id: true },
    });
    const byRecord = new Map(allocations.map((a) => [a.recordId, a]));
    await db.workbookRecord.createMany({
      data: companies.map((c) => ({ workbookId: book.id, companyId: c.id, assignedToUserId: byRecord.get(c.id)?.userId ?? null, sortOrder: byRecord.get(c.id)?.sortOrder ?? 0, createdAt: startedAt })),
      skipDuplicates: true,
    });
    const records = await db.workbookRecord.findMany({ where: { workbookId: book.id }, select: { id: true, companyId: true, assignedToUserId: true, sortOrder: true } });
    const company = new Map(companies.map((c) => [c.id, c]));

    for (const [ci, callerId] of callerIds.entries()) {
      const queue = records.filter((r) => r.assignedToUserId === callerId).sort((a, b) => a.sortOrder - b.sortOrder);
      const task = await db.task.create({
        data: {
          title: `Call through ${camp.name}`,
          description: `${queue.length} compan${queue.length === 1 ? "y" : "ies"} to call.${camp.note ? ` ${camp.note}` : ""}`,
          dueDate: dueAt, assignedToUserId: callerId, createdByUserId: camp.owner.id, createdAt: startedAt,
        },
        select: { id: true },
      });
      await db.workbookAssignee.create({ data: { workbookId: book.id, userId: callerId, assignedByUserId: camp.owner.id, assignedAt: startedAt, note: camp.note, dueAt, taskId: task.id } });

      // Working the queue from the top, a session a day: open, call, write it down, next.
      const target = Math.round(queue.length * (camp.progress[ci % camp.progress.length] ?? 0.5));
      let cursor = plus(startedAt, int(10, 60));
      let previous: Date | null = null;
      let today = 0;
      let done = 0;
      for (const r of queue) {
        if (done >= target) break;
        const p = clock.parts(cursor);
        if (p.hour >= 18 || today >= 14) {
          let next = clock.at(p.year, p.month, p.day + 1, 10, int(0, 30));
          if (clock.parts(next).weekday === 0) next = clock.at(p.year, p.month, p.day + 2, 10, int(0, 30));
          cursor = next;
          today = 0;
        }
        if (cursor.getTime() > NOW.getTime() - 15 * MINUTE) break;
        const openedAt = cursor;
        const skipped = chance(0.08);
        const handle = skipped ? int(15, 60) : int(70, 420);
        const completedAt = new Date(openedAt.getTime() + handle * 1000);
        const c = company.get(r.companyId)!;
        const contact = c.contacts[0] ?? null;
        let callId: string | null = null;
        let note: string;
        if (skipped) note = pick(SKIP_REASONS);
        else {
          const outcome = pick(CALL_OUTCOMES);
          const talked = outcome === "CONNECTED" || outcome === "CALLBACK_REQUESTED" || outcome === "NOT_INTERESTED";
          note = outcome === "CONNECTED" ? pick(camp.connectedNotes) : outcome === "CALLBACK_REQUESTED" ? "Asked us to call back next week" : outcome === "NOT_INTERESTED" ? "Not interested — their IT is handled in-house" : outcome === "WRONG_NUMBER" ? "Number belongs to a different company" : outcome === "LEFT_VOICEMAIL" ? "Left a voicemail with my number" : outcome.replaceAll("_", " ").toLowerCase();
          const callAt = new Date(openedAt.getTime() + 15_000);
          const call = await db.callLog.create({
            data: {
              companyId: c.id, contactId: contact?.id ?? null, phoneNumber: contact?.phone ?? phone(), direction: "OUTBOUND", outcome, startedAt: callAt,
              durationSeconds: talked ? Math.max(20, handle - int(30, 60)) : outcome === "LEFT_VOICEMAIL" ? int(18, 40) : 0,
              notes: note, userId: callerId, createdAt: callAt,
            },
            select: { id: true },
          });
          callId = call.id;
          if (outcome === "CALLBACK_REQUESTED") {
            const due = plus(completedAt, int(2, 6) * 24 * 60);
            const isDone = due.getTime() < NOW.getTime() && chance(0.7);
            await db.callLog.update({ where: { id: call.id }, data: { followUpAt: due } });
            await callback(db, { callId: call.id, companyName: c.name, contactName: contact?.name ?? null, phoneNumber: contact?.phone ?? "", notes: note, due, userId: callerId, companyId: c.id, at: callAt, done: isDone });
          }
        }
        await db.workbookRecord.update({
          where: { id: r.id },
          data: { status: skipped ? "SKIPPED" : "DONE", openedAt, completedAt, handleSeconds: handle, gapSeconds: trackedGap(previous, openedAt), outcomeNote: note, callId },
        });
        previous = completedAt;
        cursor = new Date(completedAt.getTime() + int(20, 300) * 1000);
        today += 1;
        done += 1;
        worked += 1;
      }
      // The first caller is on a call right now; the rest left their next record for tomorrow.
      const nextUp = queue[done];
      if (nextUp && ci === 0 && previous) {
        const openedAt = plus(NOW, -int(2, 9));
        await db.workbookRecord.update({ where: { id: nextUp.id }, data: { status: "IN_PROGRESS", openedAt, gapSeconds: trackedGap(previous, openedAt) } });
      }
      if (done === queue.length && previous) {
        await db.workbookAssignee.update({ where: { workbookId_userId: { workbookId: book.id, userId: callerId } }, data: { completedAt: previous } });
        await db.task.update({ where: { id: task.id }, data: { done: true, doneAt: previous } });
      }
    }
    started += 1;
  }
  log("CRM: calling lists", `${saved} saved lists, ${started} activities started (equal blocks, by account owner), ${worked} records worked`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The company lock
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * One row, `id = "global"` — the whole company locked out by the super admin (src/lib/access/lock.ts).
 * Written as one that was used once and lifted: the year-end stock count on 31 March. Never left on,
 * and never written over a row the workspace already has.
 */
const LOCK_MESSAGE = "Year-end stock count — the CRM is closed while Accounts and Purchase reconcile stock. Back by 2 pm.";

async function coverLock(db: Db, cast: Cast) {
  if (await db.companyLock.findUnique({ where: { id: "global" }, select: { id: true } })) {
    log("CRM: company lock", "the workspace already has its lock row — left alone");
    return;
  }
  const superAdmin = (await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } }))?.id ?? cast.admin.id;
  const fyEnd = clock.at(TM - 1 >= 3 ? TY : TY - 1, 2, 31, 8, 0);
  const lockedAt = fyEnd.getTime() < NOW.getTime() - 30 * DAY ? fyEnd : workedAt(180);
  await db.companyLock.create({
    data: {
      id: "global",
      enabled: false,
      message: LOCK_MESSAGE,
      until: plus(lockedAt, 6 * 60),
      lockedAt,
      lockedById: superAdmin,
    },
  });
  log("CRM: company lock", `used once on ${clock.date(lockedAt)} and lifted — off now`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * For `--reset`, before the demo companies go: what this adds that no demo company or person takes
 * with it. Dismissals are plain ids with no foreign key; field definitions and the lock row belong to
 * nothing. Everything else here hangs off a demo company, person, lead or item and goes with it.
 */
export async function resetCrm(db: PrismaClient, companyIds: string[]): Promise<void> {
  await db.companyDuplicateDismissal.deleteMany({ where: { OR: [{ companyAId: { in: companyIds } }, { companyBId: { in: companyIds } }] } });
  await db.customFieldDefinition.deleteMany({ where: { OR: FIELDS.map((f) => ({ entity: f.entity, label: f.label, type: f.type })) } });
  await db.companyLock.deleteMany({ where: { id: "global", enabled: false, message: LOCK_MESSAGE } });
}

export default async function seedCrm(db: PrismaClient, ctx: DemoContext): Promise<void> {
  const cast = await castOf(db, ctx);
  const app = await appFunctions();
  try {
    await coverCompanies(db, cast);
    await coverContacts(db, cast);
    await coverDuplicates(db, cast, app);
    await coverLeads(db, ctx, cast);
    await coverCalls(db, cast);
    await coverVisits(db, cast);
    await coverMeetings(db, cast, app);
    await coverWorkbooks(db, cast);
    await coverNotes(db, cast, app);
    await coverForecast(db, cast);
    await coverCustomFields(db, ctx, cast);
    await coverLock(db, cast);

    // ── Credit ratings, from the payment history, by the credit engine itself ──
    const rated = (await db.company.findMany({ where: { tags: { has: DEMO_TAG }, relationshipType: { in: ["CLIENT", "RESELLER"] } }, select: { id: true } })).map((c) => c.id);
    const assessments = await app.ws(() => app.credit.assessCompanies(rated, NOW));
    await app.ws(() => app.credit.cacheAssessments(assessments, NOW));
    const ratings: Record<string, number> = {};
    for (const a of assessments.values()) ratings[a.rating] = (ratings[a.rating] ?? 0) + 1;
    log("CRM: credit ratings", Object.entries(ratings).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", "));

    // ── Lead scores, now that their calls, meetings and moves are all there ──
    const leads = await db.lead.findMany({ where: { company: { tags: { has: DEMO_TAG } } }, select: { id: true } });
    for (const l of leads) await app.refreshLeadScore(l.id, db, NOW);
    log("CRM: lead scores", `${leads.length} scored`);
  } finally {
    await app.close();
  }
}
