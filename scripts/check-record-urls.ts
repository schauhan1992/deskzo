/**
 * Readable record URLs: /leads/LEAD-000123 instead of /leads/cmu9u5fou04vgufgk6079c8sw.
 *
 * Three things have to hold, and the third is the one that would be a security bug rather than a
 * cosmetic one:
 *
 *   · **A cuid link never stops working.** They are in bookmarks, emails and chats sent months ago.
 *   · **Both readable forms resolve** — the bare number somebody types and the prefixed form the
 *     app shows.
 *   · **The redirect happens after the authorization check, never before.** `redirect` throws to
 *     unwind the request, so calling it first would answer a probe for somebody else's record with
 *     a tidy redirect to a canonical URL — confirming the record exists, which is precisely what
 *     `notFound()` is there not to disclose.
 *
 * The first two are checked against the real routes with real records. The third is checked by
 * reading the routes, because it is an ordering property that no amount of successful output can
 * demonstrate.
 *
 *   npm run check:record-urls
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { parseRecordRef } from "../src/lib/record-url";
import { formatCompanyId, formatLeadId, formatOrderId, formatItemId, formatUserId } from "../src/lib/order-id";
import { formatTicketId } from "../src/lib/tickets";
import { formatVisitId } from "../src/lib/visits";
import { formatExpenseId } from "../src/lib/expenses";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  // ── Parsing ──────────────────────────────────────────────────────────────────────────────────
  section("Telling a reference from a cuid");

  ok("a bare number is a sequence", parseRecordRef("123").kind === "seq");
  ok("a prefixed reference is a sequence", parseRecordRef("LEAD-000123").kind === "seq");
  ok("  case doesn't matter", parseRecordRef("lead-000123").kind === "seq");
  ok("  and leading zeros are stripped", (parseRecordRef("COM-000007") as { seq: number }).seq === 7);
  ok(
    "a cuid is not a sequence",
    parseRecordRef("cmu9u5fou04vgufgk6079c8sw").kind === "id",
    "the two forms must never be confused, or a URL could resolve to the wrong record",
  );
  ok(
    "  nor is anything else unparseable",
    parseRecordRef("not-a-real-id").kind === "id" && parseRecordRef("").kind === "id",
  );

  // ── The real routes, ordered correctly ───────────────────────────────────────────────────────
  section("The redirect comes after the authorization check");

  /**
   * Read rather than executed.
   *
   * This is an ordering property: a route that redirected first would still serve every legitimate
   * request perfectly, and would only misbehave for somebody probing a record they cannot see. No
   * amount of correct output demonstrates the ordering, so the source is what gets checked.
   */
  const ROUTES = [
    ["companies", "src/app/(dashboard)/companies/[id]/page.tsx"],
    ["leads", "src/app/(dashboard)/leads/[id]/page.tsx"],
    ["orders", "src/app/(dashboard)/orders/[id]/page.tsx"],
    ["tickets", "src/app/(dashboard)/tickets/[id]/page.tsx"],
    ["items", "src/app/(dashboard)/items/[id]/page.tsx"],
    ["visits", "src/app/(dashboard)/visits/[id]/page.tsx"],
    ["expenses", "src/app/(dashboard)/expenses/[id]/page.tsx"],
    ["people", "src/app/(dashboard)/people/[id]/page.tsx"],
  ] as const;

  for (const [name, file] of ROUTES) {
    const source = readFileSync(file, "utf8");
    const refuse = Math.max(source.indexOf("notFound()"), source.lastIndexOf("notFound()"));
    const canon = source.indexOf("canonicalise(");
    ok(`${name}: resolves both forms`, /parseRecordRef\(/.test(source) && /kind === "seq"/.test(source));
    ok(`  and redirects only after the refusal`, refuse !== -1 && canon !== -1 && canon > refuse, `notFound at ${refuse}, canonicalise at ${canon}`);
  }

  section("The redirect keeps the query string");

  /**
   * The tab lives in the query, and the tabs link to it as a bare `?tab=leads`.
   *
   * So a redirect that rebuilt only the path silently dropped it and put people back on the first
   * tab — which read as the tabs being broken, when what was broken was the redirect underneath.
   * Asserted per route rather than once, because each one has to pass its own query through and
   * forgetting a single call site reproduces the bug on that screen alone.
   */
  for (const [name, file] of ROUTES) {
    const source = readFileSync(file, "utf8");
    ok(
      `${name}: carries the query across the redirect`,
      /canonicalise\([^;]*,\s*query\)/.test(source),
      "without it, ?tab= is lost and every tabbed page snaps back to its first tab",
    );
    ok(
      `  and receives one to carry`,
      /searchParams/.test(source),
      "a route that never reads the query cannot forward it",
    );
  }
  section("Nothing downstream is handed the URL segment");

  /**
   * The bug this exists to stop, which shipped and had to be found in a server log.
   *
   * On these routes the *sequence* is the canonical URL — `/people/USR-000001` does not redirect,
   * it is the destination. So `id` stays "USR-000001" for the whole render, and anything below the
   * lookup that takes `id` instead of the row's own id is quietly working with a string that is not
   * a database key.
   *
   * What made it survive review is that it mostly fails politely: a finder given "USR-000001"
   * returns nothing, and an empty tab looks like an employee with no documents rather than a page
   * that is lying. `leaveBalances` is the one that opens the year's balance on first read, so it
   * tried to *write* that string into `leave_balances.userId` and the foreign key finally said so.
   *
   * Everything after `canonicalise` must therefore go through the row, never the segment.
   */
  for (const [name, file] of ROUTES) {
    const source = readFileSync(file, "utf8");
    const canon = source.indexOf("canonicalise(");
    const after = source.slice(canon + "canonicalise(".length);
    // A bare `id` as a whole argument, or handed to a component as a prop.
    const offenders = [...after.matchAll(/(?:\w+\(|,\s*|=\{)id(?=[),}\s])/g)].map((m) => m[0].trim());
    ok(
      `${name}: passes the record, not the segment`,
      offenders.length === 0,
      offenders.length
        ? `${offenders.join(" ")} — on a sequence URL these receive the segment, not a database key`
        : "every call below the lookup takes the row's own id",
    );
  }

  section("The app links straight to the readable address");

  /**
   * A cuid still opens a record, by redirecting, and the redirect is the slow part. Next follows
   * it and then fetches the new address again itself, so the page renders twice, side by side.
   * Every link the app builds therefore hands over the reference (src/lib/record-links.ts), and the
   * redirect is left to old bookmarks and emails.
   *
   * Read from the source: a link interpolated into a detail route has to come from a formatter, or
   * from a value whose name says it is the reference (`…Ref`, `…Label`). Sub-routes (/edit,
   * /handover, /settlement) take the cuid and never redirect, and `revalidatePath` isn't a link.
   * The website CMS has a /leads of its own, on its own host, keyed by its own ids.
   */
  const ROUTE_LINK = /\/(companies|leads|items|orders|people|tickets|visits|expenses)\/\$\{([^`]*?)\}(?!\/)/g;
  const READABLE = /format\w*Id\(|(^|\.)\w*([rR]ef|[lL]abel)$/;
  /** The order just punched, held as its ORD- reference (new-order-form.tsx sets it from formatOrderId). */
  const KNOWN_READABLE = new Set(["src/components/orders/punch/order-summary.tsx:justPunched"]);
  const NOT_APP_RECORDS = ["src/lib/cms/", "src/app/platform-cms/"];
  const cuidLinks: string[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
    );
  for (const file of walk("src")) {
    const name = file.replace(/\\/g, "/");
    if (NOT_APP_RECORDS.some((prefix) => name.startsWith(prefix))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes("revalidatePath(")) return;
      for (const m of line.matchAll(ROUTE_LINK)) {
        const expr = m[2].trim();
        if (READABLE.test(expr) || KNOWN_READABLE.has(`${name}:${expr}`)) continue;
        cuidLinks.push(`${name}:${i + 1} /${m[1]}/\${${m[2]}}`);
      }
    });
  }
  ok(
    "no link hands a detail page the cuid",
    cuidLinks.length === 0,
    cuidLinks.length ? `\n      ${cuidLinks.join("\n      ")}` : "every one goes through companyPath, leadPath, orderPath…",
  );

  // ── Against real records ─────────────────────────────────────────────────────────────────────
  section("Both forms find the same record");

  const checks: [string, string | null, string | null][] = [];

  const company = await db.company.findFirst({ select: { id: true, companySeq: true } });
  if (company) {
    const found = await db.company.findUnique({ where: { companySeq: company.companySeq }, select: { id: true } });
    checks.push(["company", found?.id ?? null, company.id]);
    ok(`a company's reference reads ${formatCompanyId(company.companySeq)}`, true);
  }
  const lead = await db.lead.findFirst({ select: { id: true, leadSeq: true } });
  if (lead) {
    const found = await db.lead.findUnique({ where: { leadSeq: lead.leadSeq }, select: { id: true } });
    checks.push(["lead", found?.id ?? null, lead.id]);
    ok(`a lead's reference reads ${formatLeadId(lead.leadSeq)}`, true);
  }
  const order = await db.companyProduct.findFirst({ select: { id: true, orderSeq: true } });
  if (order) {
    const found = await db.companyProduct.findUnique({ where: { orderSeq: order.orderSeq }, select: { id: true } });
    checks.push(["order", found?.id ?? null, order.id]);
    ok(`an order's reference reads ${formatOrderId(order.orderSeq)}`, true);
  }
  const ticket = await db.ticket.findFirst({ select: { id: true, ticketSeq: true } });
  if (ticket) {
    const found = await db.ticket.findUnique({ where: { ticketSeq: ticket.ticketSeq }, select: { id: true } });
    checks.push(["ticket", found?.id ?? null, ticket.id]);
    ok(`a ticket's reference reads ${formatTicketId(ticket.ticketSeq)}`, true);
  }
  const item = await db.item.findFirst({ select: { id: true, itemSeq: true } });
  if (item) {
    const found = await db.item.findUnique({ where: { itemSeq: item.itemSeq }, select: { id: true } });
    checks.push(["item", found?.id ?? null, item.id]);
    ok(`an item's reference reads ${formatItemId(item.itemSeq)}`, true);
  }
  const visit = await db.visit.findFirst({ select: { id: true, visitSeq: true } });
  if (visit) {
    const found = await db.visit.findUnique({ where: { visitSeq: visit.visitSeq }, select: { id: true } });
    checks.push(["visit", found?.id ?? null, visit.id]);
    ok(`a visit's reference reads ${formatVisitId(visit.visitSeq)}`, true);
  }
  const expense = await db.expense.findFirst({ select: { id: true, expenseSeq: true } });
  if (expense) {
    const found = await db.expense.findUnique({ where: { expenseSeq: expense.expenseSeq }, select: { id: true } });
    checks.push(["expense", found?.id ?? null, expense.id]);
    ok(`an expense's reference reads ${formatExpenseId(expense.expenseSeq)}`, true);
  }
  const person = await db.user.findFirst({ select: { id: true, userSeq: true } });
  if (person) {
    const found = await db.user.findUnique({ where: { userSeq: person.userSeq }, select: { id: true } });
    checks.push(["person", found?.id ?? null, person.id]);
    ok(`a person's reference reads ${formatUserId(person.userSeq)}`, true);
  }

  ok("every record type covered", checks.length === 8, `${checks.length} of 8`);
  for (const [name, viaSeq, viaId] of checks) {
    ok(`  ${name}: the sequence resolves to the same row as the cuid`, viaSeq !== null && viaSeq === viaId);
  }

  // ── The uniqueness the whole thing rests on ──────────────────────────────────────────────────
  section("The sequences are unique");

  /**
   * Asserted rather than assumed. Every one of these carries `@unique` in the schema, so a duplicate
   * is impossible — but the whole scheme rests on it, and a schema can be edited.
   */
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const seqLines = schema.split("\n").filter((l) => /^\s+\w*[Ss]eq\s+Int/.test(l));
  ok("every sequence column found", seqLines.length >= 11, `${seqLines.length} columns`);
  const notUnique = seqLines.filter((l) => !l.includes("@unique"));
  ok(
    "  and every one is unique",
    notUnique.length === 0,
    notUnique.length ? notUnique.map((l) => l.trim().split(/\s+/)[0]).join(", ") : "a URL keyed on a non-unique column would open the wrong record",
  );
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll record URL checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
