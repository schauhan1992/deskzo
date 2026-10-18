/**
 * Opening balances from one file (owner, 18 Oct 2026 — src/lib/portability/opening-balances.ts,
 * src/actions/opening-balances.ts, the Journal's Import button).
 *
 *   · Only somebody who may post journals and import finance data may import them.
 *   · A trial balance as Zoho Books exports it: accounts by code or name, debits and credits or a Dr/Cr
 *     balance, the file's total row skipped.
 *   · Receivables and payables name their party; a party whose open documents were imported is refused.
 *     A group, an archived or an unknown account is refused, and so is a line with both sides.
 *   · Any unusable row and nothing is posted; otherwise one entry on the start day, the difference to
 *     Opening Balance Equity, said in red first.
 *   · Importing again reverses the earlier entry and posts the new one.
 *
 * Everything is named ZZPROBE_OB / ZZOB- and removed in a finally.
 *
 *   npm run check:opening-balances
 */
import "dotenv/config";
import Module from "node:module";
import Papa from "papaparse";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Ob", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_OB";
const MAIL = "@zzprobe-ob.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
// Every row's columns, not the first's: Papa takes the header from the first row unless told.
const file = (rows: Record<string, string>[], name = "trial-balance.csv") => ({
  filename: name,
  base64: Buffer.from(Papa.unparse({ fields: [...new Set(rows.flatMap((r) => Object.keys(r)))], data: rows })).toString("base64"),
});

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await db.journalEntry.deleteMany({ where: { createdById: { in: users }, reversesId: { not: null } } });
    await db.journalEntry.deleteMany({ where: { createdById: { in: users } } });
  }
  await db.tradeDocument.deleteMany({ where: { docNumber: { startsWith: "ZZOB-" } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.ledgerAccount.deleteMany({ where: { code: { startsWith: "ZZOB-" }, isGroup: false } });
  await db.ledgerAccount.deleteMany({ where: { code: { startsWith: "ZZOB-" } } });
  if (users.length) {
    await db.auditLog.deleteMany({ where: { userId: { in: users } } });
    await db.userPermission.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const opening = require("../src/actions/opening-balances") as typeof import("../src/actions/opening-balances");
  const { ensureChartOfAccounts } = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    await ensureChartOfAccounts();
    const make = async (key: string, role: "ADMIN" | "PROFILE", grants: string[] = []) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60) } });
      roles.set(u.id, role);
      for (const permission of grants) await db.userPermission.create({ data: { userId: u.id, permission, allowed: true, reason: TAG } });
      return u;
    };
    const admin = await make("admin", "ADMIN");
    const poster = await make("poster", "PROFILE", ["ledger.post"]);
    const importer = await make("importer", "PROFILE", ["data.importFinance"]);

    const system = new Map((await db.ledgerAccount.findMany({ where: { systemKey: { in: ["BANK", "AR", "AP", "OPENING_BALANCE_EQUITY"] } }, select: { id: true, code: true, name: true, systemKey: true } })).map((a) => [a.systemKey!, a]));
    const account = (code: string, name: string, type: "ASSET" | "LIABILITY" | "EQUITY", extra: { isGroup?: boolean; active?: boolean } = {}) =>
      db.ledgerAccount.create({ data: { code, name: `${TAG} ${name}`, type, ...extra } });
    await account("ZZOB-FUR", "Furniture", "ASSET");
    await account("ZZOB-CAP", "Capital", "EQUITY");
    await account("ZZOB-GRP", "Fixed assets group", "ASSET", { isGroup: true });
    await account("ZZOB-OLD", "Old account", "ASSET", { active: false });
    const company = (name: string, relationshipType: "CLIENT" | "VENDOR") =>
      db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), relationshipType, createdById: admin.id, ownerUserId: admin.id } });
    const customer = await company("Customer", "CLIENT");
    await company("Vendor", "VENDOR");
    const covered = await company("Covered", "CLIENT");
    // A customer whose open invoices came across with the documents import: their balance is posted already.
    await db.tradeDocument.create({ data: { docNumber: "ZZOB-INV-1", docType: "INVOICE", direction: "SALES", status: "ISSUED", origin: "IMPORTED", companyId: covered.id, createdById: admin.id, total: 1000 } });

    const day = "2026-10-01";
    const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    const startDay = lock?.lockedUntil && lock.lockedUntil.toISOString().slice(0, 10) >= day ? new Date(lock.lockedUntil.getTime() + 86_400_000).toISOString().slice(0, 10) : day;

    // As Zoho Books writes a trial balance: its own headings, a total row at the bottom.
    const good = [
      { "Account Code": "ZZOB-FUR", "Account Name": "", "Net Debit": "50,000", "Net Credit": "", "Contact Name": "" },
      { "Account Code": system.get("BANK")!.code, "Account Name": "", "Net Debit": "100000", "Net Credit": "", "Contact Name": "" },
      { "Account Code": "", "Account Name": system.get("AR")!.name, "Net Debit": "20000", "Net Credit": "", "Contact Name": `${TAG} Customer` },
      { "Account Code": system.get("AP")!.code, "Account Name": "", "Net Debit": "", "Net Credit": "15000", "Contact Name": `${TAG} Vendor` },
      { "Account Code": "ZZOB-CAP", "Account Name": "", "Net Debit": "", "Net Credit": "1,20,000", "Contact Name": "" },
      { "Account Code": "", "Account Name": "Total", "Net Debit": "170000", "Net Credit": "135000", "Contact Name": "" },
    ];

    section("Who may");

    actorId = poster.id;
    ok("posting journals without importing finance data isn't enough", !(await opening.previewOpeningBalances({ ...file(good), openingDate: startDay })).ok);
    actorId = importer.id;
    ok("nor importing finance data without posting journals", !(await opening.previewOpeningBalances({ ...file(good), openingDate: startDay })).ok);
    actorId = admin.id;
    ok("the day the books start is needed", !(await opening.previewOpeningBalances(file(good))).ok);

    section("The preview");

    const preview = await opening.previewOpeningBalances({ ...file(good), openingDate: startDay });
    if (!preview.ok) throw new Error(preview.error);
    ok("Zoho's headings are read; five lines; the file's total is skipped", preview.data.creates === 5 && preview.data.skips === 1 && preview.data.errors === 0 && preview.data.readAs.some((r) => r.from === "Net Debit" && r.to === "Debit"), JSON.stringify({ c: preview.data.creates, s: preview.data.skips, e: preview.data.errors, rows: preview.data.rows.filter((r) => r.error).map((r) => r.error) }));
    const red = preview.data.notices.find((n) => n.tone === "danger");
    ok("the ₹35,000 difference is said in red: to Opening Balance Equity, as a credit", !!red && red.text.includes("₹35,000") && red.text.includes("credit"), red?.text);

    const bad: Record<string, string>[] = [
      { "Account Code": system.get("AR")!.code, "Net Debit": "100" },
      { "Account Code": system.get("AR")!.code, "Net Debit": "100", "Contact Name": `${TAG} Covered` },
      { "Account Code": "ZZOB-NOPE", "Net Debit": "100" },
      { "Account Code": "ZZOB-GRP", "Net Debit": "100" },
      { "Account Code": "ZZOB-OLD", "Net Debit": "100" },
      { "Account Code": "ZZOB-FUR", "Net Debit": "100", "Net Credit": "100" },
      { "Account Code": "ZZOB-FUR", Balance: "5,000 Cr" },
    ];
    const badPreview = await opening.previewOpeningBalances({ ...file(bad), openingDate: startDay });
    const errs = badPreview.ok ? badPreview.data.rows.map((r) => r.error ?? `(${r.action})`) : [];
    ok("a receivable without its customer is refused", errs[0]?.includes("receivable names its customer") === true, errs[0]);
    ok("a customer whose open documents were imported is refused", errs[1]?.includes("were imported") === true, errs[1]);
    ok("an unknown account, a group and an archived one are refused", errs[2]?.includes("Import the chart of accounts first") === true && errs[3]?.includes("is a group") === true && errs[4]?.includes("archived") === true, errs.slice(2, 5).join(" | "));
    ok("a line with both sides is refused", errs[5]?.includes("not both") === true, errs[5]);
    ok("a balance written 5,000 Cr is a credit", badPreview.ok && badPreview.data.rows[6]?.changes[0]?.field === "Credit" && badPreview.data.rows[6]?.changes[0]?.to === "₹5,000");

    section("Posting");

    const refused = await opening.commitOpeningBalances({ ...file(bad), openingDate: startDay });
    const nothing = await db.journalEntry.count({ where: { createdById: admin.id } });
    ok("any unusable row and nothing is posted", refused.ok && refused.data.created === 0 && refused.data.failed.length === 6 && nothing === 0, JSON.stringify({ r: refused.ok && refused.data.failed.length, nothing }));
    const done = await opening.commitOpeningBalances({ ...file(good), openingDate: startDay });
    const entry = await db.journalEntry.findFirst({ where: { createdById: admin.id, source: "OPENING" }, include: { lines: true } });
    const debit = entry?.lines.reduce((t, l) => t + Number(l.debit), 0);
    const credit = entry?.lines.reduce((t, l) => t + Number(l.credit), 0);
    const obe = entry?.lines.find((l) => l.accountId === system.get("OPENING_BALANCE_EQUITY")!.id);
    ok("one entry on the start day: five lines and the difference, balanced", done.ok && done.data.created === 5 && entry?.date.toISOString().startsWith(startDay) === true && entry.lines.length === 6 && debit === 170000 && credit === 170000 && Number(obe?.credit) === 35000, JSON.stringify({ lines: entry?.lines.length, debit, credit }));
    ok("  the receivable carries its customer", entry?.lines.some((l) => l.accountId === system.get("AR")!.id && l.companyId === customer.id && Number(l.debit) === 20000) === true);

    const changed = good.map((r) => (r["Account Code"] === "ZZOB-CAP" ? { ...r, "Net Credit": "130000" } : r));
    const again = await opening.previewOpeningBalances({ ...file(changed), openingDate: startDay });
    ok("importing again says it replaces the earlier entry", again.ok && again.data.notices.some((n) => n.text.includes(`replaces the opening balances imported before (${entry?.entryNumber})`)));
    const redone = await opening.commitOpeningBalances({ ...file(changed), openingDate: startDay });
    const first = await db.journalEntry.findUnique({ where: { id: entry!.id }, select: { reversedBy: { select: { date: true } } } });
    const live = await db.journalEntry.findMany({ where: { createdById: admin.id, source: "OPENING", reversesId: null, reversedBy: { is: null } }, include: { lines: true } });
    ok("  and does: the earlier one reversed on the start day, the new one standing", redone.ok && first?.reversedBy?.date.toISOString().startsWith(startDay) === true && live.length === 1 && live[0]!.id !== entry!.id && live[0]!.lines.some((l) => Number(l.credit) === 130000));
  } finally {
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll opening balance checks passed." : `\n${failures} opening balance check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
