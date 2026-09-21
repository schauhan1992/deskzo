/**
 * Import checks.
 *
 * These run against a real database because the property that matters cannot be checked any other
 * way: **the preview must describe the write**. A planner that reports "Stage: → CUSTOMER" and a
 * writer that ignores the Stage column both look correct in isolation and in a type check. What
 * exposes the disagreement is importing a file, importing it a second time, and finding that the
 * second run still wants to make changes — a file that has just been imported must be a no-op.
 *
 * Every area is put through the same five questions rather than each being spot-checked, because the
 * defect this catches is one an author is by definition not looking for:
 *
 *   1. Does planning write anything? (It must not — including lookup rows.)
 *   2. Do the creates land?
 *   3. Is re-importing the same file a no-op?          ← the convergence property
 *   4. Does exporting and re-importing change nothing? ← the round trip
 *   5. Are the rows that should be refused, refused, for the stated reason?
 *
 * Everything creates rows under a reserved prefix and removes them again, so it is safe to run
 * against a database with real data in it.
 */
import { db } from "../src/lib/db";
import { parseFile, plan, apply, TEMPLATE_COLUMNS } from "../src/lib/portability/import";
import { IMPLEMENTED_IMPORTS } from "../src/lib/portability/importers";
import { areaRows, toWorkbookBuffer, toCsv } from "../src/lib/portability/export";
import { EXPORTERS } from "../src/lib/portability/exporters";
import { PORTABLE_AREAS } from "../src/lib/portability/areas";

const PREFIX = "ZZImportCheck";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function note(text: string) {
  console.log(`  ..    ${text}`);
}

/** Turns rows-as-objects into the base64 CSV the import action receives. */
function csvOf(columns: string[], rows: Record<string, string>[]): string {
  const escape = (v: string) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const body = [columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c] ?? "")).join(","))];
  return Buffer.from(body.join("\n"), "utf8").toString("base64");
}

type Refusal = { label: string; row: Record<string, string>; expect: RegExp };

type Fixture = {
  area: string;
  /** Prerequisites — companies, users — created before the fixture rows are imported. */
  setup?: () => Promise<void>;
  rows: Record<string, string>[];
  /** How many of `rows` should create a record. The rest are expected refusals. */
  creates: number;
  /** One field edited, to prove an update is detected and its before/after shown. */
  edit?: { column: string; to: string; expectField: string };
  /**
   * The rows carry no key of their own, so re-importing the same file legitimately creates again —
   * a ticket or a visit has nothing to match on until it has been given a number. For those, the
   * convergence property is proven against the *exported* file, which does carry keys, and the
   * same-file check is skipped rather than quietly weakened.
   */
  keyedOnExportOnly?: boolean;
  refusals?: Refusal[];
  cleanup: () => Promise<void>;
};

// ── The lookup tables a planner might be tempted to write to ────────────────────────────────────
async function lookupCounts() {
  const [industries, brands, families, departments, accounts] = await Promise.all([
    db.industry.count(),
    db.brand.count(),
    db.productFamily.count(),
    db.department.count(),
    db.ledgerAccount.count(),
  ]);
  return { industries, brands, families, departments, accounts };
}

// ── The driver ──────────────────────────────────────────────────────────────────────────────────

