/**
 * That the printable copy is reachable before a document is issued, and says that it is a draft.
 *
 * The print page is what becomes the PDF a customer receives. It used to be offered only once a
 * document had been issued, which had it backwards — a draft is exactly the thing you want to read
 * as a document *before* committing to it. Now it is offered on a draft too, and that raises the
 * risk this suite exists for: the page otherwise renders identically to the finished article, and
 * the number on a draft is not final. Somebody previews, saves the PDF and sends it, and the
 * customer holds a quote whose number will end up belonging to a different document.
 *
 * So the page is rendered for real — the actual server component, against a real document — and
 * read back as HTML. Rendering it is also the only way to find out that it renders at all for a
 * draft; a type check cannot tell you that.
 *
 *   npm run check:document-print
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";

const TAG = "ZZPROBE_PRINT";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};

/** The page and the actions beneath it need a session; substitute one, the way the other suites do. */
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    return {
      requireUser: async () => ({ id: actorId, name: "Probe" }),
      currentUser: async () => ({ id: actorId, name: "Probe" }),
    };
  }
  if (request === "next/navigation") {
    // Distinguishable from any other throw, so "the document was not found" cannot be mistaken for
    // "the page crashed" — they would otherwise both surface as a failed render.
    return {
      notFound: () => { throw new Error("NOT_FOUND_CALLED"); },
      redirect: () => {},
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const { createProposalFromAddonQuote } = await import("../src/actions/addon-proposal");
  const PrintPage = (await import("../src/app/(print)/documents/[id]/print/page")).default;

  /** Renders the real server component and returns its HTML. */
  const render = async (id: string) => {
    const element = await PrintPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(element as React.ReactElement);
  };

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() - 3, 1));
  const addOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

  const created: { documents: string[]; orders: string[]; companies: string[]; items: string[] } = {
    documents: [], orders: [], companies: [], items: [],
  };

  try {
    const item = await db.item.create({
      data: {
        name: `${TAG} Microsoft 365 Business Standard`,
        sku: `${TAG}-SKU`, type: "SUBSCRIPTION", hsnCode: "997331", unit: "Licence",
        sellingPrice: 3955, taxRatePercent: 18, createdById: actorId,
      },
      select: { id: true },
    });
    created.items.push(item.id);

    const company = await db.company.create({
      data: {
        name: `${TAG} Juniper Pharma`,
        normalizedName: `${TAG.toLowerCase()} juniper pharma`,
        createdById: actorId, ownerUserId: actorId,
        locations: {
          create: {
            label: "Head office", address: "12 Hosur Road", city: "Bengaluru", state: "Karnataka",
            pincode: "560029", gstNumber: "29AABCU9603R1ZM", gstTreatment: "REGISTERED_REGULAR", isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(company.id);

    const order = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId: company.locations[0]!.id, itemId: item.id, quantity: 10,
        startDate: start, endDate: end, unitPrice: 3955, fullTermUnitPrice: 3955,
        orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(order.id);

    const made = await createProposalFromAddonQuote({ parentId: order.id, quantity: 10, startDate: addOn, basis: "DAY" });
    ok("a draft proposal exists to print", made.ok, made.ok ? made.data.docNumber : made.error);
    if (!made.ok) return;
    created.documents.push(made.data.id);

    // ── It renders at all, as a draft ────────────────────────────────────────────────────────────
    let html = "";
    try {
      html = await render(made.data.id);
      ok("the print page renders for a DRAFT", html.length > 0, `${html.length} bytes of HTML`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ok(
        "the print page renders for a DRAFT",
        false,
        message === "NOT_FOUND_CALLED" ? "it called notFound() — a draft is not reachable" : message,
      );
      return;
    }

    ok(
      "  and it carries the document number",
      // A null number must fail, not fall back to a needle the page trivially contains.
      Boolean(made.data.docNumber) && html.includes(made.data.docNumber!),
      made.data.docNumber,
    );
    ok("  and the customer's name", html.includes("Juniper Pharma"));
    ok("  and the line it is quoting for", html.includes("997331"), "the HSN off the catalogue item");

    // ── The draft says so, on the paper ──────────────────────────────────────────────────────────
    const marked = /Draft\s*(?:—|&#x2014;|&mdash;)\s*not issued/i.test(html);
    ok(
      "the printed copy is marked as a draft",
      marked,
      "without this, previewing and sending the PDF hands a customer a number that isn't final",
    );
    ok(
      "  and the mark is not hidden from print",
      marked && !/print:hidden[^"]*"[^>]*>\s*Draft/i.test(html),
      "the printed copy is the whole risk, so the mark must survive printing",
    );

    /**
     * ── The button that gets you there ──────────────────────────────────────────────────────────
     *
     * The page above is only worth having if something offers it. The action bar used to put
     * Print / PDF in the issued branch alone, so on a draft there was no way to reach the printable
     * copy at all — which is what this half of the suite is guarding against coming back.
     */
    const { DocumentActions } = await import("../src/components/documents/document-actions");
    const bar = (status: "DRAFT" | "ACCEPTED") =>
      renderToStaticMarkup(
        createElement(DocumentActions, {
          id: made.data.id,
          docType: "PROPOSAL" as const,
          status,
          einvoiceStatus: "NOT_APPLICABLE" as const,
          hasIrn: false,
          einvoiceEnabled: false,
          canCancelIrn: false,
        }),
      );

    const draftBar = bar("DRAFT");
    ok("a draft offers the printable copy", /Preview PDF/.test(draftBar), "it offered nothing at all before");
    ok("  without losing Issue", /Issue/.test(draftBar));
    ok("  or Edit", /Edit/.test(draftBar));

    const issuedBar = bar("ACCEPTED");
    ok("an issued document still offers it", /Print \/ PDF/.test(issuedBar));
    ok(
      "  and the label reflects which it is",
      /Preview PDF/.test(draftBar) && !/Preview PDF/.test(issuedBar),
      "a draft is previewed, an issued document is printed — the word says which you are looking at",
    );

    // ── An issued document is not marked ─────────────────────────────────────────────────────────
    await db.tradeDocument.update({ where: { id: made.data.id }, data: { status: "ACCEPTED" } });
    const issuedHtml = await render(made.data.id);
    ok(
      "an issued document carries no draft mark",
      !/Draft\s*(?:—|&#x2014;|&mdash;)\s*not issued/i.test(issuedHtml),
      "the mark is about status, not about being a proposal",
    );
    ok("  and still renders", issuedHtml.length > 0, `${issuedHtml.length} bytes`);
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
    console.log(failures === 0 ? "\nAll print checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
