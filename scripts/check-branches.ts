/**
 * Branches and GST registrations: one company, several GSTINs, and every place that has to know
 * which one a document is under.
 *
 * What goes wrong without this, and what each costs:
 *
 *   · **The wrong GSTIN on a document.** A Bengaluru invoice under the Mumbai GSTIN is a supply the
 *     Mumbai registration never made — the customer's input credit fails the match, and both returns
 *     are wrong.
 *   · **The wrong tax.** CGST+SGST versus IGST is decided by the *branch's* state, not the registered
 *     office's. Getting it backwards is tax paid to the wrong government.
 *   · **Numbers that aren't a series.** Rule 46(b) wants a consecutive series per GSTIN, of at most
 *     16 characters; the IRP refuses anything longer or starting with 0, / or -.
 *   · **Returns that mix GSTINs.** GSTR-1 and 3B are filed per registration; a document or a ledger
 *     line counted in the wrong one is a mismatch notice.
 *
 * Two halves. The pure half needs no database: the GSTIN checksum, the identity merge, the numbering
 * tokens, the India-day helpers. The database half builds its own registration, branch, customer
 * and vendor under the `ZZBR` prefix and drives the real actions, as the super admin, against the
 * real dev database — so every assertion is about the suite's own fixture, never a table count.
 *
 * Shared settings it has to touch are snapshotted first and put back in a `finally`: the
 * organisation's PAN (only when it had none), GSTIN mirror and e-invoice switch; the head office's
 * registration and anything `setHeadOffice` copied into it; the invoice numbering setting and its
 * series. The e-invoice portal is the local `mock` provider only; nothing here sends mail or
 * reaches a real portal.
 *
 * Dates are written with India's offset spelled out. Run it under a foreign clock too — a suite
 * written in host-local time agrees with the timezone bug it is meant to catch:
 *
 *   npm run check:branches
 *   TZ=UTC npm run check:branches
 *   $env:TZ = "Pacific/Auckland"; npm run check:branches     (PowerShell — Git Bash drops a TZ with "/")
 */
import "dotenv/config";
import Module from "node:module";
import { createHash } from "node:crypto";
import type { Branch, DocumentNumberSetting, DocumentSeries, OrganisationSettings, TradeDocumentType } from "@prisma/client";
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import {
  GST_STATE_ABBREVIATIONS,
  GST_STATE_CODES,
  financialYearOf,
  gstinCheckCharacter,
  hasValidGstinChecksum,
  isValidGstin,
  panOfGstin,
  shortFinancialYear,
} from "../src/lib/gst-engine";
import { buildDocumentNumber, derivedSeriesPrefix, expandPrefix, gstNumberProblem } from "../src/lib/document-numbering";
import { mergeIdentity } from "../src/lib/branches/format";
import { indiaClock } from "../src/lib/time/zone";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const json = (value: unknown) => JSON.stringify(value);

// ── Who the actions think is calling ───────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

/**
 * The module swaps, installed before anything that imports them is loaded.
 *
 * Matched on the resolved file as well as on the text of the import, so a module that reaches the
 * session through `@/lib/session` or a relative path gets the stub either way. Everything that
 * decides behaviour — the permission resolver, the plan check, the rules — is the real code; only
 * "who is asking", the cache revalidation, the router and the view-mode cookie are supplied.
 */
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};

class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  // Distinguishable from any other throw: "not found" and "the page crashed" must not look alike.
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/documents",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// The list reads its layout from a cookie; outside a request there is none, so it is the table.
const viewMode = { getViewMode: async () => "list" as const, setViewMode: async () => {} };

const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/actions/view-mode", viewMode],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/actions/view-mode"), viewMode],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    // Not resolvable from here, so certainly not one of ours — let the real loader raise it.
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

