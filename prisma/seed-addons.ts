/**
 * Walks the exact scenario: 10 seats of M365 Business Basic from 10/08/2026 to 09/08/2027, with
 * seats added part-way through, then checks what the renewal would come to.
 *
 * The check that earns its place is the last one: renewing at what the addon was *charged* would
 * under-bill by the part of the term that had already gone. That mistake is silent, it is in the
 * customer's favour, and nothing else in the system would notice.
 *
 *   npm run db:seed:addons            seed and verify
 *   npm run db:seed:addons -- --reset remove what this made first
 *   npm run db:seed:addons -- --verify-only
 */
import { Prisma } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { canAddTo, proRata, remainingDays, renewalGroup, termDays } from "../src/lib/subscriptions/proration";

const db = directClient();

const PARENT_START = "2026-08-10";
const PARENT_END = "2027-08-09";
const ANNUAL_PER_SEAT = 6000;
const SKU = "M365-BB-SEED";

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** The additions, as they would really arrive: a few seats here, a few there. */
const ADDITIONS = [
  { on: "2026-11-15", seats: 5 },
  { on: "2027-02-01", seats: 3 },
  { on: "2027-06-20", seats: 2 },
];

async function reset() {
  const item = await db.item.findFirst({ where: { sku: SKU }, select: { id: true } });
  if (item) {
    await db.companyProduct.deleteMany({ where: { itemId: item.id } });
    await db.item.delete({ where: { id: item.id } });
  }
  console.log("Removed the previous addon seed.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const company = await db.company.findFirstOrThrow({
    where: { relationshipType: "CLIENT", locations: { some: {} } },
    select: { id: true, name: true, locations: { select: { id: true }, take: 1 } },
  });

  const item = await db.item.upsert({
    where: { sku: SKU },
    update: {},
    create: {
      name: "Microsoft 365 Business Basic",
      sku: SKU,
      type: "SUBSCRIPTION",
      billingCycle: "ANNUAL",
      hsnCode: "997331",
      unit: "seat",
      sellingPrice: new Prisma.Decimal(ANNUAL_PER_SEAT),
      taxRatePercent: new Prisma.Decimal(18),
      createdById: admin.id,
    },
    select: { id: true },
  });

  // ── The original ───────────────────────────────────────────────────────────
  const parent = await db.companyProduct.create({
    data: {
      companyId: company.id,
      locationId: company.locations[0].id,
      itemId: item.id,
      quantity: 10,
      startDate: date(PARENT_START),
      endDate: date(PARENT_END),
      unitPrice: new Prisma.Decimal(ANNUAL_PER_SEAT),
      // The parent's own price is already a full term, but recording it explicitly means the
      // renewal never has to infer which of the two prices it is looking at.
      fullTermUnitPrice: new Prisma.Decimal(ANNUAL_PER_SEAT),
      fullTermDays: termDays(PARENT_START, PARENT_END),
      purchasePrice: new Prisma.Decimal(ANNUAL_PER_SEAT * 0.82),
      businessType: "NEW",
      orderStatus: "FULFILLED",
      addedByUserId: admin.id,
    },
    select: { id: true },
  });
  console.log(`Parent: 10 seats, ${PARENT_START} → ${PARENT_END}, ₹${ANNUAL_PER_SEAT.toLocaleString("en-IN")} a seat`);

  // ── The additions ──────────────────────────────────────────────────────────
  for (const addition of ADDITIONS) {
    // Checked exactly as the action checks it — a seed that plants what the action refuses would be
    // seeding the bug the validation exists to catch.
    const problems = canAddTo({
      parent: {
        startDate: PARENT_START,
        endDate: PARENT_END,
        orderStatus: "FULFILLED",
        itemType: "SUBSCRIPTION",
        parentId: null,
      },
      addonStart: addition.on,
      quantity: addition.seats,
    });
    if (problems.length > 0) throw new Error(`${addition.on}: ${problems[0].message}`);

    const quote = proRata({
      fullTermUnitPrice: ANNUAL_PER_SEAT,
      quantity: addition.seats,
      addonStart: addition.on,
      parentStart: PARENT_START,
      parentEnd: PARENT_END,
    });

    await db.companyProduct.create({
      data: {
        companyId: company.id,
        locationId: company.locations[0].id,
        itemId: item.id,
        parentId: parent.id,
        quantity: addition.seats,
        // Co-terminated with the parent: one product, one renewal date.
        startDate: date(addition.on),
        endDate: date(PARENT_END),
        unitPrice: new Prisma.Decimal(quote.unitPrice),
        fullTermUnitPrice: new Prisma.Decimal(ANNUAL_PER_SEAT),
        proRataDays: quote.daysCharged,
        fullTermDays: quote.fullTermDays,
        purchasePrice: new Prisma.Decimal(Math.round(quote.unitPrice * 0.82 * 100) / 100),
        businessType: "ADDON",
        orderStatus: "FULFILLED",
        notes: quote.workings,
        addedByUserId: admin.id,
      },
    });
    console.log(
      `  + ${addition.seats} seats from ${addition.on}: ${quote.daysCharged}/${quote.fullTermDays} days, ₹${quote.unitPrice.toLocaleString("en-IN")} a seat, ₹${quote.total.toLocaleString("en-IN")} total`,
    );
  }
  console.log(`Customer: ${company.name}`);
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };
  const round2 = (n: number) => Math.round(n * 100) / 100;

  console.log("\n— Verifying —");

  const item = await db.item.findFirst({ where: { sku: SKU }, select: { id: true } });
  if (!item) {
    console.log(" FAIL  the seeded subscription is missing");
    return 1;
  }

  const parent = await db.companyProduct.findFirst({
    where: { itemId: item.id, parentId: null },
    include: { addons: { orderBy: { startDate: "asc" } }, company: { select: { name: true } } },
  });
  if (!parent) {
    console.log(" FAIL  the parent subscription is missing");
    return 1;
  }

  ok("the original is there", parent.quantity === 10, `${parent.quantity} seats`);
  ok("the additions are separate orders", parent.addons.length === 3, `${parent.addons.length}`);

  // The reason they are separate rows at all: each keeps its own sale date and its own price.
  const distinctStarts = new Set(parent.addons.map((a) => a.startDate?.toISOString().slice(0, 10)));
  ok(
    "each addition kept its own start date",
    distinctStarts.size === 3,
    [...distinctStarts].join(", "),
  );
  const distinctPrices = new Set(parent.addons.map((a) => Number(a.unitPrice)));
  ok(
    "and its own pro-rated price",
    distinctPrices.size === 3,
    [...distinctPrices].map((p) => `₹${p.toLocaleString("en-IN")}`).join(", "),
  );

  // Co-termination is the whole point — a customer with two renewal dates for one product has been
  // let down by the system, not by the vendor.
  const sameExpiry = parent.addons.every(
    (a) => a.endDate?.toISOString() === parent.endDate?.toISOString(),
  );
  ok("everything expires on the same day", sameExpiry, parent.endDate?.toISOString().slice(0, 10));

  const startsAfterParent = parent.addons.every((a) => a.startDate! >= parent.startDate!);
  ok("nothing starts before the subscription it was added to", startsAfterParent);

  const endsBeforeExpiry = parent.addons.every((a) => a.startDate! <= parent.endDate!);
  ok("nothing starts after it expires", endsBeforeExpiry);

  // Every pro-rated price reproduces from the frozen day counts.
  let reproduced = 0;
  for (const addon of parent.addons) {
    const expected = proRata({
      fullTermUnitPrice: Number(addon.fullTermUnitPrice),
      quantity: addon.quantity,
      addonStart: addon.startDate!,
      parentStart: parent.startDate!,
      parentEnd: parent.endDate!,
    });
    if (
      round2(expected.unitPrice) === round2(Number(addon.unitPrice)) &&
      expected.daysCharged === addon.proRataDays
    ) {
      reproduced += 1;
    }
  }
  ok("every price reproduces from its day count", reproduced === parent.addons.length, `${reproduced}/${parent.addons.length}`);

  const laterIsCheaper = parent.addons.every((a, i) =>
    i === 0 ? true : Number(a.unitPrice) < Number(parent.addons[i - 1].unitPrice),
  );
  ok("the later the addition, the less it costs", laterIsCheaper, "fewer days left to charge for");

  const daysMatch = parent.addons.every(
    (a) => a.proRataDays === remainingDays(a.startDate!, parent.endDate!),
  );
  ok("the frozen day counts still agree with the dates", daysMatch);

  // ── The renewal ────────────────────────────────────────────────────────────
  const group = renewalGroup([
    {
      id: parent.id,
      quantity: parent.quantity,
      unitPrice: Number(parent.unitPrice),
      fullTermUnitPrice: parent.fullTermUnitPrice ? Number(parent.fullTermUnitPrice) : null,
      startDate: parent.startDate,
      isAddon: false,
    },
    ...parent.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: Number(a.unitPrice),
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  ok("the renewal covers every seat", group.totalQuantity === 20, `10 + 5 + 3 + 2 = ${group.totalQuantity}`);
  ok(
    "at the full-year price",
    group.renewalValue === 20 * ANNUAL_PER_SEAT,
    `₹${group.renewalValue.toLocaleString("en-IN")} — 20 × ₹${ANNUAL_PER_SEAT.toLocaleString("en-IN")}`,
  );
  ok("with nothing missing a price", !group.incomplete, group.note);

  // The mistake this whole design exists to prevent.
  const charged =
    parent.quantity * Number(parent.unitPrice) +
    parent.addons.reduce((t, a) => t + a.quantity * Number(a.unitPrice), 0);
  const shortfall = round2(group.renewalValue - charged);
  ok(
    "renewing at what was charged would under-bill",
    shortfall > 0,
    `by ₹${shortfall.toLocaleString("en-IN")} — which is why the full-year price is kept separately`,
  );

  // Addons must not show up as renewals in their own right.
  const asRenewals = await db.companyProduct.count({
    where: { itemId: item.id, parentId: null, endDate: { not: null } },
  });
  ok("only the parent appears as a renewal", asRenewals === 1, `${asRenewals} of ${1 + parent.addons.length} rows`);

  // Nothing nested — an addon on an addon would leave the renewal unsure which row is the real one.
  const nested = await db.companyProduct.count({
    where: { parentId: { not: null }, addons: { some: {} } },
  });
  ok("no addon has its own addon", nested === 0);

  // The billed value is real revenue and belongs to the month it was sold in, not to August.
  const addonRevenue = parent.addons.reduce((t, a) => t + a.quantity * Number(a.unitPrice), 0);
  ok(
    "the additions are worth counting on their own",
    addonRevenue > 0,
    `₹${round2(addonRevenue).toLocaleString("en-IN")} billed across ${parent.addons.length} sales, each in its own month`,
  );

  console.log(failures === 0 ? "\nAll addon seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
