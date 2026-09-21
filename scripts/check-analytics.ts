/**
 * That every report the explorer offers actually works, and shows only what it should.
 *
 * Two different risks, and the second is the serious one.
 *
 * A dimension that throws is a visible bug — somebody picks "by brand", gets an error, reports it.
 * A dimension that *silently* reads a field that is always null is not: the report renders, every
 * row says "—", and it looks like the business has no brands. So every declared dimension and
 * measure is exercised here against real rows rather than merely type-checked.
 *
 * The scoping is the one that matters. A report is the largest read in the application, deliberately
 * so, and its whole purpose is to cross accounts. If the account filter were missing from a source,
 * nothing would look wrong — the numbers would simply be bigger, and bigger numbers are what
 * somebody running a report is hoping for. So the sources are checked to be narrowing at all, and a
 * scoped viewer is compared against an unscoped one on the same window.
 */
import { db } from "../src/lib/db";
import { endOfIndianDay, startOfIndianDay } from "../src/lib/india-time";
import { FACT_SOURCES } from "../src/lib/analytics/sources";
import {
  COLUMN_CAP,
  FILTER_VALUE_CAP,
  OTHER_COLUMN,
  dimensionOptions,
  dimensionValues,
  runReport,
} from "../src/lib/analytics/run";
import { bucketOf, GRAINS, NONE, resolveDateColumn, type Grain } from "../src/lib/analytics/types";
import { csvRow } from "../src/lib/csv";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