async function runFixture(f: Fixture, actorUserId: string) {
  const columns = TEMPLATE_COLUMNS[f.area] ?? [];
  console.log(`\n— ${f.area} —\n`);

  if (columns.length === 0) {
    ok(`${f.area} has template columns`, false, "no importer registered");
    return;
  }

  await f.cleanup();
  if (f.setup) await f.setup();

  const file = csvOf(columns, f.rows);
  const parsed = await parseFile(file, "check.csv");

  // 1. Planning writes nothing.
  const before = await lookupCounts();
  const p1 = await plan(f.area, parsed, actorUserId);
  const after = await lookupCounts();
  ok(
    "planning writes nothing",
    JSON.stringify(before) === JSON.stringify(after),
    "a preview somebody abandons must leave no industries, brands or departments behind",
  );
  ok("  the file is understood", p1.unknownColumns.length === 0, p1.unknownColumns.join(", ") || `${columns.length} columns`);
  ok("  creates are counted", p1.creates === f.creates, `${p1.creates} creates, expected ${f.creates}`);
  if (p1.errors > 0) {
    note(`unexpected error rows: ${p1.rows.filter((r) => r.action === "error").map((r) => `line ${r.line}: ${r.error}`).join(" | ")}`);
  }
  ok("  with nothing unusable", p1.errors === 0);

  // 2. The creates land.
  const r1 = await apply(f.area, parsed, actorUserId);
  if (r1.failed.length) {
    note(`write failures: ${r1.failed.map((x) => `line ${x.line}: ${x.error}`).join(" | ")}`);
  }
  ok("applying creates the records", r1.created === f.creates && r1.failed.length === 0, `${r1.created} created, ${r1.failed.length} failed`);

  // 3. Re-importing is a no-op. The property everything rests on.
  if (f.keyedOnExportOnly) {
    note("rows carry no key of their own — convergence is checked against the exported file below");
  } else {
  const p2 = await plan(f.area, parsed, actorUserId);
  if (p2.creates + p2.updates > 0) {
    note(
      `still wants to change: ${p2.rows
        .filter((r) => r.action !== "skip")
        .map((r) => `${r.action} ${r.label} [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]`)
        .join(" | ")}`,
    );
  }
  ok(
    "re-importing the same file is a no-op",
    p2.creates === 0 && p2.updates === 0,
    p2.creates + p2.updates === 0
      ? `${p2.skips} already match`
      : "the preview is describing a write that isn't happening — plan() and apply() disagree",
  );
  }

  // 4. Export, then import what was exported.
  if (EXPORTERS[f.area]) {
    const exported = await areaRows(actorUserId, f.area);
    if (exported.length === 0) {
      ok("  the exporter returns rows", false, "exported nothing after importing records");
    } else {
      const headings = Object.keys(exported[0]!);
      const missing = columns.filter((c) => !headings.includes(c));
      ok(
        "  every importable column is exported",
        missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : `${headings.length} columns`,
      );

      const workbook = await toWorkbookBuffer([{ name: f.area, rows: exported }], {
        title: f.area,
        by: "check",
        generatedAt: new Date(),
      });
      const reparsed = await parseFile(workbook.toString("base64"), "x.xlsx");
      const p3 = await plan(f.area, reparsed, actorUserId);
      if (p3.creates + p3.updates > 0) {
        note(
          `round trip differs: ${p3.rows
            .filter((r) => r.action !== "skip")
            .slice(0, 4)
            .map((r) => `${r.action} ${r.label} [${r.changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ")}]`)
            .join(" | ")}`,
        );
      }
      ok(
        "  an exported file re-imports unchanged",
        p3.creates === 0 && p3.updates === 0 && p3.errors === 0,
        p3.errors ? `${p3.errors} rows the exporter wrote cannot be read back` : `${p3.skips} already match`,
      );

      // CSV is the other half of the promise, and quotes and commas break it differently.
      const asCsv = Buffer.from(toCsv(exported), "utf8").toString("base64");
      const p4 = await plan(f.area, await parseFile(asCsv, "x.csv"), actorUserId);
      ok("  and so does the CSV", p4.creates === 0 && p4.updates === 0 && p4.errors === 0, `${p4.skips} match`);
    }
  }

  // 5. An edit shows as an edit, and only that field changes.
  if (f.edit) {
    const first = { ...f.rows[0]! };
    first[f.edit.column] = f.edit.to;
    const p5 = await plan(f.area, await parseFile(csvOf(columns, [first]), "x.csv"), actorUserId);
    ok("an edited cell is an update", p5.updates === 1, `${p5.updates} update, ${p5.errors} errors`);
    const changes = p5.rows[0]?.changes ?? [];
    ok(
      "  naming the field and both values",
      changes.length === 1 && changes[0]!.field === f.edit.expectField,
      changes.map((c) => `${c.field}: ${c.from}→${c.to}`).join(", ") || "no changes reported",
    );
  }

  // 6. What must be refused, is refused.
  for (const refusal of f.refusals ?? []) {
    const p = await plan(f.area, await parseFile(csvOf(columns, [refusal.row]), "x.csv"), actorUserId);
    const message = p.rows[0]?.error ?? "";
    ok(`refuses ${refusal.label}`, p.errors === 1 && refusal.expect.test(message), message || `action was "${p.rows[0]?.action}"`);
  }

  await f.cleanup();
}

// ── Everything the check creates, removed again ─────────────────────────────────────────────────
// One function rather than per-fixture teardown: it is idempotent, it runs before and after every
// fixture, and it means a fixture that fails half way through still leaves the database clean.

const MARK = "zzimportcheck";

async function cleanupAll() {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  const probeUsers = await db.user.findMany({ where: { email: { contains: MARK } }, select: { id: true } });
  const userIds = probeUsers.map((u) => u.id);

  await db.expense.deleteMany({ where: { description: { startsWith: PREFIX } } });
  await db.asset.deleteMany({ where: { assetTag: { startsWith: PREFIX } } });
  if (companyIds.length) {
    await db.visit.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
    await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  }
  await db.workbookAssignee.deleteMany({ where: { workbook: { name: { startsWith: PREFIX } } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.suppression.deleteMany({ where: { value: { contains: MARK } } });
  await db.candidate.deleteMany({ where: { email: { contains: MARK } } });
  await db.ledgerAccount.deleteMany({ where: { code: { contains: "ZZIC" }, isGroup: false } });
  await db.ledgerAccount.deleteMany({ where: { code: { contains: "ZZIC" } } });
  await db.item.deleteMany({ where: { sku: { contains: "ZZIC" } } });
  await db.productFamily.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.brand.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (companyIds.length) await db.company.deleteMany({ where: { id: { in: companyIds } } });
  if (userIds.length) {
    await db.employeeProfile.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.employeeProfile.deleteMany({ where: { employeeCode: { startsWith: "ZZIC" } } });
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.industry.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/** The account most fixtures hang off. Created directly rather than through an importer. */
async function probeCompany(ownerUserId: string) {
  return db.company.upsert({
    where: { normalizedName: `${PREFIX.toLowerCase()} alpha` },
    update: {},
    create: {
      name: `${PREFIX} Alpha`,
      normalizedName: `${PREFIX.toLowerCase()} alpha`,
      relationshipType: "CLIENT",
      stage: "CUSTOMER",
      ownerUserId,
      createdById: ownerUserId,
    },
  });
}

/** A colleague for the columns that name somebody other than the importer. */
async function probeUser(name: string, role: "SALES" | "SUPPORT" = "SALES") {
  const email = `${MARK}.${name.toLowerCase().replace(/\W+/g, "")}@example.invalid`;
  return db.user.upsert({
    where: { email },
    update: {},
    create: { name: `${PREFIX} ${name}`, email, role, passwordHash: "x".repeat(60), active: true },
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function fixtures(actor: { id: string; name: string }): Fixture[] {
  const owner = actor.name;

  return [
    {
      area: "companies",
      rows: [
        {
          Name: `${PREFIX} Alpha`,
          Stage: "customer",
          Source: "Referral",
          Industry: `${PREFIX} Industry`,
          Website: "https://alpha.test",
          "Account manager": owner,
        },
        { Name: `${PREFIX} Beta`, Stage: "LEAD", Source: "INBOUND", Website: "-dash-leading.test" },
      ],
      creates: 2,
      edit: { column: "Website", to: "https://changed.test", expectField: "Website" },
      refusals: [
        { label: "a row with no name", row: { Stage: "LEAD" }, expect: /Name is required/i },
        { label: "an unrecognised stage", row: { Name: `${PREFIX} Alpha`, Stage: "Custommer" }, expect: /isn't one of/i },
        {
          label: "an account manager who doesn't exist",
          row: { Name: `${PREFIX} Alpha`, "Account manager": "Nobody At All" },
          expect: /No active user matches/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "contacts",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Name: `${PREFIX} Priya`,
          Company: `${PREFIX} Alpha`,
          Designation: "Purchase Manager",
          Email: `${MARK}.priya@example.invalid`,
          Phone: "9876543210",
        },
      ],
      creates: 1,
      edit: { column: "Phone", to: "9000000000", expectField: "Phone" },
      refusals: [
        {
          label: "a contact at an unknown company",
          row: { Name: "Orphan", Company: "No Such Company Ltd" },
          expect: /No company named/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "items",
      rows: [
        {
          Name: `${PREFIX} Laptop`,
          SKU: "ZZIC-SKU-1",
          Type: "GOOD",
          Brand: `${PREFIX} Brand`,
          Family: `${PREFIX} Family`,
          "Billing cycle": "ONE_TIME",
          Unit: "Nos",
          Price: "72500",
          "Tax %": "18",
        },
        // A part number Excel would read as a formula. This is the round-trip canary.
        { Name: `${PREFIX} Cable`, SKU: "-ZZIC-SKU-2", Type: "GOOD", Price: "450", "Tax %": "18" },
      ],
      creates: 2,
      edit: { column: "Price", to: "69999", expectField: "Price" },
      refusals: [
        { label: "an item key naming nothing", row: { Key: "ITM-999999", Name: "x" }, expect: /No item with key/i },
        { label: "an unrecognised type", row: { Name: "x", SKU: "ZZIC-SKU-9", Type: "Widget" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "suppression",
      rows: [
        { Scope: "EMAIL", Value: `${MARK}.optout@example.invalid`, Reason: "UNSUBSCRIBED", Added: "2026-01-15" },
        { Scope: "DOMAIN", Value: `${MARK}.example.invalid`, Reason: "MANUAL", Added: "2026-02-01", Expires: "2027-01-01" },
      ],
      creates: 2,
      refusals: [
        {
          label: "an unrecognised scope",
          row: { Scope: "PIGEON", Value: `${MARK}.x@example.invalid`, Reason: "MANUAL" },
          expect: /isn't one of/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "tickets",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Company: `${PREFIX} Alpha`,
          Title: `${PREFIX} Printer offline`,
          Status: "OPEN",
          Priority: "HIGH",
          "Assigned to": owner,
          Raised: "2026-01-15",
        },
      ],
      creates: 1,
      // A blank key always creates — see the module comment. Convergence is proven by the round
      // trip below, where the exported file carries TKT- numbers.
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a ticket key naming nothing",
          row: { Ticket: "TKT-999999", Company: `${PREFIX} Alpha`, Title: "x" },
          expect: /No ticket|isn't a ticket/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "visits",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Company: `${PREFIX} Alpha`,
          By: owner,
          Purpose: "Product demo",
          Status: "COMPLETED",
          "Scheduled for": "2026-03-04",
          "Checked in": "2026-03-04",
          "Checked out": "2026-03-04",
          Address: "Sector 62, Noida",
          Outcome: `${PREFIX} demo went well`,
        },
      ],
      creates: 1,
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a checked-in visit with no check-in time",
          row: { Company: `${PREFIX} Alpha`, By: owner, Status: "CHECKED_IN", "Scheduled for": "2026-09-22" },
          expect: /check|time/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "assets",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          "Asset tag": `${PREFIX}-AST-1`,
          "Serial number": "ZZICSN0001",
          Name: `${PREFIX} ThinkPad`,
          Kind: "LAPTOP",
          Status: "ASSIGNED",
          Ownership: "CLIENT_OWNED",
          "Owner company": `${PREFIX} Alpha`,
          Custodian: owner,
          Make: "Lenovo",
          Model: "T14",
          "Warranty ends": "2027-06-30",
        },
      ],
      creates: 1,
      edit: { column: "Model", to: "T14s", expectField: "Model" },
      refusals: [
        {
          label: "an unrecognised kind",
          row: { "Asset tag": `${PREFIX}-AST-9`, Name: "x", Kind: "Toaster" },
          expect: /isn't one of/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "ledger",
      rows: [
        { Code: "ZZIC-100", Name: `${PREFIX} Current assets`, Type: "ASSET", Group: "yes", Active: "yes" },
        { Code: "ZZIC-110", Name: `${PREFIX} Petty cash`, Type: "ASSET", Parent: "ZZIC-100", Active: "yes" },
      ],
      creates: 2,
      edit: { column: "Name", to: `${PREFIX} Current assets (India)`, expectField: "Name" },
      refusals: [
        { label: "an unknown parent", row: { Code: "ZZIC-120", Name: "x", Type: "ASSET", Parent: "ZZIC-999" }, expect: /parent|ZZIC-999/i },
        { label: "an unrecognised account type", row: { Code: "ZZIC-130", Name: "x", Type: "Revenue" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "expenses",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Person: owner,
          Category: "TRAVEL",
          Amount: "2450",
          Tax: "0",
          "Spent on": "2026-02-11",
          Description: `${PREFIX} cab to client site`,
          "Payment mode": "UPI",
          Reimbursable: "yes",
          Status: "SUBMITTED",
          Company: `${PREFIX} Alpha`,
        },
      ],
      creates: 1,
      keyedOnExportOnly: true,
      refusals: [
        {
          label: "a claim that was already reimbursed",
          row: {
            Person: owner,
            Category: "TRAVEL",
            Amount: "100",
            "Spent on": "2026-02-11",
            Description: `${PREFIX} already paid`,
            Status: "REIMBURSED",
          },
          expect: /reimburse|decid|approv/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "hiring",
      rows: [
        {
          Email: `${MARK}.candidate@example.invalid`,
          Name: `${PREFIX} Candidate`,
          Phone: "9811111111",
          Designation: "Sales Executive",
          Department: `${PREFIX} Sales`,
          "Employment type": "FULL_TIME",
          Status: "PROSPECT",
          Source: "Referral",
          Owner: owner,
          "Expected joining": "2026-05-01",
        },
      ],
      creates: 1,
      edit: { column: "Status", to: "OFFERED", expectField: "Status" },
      refusals: [
        { label: "an unrecognised status", row: { Email: `${MARK}.c2@example.invalid`, Name: "x", Status: "Maybe" }, expect: /isn't one of/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "people",
      setup: async () => void (await probeUser("Employee")),
      rows: [
        {
          User: `${PREFIX} Employee`,
          "Employee code": "ZZIC-EMP-1",
          Designation: "Sales Executive",
          "Employment type": "FULL_TIME",
          "Work location": "Noida",
          "Joined on": "2024-07-01",
          "Date of birth": "1995-03-12",
          Gender: "FEMALE",
          "Personal email": `${MARK}.personal@example.invalid`,
          "Personal phone": "9822222222",
          City: "Noida",
          State: "Uttar Pradesh",
        },
      ],
      creates: 1,
      edit: { column: "Work location", to: "Gurugram", expectField: "Work location" },
      refusals: [
        { label: "a profile for somebody with no account", row: { User: "Nobody At All" }, expect: /No (active )?user matches/i },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "users",
      rows: [
        {
          Name: `${PREFIX} Newjoiner`,
          Email: `${MARK}.newjoiner@example.invalid`,
          Role: "SALES",
          "Super admin": "false",
          Active: "true",
          Department: `${PREFIX} Sales`,
        },
      ],
      creates: 1,
      edit: { column: "Role", to: "SUPPORT", expectField: "Role" },
      refusals: [
        {
          label: "a row trying to grant super admin",
          row: {
            Name: `${PREFIX} Newjoiner`,
            Email: `${MARK}.newjoiner@example.invalid`,
            Role: "SALES",
            "Super admin": "true",
          },
          expect: /super admin/i,
        },
        {
          label: "a user key naming nothing",
          row: { Key: "USR-999999", Name: "x", Email: `${MARK}.x@example.invalid`, Role: "SALES" },
          expect: /No user|isn't a user/i,
        },
      ],
      cleanup: cleanupAll,
    },

    {
      area: "workspace",
      setup: async () => void (await probeCompany(actor.id)),
      rows: [
        {
          Name: `${PREFIX} Delhi manufacturers`,
          Description: "Cold calling list",
          Owner: owner,
          Shared: "yes",
          Mode: "LIST",
          Filters: JSON.stringify({ stage: ["LEAD"] }),
        },
      ],
      creates: 1,
      edit: { column: "Description", to: "Q2 calling list", expectField: "Description" },
      refusals: [
        {
          label: "filters that are not valid JSON",
          row: { Name: `${PREFIX} Broken`, Owner: owner, Filters: "{not json" },
          expect: /filter|json/i,
        },
      ],
      cleanup: cleanupAll,
    },
  ];
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const actor = await db.user.findFirst({
    where: { active: true, isSuperAdmin: true },
    select: { id: true, name: true },
  });
  if (!actor) throw new Error("No active super admin. Run npm run db:bootstrap first.");

  console.log(`\nImporting as ${actor.name}\n`);
  console.log("— Wiring —\n");

  const importable = PORTABLE_AREAS.filter((a) => a.importPermission !== null).map((a) => a.key);
  ok(
    "Every built importer belongs to an importable area",
    IMPLEMENTED_IMPORTS.every((k) => importable.includes(k)),
    IMPLEMENTED_IMPORTS.filter((k) => !importable.includes(k)).join(", ") ||
      "an importer on an export-only area would be a button that refuses on click",
  );
  const notBuilt = importable.filter((k) => !IMPLEMENTED_IMPORTS.includes(k));
  ok(
    "Every importable area has an importer",
    notBuilt.length === 0,
    notBuilt.length ? `${notBuilt.join(", ")} would show a disabled button` : `${IMPLEMENTED_IMPORTS.length} importers`,
  );

  const all = fixtures(actor);
  const covered = new Set(all.map((f) => f.area));
  const uncovered = IMPLEMENTED_IMPORTS.filter((k) => !covered.has(k) && !["customers", "vendors", "resellers", "commission-parties"].includes(k));
  ok(
    "Every importer has a fixture here",
    uncovered.length === 0,
    uncovered.length ? `untested: ${uncovered.join(", ")}` : `${covered.size} areas exercised`,
  );

  await cleanupAll();
  for (const f of all) {
    try {
      await runFixture(f, actor.id);
    } catch (err) {
      ok(`${f.area} ran to completion`, false, err instanceof Error ? err.message : String(err));
      await cleanupAll();
    }
  }
  await cleanupAll();

  console.log(failures === 0 ? "\nAll import checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanupAll().catch(() => {});
  process.exit(1);
});
