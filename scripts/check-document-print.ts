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
 * It also reads whose paper it is: the document is raised from a branch, its letterhead prints the
 * GSTIN the document recorded rather than today's, and a "Branch:" line appears only where the
 * workspace has several branches and this is not the head office's document.
 *
 *   npm run check:document-print
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import { gstinCheckCharacter } from "../src/lib/gst-engine";

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

    /**
     * ── Whose paper it is ───────────────────────────────────────────────────────────────────────
     *
     * Every document is raised from a branch now, and one written without choosing is raised from
     * the writer's: their own branch while it is active, else the head office. Worked out here from
     * the rows rather than by asking the helper that decides it, so a document that silently landed
     * nowhere — or on somebody else's branch — fails.
     */
    const stored = await db.tradeDocument.findUniqueOrThrow({
      where: { id: made.data.id },
      select: { branchId: true, branch: { select: { name: true, isHeadOffice: true } } },
    });
    const [writer, headOffice] = await Promise.all([
      db.user.findUnique({ where: { id: actorId }, select: { branch: { select: { id: true, active: true } } } }),
      db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } }),
    ]);
    const expectedBranch = writer?.branch?.active ? writer.branch.id : (headOffice?.id ?? null);
    ok(
      "the proposal was raised from a branch — the writer's default",
      stored.branchId !== null && stored.branchId === expectedBranch,
      stored.branch ? stored.branch.name : "no branch at all",
    );

    /**
     * The GSTIN printed is the one the document recorded, not the one the company has today (X2).
     *
     * A GSTIN is replaced, or a branch moves to another registration, and an invoice reprinted
     * afterwards must still carry the number it was issued under. So the fixture is given a snapshot
     * no registration holds — a made-up PAN with a real check character — and the page must print
     * exactly that. Nothing is restored: the document is deleted in the `finally`.
     */
    const snapshot = `27ZZPRT0000Z1Z${gstinCheckCharacter("27ZZPRT0000Z1Z")}`;
    await db.tradeDocument.update({ where: { id: made.data.id }, data: { sellerGstin: snapshot } });

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

    {
      // In the letterhead — ahead of the customer's block, which carries the customer's own GSTIN.
      const printed = new RegExp(`GSTIN:\\s*(?:<!-- -->)?\\s*${snapshot}`).exec(html);
      const customerAt = html.indexOf("Juniper Pharma");
      ok(
        "the letterhead prints the document's own GSTIN snapshot",
        printed !== null && customerAt >= 0 && printed.index < customerAt,
        printed ? snapshot : "the snapshot is not in the header",
      );
      // And not today's: the organisation's live GSTIN (its head office registration's), where it has one.
      const { getOrganisation } = await import("../src/lib/organisation");
      const live = (await getOrganisation()).gstin;
      ok(
        "  not the organisation's live GSTIN",
        !live || live === snapshot || !html.includes(live),
        live ? `${live} is ${html.includes(live) ? "on the page" : "not on the page"}` : "the organisation has no GSTIN today",
      );
    }

    {
      /**
       * A "Branch:" line only where there is more than one branch to tell apart, and only for a
       * branch other than the head office — a single-branch company's paper reads as it always has.
       * Asserted for whichever of the two this workspace is; the suite doesn't change it to find out.
       */
      const { isMultiBranch } = await import("../src/lib/branches/identity");
      const multi = await isMultiBranch();
      const named = multi && stored.branch !== null && !stored.branch.isHeadOffice;
      const line = /Branch:\s*(?:<!-- -->)?\s*([^<]+)</.exec(html);
      ok(
        named ? "the branch it was raised from is named on the paper" : "no branch line — one branch, or the head office's paper",
        named ? line !== null && line[1]!.trim() === stored.branch!.name : line === null,
        `${multi ? "several branches" : "one branch"}; raised from ${stored.branch?.isHeadOffice ? "the head office" : (stored.branch?.name ?? "nowhere")}${line ? `; printed "${line[0].slice(0, -1).trim()}"` : ""}`,
      );
    }

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
