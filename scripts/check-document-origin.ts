/**
 * Where each document came from, and whether the Source column can be believed.
 *
 * A provenance column is only worth having if every path that makes a document declares itself.
 * One that forgets is not a visible bug — the row simply reads as something it isn't, or as blank,
 * and the column quietly stops meaning anything. So each creation path is exercised for real and
 * the value it writes is read back.
 *
 * The backfill is checked too. Every document that existed before the column was added came from
 * one of three places, and the migration placed them; a null appearing later means a newer path is
 * not saying where it came from.
 *
 *   npm run check:document-origin
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import { documentOriginLabels } from "../src/lib/trade-documents";

const TAG = "ZZPROBE_ORIGIN";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/sales/proposals",
      notFound: () => { throw new Error("NOT_FOUND_CALLED"); },
      redirect: () => {},
    };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    return {
      requireUser: async () => ({ id: actorId, name: "Probe" }),
      currentUser: async () => ({ id: actorId, name: "Probe" }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const { createProposalFromAddonQuote } = await import("../src/actions/addon-proposal");
  const { createProposalFromRenewal } = await import("../src/actions/renewal-proposal");
  const { createTradeDocument, convertTradeDocument, listTradeDocuments } = await import("../src/actions/trade-document");
  const { DocumentRows } = await import("../src/components/documents/document-rows");

  section("Nothing in the book is unaccounted for");

  /**
   * The backfill, and every path since.
   *
   * Checked over the whole table rather than a fixture, because the point of this assertion is that
   * no document anywhere is missing a provenance — including ones written by a path this suite does
   * not know about.
   */
  const unplaced = await db.tradeDocument.count({ where: { origin: null } });
  const totalDocs = await db.tradeDocument.count();
  ok(
    "every document says where it came from",
    unplaced === 0,
    `${unplaced} of ${totalDocs} unplaced — a null means a creation path isn't declaring itself`,
  );

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  const addOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

  const created: { documents: string[]; orders: string[]; companies: string[]; items: string[] } = {
    documents: [], orders: [], companies: [], items: [],
  };

  try {
    const item = await db.item.create({
      data: {
        name: `${TAG} Autodesk AutoCAD`, sku: `${TAG}-SKU`, type: "SUBSCRIPTION",
        hsnCode: "997331", unit: "Licence", billingCycle: "ANNUAL",
        sellingPrice: 60000, taxRatePercent: 18, createdById: actorId,
      },
      select: { id: true },
    });
    created.items.push(item.id);

    const company = await db.company.create({
      data: {
        name: `${TAG} Meridian Engineering`,
        normalizedName: `${TAG.toLowerCase()} meridian engineering`,
        createdById: actorId, ownerUserId: actorId,
        locations: {
          create: {
            label: "Works", address: "Plot 9, MIDC", city: "Pune", state: "Maharashtra",
            pincode: "411018", gstNumber: "27AABCU9603R1ZX", gstTreatment: "REGISTERED_REGULAR", isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(company.id);
    const locationId = company.locations[0]!.id;

    const order = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId, itemId: item.id, quantity: 4,
        startDate: start, endDate: end, unitPrice: 60000, fullTermUnitPrice: 60000,
        orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(order.id);

    section("Each path declares itself");

    const originOf = async (id: string) =>
      (await db.tradeDocument.findUnique({ where: { id }, select: { origin: true } }))?.origin ?? null;

    // ── The add-on calculator ────────────────────────────────────────────────────────────────────
    const addon = await createProposalFromAddonQuote({ parentId: order.id, quantity: 2, startDate: addOn, basis: "DAY" });
    ok("the add-on calculator raises a proposal", addon.ok, addon.ok ? addon.data.docNumber : addon.error);
    if (!addon.ok) return;
    created.documents.push(addon.data.id);
    ok("  recorded as ADDON_CALCULATOR", (await originOf(addon.data.id)) === "ADDON_CALCULATOR", await originOf(addon.data.id));

    // ── The renewals list ────────────────────────────────────────────────────────────────────────
    const renewal = await createProposalFromRenewal({ companyProductId: order.id });
    ok("the renewals list raises a proposal", renewal.ok, renewal.ok ? renewal.data.docNumber : renewal.error);
    if (!renewal.ok) return;
    created.documents.push(renewal.data.id);
    ok("  recorded as RENEWAL", (await originOf(renewal.data.id)) === "RENEWAL", await originOf(renewal.data.id));

    ok(
      "  and the two are told apart",
      (await originOf(addon.data.id)) !== (await originOf(renewal.data.id)),
      "both are proposals for the same customer and the same product; only the origin distinguishes them",
    );

    // ── The document form ────────────────────────────────────────────────────────────────────────
    const manualDoc = await createTradeDocument({
      docType: "PROPOSAL", companyId: company.id, locationId, docNumber: "",
      placeOfSupplyCode: "27", gstTreatment: "REGISTERED_REGULAR", buyerGstin: "27AABCU9603R1ZX",
      reverseCharge: false, currency: "INR", exchangeRate: 1,
      issueDate: new Date().toISOString().slice(0, 10), dueDate: "", validUntil: "",
      reference: "", salespersonId: "", notes: "", terms: "", dispatchFromAddress: "",
      billing: { attention: "", line1: "Plot 9, MIDC", line2: "", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411018", country: "India", phone: "" },
      shippingSameAsBilling: true,
      shipping: { attention: "", line1: "Plot 9, MIDC", line2: "", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411018", country: "India", phone: "" },
      shippingGstin: "", shippingCharge: 0, shippingTaxRatePercent: 0,
      withholdingMode: "NONE", withholdingSection: "", withholdingRatePercent: 0,
      adjustmentLabel: "", adjustment: 0, sourceDocumentId: "", leadId: "", againstDocumentId: "",
      lines: [{ itemId: item.id, companyProductId: "", name: "AutoCAD", description: "", hsnCode: "997331", unit: "Licence", quantity: 1, unitPrice: 60000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 }],
    });
    ok("the document form raises a proposal", manualDoc.ok, manualDoc.ok ? "" : manualDoc.error);
    if (!manualDoc.ok) return;
    created.documents.push(manualDoc.data.id);
    ok(
      "  recorded as MANUAL, which is the default",
      (await originOf(manualDoc.data.id)) === "MANUAL",
      "a caller that says nothing is the form, and that is the only path that should be silent",
    );

    // ── Conversion ───────────────────────────────────────────────────────────────────────────────
    const converted = await convertTradeDocument({ id: manualDoc.data.id, target: "PROFORMA" });
    ok("a proposal converts to a proforma", converted.ok, converted.ok ? "" : converted.error);
    if (converted.ok) {
      created.documents.unshift(converted.data.id);
      ok("  recorded as CONVERSION", (await originOf(converted.data.id)) === "CONVERSION", await originOf(converted.data.id));
      const link = await db.tradeDocument.findUnique({
        where: { id: converted.data.id },
        select: { sourceDocument: { select: { id: true, docNumber: true } } },
      });
      ok(
        "  and it points at what it came from",
        link?.sourceDocument?.id === manualDoc.data.id,
        `${link?.sourceDocument?.docNumber} — "Converted" on its own only raises the question`,
      );
    }

    section("What the list shows");

    const listed = await listTradeDocuments({ docType: "PROPOSAL", page: 1, pageSize: 200 });
    const addonRow = listed.rows.find((r) => r.id === addon.data.id);
    const renewalRow = listed.rows.find((r) => r.id === renewal.data.id);
    ok("the list query returns the origin", addonRow?.origin === "ADDON_CALCULATOR", addonRow?.origin);
    ok("  for every row", renewalRow?.origin === "RENEWAL", renewalRow?.origin);

    const html = renderToStaticMarkup(
      createElement(DocumentRows, {
        docType: "PROPOSAL" as const,
        documents: [addonRow, renewalRow].filter(Boolean) as never,
        eInvoiced: false,
      }),
    );
    ok("the table has a Source column", />Source</.test(html));
    ok(
      "  labelled in words rather than in enum values",
      html.includes(documentOriginLabels.ADDON_CALCULATOR) && html.includes(documentOriginLabels.RENEWAL),
      `"${documentOriginLabels.ADDON_CALCULATOR}" and "${documentOriginLabels.RENEWAL}"`,
    );
    ok(
      "  and never prints a raw enum value",
      !/ADDON_CALCULATOR|NOT_STARTED|CONSIGNMENT<|>RENEWAL</.test(html),
      "a column that shows SCREAMING_SNAKE is a column nobody reads",
    );

    /**
     * A row whose origin was never recorded says so.
     *
     * Not "Entered by hand": every pre-existing document was placed by the migration, so a blank
     * means something newer is not declaring itself, and labelling that as manual would be a guess
     * presented as a fact.
     */
    const blank = renderToStaticMarkup(
      createElement(DocumentRows, {
        docType: "PROPOSAL" as const,
        documents: [{ ...addonRow, origin: null }] as never,
        eInvoiced: false,
      }),
    );
    ok("an unrecorded origin reads as 'Not recorded'", blank.includes("Not recorded"));
    ok(
      "  rather than being guessed as manual",
      !blank.includes(documentOriginLabels.MANUAL),
      "the whole value of the column is that it is not guessing",
    );
  } finally {
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
    console.log(failures === 0 ? "\nAll document origin checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
