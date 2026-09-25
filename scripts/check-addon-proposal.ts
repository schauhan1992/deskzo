/**
 * That the proposal a salesperson raises from the calculator carries the figure they were shown.
 *
 * The calculator has always been able to work out a part-term price; the button under it now writes
 * that price into a real document. Two things have to hold for that to be worth having, and both are
 * easy to get silently wrong:
 *
 *   - the price on the document is the one that was on screen — including which *basis* was on
 *     screen, because the day and month conventions give different totals for the same seats;
 *   - the price is worked out on the server, so a posted figure cannot become a customer-facing
 *     quote.
 *
 * Run against the real action with a substituted session, so what is checked is the path the button
 * takes rather than a re-implementation of it. Everything it touches is its own fixture, prefixed
 * ZZPROBE and removed in a finally, so it is safe against a database with real data in it.
 *
 *   npm run check:addon-proposal
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { proRata, proRataMonths } from "../src/lib/subscriptions/proration";

const TAG = "ZZPROBE_ADDON_PROPOSAL";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

/** The action needs a session; substitute one, the way the other suites do. */
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") {
    // revalidatePath wants a render store. Which pages re-render is not what this is testing.
    return { revalidatePath: () => {}, revalidateTag: () => {} };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    return {
      requireUser: async () => ({ id: actorId, name: "Probe" }),
      currentUser: async () => ({ id: actorId, name: "Probe" }),
    };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