async function main() {
  const superAdmin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true } });
  if (!superAdmin) throw new Error("No active super admin. Run npm run db:bootstrap first.");

  const from = new Date(2000, 0, 1);
  const to = new Date(2100, 0, 1);
  const ctx = { userId: superAdmin.id, from, to, dateColumn: "createdAt" };

  // ── Time buckets ──────────────────────────────────────────────────────────────────────────────
  section("Time buckets sort the way they read");

  const jan = new Date(2026, 0, 5);
  const apr = new Date(2026, 3, 5);
  const nextJan = new Date(2027, 0, 5);
  for (const g of GRAINS) {
    const a = bucketOf(jan, g.key);
    const b = bucketOf(apr, g.key);
    const c = bucketOf(nextJan, g.key);
    // At year grain January and April are the same bucket, correctly. Requiring a strict order
    // there was the check being wrong about the code rather than the other way round.
    const sameYearOrdered = g.key === "year" ? a.key === b.key : a.key < b.key;
    ok(
      `${g.label}: January${g.key === "year" ? " and April share a bucket" : " sorts before April"}, and next January comes after`,
      sameYearOrdered && b.key < c.key,
      `${a.key} ${g.key === "year" ? "=" : "<"} ${b.key} < ${c.key}`,
    );
  }
  ok(
    "  a week is keyed on its Monday",
    bucketOf(new Date(2026, 0, 8), "week").key === bucketOf(new Date(2026, 0, 5), "week").key,
    "Thursday and the Monday before it land in one bucket",
  );
  ok(
    "  and December's last week does not collide with January's first",
    bucketOf(new Date(2026, 11, 31), "week").key < bucketOf(new Date(2027, 0, 4), "week").key,
    "an ISO week number alone would put week 1 before week 53",
  );

  section("'Dated on' bounds the query, not just the buckets");

  /**
   * The control that chooses which date a report is *about*.
   *
   * Every `load` used to hard-code its own column while "Dated on" steered only the bucketing. So
   * asking for subscriptions expiring in Q1 2027 loaded the orders *punched* in Q1 2027 — none —
   * and grouped them by expiry, giving an empty renewals screen with nothing to say why. Measured
   * at the time: the report said 0 where the database said 25.
   *
   * Checked against the database rather than against another report, because the failure mode is
   * two reports agreeing with each other and both being wrong.
   */
  for (const source of FACT_SOURCES) {
    if (source.dateFields.length < 2) continue;

    const rows = await source.load({ ...ctx, dateColumn: resolveDateColumn(source, source.dateFields[0]!.key) });
    if (rows.length === 0) {
      console.log(`  ..    ${source.label}: no rows to place, skipped`);
      continue;
    }

    for (const field of source.dateFields) {
      const column = resolveDateColumn(source, field.key);
      const loaded = await source.load({ ...ctx, dateColumn: column });

      /**
       * The count the database gives for that column over the same window. A source's own `where`
       * carries scoping and module filters too, so this is compared as "no row is outside the
       * window", which holds whatever else the source narrows by.
       */
      const outside = loaded.filter((row) => {
        const at = field.get(row);
        // A null date cannot be in the window, so a row carrying one should not have been loaded.
        return at === null || at < ctx.from || at >= ctx.to;
      }).length;

      ok(
        `${source.label} dated on "${field.label}": every row falls in the window`,
        outside === 0,
        outside === 0 ? `${loaded.length} row(s)` : `${outside} of ${loaded.length} are outside it`,
      );
    }
  }

  section("Buckets and windows are on India's clock, not the server's");

  /**
   * Every moment here is written with its offset spelled out, and the assertions are about IST.
   *
   * `bucketOf` read `getFullYear()` / `getMonth()` / `getDate()` — the *host's* calendar. Right on a
   * laptop in Pune, wrong in the container this deploys to: an order punched at 01:30 IST on 1
   * October is 20:00 UTC on 30 September, so a monthly report booked October's revenue into
   * September. And `new Date("2026-09-01")` is UTC midnight, so the window opened at 05:30 IST and
   * lost the first five and a half hours of the opening day — on every machine, Indian ones
   * included.
   *
   * Written `new Date(2026, 9, 1)` these would assert nothing: that constructor reads the host too,
   * so the test would agree with the bug. Run this suite under `TZ=UTC` to see it mean something.
   */
  const ist = (wallClock: string) => new Date(`${wallClock}:00+05:30`);

  ok("01:30 IST on 1 October is October", bucketOf(ist("2026-10-01T01:30"), "month").label === "Oct 26", bucketOf(ist("2026-10-01T01:30"), "month").label);
  ok("  23:30 IST on 30 September is September", bucketOf(ist("2026-09-30T23:30"), "month").label === "Sep 26");
  ok("  00:10 IST on 1 January is the new year", bucketOf(ist("2027-01-01T00:10"), "year").label === "2027");
  ok(
    "  and a day bucket is the Indian day",
    bucketOf(ist("2026-10-01T01:30"), "day").key === "2026-10-01",
    bucketOf(ist("2026-10-01T01:30"), "day").key,
  );
  ok(
    "  a week is keyed on the Indian Monday",
    bucketOf(ist("2026-09-30T23:30"), "week").key === bucketOf(ist("2026-09-28T09:00"), "week").key,
    "Wednesday night and the Monday of that week are one bucket",
  );

  /**
   * The window the form's two dates mean — half-open, so there is no ".999 of a second" edge for a
   * timestamp to fall through.
   */
  const windowFrom = startOfIndianDay("2026-09-01")!;
  const windowTo = endOfIndianDay("2026-09-30")!;
  const inWindow = (at: Date) => at >= windowFrom && at < windowTo;

  ok("A September window opens at Indian midnight on the 1st", inWindow(ist("2026-09-01T00:30")), "00:30 IST on the 1st is in it");
  ok("  and runs to the last minute of the 30th", inWindow(ist("2026-09-30T23:30")));
  ok("  without reaching into October", !inWindow(ist("2026-10-01T02:00")), "02:00 IST on the 1st is not");
  ok("  or back into August", !inWindow(ist("2026-08-31T23:30")));

  // ── Every dimension and measure runs ──────────────────────────────────────────────────────────
  for (const source of FACT_SOURCES) {
    section(`${source.label}`);

    const rows = await source.load(ctx);
    console.log(`  ..    ${rows.length} row(s) visible to the super admin`);

    ok(
      "Declares at least one measure, dimension and date field",
      source.measures.length > 0 && source.dimensions.length > 0 && source.dateFields.length > 0,
      `${source.measures.length} measures, ${source.dimensions.length} dimensions, ${source.dateFields.length} date fields`,
    );

    const keys = source.dimensions.map((d) => d.key);
    ok("  no dimension key is declared twice", new Set(keys).size === keys.length, keys.join(", "));
    ok(
      "  and none is called 'time'",
      !keys.includes("time"),
      "the explorer reserves that for the date field, so a dimension of the same name would be unreachable",
    );

    // Every measure, against every dimension. The combination is the product being sold here, so
    // spot-checking one of each would miss exactly the pairing nobody tried.
    let ran = 0;
    let threw: string | null = null;
    for (const measure of source.measures) {
      for (const dimension of [...source.dimensions.map((d) => d.key), "time"]) {
        try {
          runReport({
            source,
            rows,
            measureKey: measure.key,
            dimensionKey: dimension,
            columnKey: "time",
            grain: "month" as Grain,
            dateKey: source.dateFields[0]!.key,
            scopeNote: "check",
          });
          ran += 1;
        } catch (err) {
          threw ??= `${measure.key} by ${dimension}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
    ok(`  every measure × dimension pairing runs`, threw === null, threw ?? `${ran} combinations`);

    if (rows.length > 0) {
      // A dimension that reads a field nobody populates renders as a column of dashes and looks
      // like an empty business rather than a broken report. Reported, not failed: a young database
      // legitimately has no brands yet.
      const blank = source.dimensions.filter((d) => {
        const buckets = new Set(rows.flatMap((r) => (Array.isArray(d.of(r)) ? (d.of(r) as string[]) : [d.of(r) as string])));
        return buckets.size === 1 && buckets.has(NONE);
      });
      if (blank.length > 0) {
        console.log(`  ..    always empty on this data: ${blank.map((d) => d.label).join(", ")}`);
      }

      const totals = source.measures.map((m) => rows.reduce((acc, r) => acc + m.value(r), 0));
      ok(
        "  every measure returns a finite number",
        totals.every((t) => Number.isFinite(t)),
        totals.map((t, i) => `${source.measures[i]!.label} ${Math.round(t)}`).join(" · "),
      );
    }

    // ── The part that matters ───────────────────────────────────────────────────────────────────
    const note = await source.scopeNote(ctx);
    ok("  says whose rows these are", note.length > 10, note);

    /**
     * And whether it was narrowed further before the rows were counted.
     *
     * The account panel narrows the *query*, so rows it excluded never reach `runReport` and are not
     * in `filteredOut`. The scope note is the only thing on the sheet that can say they existed — a
     * report of one city and a report of everywhere are otherwise character-for-character identical,
     * including when the sheet is printed and handed to somebody who did not run it.
     *
     * Three cases because two of them are the same line of code and the third is grammar: no filters
     * must add nothing at all, one must not say "1 account filters", and many must count them.
     */
    const bare = await source.scopeNote({ ...ctx, companyFilters: {} });
    const one = await source.scopeNote({ ...ctx, companyFilters: { city: ["Pune"] } });
    const several = await source.scopeNote({
      ...ctx,
      companyFilters: { city: ["Pune"], tags: ["renewal"], employeeMin: 50 },
    });

    ok("    and adds nothing when the account panel is empty", bare === note, bare);
    ok(
      "    counts one filter in the singular",
      one === `${note} 1 account filter applied.`,
      one.slice(note.length).trim() || "nothing added",
    );
    ok(
      "    and says how many when there are more",
      several === `${note} 3 account filters applied.`,
      several.slice(note.length).trim() || "nothing added",
    );
  }

  // ── Scoping actually narrows ────────────────────────────────────────────────────────────────
  section("Scoping narrows for somebody without the view-all permissions");

  /**
   * A fixture, because the comparison is worthless without one.
   *
   * On an empty database "the narrow viewer sees no more than the wide one" is 0 <= 0, which is
   * true of a source with no filter at all. So two accounts are created under two different
   * managers with an order each, and the question becomes whether the salesperson who manages one
   * of them sees exactly one — which a missing filter cannot pass.
   */
  const PREFIX = "ZZAnalyticsCheck";

  async function cleanup() {
    const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
    const ids = companies.map((c) => c.id);
    if (ids.length) {
      await db.companyProduct.deleteMany({ where: { companyId: { in: ids } } });
      await db.companyLocation.deleteMany({ where: { companyId: { in: ids } } });
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
    await db.item.deleteMany({ where: { sku: { startsWith: PREFIX } } });
    await db.user.deleteMany({ where: { email: { contains: "zzanalyticscheck" } } });
  }

  await cleanup();
  try {
    const mine = await db.user.create({
      data: { name: `${PREFIX} Salesperson`, email: "zzanalyticscheck.mine@example.invalid", role: "SALES", passwordHash: "x".repeat(60) },
    });
    const theirs = await db.user.create({
      data: { name: `${PREFIX} Colleague`, email: "zzanalyticscheck.theirs@example.invalid", role: "SALES", passwordHash: "x".repeat(60) },
    });
    const item = await db.item.create({
      data: { name: `${PREFIX} Laptop`, sku: `${PREFIX}-SKU`, type: "GOOD", sellingPrice: 1000, createdById: superAdmin.id },
    });

    for (const [label, owner] of [["Alpha", mine], ["Beta", theirs]] as const) {
      const company = await db.company.create({
        data: {
          name: `${PREFIX} ${label}`,
          normalizedName: `${PREFIX.toLowerCase()} ${label.toLowerCase()}`,
          relationshipType: "CLIENT",
          ownerUserId: owner.id,
          createdById: superAdmin.id,
          locations: { create: { label: "Head Office", isPrimary: true } },
        },
        select: { id: true, locations: { select: { id: true } } },
      });
      await db.companyProduct.create({
        data: {
          companyId: company.id,
          locationId: company.locations[0]!.id,
          itemId: item.id,
          addedByUserId: owner.id,
          quantity: 1,
          unitPrice: 1000,
        },
      });
    }

    const window = { from, to, dateColumn: "createdAt" };
    const orders = FACT_SOURCES.find((s2) => s2.key === "orders")!;

    // The registry erases each source's row type so the array can hold all six; the only thing
    // this check reads off an order row is the customer name, so it says so rather than casting
    // to the full shape and pretending to know more than it does.
    type Named = { company: { name: string } };
    const asSuperAdmin = (await orders.load({ userId: superAdmin.id, ...window })) as unknown as Named[];
    const asSalesperson = (await orders.load({ userId: mine.id, ...window })) as unknown as Named[];

    ok(
      "The super admin sees both accounts' orders",
      asSuperAdmin.filter((r) => r.company.name.startsWith(PREFIX)).length === 2,
      `${asSuperAdmin.filter((r) => r.company.name.startsWith(PREFIX)).length} of 2`,
    );
    ok(
      "  the salesperson sees only the account they manage",
      asSalesperson.length === 1 && asSalesperson[0]!.company.name === `${PREFIX} Alpha`,
      asSalesperson.map((r) => r.company.name).join(", ") || "nothing",
    );
    ok(
      "  and their colleague's revenue is absent from the total, not merely from the rows",
      runReport({
        source: orders,
        rows: asSalesperson as unknown as never[],
        measureKey: "value",
        dimensionKey: "salesperson",
        grain: "month",
        dateKey: "createdAt",
        scopeNote: "check",
      }).grandTotal === 1000,
      "a report that filtered the list but not the arithmetic would still leak the number",
    );

    // Every other source, with the same viewer, must not widen either.
    for (const source of FACT_SOURCES) {
      const wide = (await source.load({ userId: superAdmin.id, ...window })).length;
      const narrow = (await source.load({ userId: mine.id, ...window })).length;
      ok(`  ${source.label} never returns more to the narrower viewer`, narrow <= wide, `${narrow} of ${wide}`);
    }
  } finally {
    await cleanup();
  }
  // ── The arithmetic ────────────────────────────────────────────────────────────────────────────
  section("Aggregation");

  type Fake = { who: string; tags: string[]; amount: number; when: Date; done: boolean };
  const fakeRows: Fake[] = [
    { who: "A", tags: ["x", "y"], amount: 100, when: new Date(2026, 0, 10), done: true },
    { who: "A", tags: ["x"], amount: 50, when: new Date(2026, 1, 10), done: false },
    { who: "B", tags: [], amount: 25, when: new Date(2026, 0, 20), done: true },
  ];
  const fakeSource = {
    key: "fake",
    label: "Fake",
    description: "",
    moduleKey: null,
    companyAnchored: false,
    load: async () => fakeRows,
    scopeNote: async () => "check",
    measures: [
      { key: "amount", label: "Amount", unit: "currency" as const, value: (r: Fake) => r.amount },
      { key: "avg", label: "Average", unit: "number" as const, average: true, value: (r: Fake) => (r.done ? r.amount : 0) },
    ],
    dimensions: [
      { key: "who", label: "Who", of: (r: Fake) => r.who },
      { key: "tag", label: "Tag", of: (r: Fake) => (r.tags.length ? r.tags : NONE), multi: true },
    ],
    dateFields: [{ key: "when", label: "When", get: (r: Fake) => r.when }],
  };

  const byWho = runReport({
    source: fakeSource,
    rows: fakeRows,
    measureKey: "amount",
    dimensionKey: "who",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok("Totals add up", byWho.grandTotal === 175, String(byWho.grandTotal));
  ok("  biggest first", byWho.rows[0]?.label === "A" && byWho.rows[0]?.total === 150, byWho.rows.map((r) => `${r.label} ${r.total}`).join(", "));

  const byMonth = runReport({
    source: fakeSource,
    rows: fakeRows,
    measureKey: "amount",
    dimensionKey: "time",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok(
    "  a time breakdown stays chronological, not ranked",
    byMonth.rows[0]!.key < byMonth.rows[1]!.key,
    byMonth.rows.map((r) => `${r.label} ${r.total}`).join(", "),
  );

  const byTag = runReport({
    source: fakeSource,
    rows: fakeRows,
    measureKey: "amount",
    dimensionKey: "tag",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok(
    "  a multi-valued dimension counts a row in every bucket",
    byTag.rows.find((r) => r.label === "x")?.total === 150 && byTag.rows.find((r) => r.label === "y")?.total === 100,
    byTag.rows.map((r) => `${r.label} ${r.total}`).join(", "),
  );
  ok("  and says so, because the parts now exceed the whole", byTag.doubleCounted, `grand total still ${byTag.grandTotal}`);

  /**
   * The headline is the one number on the page that is *not* double counted.
   *
   * It used to be the sum of the row totals, which is the double-counted number by construction:
   * the A row tagged x and y put its 100 into both, so "Total" read 275 over 175 of actual money —
   * while the caption underneath told the reader the rows exceeded the total and the total was
   * sound. 275 is what this line would have measured before.
   */
  const partsOfTag = byTag.rows.reduce((t, r) => t + r.total, 0);
  ok(
    "  but the total still counts each record once",
    byTag.grandTotal === 175 && partsOfTag === 275,
    `rows add to ${partsOfTag}, total ${byTag.grandTotal} — the same 175 as every other breakdown of the same rows`,
  );

  // The flag read the dimension's *declaration*, so every tag report warned about an inflation that
  // had not happened. Most accounts carry one tag; a warning that is always on is one nobody reads
  // on the day it is true.
  const singleTagged = runReport({
    source: fakeSource,
    rows: fakeRows.filter((r) => r.tags.length < 2),
    measureKey: "amount",
    dimensionKey: "tag",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok(
    "  and stays quiet when nothing actually landed twice, multi-valued dimension or not",
    !singleTagged.doubleCounted && !byWho.doubleCounted,
    "one tag each, so no record is in two buckets — the declaration alone used to be enough to warn",
  );

  const avg = runReport({
    source: fakeSource,
    rows: fakeRows,
    measureKey: "avg",
    dimensionKey: "who",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok(
    "An averaged measure ignores rows that did not contribute",
    avg.rows.find((r) => r.label === "A")?.total === 100,
    "A has one done at 100 and one not done — counting the second as zero would report 50",
  );

  const cross = runReport({
    source: fakeSource,
    rows: fakeRows,
    measureKey: "amount",
    dimensionKey: "who",
    columnKey: "time",
    grain: "month",
    dateKey: "when",
    scopeNote: "check",
  });
  ok("A cross-tab's columns add up to the grand total",
    Object.values(cross.columnTotals).reduce((a, b) => a + b, 0) === cross.grandTotal,
    `${Object.entries(cross.columnTotals).map(([k, v]) => `${k}:${v}`).join(" ")} = ${cross.grandTotal}`,
  );

  section("What the number under 'Total' means");

  /**
   * An averaged measure, weighted the way arithmetic weights it.
   *
   * "Total" over an average was the mean of the bucket *means*: a hundred tickets resolved in 10
   * days and one resolved in 100 came out as 55, because each bucket got a vote rather than each
   * record. The true mean over those 101 records is 10.89. Measured on live tickets, the same
   * question returned eight different totals depending only on which breakdown somebody picked —
   * which is the real damage: not that one number is wrong, but that there is no one number.
   *
   * Written with explicit IST instants. `new Date(2026, 0, 10)` reads the host's clock, so a suite
   * built from it agrees with a timezone bug instead of catching one.
   */
  const weighted: Fake[] = [
    ...Array.from({ length: 100 }, () => ({ who: "Big", tags: [], amount: 10, when: ist("2026-01-10T09:00"), done: true })),
    { who: "Tiny", tags: [], amount: 100, when: ist("2026-01-10T09:00"), done: true },
    // A bucket that contributes no records at all, which the old code had to drop by hand.
    { who: "Zero", tags: [], amount: 0, when: ist("2026-01-11T09:00"), done: false },
  ];
  const trueMean = 1100 / 101;

  const avgBy = (dimensionKey: string, columnKey?: string) =>
    runReport({
      source: fakeSource,
      rows: weighted,
      measureKey: "avg",
      dimensionKey,
      columnKey,
      grain: "day" as Grain,
      dateKey: "when",
      scopeNote: "check",
    });

  const avgByWho = avgBy("who");
  ok(
    "An averaged total is the mean over the records, not the mean of the bucket means",
    Math.abs(avgByWho.grandTotal - trueMean) < 0.01,
    `${avgByWho.grandTotal} — 100 records at 10 and one at 100; one vote per bucket gives 55`,
  );

  const everyWay = [avgBy("who").grandTotal, avgBy("time").grandTotal, avgBy("tag").grandTotal];
  ok(
    "  so the same question gives the same total however it is broken down",
    new Set(everyWay).size === 1,
    `by who ${everyWay[0]}, by day ${everyWay[1]}, by tag ${everyWay[2]}`,
  );

  ok(
    "  and a bucket nothing contributed to drags nothing, because it brings n = 0 rather than a zero",
    avgByWho.rows.find((r) => r.label === "Zero")?.total === 0 && Math.abs(avgByWho.grandTotal - trueMean) < 0.01,
    "dropping zeroes by hand also dropped the genuine ones — an average of 0 days is a real answer",
  );

  const avgCross = avgBy("who", "time");
  ok(
    "  a cross-tab's column total is weighted down the column the same way",
    Math.abs((avgCross.columnTotals["2026-01-10"] ?? 0) - trueMean) < 0.01,
    `${avgCross.columnTotals["2026-01-10"]} — the same 101 records in one column; averaging its two cells gives 55`,
  );

  section("A cross-tab has a width");

  /**
   * The table, the CSV and the wire payload were the only three things in this feature with no
   * ceiling: `runReport` fills every column for every row, so two dropdowns produced a 96 × 233
   * table — twenty-odd thousand cells and as many DOM nodes — while every chart drawn from the same
   * result capped itself at forty series or fewer.
   *
   * Folded rather than dropped: everything past the cap is still counted, in one column that says
   * how many it stands for.
   */
  const wide: Fake[] = Array.from({ length: COLUMN_CAP + 20 }, (_, i) => ({
    who: i % 2 === 0 ? "A" : "B",
    tags: [],
    amount: 10,
    when: new Date(ist("2026-01-01T09:00").getTime() + i * 24 * 60 * 60 * 1000),
    done: true,
  }));
  const capped = runReport({
    source: fakeSource,
    rows: wide,
    measureKey: "amount",
    dimensionKey: "who",
    columnKey: "time",
    grain: "day",
    dateKey: "when",
    scopeNote: "check",
  });
  ok(
    `A cross-tab folds everything past ${COLUMN_CAP} columns into one`,
    capped.columns.length === COLUMN_CAP + 1 && capped.columnsFolded === 20,
    `${capped.columns.length} columns and ${capped.columnsFolded} folded, from ${wide.length} days`,
  );
  ok(
    "  and folding moves no money out of the totals",
    capped.grandTotal === wide.length * 10 &&
      Object.values(capped.columnTotals).reduce((a, b) => a + b, 0) === capped.grandTotal,
    `${capped.grandTotal} across ${capped.columns.length} columns`,
  );
  ok(
    "  the folded column holds the oldest periods and comes first, so the header stays in date order",
    capped.columns[0]!.key === OTHER_COLUMN && capped.columns[1]!.key === "2026-01-21",
    capped.columns.slice(0, 3).map((c) => c.label).join(" | "),
  );

  /**
   * A record with no date is not a record from before the window.
   *
   * `NONE` is "—", which sorts ahead of every `yyyy-…` key, so the slice that keeps the most recent
   * periods dropped the undated bucket first and the fold then filed it under "Earlier (20 more)".
   * That is a confident, specific, wrong claim: it turns "we never recorded a date for this" into
   * "this happened before January", on a column somebody is about to read as a trend.
   *
   * Deleting the `undated` guard in `runReport` puts the 7 below inside "Earlier".
   */
  type Undated = { who: string; when: Date | null; amount: number };
  const undatedSource = {
    key: "undated",
    label: "Undated",
    description: "",
    moduleKey: null,
    companyAnchored: false,
    load: async () => [] as Undated[],
    scopeNote: async () => "check",
    measures: [{ key: "amount", label: "Amount", unit: "currency" as const, value: (r: Undated) => r.amount }],
    dimensions: [{ key: "who", label: "Who", of: (r: Undated) => r.who }],
    dateFields: [{ key: "when", label: "When", get: (r: Undated) => r.when }],
  };
  const withUndated = runReport({
    source: undatedSource,
    rows: [
      ...wide.map((r) => ({ who: r.who, when: r.when, amount: r.amount })),
      { who: "A", when: null, amount: 7 },
    ],
    measureKey: "amount",
    dimensionKey: "who",
    columnKey: "time",
    grain: "day",
    dateKey: "when",
    scopeNote: "check",
  });

  ok(
    "  'no date' keeps a column of its own rather than being folded into 'Earlier'",
    withUndated.columns[0]!.key === NONE && withUndated.columns[1]!.key === OTHER_COLUMN,
    withUndated.columns.slice(0, 3).map((c) => c.label).join(" | "),
  );
  ok(
    "  and its money is not reported as an older period",
    withUndated.columnTotals[NONE] === 7,
    `${withUndated.columnTotals[NONE] ?? "nothing"} under "—", ${withUndated.columnTotals[OTHER_COLUMN]} under "Earlier"`,
  );
  ok(
    "  while the periods it sits beside are capped exactly as before",
    withUndated.columnsFolded === 20 && withUndated.grandTotal === wide.length * 10 + 7,
    `${withUndated.columnsFolded} folded, ${withUndated.grandTotal} total`,
  );

  section("Filters");

  const run = (extra: Record<string, unknown> = {}) =>
    runReport({
      source: fakeSource,
      rows: fakeRows,
      measureKey: "amount",
      dimensionKey: "who",
      grain: "month" as Grain,
      dateKey: "when",
      scopeNote: "check",
      ...extra,
    });

  const unfiltered = run();
  const onlyA = run({ filters: { who: ["A"] } });

  ok("A filter drops the rows it excludes", onlyA.rows.length === 1, `${onlyA.rows.length} of ${unfiltered.rows.length}`);
  ok(
    "  and the total goes with them",
    onlyA.grandTotal === 150,
    "a filter that narrowed the list but not the arithmetic would show B's money under A's name",
  );
  ok("  it says how many it dropped", onlyA.filteredOut === 1, `${onlyA.filteredOut} excluded`);
  ok("  and counts the kept rows, not the loaded ones", onlyA.rowCount === 2, String(onlyA.rowCount));

  ok(
    "The values it offers come from the unfiltered set",
    onlyA.values.who?.length === 2,
    "otherwise filtering to A removes B from the list and there is no way back",
  );

  const multi = run({ filters: { tag: ["x"] } });
  ok(
    "A multi-valued filter keeps a row matching on any of its values",
    multi.rowCount === 2 && multi.grandTotal === 150,
    `${multi.rowCount} rows totalling ${multi.grandTotal}`,
  );

  const both = run({ filters: { who: ["A"], tag: ["y"] } });
  ok(
    "  and two filters are an AND, not an OR",
    both.rowCount === 1 && both.grandTotal === 100,
    `${both.rowCount} row totalling ${both.grandTotal} — only the A row tagged y`,
  );

  const none = run({ filters: { who: [] } });
  ok("An empty filter list is no filter at all", none.rowCount === unfiltered.rowCount, String(none.rowCount));

  /**
   * Filtering to one value of a multi-valued dimension *and* breaking down by that dimension.
   *
   * The case this section never covered: every filter above breaks down by `who`, so the filtered
   * dimension was never the axis. A record is kept for matching on any of its values — correctly —
   * and was then bucketed under its other values too, so clicking into "x" brought back a "y" row
   * as well and counted the same 100 under both. Before this change: two rows, total 250.
   */
  const drilled = run({ dimensionKey: "tag", filters: { tag: ["x"] } });
  ok(
    "Drilling into one value of a multi-valued dimension returns only that value",
    drilled.rows.length === 1 && drilled.rows[0]!.label === "x",
    drilled.rows.map((r) => `${r.label} ${r.total}`).join(", ") || "nothing",
  );
  ok(
    "  and totals the money in it, not that plus the rows nobody asked for",
    drilled.grandTotal === 150,
    `${drilled.grandTotal} — the two x-tagged rows`,
  );

  section("What the filter panel is allowed to offer");

  /**
   * The contract between the panel and the engine.
   *
   * The panel lists values so somebody can narrow a report *before* running it — "AutoCAD, in
   * Kochi, last quarter" rather than running the wrong report and clicking their way to the right
   * one. Those options come from `dimensionValues`; the report filters with `runReport`. If the two
   * ever disagreed, the panel would offer a value that returns an empty report, and an empty report
   * reads as "we sold none of that" rather than "the tool is broken".
   *
   * So every offered value is used as a filter, and has to bring something back.
   */
  const offered = dimensionValues(fakeSource, fakeRows);

  ok("it offers every value a dimension takes", (offered.who ?? []).join() === "A,B", (offered.who ?? []).join() || "nothing");
  ok(
    "  including each value of a multi-valued one, not the combination",
    (offered.tag ?? []).join() === [NONE, "x", "y"].join(),
    (offered.tag ?? []).join() || "nothing",
  );
  ok(
    "  and the rows with none of it, as a value of its own",
    (offered.tag ?? []).includes(NONE),
    "'which orders have no tag' is usually the interesting question on that column",
  );
  ok(
    "  and it agrees with what a run reports",
    JSON.stringify(offered) === JSON.stringify(unfiltered.values),
    "two implementations of the same list would drift apart quietly",
  );

  const empty: string[] = [];
  for (const dim of fakeSource.dimensions) {
    for (const value of offered[dim.key] ?? []) {
      if (run({ filters: { [dim.key]: [value] } }).rowCount === 0) empty.push(dim.key + "=" + value);
    }
  }
  ok(
    "no offered value returns an empty report",
    empty.length === 0,
    empty.length === 0 ? "every option brings something back" : empty.join(", "),
  );

  /**
   * And it says when the list is a slice.
   *
   * Past `FILTER_VALUE_CAP` the tail of the alphabet is simply dropped, and the panel printed the
   * length of what it was handed — "Search 300 customers…" — which reads as the whole list and is
   * exactly the number that proves it is not. The count is the pre-cap total, so the offer can name
   * what it is leaving out.
   */
  const crowd: Fake[] = Array.from({ length: FILTER_VALUE_CAP + 100 }, (_, i) => ({
    who: `Customer ${String(i).padStart(4, "0")}`,
    tags: [],
    amount: 1,
    when: ist("2026-01-10T09:00"),
    done: true,
  }));
  const crowded = dimensionOptions(fakeSource, crowd);

  ok(
    `it offers at most ${FILTER_VALUE_CAP} values of one dimension`,
    (crowded.values.who ?? []).length === FILTER_VALUE_CAP,
    `${(crowded.values.who ?? []).length} offered`,
  );
  ok(
    "  and reports how many there really are, so nothing can pass the slice off as the list",
    crowded.counts.who === FILTER_VALUE_CAP + 100,
    `${crowded.counts.who} distinct — the ${crowd.length - FILTER_VALUE_CAP} at the end of the alphabet are not offered, and only this number says so`,
  );
  ok(
    "  while a dimension under the cap counts exactly what it offers",
    dimensionOptions(fakeSource, fakeRows).counts.who === (offered.who ?? []).length,
    "the count is only interesting where it differs from the list",
  );

  section("The downloaded file agrees with the screen");

  /**
   * The one thing in the export that a spreadsheet can silently disagree with.
   *
   * A loss is a negative measure, a negative measure starts with a minus, and the formula-injection
   * guard quotes anything starting with a minus — so the cell left as `'-1488`, Excel read it as
   * text, it dropped out of SUM, and the file's total came back *larger* than the report's. The
   * failure is invisible in the CSV itself: you have to open it and add the column up.
   *
   * Reverting `csvRow` to sanitise every cell fails the first of these.
   */
  ok(
    "a negative number stays a number",
    csvRow([-1488]) === '"-1488"',
    `${csvRow([-1488])} — an apostrophe here drops the cell out of SUM and inflates the file's total`,
  );
  ok(
    "  while text that could be read as a formula is still defused",
    csvRow(["=1+1"]) === `"'=1+1"`,
    csvRow(["=1+1"]),
  );
  ok(
    "  and a customer name beginning with a minus is defused too",
    csvRow(["-Acme"]) === `"'-Acme"`,
    "it is text, so the guard still applies — the type is what decides, not the character",
  );
  ok(
    "  a quote inside a cell is doubled rather than closing it",
    csvRow(['He said "yes"']) === '"He said ""yes"""',
    csvRow(['He said "yes"']),
  );
  ok(
    "  and a comma does not become a column",
    csvRow(["Pune, Maharashtra", 10]).split('","').length === 2,
    csvRow(["Pune, Maharashtra", 10]),
  );

  console.log(failures === 0 ? "\nAll analytics checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