/** Every element of `type` in a tree a server component returned — found without rendering it. */
function findElements(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findElements((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

/** Runs `run` with `new Date()` and `Date.now()` reading `iso` — for code that asks the clock what day it is. */
function atClock<T>(iso: string, run: () => T): T {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return run();
  } finally {
    globalThis.Date = RealDate;
  }
}

const withCheck = (first14: string) => `${first14}${gstinCheckCharacter(first14) ?? "?"}`;

// ─── The pure half ───────────────────────────────────────────────────────────────────────────────

function pure() {
  section("1. The GSTIN check digit");
  ok("27AAPFU0939F1ZV passes the checksum", hasValidGstinChecksum("27AAPFU0939F1ZV"));
  ok("29AAGCB7383J1Z4 passes the checksum", hasValidGstinChecksum("29AAGCB7383J1Z4"));
  ok("  one character changed (the check digit) fails", !hasValidGstinChecksum("27AAPFU0939F1ZW"));
  ok("  one character changed (inside the PAN) fails", !hasValidGstinChecksum("27AAPFU0938F1ZV"));
  ok("gstinCheckCharacter gives a published GSTIN's own check digit", gstinCheckCharacter("27AAPFU0939F1Z") === "V", gstinCheckCharacter("27AAPFU0939F1Z"));
  const assembled = withCheck("29ZZBRP1234Z9Z");
  ok(
    "a GSTIN assembled with gstinCheckCharacter round-trips",
    assembled.length === 15 && hasValidGstinChecksum(assembled) && isValidGstin(assembled),
    assembled,
  );
  ok("  and a wrong length gives no check digit at all", gstinCheckCharacter("29ZZBRP1234Z9") === null);

  section("2. PAN, and the registration codes");
  ok("panOfGstin reads characters 3–12", panOfGstin("27AAPFU0939F1ZV") === "AAPFU0939F", panOfGstin("27AAPFU0939F1ZV"));
  ok("  and nothing from something that isn't a GSTIN", panOfGstin("not a gstin") === null && panOfGstin(null) === null);
  const missing = Object.keys(GST_STATE_CODES).filter((code) => code !== "96" && !GST_STATE_ABBREVIATIONS[code]);
  const extra = Object.keys(GST_STATE_ABBREVIATIONS).filter((code) => !GST_STATE_CODES[code] || code === "96");
  ok(
    "GST_STATE_ABBREVIATIONS has every GST state code except 96, and nothing else",
    missing.length === 0 && extra.length === 0,
    json({ missing, extra }),
  );

  section("3. Who we are on paper — the merge rule");
  const org = {
    legalName: "ZZBR Org Pvt Ltd",
    addressLine1: "1 Nariman Point",
    city: "Mumbai",
    state: "Maharashtra",
    stateCode: "27",
    pincode: "400021",
    bankName: "HDFC Bank",
    bankAccountNumber: "50100000000001",
    bankIfsc: "HDFC0000001",
    bankBranch: "Fort",
    upiId: "org@hdfc",
    invoiceTerms: "Org terms",
    invoiceNotes: "Org notes",
    signatureDataUrl: "data:image/png;base64,T1JH",
  };
  const mh = { id: "r-mh", gstin: "27AAPFU0939F1ZV", stateCode: "27", code: "MH" };
  const ho = mergeIdentity({ id: "b-ho", name: "Head office", code: "HO", isHeadOffice: true, gstRegistration: mh }, org);
  ok(
    "a head office with a blank address prints the organisation's",
    ho.addressSource === "organisation" && ho.addressLine1 === "1 Nariman Point" && ho.city === "Mumbai" && ho.gstin === mh.gstin,
    json({ source: ho.addressSource, line1: ho.addressLine1 }),
  );
  const pune = mergeIdentity(
    {
      id: "b-pune", name: "Pune", code: "PUN", isHeadOffice: false, gstRegistration: mh,
      addressLine1: "3 FC Road", city: "Pune", state: "Maharashtra", pincode: "411004",
      bankAccountNumber: "999000111", invoiceTerms: "   ",
    },
    org,
  );
  ok(
    "a branch with its own account number takes the whole bank block — IFSC included, even blank",
    pune.bankAccountNumber === "999000111" && pune.bankIfsc === null && pune.bankName === null && pune.upiId === null,
    json({ acct: pune.bankAccountNumber, ifsc: pune.bankIfsc, name: pune.bankName, upi: pune.upiId }),
  );
  ok("  and its own address, whole", pune.addressSource === "branch" && pune.city === "Pune" && pune.addressLine2 === null);
  ok(
    "terms and signature fall back one by one; the logo does not",
    pune.invoiceTerms === "Org terms" && pune.signatureDataUrl === org.signatureDataUrl && pune.invoiceNotes === "Org notes" && pune.logoDataUrl === null,
  );
  const mismatched = mergeIdentity(
    { id: "b-x", name: "X", code: "X", isHeadOffice: false, gstRegistration: mh, addressLine1: "2 Brigade Road", city: "Bengaluru", state: "Karnataka", pincode: "560025" },
    org,
  );
  ok("the registration's state beats the address's", mismatched.stateCode === "27", mismatched.stateCode);

  // The coordinator's fix: an unregistered head office on the registered office's address.
  const unregistered = { id: "b-ho", name: "Head office", code: "HO", isHeadOffice: true, gstRegistration: null };
  const typo = mergeIdentity(unregistered, { state: "Maharastra", stateCode: "27" });
  ok(
    "an unregistered head office whose state name doesn't map falls back to Profile's stored state code",
    typo.stateCode === "27",
    typo.stateCode,
  );
  ok("  the name still wins when it maps", mergeIdentity(unregistered, { state: "Karnataka", stateCode: "27" }).stateCode === "29");
  ok(
    "  a branch on its own address gets no such fallback",
    mergeIdentity({ ...unregistered, isHeadOffice: false, addressLine1: "4 Road", city: "Pune", state: "Maharastra", pincode: "411004" }, { stateCode: "27" }).stateCode === null,
  );
  ok(
    "  and a head office abroad has no state at all",
    mergeIdentity(unregistered, { country: "United Arab Emirates", state: "Dubai", stateCode: "27" }).stateCode === null,
  );

  section("4. Numbering: tokens, the derived prefix, the 16-character rule");
  const lastDay = new Date("2027-03-31T23:30:00+05:30");
  const firstDay = new Date("2027-04-01T00:30:00+05:30");
  const ctx = { registrationCode: "MH", branchCode: "PUN" };
  ok(
    "23:30 IST on 31 March 2027 is still 2026-27",
    expandPrefix("{GST}/{BR}/{FY}/{FY2}/", lastDay, ctx) === "MH/PUN/2026-27/2627/",
    expandPrefix("{GST}/{BR}/{FY}/{FY2}/", lastDay, ctx),
  );
  ok(
    "00:30 IST on 1 April 2027 is 2027-28",
    expandPrefix("{GST}/{BR}/{FY}/{FY2}/", firstDay, ctx) === "MH/PUN/2027-28/2728/",
    expandPrefix("{GST}/{BR}/{FY}/{FY2}/", firstDay, ctx),
  );
  ok(
    "financialYearOf 01:00 IST on 1 April 2027 is 2027-28, whatever the host clock",
    financialYearOf(new Date("2027-04-01T01:00:00+05:30")) === "2027-28" && shortFinancialYear(new Date("2027-04-01T01:00:00+05:30")) === "2728",
    financialYearOf(new Date("2027-04-01T01:00:00+05:30")),
  );
  const derived = derivedSeriesPrefix("INV/{FY}/", "REGISTRATION");
  const first = buildDocumentNumber(derived, 1, 4, lastDay, { registrationCode: "MH" });
  ok("derivedSeriesPrefix(\"INV/{FY}/\", REGISTRATION) is {GST}/INV/{FY2}/", derived === "{GST}/INV/{FY2}/", derived);
  ok("  its first number is MH/INV/2627/0001, exactly 16 characters", first === "MH/INV/2627/0001" && first.length === 16, first);
  ok("  and GST has no problem with it", gstNumberProblem("INVOICE", first) === null, gstNumberProblem("INVOICE", first) ?? "");
  ok("  per branch it is {BR}/INV/{FY2}/", derivedSeriesPrefix("INV/{FY}/", "BRANCH") === "{BR}/INV/{FY2}/");
  const long = gstNumberProblem("INVOICE", "MH/INV/2026-27/0001");
  ok("MH/INV/2026-27/0001 is refused — it is over 16 characters", long !== null && long.includes("16"), long ?? "accepted");
  ok("0INV/1 is refused — a GST number cannot start with 0", gstNumberProblem("INVOICE", "0INV/1") !== null);
  ok("  and a proposal is not a GST document, so it is not checked", gstNumberProblem("PROPOSAL", "0QT/2026-27/000000001") === null);

  section("The India clock, wherever the server is");
  const { portalDate } = load("../src/lib/eway/payload") as typeof import("../src/lib/eway/payload");
  ok(
    "portalDate: 01:30 IST on 1 October is 01/10/2026",
    portalDate(new Date("2026-10-01T01:30:00+05:30")) === "01/10/2026",
    portalDate(new Date("2026-10-01T01:30:00+05:30")),
  );
  ok("  and 23:59 IST on 30 September is 30/09/2026", portalDate(new Date("2026-09-30T23:59:00+05:30")) === "30/09/2026");

  const { emptyDefaults } = load("../src/lib/document-draft") as typeof import("../src/lib/document-draft");
  // Dated today on the workspace's clock — India's here.
  const early = atClock("2026-10-01T01:30:00+05:30", () => emptyDefaults(indiaClock).issueDate);
  ok("a new document at 01:30 IST on 1 October defaults to 1 October, not 30 September", early === "2026-10-01", early);
  const beforeDawn = atClock("2026-10-01T05:29:00+05:30", () => emptyDefaults(indiaClock).issueDate);
  ok("  and still at 05:29 IST", beforeDawn === "2026-10-01", beforeDawn);
  const lateNight = atClock("2026-09-30T23:59:00+05:30", () => emptyDefaults(indiaClock).issueDate);
  ok("  and 23:59 IST on 30 September is still the 30th", lateNight === "2026-09-30", lateNight);
}

// ─── The database half ───────────────────────────────────────────────────────────────────────────

const PREFIX = "ZZBR";
/** Set on the organisation only when it has no PAN of its own — and taken off again. */
const PROBE_PAN = "ZZBRP1234Z";
/** Someone else's PAN, for the refusal. Never saved. */
const OTHER_PAN = "ZZBRQ5678Y";
const CUSTOMER_PAN = "ZZBRC5678Q";
const VENDOR_PAN = "ZZBRV4321K";
/** Two characters, so `{GST}/INV/{FY2}/0001` is exactly 16. Entity character 8 and 9 below keep the GSTINs off any real one. */
const R1_CODE = "Z8";
const R2_CODE = "Z9";
const B2_CODE = "ZZB2";
const FIXTURE_BRANCH_CODES = [B2_CODE, "ZZB3", "ZZB4"];
const NUMBERED_TYPES = ["INVOICE", "CREDIT_NOTE", "PROPOSAL", "BILL"] as const;
const HEAD_OFFICE_FIELDS = ["addressLine1", "addressLine2", "city", "state", "pincode", "country", "email", "phone"] as const;

/** Where a fixture branch and its customer sit, by GST state code. */
const PLACES: Record<string, { name: string; city: string; state: string; pincode: string }> = {
  "29": { name: "Bengaluru", city: "Bengaluru", state: "Karnataka", pincode: "560025" },
  "27": { name: "Mumbai", city: "Mumbai", state: "Maharashtra", pincode: "400021" },
};

type Created = {
  companies: string[];
  documents: string[];
  branches: string[];
  registrations: string[];
  entries: string[];
  departments: string[];
};

type Snapshot = {
  org: OrganisationSettings | null;
  headOffice: Branch;
  settings: DocumentNumberSetting[];
  invoiceSeries: DocumentSeries[];
  policiesDisabled: TradeDocumentType[];
};

type HeadOfficeField = (typeof HEAD_OFFICE_FIELDS)[number];

/** The head office fields that differ between two readings of it, as an update that puts back the first. */
function headOfficeFieldsOf(wanted: Branch, now: Branch): Partial<Record<HeadOfficeField, string | null>> {
  const changed: Partial<Record<HeadOfficeField, string | null>> = {};
  for (const field of HEAD_OFFICE_FIELDS) if (now[field] !== wanted[field]) changed[field] = wanted[field];
  return changed;
}

/** The fixture registrations, by the GSTIN shape and code this suite gives them — never by code alone. */
const fixtureRegistrationWhere = (pans: string[], ids: string[]) => ({
  OR: [
    { id: { in: ids } },
    ...pans.flatMap((pan) => [
      { code: R1_CODE, gstin: { contains: `${pan}8Z` } },
      { code: R2_CODE, gstin: { contains: `${pan}9Z` } },
    ]),
  ],
});

/**
 * Everything this suite makes, found by id, by the ZZBR prefix, by the fixture GSTINs and by what
 * points at a fixture branch or registration. Runs first (a crashed run's leftovers) and last.
 *
 * Journal lines are immutable in the app; for the suite's own documents and entries they are deleted
 * here directly, reversals before the entries they reverse. A document or line of somebody else's
 * that happens to name a fixture registration (another suite's head-office invoice written while the
 * head office held R1) is let go of that registration rather than deleted.
 */
async function cleanup(created: Created, pans: string[], headOfficeId: string | null) {
  const branches = await db.branch.findMany({
    where: { OR: [{ id: { in: created.branches } }, { name: { startsWith: PREFIX } }, { code: { in: FIXTURE_BRANCH_CODES } }] },
    select: { id: true, isHeadOffice: true },
  });
  const branchIds = branches.map((b) => b.id);

  // A run that died between the two setHeadOffice calls leaves the flag on a fixture branch.
  if (branches.some((b) => b.isHeadOffice)) {
    const fallback =
      headOfficeId ??
      (await db.branch.findFirst({ where: { id: "branch_head_office" }, select: { id: true } }))?.id ??
      (await db.branch.findFirst({ where: { id: { notIn: branchIds } }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
    await db.$transaction(async (tx) => {
      await tx.branch.updateMany({ where: { id: { in: branchIds } }, data: { isHeadOffice: false } });
      if (fallback) await tx.branch.update({ where: { id: fallback }, data: { isHeadOffice: true }, select: { id: true } });
    });
  }

  const registrations = await db.gstRegistration.findMany({ where: fixtureRegistrationWhere(pans, created.registrations), select: { id: true, gstin: true } });
  const registrationIds = registrations.map((r) => r.id);

  const companies = await db.company.findMany({
    where: { OR: [{ id: { in: created.companies } }, { name: { startsWith: PREFIX } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);

  const documents = await db.tradeDocument.findMany({
    where: {
      OR: [
        { id: { in: created.documents } },
        { docNumber: { startsWith: PREFIX } },
        { companyId: { in: companyIds } },
        { branchId: { in: branchIds } },
      ],
    },
    select: { id: true },
  });
  const documentIds = documents.map((d) => d.id);
  const payments = await db.payment.findMany({
    where: { OR: [{ branchId: { in: branchIds } }, { companyId: { in: companyIds } }] },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);

  const entries = await db.journalEntry.findMany({
    where: {
      OR: [
        { id: { in: created.entries } },
        { documentId: { in: documentIds } },
        { paymentId: { in: paymentIds } },
        { narration: { startsWith: PREFIX } },
        { lines: { some: { branchId: { in: branchIds } } } },
      ],
    },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  const reversals = await db.journalEntry.findMany({ where: { reversesId: { in: entryIds }, id: { notIn: entryIds } }, select: { id: true } });
  await db.journalEntry.deleteMany({ where: { id: { in: reversals.map((r) => r.id) } } });
  await db.journalEntry.deleteMany({ where: { id: { in: entryIds }, reversesId: { not: null } } });
  await db.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await db.journalLine.updateMany({ where: { gstRegistrationId: { in: registrationIds } }, data: { gstRegistrationId: null } });

  await db.ewayBill.deleteMany({ where: { document: { id: { in: documentIds } } } });
  await db.consignment.deleteMany({ where: { branchId: { in: branchIds } } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.tradeDocument.deleteMany({ where: { id: { in: documentIds } } });
  await db.tradeDocument.updateMany({ where: { gstRegistrationId: { in: registrationIds } }, data: { gstRegistrationId: null } });
  await db.documentSeries.deleteMany({ where: { OR: [{ branchId: { in: branchIds } }, { gstRegistrationId: { in: registrationIds } }] } });
  await db.user.updateMany({ where: { branchId: { in: branchIds } }, data: { branchId: null } });
  // The head office took R1 when this suite created it (it had none): it lets go of it here.
  await db.branch.updateMany({ where: { gstRegistrationId: { in: registrationIds }, id: { notIn: branchIds } }, data: { gstRegistrationId: null } });
  await db.branch.deleteMany({ where: { id: { in: branchIds }, isHeadOffice: false } });
  await db.gstRegistration.deleteMany({ where: { id: { in: registrationIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.department.deleteMany({ where: { OR: [{ id: { in: created.departments } }, { name: { startsWith: PREFIX } }] } });
  // The trail of what this suite did: by the rows it touched — including a branch the action itself
  // deleted, and the real head office's side of the round trip, which names B2 — and by the prefix.
  const touched = [...documentIds, ...branchIds, ...registrationIds, ...companyIds, ...paymentIds, ...Object.values(created).flat()];
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: touched } }, { entityLabel: { contains: PREFIX } }] } });

  // A crashed run's probe PAN and GSTIN mirror on the organisation. The finally restores its own
  // snapshot first, so this only ever finds a crash's.
  const org = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { pan: true, gstin: true, legalName: true } });
  if (org?.pan === PROBE_PAN) {
    if (org.legalName.startsWith(PREFIX)) await db.organisationSettings.deleteMany({ where: { id: "global" } });
    else await db.organisationSettings.update({ where: { id: "global" }, data: { pan: null } });
  }
  if (org?.gstin && registrations.some((r) => r.gstin === org.gstin)) {
    await db.organisationSettings.updateMany({ where: { id: "global" }, data: { gstin: null } });
  }
}

/** Puts back every shared row this suite changed, from the snapshot taken before it changed any. */
async function restoreShared(snap: Snapshot) {
  const headOffice = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
  if (headOffice?.id !== snap.headOffice.id) {
    await db.$transaction(async (tx) => {
      await tx.branch.updateMany({ where: { isHeadOffice: true }, data: { isHeadOffice: false } });
      await tx.branch.update({ where: { id: snap.headOffice.id }, data: { isHeadOffice: true }, select: { id: true } });
    });
  }
  const now = await db.branch.findUniqueOrThrow({ where: { id: snap.headOffice.id } });
  const changed = headOfficeFieldsOf(snap.headOffice, now);
  if (now.gstRegistrationId !== snap.headOffice.gstRegistrationId || Object.keys(changed).length > 0) {
    await db.branch.update({
      where: { id: snap.headOffice.id },
      data: { ...changed, gstRegistrationId: snap.headOffice.gstRegistrationId },
      select: { id: true },
    });
  }

  if (!snap.org) {
    // No row existed: this suite's probe PAN made it, and leaving it would give the workspace a PAN.
    await db.organisationSettings.deleteMany({ where: { id: "global" } });
  } else {
    await db.organisationSettings.update({
      where: { id: "global" },
      data: {
        pan: snap.org.pan,
        gstin: snap.org.gstin,
        einvoiceEnabled: snap.org.einvoiceEnabled,
        einvoiceMinValue: snap.org.einvoiceMinValue,
      },
    });
  }

  // Invoice numbering exactly as it was; the other types' counters keep the numbers the fixture
  // burned, as every suite's do — but a setting row this run created goes again.
  const invoiceBefore = snap.settings.find((s) => s.docType === "INVOICE");
  for (const docType of NUMBERED_TYPES) {
    const before = snap.settings.find((s) => s.docType === docType);
    if (!before) await db.documentNumberSetting.deleteMany({ where: { docType } });
  }
  if (invoiceBefore) {
    await db.documentNumberSetting.update({
      where: { docType: "INVOICE" },
      data: {
        scope: invoiceBefore.scope,
        mode: invoiceBefore.mode,
        prefix: invoiceBefore.prefix,
        nextNumber: invoiceBefore.nextNumber,
        padding: invoiceBefore.padding,
      },
    });
  }
  await db.documentSeries.deleteMany({ where: { docType: "INVOICE", id: { notIn: snap.invoiceSeries.map((s) => s.id) } } });
  for (const series of snap.invoiceSeries) {
    await db.documentSeries.update({
      where: { id: series.id },
      data: { prefix: series.prefix, nextNumber: series.nextNumber, padding: series.padding },
    });
  }

  if (snap.policiesDisabled.length > 0) {
    await db.documentApprovalPolicy.updateMany({
      where: { docType: { in: snap.policiesDisabled } },
      data: { enabled: true },
    });
  }
}

async function database() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) {
    section("The database half");
    ok("a super admin exists to act as", false, "seed the database first");
    return;
  }
  actor = { id: admin.id, name: admin.name, email: admin.email, role: String(admin.role) };

  const branchActions = load("../src/actions/branch") as typeof import("../src/actions/branch");
  const docs = load("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const numbering = load("../src/actions/document-number") as typeof import("../src/actions/document-number");
  const tax = load("../src/actions/tax-reports") as typeof import("../src/actions/tax-reports");
  const reports = load("../src/actions/ledger-reports") as typeof import("../src/actions/ledger-reports");
  const identity = load("../src/lib/branches/identity") as typeof import("../src/lib/branches/identity");
  const journal = load("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const registry = load("../src/lib/tables/registry") as typeof import("../src/lib/tables/registry");
  const { DocumentList } = load("../src/components/documents/document-list") as typeof import("../src/components/documents/document-list");
  const { DocumentRows } = load("../src/components/documents/document-rows") as typeof import("../src/components/documents/document-rows");
  const { ColumnPicker, TableColumnsProvider } = load("../src/components/ui/table-columns") as typeof import("../src/components/ui/table-columns");
  const { SelectParamFilter } = load("../src/components/ui/select-param-filter") as typeof import("../src/components/ui/select-param-filter");
  const { DocumentForm } = load("../src/components/documents/document-form") as typeof import("../src/components/documents/document-form");
  const NewDocumentPage = (load("../src/app/(dashboard)/documents/new/page") as typeof import("../src/app/(dashboard)/documents/new/page")).default;
  const PrintPage = (load("../src/app/(print)/documents/[id]/print/page") as typeof import("../src/app/(print)/documents/[id]/print/page")).default;

  const created: Created = { companies: [], documents: [], branches: [], registrations: [], entries: [], departments: [] };
  const firstOrg = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { pan: true } });
  const firstHo = await db.branch.findFirst({ where: { isHeadOffice: true }, include: { gstRegistration: true } });
  const candidatePans = () =>
    [...new Set([PROBE_PAN, panOfGstin(firstHo?.gstRegistration?.gstin), firstOrg?.pan?.trim().toUpperCase() || null].filter((p): p is string => Boolean(p)))];
  await cleanup(created, candidatePans(), null);

  let snap: Snapshot | null = null;
  let pan = "";

  try {
    section("5. The fixture: GSTINs built on the company's own PAN");
    const ho0 = await identity.ensureHeadOffice();
    const [orgBefore, settingsBefore, seriesBefore, enabledPolicies] = await Promise.all([
      db.organisationSettings.findUnique({ where: { id: "global" } }),
      db.documentNumberSetting.findMany({ where: { docType: { in: [...NUMBERED_TYPES] } } }),
      db.documentSeries.findMany({ where: { docType: "INVOICE" } }),
      db.documentApprovalPolicy.findMany({ where: { docType: { in: [...NUMBERED_TYPES] }, enabled: true }, select: { docType: true } }),
    ]);
    const hoRow = await db.branch.findUniqueOrThrow({ where: { id: ho0.id } });
    snap = { org: orgBefore, headOffice: hoRow, settings: settingsBefore, invoiceSeries: seriesBefore, policiesDisabled: enabledPolicies.map((p) => p.docType) };
    // Sign-off is a policy about people, not about GSTINs; with one switched on the issues below would
    // wait for an approver. Put back in the finally.
    if (snap.policiesDisabled.length > 0) {
      await db.documentApprovalPolicy.updateMany({ where: { docType: { in: enabledPolicies.map((p) => p.docType) } }, data: { enabled: false } });
    }
    // Issuing posts to the ledger, and only the accounting screens seed the chart of accounts; a
    // workspace that never opened them (a freshly reset one) has none. Seeded the way those screens do.
    await journal.ensureChartOfAccounts();
    const hoIdentity = await identity.branchIdentity(ho0.id);
    const singleBranchAtStart = !(await identity.isMultiBranch());

    const orgPan = orgBefore?.pan?.trim().toUpperCase() || null;
    pan = panOfGstin(ho0.gstRegistration?.gstin) ?? orgPan ?? "";
    const probePan = !pan;
    if (probePan) {
      pan = PROBE_PAN;
      await db.organisationSettings.upsert({
        where: { id: "global" },
        create: { id: "global", legalName: `${PREFIX} Probe Traders Pvt Ltd`, pan: PROBE_PAN },
        update: { pan: PROBE_PAN },
      });
    }
    ok("the fixture PAN is the company's own", /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan), probePan ? `${pan} — a probe PAN; the company had none, and it goes again` : pan);

    // ── R1: the head office's registration, or one the head office is given.
    let r1 = ho0.gstRegistration;
    if (r1) {
      ok("R1 is the head office's own registration", Boolean(r1.active), `${r1.gstin} (${r1.code}), reused and not changed`);
    } else {
      const r1State = hoIdentity.stateCode && GST_STATE_CODES[hoIdentity.stateCode] && hoIdentity.stateCode !== "96" ? hoIdentity.stateCode : "27";
      const saved = await branchActions.saveGstRegistration({ gstin: withCheck(`${r1State}${pan}8Z`), code: R1_CODE });
      if (saved.ok) created.registrations.push(saved.data.id);
      ok("R1 is created, since the head office has no registration", saved.ok, saved.ok ? withCheck(`${r1State}${pan}8Z`) : saved.error);
      const heldBy = await db.branch.findUnique({ where: { id: ho0.id }, include: { gstRegistration: true } });
      r1 = heldBy?.gstRegistration ?? null;
      ok(
        "  and the head office, which had none, is given it (the first-registration rule)",
        saved.ok && r1?.id === saved.data.id && r1.einvoiceProvider === null,
        r1 ? `${r1.gstin}, provider ${r1.einvoiceProvider ?? "not set up"}` : "the head office has no registration",
      );
    }
    if (!r1) throw new Error("R1 could not be set up — the rest of the suite needs a registered head office.");
    const r2State = r1.stateCode === "29" ? "27" : "29";
    const place = PLACES[r2State]!;
    const r2Gstin = withCheck(`${r2State}${pan}9Z`);
    const customerGstin = withCheck(`${r2State}${CUSTOMER_PAN}1Z`);
    const vendorGstin = withCheck(`${r2State}${VENDOR_PAN}1Z`);
    ok(
      "R2's GSTIN is built on the same PAN, in another state, with a valid check digit",
      r2State !== r1.stateCode && panOfGstin(r2Gstin) === pan && hasValidGstinChecksum(r2Gstin),
      `${r2Gstin} (${GST_STATE_CODES[r2State]}), R1 in ${GST_STATE_CODES[r1.stateCode]}`,
    );

    // ── The Branch column while there is one branch (only answerable if the workspace starts with one).
    const listInvoices = async () =>
      (await DocumentList({ docType: "INVOICE", title: "Invoices", description: "ZZBR", searchParams: {} })) as ReactElement;
    if (singleBranchAtStart) {
      section("The document list's Branch column — one branch");
      const tree = await listInvoices();
      const picker = findElements(tree, ColumnPicker)[0];
      const rows = findElements(tree, DocumentRows)[0];
      ok("with one branch the column picker does not offer Branch", json((picker?.props as { omit?: string[] })?.omit) === json(["branch"]), json((picker?.props as { omit?: string[] })?.omit));
      ok("  and the rows are told not to draw it", (rows?.props as { branchColumn?: boolean })?.branchColumn === false);
      ok(
        "  and there is no branch filter",
        !findElements(tree, SelectParamFilter).some((f) => (f.props as { paramName: string }).paramName === "branch"),
      );
    } else {
      console.log("  note  the workspace already has more than one active branch, so the one-branch list can't be checked here");
    }

    section("6. Registrations and branches, through the real actions");
    const wrongPan = withCheck(`${r2State}${OTHER_PAN}9Z`);
    const refusedPan = await branchActions.saveGstRegistration({ gstin: wrongPan, code: "Z7" });
    ok(
      "a GSTIN on another PAN is refused, naming both PANs",
      !refusedPan.ok && refusedPan.error.includes(OTHER_PAN) && refusedPan.error.includes(pan),
      refusedPan.ok ? "accepted" : refusedPan.error,
    );
    const badCheck = `${r2Gstin.slice(0, 14)}${r2Gstin[14] === "A" ? "B" : "A"}`;
    const refusedCheck = await branchActions.saveGstRegistration({ gstin: badCheck, code: "Z7" });
    ok(
      "a GSTIN with a wrong check digit is refused, saying so",
      !refusedCheck.ok && refusedCheck.error.includes("check digit"),
      refusedCheck.ok ? "accepted" : refusedCheck.error,
    );
    const savedR2 = await branchActions.saveGstRegistration({ gstin: r2Gstin, code: R2_CODE });
    if (savedR2.ok) created.registrations.push(savedR2.data.id);
    ok("R2 is created", savedR2.ok, savedR2.ok ? r2Gstin : savedR2.error);
    if (!savedR2.ok) throw new Error("R2 could not be created");
    const r2 = await db.gstRegistration.findUniqueOrThrow({ where: { id: savedR2.data.id } });
    ok(
      "  stored with its state, its code, active and not set up for e-invoicing",
      r2.stateCode === r2State && r2.code === R2_CODE && r2.active && r2.einvoiceProvider === null,
      json({ state: r2.stateCode, code: r2.code, provider: r2.einvoiceProvider }),
    );
    ok(
      "  and the head office keeps R1",
      (await db.branch.findUniqueOrThrow({ where: { id: ho0.id } })).gstRegistrationId === r1.id,
    );

    const address = { addressLine1: `${PREFIX} 14 Residency Road`, city: place.city, state: place.state, pincode: place.pincode, country: "India" };
    const wrongState = await branchActions.saveBranch({ name: `${PREFIX} Wrong state`, code: "ZZB4", ...address, gstRegistrationId: r1.id });
    ok(
      `a ${place.state} address on a ${GST_STATE_CODES[r1.stateCode]} registration is refused`,
      !wrongState.ok && wrongState.error.includes("state-specific") && wrongState.error.includes(place.state),
      wrongState.ok ? "accepted" : wrongState.error,
    );
    if (wrongState.ok) created.branches.push(wrongState.data.id);
    const savedB2 = await branchActions.saveBranch({ name: `${PREFIX} ${place.name}`, code: B2_CODE, ...address, gstRegistrationId: r2.id });
    if (savedB2.ok) created.branches.push(savedB2.data.id);
    ok(`B2 ("${PREFIX} ${place.name}", ${B2_CODE}) is created on R2`, savedB2.ok, savedB2.ok ? "" : savedB2.error);
    if (!savedB2.ok) throw new Error("B2 could not be created");
    const b2 = await db.branch.findUniqueOrThrow({ where: { id: savedB2.data.id } });
    ok("  with its own address and R2", b2.gstRegistrationId === r2.id && b2.addressLine1 === address.addressLine1 && !b2.isHeadOffice);

    const toB2 = await branchActions.setHeadOffice(b2.id);
    const headsWhileB2 = await db.branch.findMany({ where: { isHeadOffice: true }, select: { id: true } });
    ok(
      "setHeadOffice(B2): exactly one head office, and it is B2",
      toB2.ok && headsWhileB2.length === 1 && headsWhileB2[0]?.id === b2.id,
      toB2.ok ? `${headsWhileB2.length} head office(s)` : toB2.error,
    );
    const back = await branchActions.setHeadOffice(ho0.id);
    const headsAfter = await db.branch.findMany({ where: { isHeadOffice: true }, select: { id: true } });
    ok(
      "setHeadOffice(the original) puts it back: exactly one, the original",
      back.ok && headsAfter.length === 1 && headsAfter[0]?.id === ho0.id,
      back.ok ? `${headsAfter.length} head office(s)` : back.error,
    );
    // The outgoing head office is given the registered office's address when it had none of its own —
    // right for a real move, but this was a round trip, so the head office gets back exactly what it had.
    const hoAfterTrip = await db.branch.findUniqueOrThrow({ where: { id: ho0.id } });
    const copiedBack = headOfficeFieldsOf(hoRow, hoAfterTrip);
    const copied = Object.keys(copiedBack);
    if (copied.length > 0) await db.branch.update({ where: { id: ho0.id }, data: copiedBack, select: { id: true } });
    const hoRestored = await db.branch.findUniqueOrThrow({ where: { id: ho0.id } });
    ok(
      "  and the head office ends the round trip as it started",
      HEAD_OFFICE_FIELDS.every((f) => hoRestored[f] === hoRow[f]) && hoRestored.gstRegistrationId === r1.id,
      copied.length ? `restored ${copied.join(", ")}, which the move copied in` : "nothing was copied into it",
    );
    const deactivateHo = await branchActions.setBranchActive(ho0.id, false);
    ok(
      "the head office can't be deactivated",
      !deactivateHo.ok && deactivateHo.error.includes("head office can't be deactivated"),
      deactivateHo.ok ? "it was" : deactivateHo.error,
    );
    const temp = await branchActions.saveBranch({ name: `${PREFIX} Temporary`, code: "ZZB3", ...address, gstRegistrationId: r2.id });
    if (temp.ok) created.branches.push(temp.data.id);
    const tempGone = temp.ok ? await branchActions.deleteBranch(temp.data.id) : null;
    ok("a branch nothing names can be deleted", Boolean(tempGone?.ok), tempGone && !tempGone.ok ? tempGone.error : temp.ok ? "" : temp.error);

    // ── The fixture parties.
    const customer = await db.company.create({
      data: {
        name: `${PREFIX} Customer Pvt Ltd`,
        normalizedName: `${PREFIX.toLowerCase()} customer pvt ltd`,
        relationshipType: "CLIENT",
        createdById: actor.id,
        ownerUserId: actor.id,
        locations: {
          create: {
            label: `${PREFIX} office`, address: `${PREFIX} 1 MG Road`, city: place.city, state: place.state, pincode: place.pincode,
            country: "India", gstNumber: customerGstin, gstTreatment: "REGISTERED_REGULAR", isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(customer.id);
    const vendor = await db.company.create({
      data: {
        name: `${PREFIX} Vendor Pvt Ltd`,
        normalizedName: `${PREFIX.toLowerCase()} vendor pvt ltd`,
        relationshipType: "VENDOR",
        createdById: actor.id,
        ownerUserId: actor.id,
        locations: {
          create: {
            label: `${PREFIX} works`, address: `${PREFIX} 9 Lavelle Road`, city: place.city, state: place.state, pincode: place.pincode,
            country: "India", gstNumber: vendorGstin, gstTreatment: "REGISTERED_REGULAR", isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(vendor.id);

    const today = indiaClock.today();
    const docInput = (over: Record<string, unknown>) => ({
      docType: "INVOICE",
      companyId: customer.id,
      locationId: customer.locations[0]!.id,
      issueDate: today,
      gstTreatment: "REGISTERED_REGULAR",
      // The form's one GSTIN field is the party's, and a registered party must have one.
      buyerGstin: customerGstin,
      billing: { line1: `${PREFIX} 1 MG Road`, city: place.city, state: place.state, stateCode: r2State, pincode: place.pincode, country: "India" },
      shippingSameAsBilling: true,
      shipping: {},
      lines: [{ name: `${PREFIX} Laptop`, hsnCode: "8471", unit: "NOS", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
      ...over,
    });
    const make = async (label: string, over: Record<string, unknown>) => {
      const result = await docs.createTradeDocument(docInput(over));
      if (result.ok) created.documents.push(result.data.id);
      else ok(`${label} is created`, false, result.error);
      return result.ok ? db.tradeDocument.findUniqueOrThrow({ where: { id: result.data.id } }) : null;
    };

    section("7. Documents: the branch decides the GSTIN and the tax");
    const invB2 = await make("an invoice from B2", { branchId: b2.id });
    ok(
      "an invoice from B2 is under R2: its registration and its GSTIN as the seller's",
      invB2?.branchId === b2.id && invB2.gstRegistrationId === r2.id && invB2.sellerGstin === r2.gstin,
      invB2 ? json({ branch: invB2.branchId === b2.id, reg: invB2.gstRegistrationId === r2.id, seller: invB2.sellerGstin }) : "not created",
    );
    ok(
      `  to a customer in ${place.state} it is CGST + SGST`,
      Number(invB2?.cgstAmount) === 90 && Number(invB2?.sgstAmount) === 90 && Number(invB2?.igstAmount) === 0,
      invB2 ? `CGST ${Number(invB2.cgstAmount)}, SGST ${Number(invB2.sgstAmount)}, IGST ${Number(invB2.igstAmount)}` : "",
    );
    ok("  and the customer's GSTIN is the buyer's", invB2?.buyerGstin === customerGstin, invB2?.buyerGstin ?? "");
    const invHo = await make("the same invoice from the head office", { branchId: ho0.id });
    ok(
      `the same lines from the head office (${GST_STATE_CODES[r1.stateCode]}) are IGST`,
      Number(invHo?.igstAmount) === 180 && Number(invHo?.cgstAmount) === 0 && Number(invHo?.sgstAmount) === 0,
      invHo ? `CGST ${Number(invHo.cgstAmount)}, IGST ${Number(invHo.igstAmount)}` : "",
    );
    ok("  under R1's GSTIN", invHo?.gstRegistrationId === r1.id && invHo.sellerGstin === r1.gstin, invHo?.sellerGstin ?? "");
    const bill = await make("a bill on B2", {
      docType: "BILL", companyId: vendor.id, locationId: vendor.locations[0]!.id, branchId: b2.id, buyerGstin: vendorGstin,
    });
    ok(
      "a bill bought by B2 stores the vendor's GSTIN as the seller's and R2's as the buyer's",
      bill?.sellerGstin === vendorGstin && bill.buyerGstin === r2.gstin && bill.gstRegistrationId === r2.id,
      bill ? json({ seller: bill.sellerGstin, buyer: bill.buyerGstin }) : "",
    );
    ok(
      "  with B2's state as the place of supply, so intra-state",
      bill?.placeOfSupplyCode === r2State && Number(bill.cgstAmount) === 90 && Number(bill.igstAmount) === 0,
      bill ? `place of supply ${bill.placeOfSupplyCode}` : "",
    );
    const b2Delete = await branchActions.deleteBranch(b2.id);
    ok(
      "deleting B2 is refused once a document names it",
      !b2Delete.ok && b2Delete.error.startsWith("Deactivate it instead") && b2Delete.error.includes("document"),
      b2Delete.ok ? "it was deleted" : b2Delete.error,
    );

    section("8. Conversions and credit notes follow the branch");
    const proposal = await make("a proposal from B2", { docType: "PROPOSAL", branchId: b2.id });
    const converted = proposal ? await docs.convertTradeDocument({ id: proposal.id, target: "INVOICE" }) : null;
    if (converted?.ok) created.documents.push(converted.data.id);
    const convertedRow = converted?.ok ? await db.tradeDocument.findUniqueOrThrow({ where: { id: converted.data.id } }) : null;
    ok(
      "PROPOSAL → INVOICE keeps B2, R2 and R2's GSTIN",
      convertedRow?.branchId === b2.id && convertedRow.gstRegistrationId === r2.id && convertedRow.sellerGstin === r2.gstin,
      converted && !converted.ok ? converted.error : "",
    );
    if (invB2) {
      const wrongBranch = await docs.createTradeDocument(docInput({ docType: "CREDIT_NOTE", againstDocumentId: invB2.id, branchId: ho0.id }));
      if (wrongBranch.ok) created.documents.push(wrongBranch.data.id);
      ok(
        "a credit note against the B2 invoice from the head office is refused",
        !wrongBranch.ok && wrongBranch.error === "A credit note is raised by the branch that issued the invoice.",
        wrongBranch.ok ? "accepted" : wrongBranch.error,
      );
      const credit = await make("a credit note against the B2 invoice", { docType: "CREDIT_NOTE", againstDocumentId: invB2.id });
      ok(
        "  without a branch it lands on B2, under R2",
        credit?.branchId === b2.id && credit.gstRegistrationId === r2.id && credit.sellerGstin === r2.gstin,
        credit ? credit.branchId ?? "no branch" : "",
      );
    }

    section("9. Numbering per GST registration");
    const settingNow = await db.documentNumberSetting.findUniqueOrThrow({ where: { docType: "INVOICE" } });
    const companyNext = settingNow.nextNumber;
    const hoSeriesBefore = snap.invoiceSeries.find((s) => s.ownerKey === r1!.id);
    const toRegistration = await numbering.setNumberingScope("INVOICE", "REGISTRATION");
    ok("invoices switch to one series per GST registration", toRegistration.ok, toRegistration.ok ? "" : toRegistration.error);
    const hoSeries = await db.documentSeries.findUnique({ where: { docType_ownerKey: { docType: "INVOICE", ownerKey: r1.id } } });
    const expectedHoNext = Math.max(companyNext, hoSeriesBefore?.nextNumber ?? 0);
    ok(
      "  the head office's registration continues the company counter",
      hoSeries?.nextNumber === expectedHoNext && hoSeries.prefix === settingNow.prefix,
      hoSeries ? `${hoSeries.prefix} from ${hoSeries.nextNumber}; the company was at ${companyNext}` : "no series",
    );
    const r2Series = await db.documentSeries.findUnique({ where: { docType_ownerKey: { docType: "INVOICE", ownerKey: r2.id } } });
    ok(
      "  R2 starts its own, at 1, with the derived prefix",
      r2Series?.nextNumber === 1 && r2Series.prefix === derivedSeriesPrefix(settingNow.prefix, "REGISTRATION"),
      r2Series ? `${r2Series.prefix} from ${r2Series.nextNumber}` : "no series",
    );
    const invB2R = await make("an invoice from B2 under per-registration numbering", { branchId: b2.id });
    const b2Ctx = { registrationCode: r2.code, branchCode: b2.code };
    const expectedB2Number = invB2R ? buildDocumentNumber(derivedSeriesPrefix(settingNow.prefix, "REGISTRATION"), 1, settingNow.padding, invB2R.issueDate, b2Ctx) : "";
    ok(
      settingNow.prefix === "INV/{FY}/"
        ? `an invoice from B2 is numbered ${R2_CODE}/INV/{FY2}/0001 (${expectedB2Number})`
        : `an invoice from B2 is numbered from R2's own series (${expectedB2Number})`,
      invB2R?.docNumber === expectedB2Number && gstNumberProblem("INVOICE", expectedB2Number) === null,
      invB2R?.docNumber ?? "",
    );
    const invHoR = await make("an invoice from the head office under per-registration numbering", { branchId: ho0.id });
    const hoPrefix = expandPrefix(settingNow.prefix, invHoR?.issueDate ?? new Date(), { registrationCode: r1.code, branchCode: ho0.code });
    const hoSerial = Number(/(\d+)$/.exec(invHoR?.docNumber ?? "")?.[1] ?? NaN);
    ok(
      "  the head office's number carries on the company's format and counter",
      Boolean(invHoR?.docNumber.startsWith(hoPrefix)) && hoSerial >= companyNext,
      invHoR?.docNumber ?? "",
    );
    const toCompany = await numbering.setNumberingScope("INVOICE", "COMPANY");
    const settingBack = await db.documentNumberSetting.findUniqueOrThrow({ where: { docType: "INVOICE" } });
    const hoSeriesAfter = await db.documentSeries.findUnique({ where: { docType_ownerKey: { docType: "INVOICE", ownerKey: r1.id } } });
    ok(
      "switching back to one company series continues past the head office's — no number reused",
      toCompany.ok && settingBack.scope === "COMPANY" && settingBack.nextNumber >= (hoSeriesAfter?.nextNumber ?? 0) && settingBack.nextNumber > hoSerial,
      toCompany.ok ? `company next ${settingBack.nextNumber}, head office series next ${hoSeriesAfter?.nextNumber}` : toCompany.error,
    );

    section("10–11. Issuing: the ledger and the returns, per GSTIN");
    const issuedHo = invHo ? await docs.issueTradeDocument({ id: invHo.id }) : null;
    ok("the head office invoice issues", Boolean(issuedHo?.ok), issuedHo && !issuedHo.ok ? issuedHo.error : "");
    if (!invB2R) throw new Error("the B2 invoice under per-registration numbering was not created");
    const { year, month } = indiaClock.parts(invB2R.issueDate);
    const baseline = await tax.gstr3b({ month: month + 1, year, gstRegistrationId: r2.id });
    const issuedB2 = await docs.issueTradeDocument({ id: invB2R.id });
    ok("the B2 invoice issues", issuedB2.ok, issuedB2.ok ? invB2R.docNumber : issuedB2.error);
    const posting = await db.journalEntry.findFirst({
      where: { documentId: invB2R.id, reversesId: null },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    ok(
      "its posting is tagged B2 and R2 on every line",
      Boolean(posting) && posting!.lines.length >= 3 && posting!.lines.every((l) => l.branchId === b2.id && l.gstRegistrationId === r2.id),
      posting ? `${posting.lines.length} lines` : "no posting",
    );

    const numbersIn = (r: { b2b: { docNumber: string }[] } | null) => new Set((r?.b2b ?? []).map((row) => row.docNumber));
    const r2Return = await tax.gstr1({ month: month + 1, year, gstRegistrationId: r2.id });
    const r2Numbers = numbersIn(r2Return);
    ok("GSTR-1 for R2 is R2's", r2Return?.registration?.id === r2.id, r2Return?.registration?.gstin ?? "no registration");
    ok("  it has the B2 invoice", r2Numbers.has(invB2R.docNumber), [...r2Numbers].join(", "));
    ok("  and not the head office's", Boolean(invHo) && !r2Numbers.has(invHo!.docNumber), invHo?.docNumber ?? "");
    const r1Return = await tax.gstr1({ month: month + 1, year, gstRegistrationId: r1.id });
    ok(
      "  which is in R1's return instead, and B2's isn't",
      Boolean(invHo) && numbersIn(r1Return).has(invHo!.docNumber) && !numbersIn(r1Return).has(invB2R.docNumber),
    );
    const afterIssue = await tax.gstr3b({ month: month + 1, year, gstRegistrationId: r2.id });
    const outputOf = (r: typeof afterIssue) => (r?.ledger ? r.ledger.outputCgst + r.ledger.outputSgst : NaN);
    const rise = Math.round((outputOf(afterIssue) - outputOf(baseline)) * 100) / 100;
    const fixtureTax = Number(invB2R.cgstAmount) + Number(invB2R.sgstAmount);
    ok(
      "GSTR-3B's ledger output for R2 rises by exactly the invoice's CGST + SGST",
      rise === fixtureTax && fixtureTax === 180,
      `rose ${rise}, the invoice carries ${fixtureTax}`,
    );
    ok(
      "  and its IGST not at all",
      (afterIssue?.ledger?.outputIgst ?? NaN) === (baseline?.ledger?.outputIgst ?? NaN),
    );

    section("12. The printed invoice speaks for B2");
    let html = "";
    try {
      html = renderToStaticMarkup((await PrintPage({ params: Promise.resolve({ id: invB2R.id }), searchParams: Promise.resolve({}) })) as ReactElement);
      ok("the print page renders for the B2 invoice", html.length > 0, `${html.length} bytes`);
    } catch (error) {
      ok("the print page renders for the B2 invoice", false, error instanceof Error ? error.message : String(error));
    }
    ok("  with R2's GSTIN", html.includes(r2.gstin));
    ok("  and B2's address", html.includes(address.addressLine1));
    ok("  and not the head office's GSTIN", html.length > 0 && !html.includes(r1.gstin), r1.gstin);
    ok("  and a Branch line naming B2", /Branch:\s*(?:<!-- -->)?ZZBR /.test(html) && html.includes(b2.name));

    section("10. Cancelling reverses with the same tags");
    const department = await db.department.create({ data: { name: `${PREFIX} Cost centre` }, select: { id: true } });
    created.departments.push(department.id);
    // A document's posting carries no cost centre of its own; one is put on the lines so the reversal
    // has something to copy — "copied" must not pass because null equals null.
    if (posting) await db.journalLine.updateMany({ where: { entryId: posting.id }, data: { departmentId: department.id } });
    const cancelled = await docs.setTradeDocumentStatus(invB2R.id, "CANCELLED");
    ok("the B2 invoice is cancelled", cancelled.ok, cancelled.ok ? "" : cancelled.error);
    const reversal = posting
      ? await db.journalEntry.findFirst({ where: { reversesId: posting.id }, include: { lines: { orderBy: { sortOrder: "asc" } } } })
      : null;
    if (reversal) created.entries.push(reversal.id);
    ok(
      "the reversal is tagged B2 and R2 on every line, with the cost centre copied",
      Boolean(reversal) &&
        reversal!.lines.length === posting!.lines.length &&
        reversal!.lines.every((l) => l.branchId === b2.id && l.gstRegistrationId === r2.id && l.departmentId === department.id),
      reversal ? `${reversal.lines.length} lines` : "no reversal",
    );
    ok(
      "  with debit and credit swapped",
      Boolean(reversal) && reversal!.lines.every((l, i) => Number(l.debit) === Number(posting!.lines[i]!.credit) && Number(l.credit) === Number(posting!.lines[i]!.debit)),
    );
    const afterCancel = await tax.gstr3b({ month: month + 1, year, gstRegistrationId: r2.id });
    ok("  and R2's ledger output is back where it started", outputOf(afterCancel) === outputOf(baseline), `${outputOf(afterCancel)} vs ${outputOf(baseline)}`);

    section("13. The IRN is generated under R2's own login");
    if (invB2) {
      await db.organisationSettings.update({ where: { id: "global" }, data: { einvoiceEnabled: true, einvoiceMinValue: null } });
      const issued = await docs.issueTradeDocument({ id: invB2.id });
      ok("a separate B2 invoice issues", issued.ok, issued.ok ? invB2.docNumber : issued.error);
      const notSetUp = await docs.generateEInvoice(invB2.id);
      ok(
        "with R2 not set up, generating the IRN is refused, naming R2's GSTIN",
        !notSetUp.ok && notSetUp.error.includes(r2.gstin),
        notSetUp.ok ? "it generated one" : notSetUp.error,
      );
      const mock = await branchActions.saveRegistrationEInvoice({ gstRegistrationId: r2.id, provider: "mock" });
      ok("R2 is set to the mock portal", mock.ok, mock.ok ? "" : mock.error);
      const generated = await docs.generateEInvoice(invB2.id);
      const withIrn = await db.tradeDocument.findUniqueOrThrow({ where: { id: invB2.id } });
      const expectedIrn = createHash("sha256").update(`${r2.gstin}INVOICE${withIrn.docNumber}`).digest("hex");
      ok("  then the IRN is generated", generated.ok && withIrn.einvoiceStatus === "GENERATED", generated.ok ? "" : generated.error);
      ok("  and it is the mock's, derived from R2's GSTIN", withIrn.irn === expectedIrn, withIrn.irn ?? "no IRN");
      let qrSeller: string | null = null;
      try {
        qrSeller = (JSON.parse(Buffer.from(withIrn.signedQrCode ?? "", "base64").toString()) as { SellerGstin?: string }).SellerGstin ?? null;
      } catch {
        qrSeller = null;
      }
      ok("  and the payload's seller GSTIN is R2's", qrSeller === r2.gstin, qrSeller ?? "no QR");
      const statusCancel = await docs.setTradeDocumentStatus(invB2.id, "CANCELLED");
      ok(
        "an invoice with a live IRN can't be cancelled by status",
        !statusCancel.ok && statusCancel.error.includes("active IRN"),
        statusCancel.ok ? "it was" : statusCancel.error,
      );
      const cleared = await branchActions.saveRegistrationEInvoice({ gstRegistrationId: r2.id, provider: "" });
      ok(
        "  R2's portal is set back to not set up",
        cleared.ok && (await db.gstRegistration.findUniqueOrThrow({ where: { id: r2.id } })).einvoiceProvider === null,
      );
    }

    section("14. Rows written without a branch are adopted by the head office");
    const raw = await db.tradeDocument.create({
      data: {
        docNumber: `${PREFIX}-RAW-${Date.now().toString(36).toUpperCase()}X`,
        docType: "INVOICE",
        direction: "SALES",
        companyId: customer.id,
        createdById: actor.id,
      },
      select: { id: true, branchId: true },
    });
    created.documents.push(raw.id);
    ok("a raw insert has no branch", raw.branchId === null);
    await identity.adoptUnassigned();
    const adopted = await db.tradeDocument.findUniqueOrThrow({ where: { id: raw.id }, select: { branchId: true, gstRegistrationId: true } });
    ok(
      "adoptUnassigned gives it the head office, and the head office's registration",
      adopted.branchId === ho0.id && adopted.gstRegistrationId === r1.id,
      json(adopted),
    );

    section("The document list's Branch column");
    for (const docType of ["PROPOSAL", "PROFORMA", "INVOICE", "CREDIT_NOTE", "PURCHASE_ORDER", "BILL", "DELIVERY_CHALLAN"] as const) {
      const key = registry.documentTableKey(docType);
      const column = registry.getTableDefinition(key)?.columns.find((c) => c.key === "branch");
      ok(
        `${key}: a Branch column, hidden by default`,
        Boolean(column) && column!.default === false && !registry.resolveColumns(key, null).includes("branch"),
      );
    }
    const row = {
      id: "zzbr-row", docNumber: `${PREFIX}/ROW/1`, status: "ISSUED" as const, issueDate: new Date("2026-09-15T12:00:00+05:30"), total: 1180,
      currency: "INR", reference: null, einvoiceStatus: "NOT_APPLICABLE" as const, irn: null,
      company: { id: "c", name: `${PREFIX} Customer Pvt Ltd`, relationshipType: "CLIENT" as const }, createdBy: { name: "Probe" }, salesperson: null,
      branch: { id: b2.id, name: b2.name, code: b2.code },
    };
    /** Somebody's stored column choices around `child`, as the layout provides them. */
    const withColumns = (initial: Record<string, string[]>, child: ReactElement) =>
      createElement(TableColumnsProvider, { initial } as ComponentProps<typeof TableColumnsProvider>, child);
    const rowsHtml = (docType: "INVOICE" | "BILL", branchColumn: boolean, stored: string[] | null) =>
      renderToStaticMarkup(
        withColumns(
          stored ? { [registry.documentTableKey(docType)]: stored } : {},
          createElement(DocumentRows, { docType, documents: [row], eInvoiced: docType === "INVOICE", branchColumn }),
        ),
      );
    const branchHeader = /<th[^>]*>Branch<\/th>/;
    const withBranch = [...registry.resolveColumns(registry.documentTableKey("INVOICE"), null), "branch"];
    ok("with several branches and nobody's choice, the column is not drawn", !branchHeader.test(rowsHtml("INVOICE", true, null)) && !rowsHtml("INVOICE", true, null).includes(`>${B2_CODE}<`));
    ok("  chosen, it is — with the branch's code", branchHeader.test(rowsHtml("INVOICE", true, withBranch)) && rowsHtml("INVOICE", true, withBranch).includes(`>${B2_CODE}<`));
    ok("  on a purchase list it reads Buying branch", /<th[^>]*>Buying branch<\/th>/.test(rowsHtml("BILL", true, [...registry.resolveColumns(registry.documentTableKey("BILL"), null), "branch"])));
    ok("  and with one branch it is not drawn even when a stored choice asks for it", !branchHeader.test(rowsHtml("INVOICE", false, withBranch)));
    const hiddenBadge = (omit: string[] | undefined) => {
      const html = renderToStaticMarkup(
        withColumns({}, createElement(ColumnPicker, { tableKey: registry.documentTableKey("INVOICE"), omit })),
      );
      return Number(/bg-brand-subtle[^"]*">(\d+)<\/span>/.exec(html)?.[1] ?? 0);
    };
    ok(
      "the picker leaves Branch out of its count when told to omit it",
      hiddenBadge(undefined) - hiddenBadge(["branch"]) === 1,
      `${hiddenBadge(undefined)} hidden offered, ${hiddenBadge(["branch"])} with Branch omitted`,
    );
    const multiTree = await listInvoices();
    const multiPicker = findElements(multiTree, ColumnPicker)[0];
    const multiRows = findElements(multiTree, DocumentRows)[0];
    ok(
      "with more than one branch the list offers the Branch column",
      Boolean(multiPicker) && (multiPicker!.props as { omit?: string[] }).omit === undefined,
      json((multiPicker?.props as { omit?: string[] } | undefined)?.omit ?? null),
    );
    ok("  and lets the rows draw it", (multiRows?.props as { branchColumn?: boolean } | undefined)?.branchColumn === true);
    ok(
      "  and filters by branch",
      findElements(multiTree, SelectParamFilter).some((f) => (f.props as { paramName: string }).paramName === "branch"),
    );

    section("A new document defaults to today in India, from the writer's branch");
    const newPage = (await NewDocumentPage({ searchParams: Promise.resolve({ type: "INVOICE" }) })) as ReactElement;
    const form = findElements(newPage, DocumentForm)[0];
    const defaults = (form?.props as { defaults?: { issueDate: string; branchId: string } } | undefined)?.defaults;
    const indiaToday = indiaClock.today();
    const defaultBranch = await identity.defaultBranchIdFor(actor.id);
    ok("the new invoice form's date is today in India", defaults?.issueDate === indiaToday, `${defaults?.issueDate} vs ${indiaToday}`);
    ok("  and its branch is the writer's default", defaults?.branchId === defaultBranch, defaults?.branchId ?? "");
    ok("  with B2 among the branches offered", ((form?.props as { branches?: { id: string }[] } | undefined)?.branches ?? []).some((b) => b.id === b2.id));

    section("Report ranges are Indian days, whatever the server's clock");
    await journal.ensureChartOfAccounts();
    const accounts = await db.ledgerAccount.findMany({ where: { systemKey: { in: ["CASH", "SALES"] } }, select: { id: true, systemKey: true } });
    const cash = accounts.find((a) => a.systemKey === "CASH")?.id;
    const sales = accounts.find((a) => a.systemKey === "SALES")?.id;
    if (!cash || !sales) {
      ok("the chart has CASH and SALES", false);
    } else {
      const september = { from: "2026-09-01", to: "2026-09-30", branchId: b2.id };
      const firstOfSeptember = { from: "2026-09-01", to: "2026-09-01", branchId: b2.id };
      const salesCreditTo31Aug = async () => (await reports.trialBalance({ to: "2026-08-31" })).rows.find((r) => r.id === sales)?.credit ?? 0;
      const [sepBefore, dayBefore, tbBefore] = await Promise.all([
        reports.profitAndLoss(september),
        reports.profitAndLoss(firstOfSeptember),
        salesCreditTo31Aug(),
      ]);
      const edges: [string, number][] = [
        ["2026-08-31T23:50:00+05:30", 7],
        ["2026-09-01T00:10:00+05:30", 11],
        ["2026-09-30T23:59:00+05:30", 13],
        ["2026-10-01T00:30:00+05:30", 17],
      ];
      for (const [at, amount] of edges) {
        const entry = await db.$transaction(async (tx) =>
          await journal.writeEntry(tx, {
            date: new Date(at),
            narration: `${PREFIX} India-day edge ${at}`,
            source: "MANUAL",
            userId: actor!.id,
            branchId: b2.id,
            lines: [
              { accountId: cash, debit: amount, credit: 0 },
              { accountId: sales, debit: 0, credit: amount },
            ],
          }),
        );
        created.entries.push(entry.id);
      }
      const [sepAfter, dayAfter, tbAfter] = await Promise.all([
        reports.profitAndLoss(september),
        reports.profitAndLoss(firstOfSeptember),
        salesCreditTo31Aug(),
      ]);
      const delta = (a: number, b: number) => Math.round((a - b) * 100) / 100;
      ok(
        "September's P&L takes 00:10 IST on 1 Sep and 23:59 IST on 30 Sep, not 23:50 IST on 31 Aug or 00:30 IST on 1 Oct",
        delta(sepAfter.totalIncome, sepBefore.totalIncome) === 24,
        `income rose ${delta(sepAfter.totalIncome, sepBefore.totalIncome)}; 24 is 11 + 13`,
      );
      ok(
        "  a one-day P&L for 1 Sep takes only the 00:10 IST entry",
        delta(dayAfter.totalIncome, dayBefore.totalIncome) === 11,
        `rose ${delta(dayAfter.totalIncome, dayBefore.totalIncome)}`,
      );
      ok(
        "  and the trial balance as at 31 Aug takes 23:50 IST that night, and nothing from 1 Sep",
        delta(tbAfter, tbBefore) === 7,
        `sales credit rose ${delta(tbAfter, tbBefore)}`,
      );
      ok(
        "  the window itself runs from India's midnight",
        new Date(sepAfter.from).getTime() === new Date("2026-09-01T00:00:00+05:30").getTime() &&
          new Date(sepAfter.to).getTime() === new Date("2026-10-01T00:00:00+05:30").getTime() - 1,
        `${new Date(sepAfter.from).toISOString()} – ${new Date(sepAfter.to).toISOString()}`,
      );
    }
  } finally {
    section("15. Cleanup");
    const ids = { ...created };
    if (snap) await restoreShared(snap);
    const pans = [...new Set([...candidatePans(), ...(pan ? [pan] : [])])];
    await cleanup(created, pans, snap?.headOffice.id ?? null);

    const [companies, branches, registrations, documents, lines, entries, series, departments, audits] = await Promise.all([
      db.company.count({ where: { OR: [{ name: { startsWith: PREFIX } }, { id: { in: ids.companies } }] } }),
      db.branch.count({ where: { OR: [{ name: { startsWith: PREFIX } }, { code: { in: FIXTURE_BRANCH_CODES } }, { id: { in: ids.branches } }] } }),
      db.gstRegistration.count({ where: fixtureRegistrationWhere(pans, ids.registrations) }),
      db.tradeDocument.count({ where: { OR: [{ docNumber: { startsWith: PREFIX } }, { id: { in: ids.documents } }, { companyId: { in: ids.companies } }] } }),
      db.journalLine.count({ where: { OR: [{ branchId: { in: ids.branches } }, { gstRegistrationId: { in: ids.registrations } }] } }),
      db.journalEntry.count({ where: { OR: [{ narration: { startsWith: PREFIX } }, { id: { in: ids.entries } }, { documentId: { in: ids.documents } }] } }),
      db.documentSeries.count({ where: { OR: [{ branchId: { in: ids.branches } }, { gstRegistrationId: { in: ids.registrations } }] } }),
      db.department.count({ where: { name: { startsWith: PREFIX } } }),
      db.auditLog.count({ where: { OR: [{ entityLabel: { contains: PREFIX } }, { entityId: { in: Object.values(ids).flat() } }] } }),
    ]);
    ok(
      "nothing with the prefix, the fixture GSTINs or pointing at B2/R2 is left",
      companies + branches + registrations + documents + lines + entries + series + departments + audits === 0,
      json({ companies, branches, registrations, documents, lines, entries, series, departments, audits }),
    );
    if (snap) {
      const s = snap;
      const ho = await db.branch.findFirst({ where: { isHeadOffice: true } });
      ok(
        "the head office is the one it was, with its registration and address",
        ho?.id === s.headOffice.id && ho.gstRegistrationId === s.headOffice.gstRegistrationId && HEAD_OFFICE_FIELDS.every((f) => ho[f] === s.headOffice[f]),
        ho ? `${ho.code}, registration ${ho.gstRegistrationId ?? "none"}` : "no head office",
      );
      const org = await db.organisationSettings.findUnique({ where: { id: "global" } });
      ok(
        "the organisation is as it was",
        s.org === null
          ? org === null
          : org !== null && org.pan === s.org.pan && org.gstin === s.org.gstin && org.einvoiceEnabled === s.org.einvoiceEnabled &&
            String(org.einvoiceMinValue) === String(s.org.einvoiceMinValue),
        s.org === null ? (org === null ? "no row, as before" : "a row was left") : `PAN ${org?.pan ?? "none"}`,
      );
      const invoiceSetting = await db.documentNumberSetting.findUnique({ where: { docType: "INVOICE" } });
      const invoiceBefore = s.settings.find((x) => x.docType === "INVOICE");
      ok(
        "invoice numbering is as it was",
        invoiceBefore
          ? invoiceSetting !== null &&
              invoiceSetting.scope === invoiceBefore.scope && invoiceSetting.prefix === invoiceBefore.prefix &&
              invoiceSetting.nextNumber === invoiceBefore.nextNumber && invoiceSetting.padding === invoiceBefore.padding
          : invoiceSetting === null,
        invoiceBefore ? `${invoiceSetting?.scope} ${invoiceSetting?.prefix} from ${invoiceSetting?.nextNumber}` : invoiceSetting ? "a row was left" : "no row, as before",
      );
      ok(
        "  and so are its series",
        (await db.documentSeries.count({ where: { docType: "INVOICE" } })) === s.invoiceSeries.length,
      );
    }
  }
}

async function main() {
  console.log(`Host clock: TZ=${process.env.TZ ?? "(not set)"}, UTC offset ${-new Date().getTimezoneOffset()} min. Run it under TZ=UTC as well.`);
  pure();
  await database();
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll branch checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