/** Rupees, for the failure messages — a bare 4931.51 next to 5000 is hard to read at a glance. */
const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const { createProposalFromAddonQuote } = await import("../src/actions/addon-proposal");

  /**
   * A term that straddles today, so the quote is for a live subscription with time left on it.
   *
   * Dated relative to now rather than pinned, because `canAddTo` refuses a start after the parent
   * expires — a fixture with hardcoded 2024 dates would pass today and start failing on its own,
   * which is the worst kind of suite to own.
   */
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() - 3, 1));
  const addOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const ANNUAL = 12000;
  const QTY = 5;

  const created: { documents: string[]; orders: string[]; companies: string[]; items: string[] } = {
    documents: [],
    orders: [],
    companies: [],
    items: [],
  };

  try {
    // ── Fixture ──────────────────────────────────────────────────────────────────────────────────
    const item = await db.item.create({
      data: {
        name: `${TAG} Microsoft 365 Business Premium`,
        sku: `${TAG}-SKU`,
        type: "SUBSCRIPTION",
        hsnCode: "997331",
        unit: "seat",
        sellingPrice: ANNUAL,
        taxRatePercent: 18,
        createdById: actorId,
      },
      select: { id: true },
    });
    created.items.push(item.id);

    /** Karnataka (29) on the GSTIN, Maharashtra on the address — so the two sources can be told apart. */
    const company = await db.company.create({
      data: {
        name: `${TAG} Acme Industries`,
        normalizedName: `${TAG.toLowerCase()} acme industries`,
        createdById: actorId,
        ownerUserId: actorId,
        locations: {
          create: {
            label: "Head office",
            address: "4th Floor, Prestige Tower",
            city: "Bengaluru",
            state: "Maharashtra",
            pincode: "560001",
            gstNumber: "29AABCU9603R1ZM",
            gstTreatment: "REGISTERED_REGULAR",
            isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(company.id);
    const locationId = company.locations[0]!.id;

    const order = await db.companyProduct.create({
      data: {
        companyId: company.id,
        locationId,
        itemId: item.id,
        quantity: 10,
        startDate: start,
        endDate: end,
        unitPrice: ANNUAL,
        fullTermUnitPrice: ANNUAL,
        orderStatus: "FULFILLED",
        addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(order.id);

    const expectedDay = proRata({ fullTermUnitPrice: ANNUAL, quantity: QTY, addonStart: addOn, parentStart: start, parentEnd: end });
    const expectedMonth = proRataMonths({ fullTermUnitPrice: ANNUAL, quantity: QTY, addonStart: addOn, parentStart: start, parentEnd: end });

    ok(
      "the fixture's two bases genuinely differ",
      expectedDay.unitPrice !== expectedMonth.unitPrice,
      `${inr(expectedDay.unitPrice)} by the day vs ${inr(expectedMonth.unitPrice)} by the month — if these matched, the basis assertions below would prove nothing`,
    );

    // ── A draft appears ──────────────────────────────────────────────────────────────────────────
    const made = await createProposalFromAddonQuote({ parentId: order.id, quantity: QTY, startDate: addOn, basis: "DAY" });
    ok("the button creates a proposal", made.ok, made.ok ? made.data.docNumber : made.error);
    if (!made.ok) return;
    created.documents.push(made.data.id);

    const doc = await db.tradeDocument.findUnique({
      where: { id: made.data.id },
      select: {
        docType: true, status: true, docNumber: true, placeOfSupplyCode: true, buyerGstin: true,
        gstTreatment: true, currency: true, validUntil: true, notes: true, companyId: true,
        subtotal: true, taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, total: true,
        lines: { select: { name: true, quantity: true, unitPrice: true, hsnCode: true, unit: true, taxRatePercent: true, companyProductId: true, description: true } },
      },
    });

    ok("  it is a PROPOSAL", doc?.docType === "PROPOSAL", doc?.docType);
    ok("  in DRAFT status", doc?.status === "DRAFT", `${doc?.status} — issuing is a separate, permissioned act`);
    ok("  numbered", Boolean(doc?.docNumber), doc?.docNumber);
    ok("  against the right customer", doc?.companyId === company.id);
    ok("  with exactly one line", doc?.lines.length === 1, doc?.lines.length);

    const line = doc!.lines[0]!;

    // ── The figure is the one on screen ──────────────────────────────────────────────────────────
    ok(
      "the line carries the day-basis price the panel showed",
      Number(line.unitPrice) === expectedDay.unitPrice,
      `${inr(Number(line.unitPrice))} vs ${inr(expectedDay.unitPrice)}`,
    );
    ok("  for the quantity asked for", Number(line.quantity) === QTY, Number(line.quantity));
    ok(
      "  and the total multiplies out",
      Number(doc!.subtotal) === expectedDay.total,
      `${inr(Number(doc!.subtotal))} vs ${inr(expectedDay.total)}`,
    );

    /**
     * Tax was charged, at the catalogue rate.
     *
     * The three components are summed rather than checked individually: whether this lands as
     * CGST+SGST or as IGST depends on the seller's own state in the organisation settings, which is
     * environment data. What must hold everywhere is that 18% was applied, once.
     */
    const taxCharged = Number(doc!.cgstAmount) + Number(doc!.sgstAmount) + Number(doc!.igstAmount);
    const expectedTax = Math.round(Number(doc!.taxableValue) * 0.18 * 100) / 100;
    ok(
      "  GST is applied at the catalogue rate",
      Math.abs(taxCharged - expectedTax) < 0.02,
      `${inr(taxCharged)} on ${inr(Number(doc!.taxableValue))}, expected ${inr(expectedTax)}`,
    );
    ok(
      "  and the payable is the taxable value plus that tax",
      Math.abs(Number(doc!.total) - (Number(doc!.taxableValue) + taxCharged)) < 1.0,
      `${inr(Number(doc!.total))} — within a rupee, which is the round-off line`,
    );

    // ── The basis is honoured, not assumed ───────────────────────────────────────────────────────
    const byMonth = await createProposalFromAddonQuote({ parentId: order.id, quantity: QTY, startDate: addOn, basis: "MONTH" });
    ok("a proposal can be raised on the month basis", byMonth.ok, byMonth.ok ? byMonth.data.docNumber : byMonth.error);
    if (byMonth.ok) {
      created.documents.push(byMonth.data.id);
      const monthDoc = await db.tradeDocument.findUnique({
        where: { id: byMonth.data.id },
        select: { notes: true, lines: { select: { unitPrice: true, description: true } } },
      });
      ok(
        "  and it carries the MONTH figure, not the day one",
        Number(monthDoc?.lines[0]?.unitPrice) === expectedMonth.unitPrice,
        `${inr(Number(monthDoc?.lines[0]?.unitPrice))} vs ${inr(expectedMonth.unitPrice)} — quoting the day basis here would hand the customer a different number from the one read out on the phone`,
      );
      /**
       * The count as well as the word.
       *
       * Checking only for "months" is not enough: an action that computed the day basis while
       * labelling it the month one renders "274 of 366 months", which contains the word and is
       * nonsense. The count is what says the label and the arithmetic came from the same place.
       */
      ok(
        "  the line says which basis it used, and counts in it",
        monthDoc?.lines[0]?.description?.includes(`${expectedMonth.daysCharged} of ${expectedMonth.fullTermDays} months`) === true,
        monthDoc?.lines[0]?.description,
      );
      ok(
        "  and the workings are on the document",
        monthDoc?.notes?.includes(expectedMonth.workings) === true,
        "so a customer querying the figure gets the same explanation wherever they ask",
      );
    }

    // ── What was derived, rather than typed ──────────────────────────────────────────────────────
    ok(
      "the place of supply comes from the GSTIN, not the address's state name",
      doc?.placeOfSupplyCode === "29",
      `${doc?.placeOfSupplyCode} — the fixture's GSTIN says 29 (Karnataka) and its address says Maharashtra (27); the GSTIN is authoritative`,
    );
    ok("the buyer's GSTIN is carried", doc?.buyerGstin === "29AABCU9603R1ZM", doc?.buyerGstin);
    ok("the GST treatment comes off the address", doc?.gstTreatment === "REGISTERED_REGULAR", doc?.gstTreatment);
    ok("the HSN and unit come off the catalogue item", line.hsnCode === "997331" && line.unit === "seat", `${line.hsnCode} / ${line.unit}`);
    ok("the tax rate comes off the catalogue item", Number(line.taxRatePercent) === 18, line.taxRatePercent);
    ok(
      "it expires with the subscription it is part of",
      doc?.validUntil?.toISOString().slice(0, 10) === end.toISOString().slice(0, 10),
      `${doc?.validUntil?.toISOString().slice(0, 10)} vs ${end.toISOString().slice(0, 10)}`,
    );
    ok(
      "the line does not claim to bill the existing order",
      line.companyProductId === null,
      `${line.companyProductId} — companyProductId marks a line as billing an order that exists, and these seats do not exist yet`,
    );

    // ── Refusals ─────────────────────────────────────────────────────────────────────────────────
    const addon = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId, itemId: item.id, quantity: 2,
        parentId: order.id, businessType: "ADDON", startDate: start, endDate: end,
        unitPrice: ANNUAL, fullTermUnitPrice: ANNUAL, orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(addon.id);

    const onAddon = await createProposalFromAddonQuote({ parentId: addon.id, quantity: 1, startDate: addOn, basis: "DAY" });
    ok("an addon cannot itself be quoted against", !onAddon.ok, onAddon.ok ? "it was drafted" : onAddon.error);

    const afterExpiry = await createProposalFromAddonQuote({
      parentId: order.id,
      quantity: 1,
      startDate: new Date(end.getTime() + 86400_000).toISOString().slice(0, 10),
      basis: "DAY",
    });
    ok("a start date past expiry is refused", !afterExpiry.ok, afterExpiry.ok ? "it was drafted" : afterExpiry.error);

    const noSeats = await createProposalFromAddonQuote({ parentId: order.id, quantity: 0, startDate: addOn, basis: "DAY" });
    ok("zero seats is refused", !noSeats.ok, noSeats.ok ? "it was drafted" : noSeats.error);

    const gone = await createProposalFromAddonQuote({ parentId: "does-not-exist", quantity: 1, startDate: addOn, basis: "DAY" });
    ok("an unknown subscription is refused", !gone.ok, gone.ok ? "it was drafted" : gone.error);

    /**
     * A customer with nothing to derive a place of supply from.
     *
     * This is the one that matters most of the refusals: `isIntraState` treats a missing place of
     * supply as inter-state, so drafting anyway would quietly put IGST on a local sale. Refusing
     * sends somebody to fix the address instead.
     */
    const bare = await db.company.create({
      data: {
        name: `${TAG} Nowhere Ltd`,
        normalizedName: `${TAG.toLowerCase()} nowhere ltd`,
        createdById: actorId,
        ownerUserId: actorId,
        locations: { create: { label: "Unknown", isPrimary: true } },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(bare.id);
    const bareOrder = await db.companyProduct.create({
      data: {
        companyId: bare.id, locationId: bare.locations[0]!.id, itemId: item.id, quantity: 4,
        startDate: start, endDate: end, unitPrice: ANNUAL, fullTermUnitPrice: ANNUAL,
        orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(bareOrder.id);

    const noState = await createProposalFromAddonQuote({ parentId: bareOrder.id, quantity: 1, startDate: addOn, basis: "DAY" });
    ok(
      "a customer with no state and no GSTIN is refused, not silently taxed as inter-state",
      !noState.ok,
      noState.ok ? "it was drafted" : noState.error,
    );

    /** A price is never posted in — the action takes no price at all, so this is a shape check. */
    const posted = await createProposalFromAddonQuote({
      parentId: order.id,
      quantity: QTY,
      startDate: addOn,
      basis: "DAY",
      // @ts-expect-error deliberately passing a field the action does not accept
      unitPrice: 1,
    });
    if (posted.ok) {
      created.documents.push(posted.data.id);
      const spoofed = await db.tradeDocument.findUnique({
        where: { id: posted.data.id },
        select: { lines: { select: { unitPrice: true } } },
      });
      ok(
        "a unit price posted alongside the input is ignored",
        Number(spoofed?.lines[0]?.unitPrice) === expectedDay.unitPrice,
        `${inr(Number(spoofed?.lines[0]?.unitPrice))} — the price is derived from the order, never accepted from the caller`,
      );
    } else {
      ok("a unit price posted alongside the input is ignored", false, posted.error);
    }
  } finally {
    // Documents first — their lines cascade, but the orders they point at do not.
    for (const id of created.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    for (const id of created.orders.reverse()) await db.companyProduct.delete({ where: { id } }).catch(() => {});
    for (const id of created.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of created.items) await db.item.delete({ where: { id } }).catch(() => {});

    const leftover = await db.company.count({ where: { name: { startsWith: TAG } } });
    ok("the fixture cleaned up after itself", leftover === 0, `${leftover} companies left behind`);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
