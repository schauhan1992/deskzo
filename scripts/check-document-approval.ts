/**
 * Document sign-off: who may approve, and what an approval is worth once given.
 *
 * Two things make this feature real rather than decorative, and both are easy to leave out:
 *
 *   · **Nobody approves their own.** A control the controlled person can wave through is not a
 *     control. It has to hold for a super admin too, or "the rule doesn't apply to me" becomes the
 *     rule.
 *   · **An edit invalidates an approval.** Otherwise a ₹1,000 quote is signed off, edited to
 *     ₹10,00,000, and the record shows an approver against a figure they never saw.
 *
 * The pure half needs no database. The rest goes through the real actions with a substituted
 * session, against its own ZZPROBE fixture, removed in a finally.
 *
 *   npm run check:document-approval
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import {
  approvalAfterEdit,
  approvalRequirement,
  defaultApprovalPolicy,
  mayApprove,
  mayIssue,
  maySubmit,
  type ApprovalPolicy,
} from "../src/lib/documents/approval";

const TAG = "ZZPROBE_APPROVAL";

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
      usePathname: () => "/documents",
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

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  ...defaultApprovalPolicy("PROPOSAL"),
  enabled: true,
  ...over,
});

async function main() {
  // ── The pure half ────────────────────────────────────────────────────────────────────────────
  section("Who may approve");

  const salesperson = { id: "u-sales", role: "SALES", isSuperAdmin: false };
  const manager = { id: "u-manager", role: "SALES", isSuperAdmin: false };
  const accounts = { id: "u-accounts", role: "ACCOUNTS", isSuperAdmin: false };
  const root = { id: "u-root", role: "ADMIN", isSuperAdmin: true };
  const submitted = { submittedById: salesperson.id, submitterManagerIds: [manager.id, "u-director"] };

  ok(
    "a role named on the policy may approve",
    mayApprove({ policy: policy({ approverRoles: ["ACCOUNTS"] }), actor: accounts, subject: submitted }).reason === "role",
  );
  ok(
    "a person named on the policy may approve",
    mayApprove({ policy: policy({ approverUserIds: [accounts.id] }), actor: accounts, subject: submitted }).reason === "named",
  );
  ok(
    "the submitter's manager may approve when that is switched on",
    mayApprove({ policy: policy({ managerApproves: true }), actor: manager, subject: submitted }).reason === "manager",
  );
  ok(
    "  and so may anyone further up that line",
    mayApprove({
      policy: policy({ managerApproves: true }),
      actor: { id: "u-director", role: "MANAGEMENT", isSuperAdmin: false },
      subject: submitted,
    }).may,
    "one person being on leave must not strand a quotation",
  );
  ok(
    "  but not somebody else's manager",
    !mayApprove({
      policy: policy({ managerApproves: true }),
      actor: { id: "u-other-manager", role: "SALES", isSuperAdmin: false },
      subject: submitted,
    }).may,
  );
  ok(
    "a manager cannot approve when that route is switched off",
    !mayApprove({ policy: policy({ approverRoles: ["ACCOUNTS"] }), actor: manager, subject: submitted }).may,
  );
  ok(
    "somebody with none of the three routes cannot approve",
    mayApprove({ policy: policy({ approverRoles: ["ACCOUNTS"] }), actor: { id: "u-x", role: "SUPPORT", isSuperAdmin: false }, subject: submitted }).reason ===
      "not-an-approver",
  );

  section("The two rules that are not configurable");

  ok(
    "an ordinary approver cannot approve what they submitted",
    mayApprove({ policy: policy({ approverRoles: ["SALES"] }), actor: salesperson, subject: submitted }).reason === "own-document",
    "even though SALES is an approving role and they hold it",
  );
  ok(
    "a super admin may approve somebody else's",
    mayApprove({ policy: policy(), actor: root, subject: submitted }).reason === "super-admin",
    "break-glass, so a policy naming two people who have both left cannot strand every invoice",
  );
  /**
   * Deliberately allowed, and deliberately distinguishable.
   *
   * Where the person who raises the quotation is also the person who signs it off, blocking this
   * only means the document never moves. The separation-of-duties cost is handled by recording it:
   * the verdict comes back as its own reason so the audit line can name it.
   */
  ok(
    "a super admin may approve their own",
    mayApprove({ policy: policy(), actor: root, subject: { ...submitted, submittedById: root.id } }).may,
  );
  ok(
    "  and that is recorded as a self-approval, not as an ordinary one",
    mayApprove({ policy: policy(), actor: root, subject: { ...submitted, submittedById: root.id } }).reason ===
      "super-admin-own",
    "\"who approved their own work\" has to stay an answerable question",
  );
  ok(
    "nobody approves anything when the policy is off",
    mayApprove({ policy: policy({ enabled: false, approverRoles: ["ACCOUNTS"] }), actor: accounts, subject: submitted }).reason ===
      "approval-not-enabled",
  );

  section("What an approval is worth");

  ok("an approved document may be issued", mayIssue({ policy: policy(), approvalStatus: "APPROVED" }).may);
  ok("a pending one may not", !mayIssue({ policy: policy(), approvalStatus: "PENDING" }).may);
  ok("a rejected one may not", !mayIssue({ policy: policy(), approvalStatus: "REJECTED" }).may);
  ok("an unsubmitted one may not", !mayIssue({ policy: policy(), approvalStatus: "NOT_SUBMITTED" }).may);
  ok(
    "and every type may be issued when approval is off",
    mayIssue({ policy: policy({ enabled: false }), approvalStatus: "NOT_SUBMITTED" }).may,
    "installing this changes nothing until a type is switched on",
  );

  ok(
    "editing an approved document withdraws the approval",
    approvalAfterEdit("APPROVED") === "NOT_SUBMITTED",
    "otherwise a ₹1,000 quote is signed off and edited to ₹10,00,000 under somebody else's name",
  );
  ok(
    "  while a pending one is left alone",
    approvalAfterEdit("PENDING") === "PENDING",
    "nothing has been agreed to yet, so there is nothing to invalidate",
  );

  section("Only above a value, or past a discount");

  const sized = (valueInr: number, lineDiscountPercents: number[] = [0]) => ({ valueInr, lineDiscountPercents });
  const limited = policy({ minValue: 200_000 });
  ok("with no limits set, every document needs approval — as before", approvalRequirement(policy(), sized(1)).required);
  ok("under the value limit, it doesn't", !approvalRequirement(limited, sized(150_000)).required);
  ok("  nor exactly at it — \"above ₹2,00,000\" lets ₹2,00,000 through", !approvalRequirement(limited, sized(200_000)).required);
  ok("  and over it, it does, and says why", approvalRequirement(limited, sized(200_001)).why.includes("over the ₹2,00,000 approval limit"));
  const both = policy({ minValue: 200_000, maxDiscountPercent: 10 });
  ok("a small quote with a heavy discount still needs it", approvalRequirement(both, sized(50_000, [0, 12.5])).required);
  ok("  and says which rule it broke", /discounted 12\.5%, more than the 10%/.test(approvalRequirement(both, sized(50_000, [12.5])).why));
  ok("  exactly at the discount limit is within it", !approvalRequirement(both, sized(50_000, [10.000001])).required);
  const discountOnly = policy({ maxDiscountPercent: 10 });
  ok("with only a discount rule, a large undiscounted order goes through", !approvalRequirement(discountOnly, sized(9_000_000, [5])).required);
  ok("  and a discounted one of any size doesn't", approvalRequirement(discountOnly, sized(1_000, [15])).required);
  ok("approval off means nothing needs it, limits or not", !approvalRequirement(policy({ enabled: false, minValue: 1 }), sized(9_000_000)).required);
  ok("under the limit it may be issued without ever being submitted", mayIssue({ policy: limited, approvalStatus: "NOT_SUBMITTED", document: sized(150_000) }).may);
  ok("  and over it, not", !mayIssue({ policy: limited, approvalStatus: "NOT_SUBMITTED", document: sized(250_000) }).may);
  ok("  and asked without the document, it errs on the side of needing approval", !mayIssue({ policy: limited, approvalStatus: "NOT_SUBMITTED" }).may);
  const nothingToAsk = maySubmit({ policy: limited, approvalStatus: "NOT_SUBMITTED", isDraft: true, document: sized(150_000) });
  ok("there's nothing to submit when it's under the limits — and it says so", !nothingToAsk.may && /No approval needed/.test(nothingToAsk.why ?? ""));

  ok("a rejected document can be submitted again", maySubmit({ policy: policy(), approvalStatus: "REJECTED", isDraft: true }).may);
  ok("  but an approved one cannot be re-submitted", !maySubmit({ policy: policy(), approvalStatus: "APPROVED", isDraft: true }).may);
  ok("  and an issued one cannot be submitted at all", !maySubmit({ policy: policy(), approvalStatus: "NOT_SUBMITTED", isDraft: false }).may);

  // ── Against the database ─────────────────────────────────────────────────────────────────────
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");

  const { saveApprovalPolicy, submitForApproval, decideApproval } = await import("../src/actions/document-approval");
  const { createTradeDocument, issueTradeDocument } = await import("../src/actions/trade-document");

  const created: { documents: string[]; companies: string[]; items: string[]; users: string[] } = {
    documents: [], companies: [], items: [], users: [],
  };
  let hadPolicy: { enabled: boolean; approverRoles: string[]; managerApproves: boolean; minValue: unknown; maxDiscountPercent: unknown } | null = null;

  try {
    hadPolicy =
      (await db.documentApprovalPolicy.findUnique({
        where: { docType: "PROPOSAL" },
        select: { enabled: true, approverRoles: true, managerApproves: true, minValue: true, maxDiscountPercent: true },
      })) ?? null;

    section("End to end, through the real actions");

    /**
     * Two people: one raises, one approves. Both removed in the finally.
     *
     * The stored hash is deliberately not a hash of anything. Password checks compare against a
     * bcrypt digest, and this string is not one, so no input can ever match it — these accounts
     * exist for the length of this suite and must not be a way in even if cleanup fails.
     */
    const UNUSABLE_PASSWORD = "!probe-account-cannot-sign-in";
    const raiser = await db.user.create({
      data: { name: `${TAG} Raiser`, email: `${TAG.toLowerCase()}.raiser@example.invalid`, role: "SALES", active: true, passwordHash: UNUSABLE_PASSWORD },
      select: { id: true },
    });
    created.users.push(raiser.id);
    const approver = await db.user.create({
      data: { name: `${TAG} Approver`, email: `${TAG.toLowerCase()}.approver@example.invalid`, role: "ACCOUNTS", active: true, passwordHash: UNUSABLE_PASSWORD },
      select: { id: true },
    });
    created.users.push(approver.id);

    /**
     * Both probe users get the two keys this flow needs, as explicit per-user grants.
     *
     * Not left to whatever the roles happen to hold in this database: the suite would then pass or
     * fail depending on how somebody has configured SALES and ACCOUNTS today, which is exactly the
     * kind of assertion that is really testing the fixture.
     */
    for (const id of [raiser.id, approver.id]) {
      for (const permission of ["companies.viewAll", "documents.issue"]) {
        await db.userPermission.create({ data: { userId: id, permission, allowed: true, grantedById: admin.id } });
      }
    }

    const item = await db.item.create({
      data: {
        name: `${TAG} Adobe Creative Cloud`, sku: `${TAG}-SKU`, type: "SUBSCRIPTION",
        hsnCode: "997331", unit: "Licence", sellingPrice: 50000, taxRatePercent: 18, createdById: admin.id,
      },
      select: { id: true },
    });
    created.items.push(item.id);

    const company = await db.company.create({
      data: {
        name: `${TAG} Larkspur Media`,
        normalizedName: `${TAG.toLowerCase()} larkspur media`,
        createdById: admin.id, ownerUserId: admin.id,
        locations: {
          create: {
            label: "Studio", address: "5 Linking Road", city: "Mumbai", state: "Maharashtra",
            pincode: "400050", gstNumber: "27AABCU9603R1ZX", gstTreatment: "REGISTERED_REGULAR", isPrimary: true,
          },
        },
      },
      select: { id: true, locations: { select: { id: true } } },
    });
    created.companies.push(company.id);

    // ── Configuring the policy ───────────────────────────────────────────────────────────────────
    actorId = admin.id;
    const empty = await saveApprovalPolicy({
      docType: "PROPOSAL", enabled: true, approverRoles: [], approverUserIds: [], managerApproves: false,
    });
    ok(
      "switching approval on with nobody able to approve is refused",
      !empty.ok,
      empty.ok ? "it was saved" : empty.error,
    );

    const saved = await saveApprovalPolicy({
      docType: "PROPOSAL", enabled: true, approverRoles: ["ACCOUNTS"], approverUserIds: [], managerApproves: false,
    });
    ok("the policy saves", saved.ok, saved.ok ? "" : saved.error);

    // ── Raising one ──────────────────────────────────────────────────────────────────────────────
    const address = { attention: "", line1: "5 Linking Road", line2: "", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400050", country: "India", phone: "" };
    const payload = {
      docType: "PROPOSAL", companyId: company.id, locationId: company.locations[0]!.id, docNumber: "",
      placeOfSupplyCode: "27", gstTreatment: "REGISTERED_REGULAR", buyerGstin: "27AABCU9603R1ZX",
      reverseCharge: false, currency: "INR", exchangeRate: 1,
      issueDate: new Date().toISOString().slice(0, 10), dueDate: "", validUntil: "",
      reference: "", salespersonId: "", notes: "", terms: "", dispatchFromAddress: "",
      billing: address, shippingSameAsBilling: true, shipping: address, shippingGstin: "",
      shippingCharge: 0, shippingTaxRatePercent: 0, withholdingMode: "NONE", withholdingSection: "",
      withholdingRatePercent: 0, adjustmentLabel: "", adjustment: 0,
      sourceDocumentId: "", leadId: "", againstDocumentId: "",
      lines: [{ itemId: item.id, companyProductId: "", name: "Creative Cloud", description: "", hsnCode: "997331", unit: "Licence", quantity: 1, unitPrice: 50000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 }],
    };

    actorId = raiser.id;
    const doc = await createTradeDocument(payload);
    ok("a salesperson raises a proposal", doc.ok, doc.ok ? "" : doc.error);
    if (!doc.ok) return;
    created.documents.push(doc.data.id);

    // ── The gate ─────────────────────────────────────────────────────────────────────────────────
    const tooSoon = await issueTradeDocument({ id: doc.data.id, generateEInvoice: false });
    ok(
      "it cannot be issued before it is approved",
      !tooSoon.ok,
      tooSoon.ok ? "it was issued" : tooSoon.error,
    );

    const submittedResult = await submitForApproval({ id: doc.data.id });
    ok("it can be submitted for approval", submittedResult.ok, submittedResult.ok ? "" : submittedResult.error);
    ok(
      "  and still cannot be issued while it waits",
      !(await issueTradeDocument({ id: doc.data.id, generateEInvoice: false })).ok,
    );

    const selfApprove = await decideApproval({ id: doc.data.id, approved: true });
    ok(
      "an ordinary approver still cannot approve their own",
      // Matched on the message, not merely on failing: a scope refusal would otherwise pass this
      // assertion while the self-approval rule was missing entirely.
      !selfApprove.ok && /approve a document you submitted yourself/.test(selfApprove.error),
      selfApprove.ok ? "they approved their own" : selfApprove.error,
    );

    // ── Sending it back, and back again ──────────────────────────────────────────────────────────
    actorId = approver.id;
    const noReason = await decideApproval({ id: doc.data.id, approved: false });
    ok("sending it back without a reason is refused", !noReason.ok, noReason.ok ? "" : noReason.error);

    const sentBack = await decideApproval({ id: doc.data.id, approved: false, note: "Discount needs Finance first" });
    ok("an approver can send it back", sentBack.ok, sentBack.ok ? "" : sentBack.error);
    const afterReject = await db.tradeDocument.findUnique({
      where: { id: doc.data.id },
      select: { approvalStatus: true, approvalNote: true, status: true },
    });
    ok("  it is marked as sent back", afterReject?.approvalStatus === "REJECTED", afterReject?.approvalStatus);
    ok("  with the reason kept", afterReject?.approvalNote === "Discount needs Finance first", afterReject?.approvalNote);
    ok(
      "  and it is still a draft, so it can be fixed",
      afterReject?.status === "DRAFT",
      "that is the point of sending it back rather than cancelling it",
    );

    actorId = raiser.id;
    ok("it can be submitted again", (await submitForApproval({ id: doc.data.id })).ok);

    actorId = approver.id;
    const approved = await decideApproval({ id: doc.data.id, approved: true, note: "Fine at this price" });
    ok("an approver can approve it", approved.ok, approved.ok ? "" : approved.error);
    ok(
      "  recorded against the person who approved",
      (await db.tradeDocument.findUnique({ where: { id: doc.data.id }, select: { approvedById: true } }))?.approvedById === approver.id,
    );

    // ── The rule that makes approval mean something ──────────────────────────────────────────────
    actorId = raiser.id;
    const { updateTradeDocument } = await import("../src/actions/trade-document");
    const edited = await updateTradeDocument({
      ...payload,
      id: doc.data.id,
      lines: [{ ...payload.lines[0], unitPrice: 1000000 }],
    });
    ok("the raiser edits the approved proposal", edited.ok, edited.ok ? "" : edited.error);
    const afterEdit = await db.tradeDocument.findUnique({
      where: { id: doc.data.id },
      select: { approvalStatus: true, approvedById: true, approvalNote: true },
    });
    ok(
      "editing it withdraws the approval",
      afterEdit?.approvalStatus === "NOT_SUBMITTED",
      `${afterEdit?.approvalStatus} — the approved document and this one are not the same document`,
    );
    ok(
      "  and the approver's name goes with it",
      afterEdit?.approvedById === null && afterEdit?.approvalNote === null,
      "leaving it would show somebody against a figure they never saw",
    );
    ok(
      "  so it cannot be issued at the new price",
      !(await issueTradeDocument({ id: doc.data.id, generateEInvoice: false })).ok,
      "this is the whole point: the ₹10,00,000 version needs approving on its own",
    );

    /**
     * ── The watermark on the PDF ────────────────────────────────────────────────────────────────
     *
     * The saved PDF is where the real risk is: somebody previews an unapproved quotation, saves it
     * and emails it, and the customer holds a price nobody signed off. So the page is rendered for
     * real at each state and the mark is read back out of the HTML.
     */
    section("The watermark on the printed copy");

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const PrintPage = (await import("../src/app/(print)/documents/[id]/print/page")).default;
    const printed = async (docId: string) =>
      renderToStaticMarkup(
        (await PrintPage({ params: Promise.resolve({ id: docId }), searchParams: Promise.resolve({}) })) as never,
      );

    const setState = (state: "NOT_SUBMITTED" | "PENDING" | "APPROVED" | "REJECTED") =>
      db.tradeDocument.update({ where: { id: doc.data.id }, data: { approvalStatus: state } });

    await setState("NOT_SUBMITTED");
    const unsubmittedPdf = await printed(doc.data.id);
    ok("an unapproved document is watermarked", /Yet to be Approved/i.test(unsubmittedPdf));

    await setState("PENDING");
    ok("one awaiting approval is watermarked too", /Yet to be Approved/i.test(await printed(doc.data.id)));

    await setState("REJECTED");
    const rejectedPdf = await printed(doc.data.id);
    ok("a rejected one says so instead", /Not Approved/i.test(rejectedPdf) && !/Yet to be/i.test(rejectedPdf));

    await setState("APPROVED");
    const approvedPdf = await printed(doc.data.id);
    ok(
      "an approved one carries no watermark",
      !/Yet to be Approved|Not Approved/i.test(approvedPdf),
      "the mark is about sign-off, not decoration",
    );
    ok(
      "  and the document itself still prints",
      approvedPdf.includes("Larkspur"),
      `${approvedPdf.length} bytes`,
    );
    ok(
      "the watermark survives printing",
      !/print:hidden[^"]*"[^>]*>s*(Yet to be|Not Approved)/i.test(unsubmittedPdf) &&
        /print-color-adjust|printColorAdjust|WebkitPrintColorAdjust/i.test(unsubmittedPdf),
      "browsers drop faint colour when printing unless told not to, and the paper is the whole point",
    );

    // ── The banner ───────────────────────────────────────────────────────────────────────────────
    section("The banner on the document");

    const { DocumentApprovalBar } = await import("../src/components/documents/document-approval-bar");
    const banner = (over: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(DocumentApprovalBar, {
          id: doc.data.id,
          status: "PENDING",
          submittedBy: "Manit Devra",
          submittedAt: new Date(),
          approvedBy: null,
          approvedAt: null,
          note: null,
          mayApprove: false,
          maySubmit: false,
          ...over,
        } as never),
      );

    const pendingBanner = banner({ mayApprove: true });
    ok("a pending document offers Approve and Reject", /Approve/.test(pendingBanner) && /Reject/.test(pendingBanner));
    ok(
      "  and tells a non-approver who it is waiting on",
      /Manit Devra/.test(banner({ mayApprove: false })),
      "so somebody who cannot act knows who can",
    );
    const rejectedBanner = banner({ status: "REJECTED", note: "Discount needs Finance first", approvedBy: "Priya" });
    ok("a rejected document shows the reason", /Discount needs Finance first/.test(rejectedBanner));
    ok("  and who rejected it", /Priya/.test(rejectedBanner));
    ok(
      "an approved one says editing will undo it",
      /send it back for approval|Editing it will send it back/i.test(
        banner({ status: "APPROVED", approvedBy: "Priya", approvedAt: new Date() }),
      ),
      "the rule is surprising unless it is stated where it applies",
    );

    // ── Both list shapes ─────────────────────────────────────────────────────────
    //
    // The banner on the open document is no use to somebody scanning a list of forty. Both the
    // table and the narrow split list have to say which ones are stuck, and neither should say
    // anything at all where the type does not need approving.
    section("The approval state in the list");

    const { DocumentRows } = await import("../src/components/documents/document-rows");
    const { DocumentSplitList } = await import("../src/components/documents/document-split-list");

    const listRow = {
      id: doc.data.id,
      docNumber: "QT/2026-27/0001",
      status: "DRAFT" as const,
      issueDate: new Date(),
      total: 59000,
      currency: "INR",
      reference: null,
      einvoiceStatus: "NOT_APPLICABLE" as const,
      irn: null,
      company: { id: company.id, name: "Larkspur Media", relationshipType: "CLIENT" as const },
      createdBy: { name: "Probe" },
      salesperson: null,
    };

    const table = (over: Record<string, unknown>, enabled = true) =>
      renderToStaticMarkup(
        createElement(DocumentRows, {
          docType: "PROPOSAL" as const,
          documents: [{ ...listRow, ...over }],
          eInvoiced: false,
          approvalEnabled: enabled,
        } as never),
      );
    const split = (over: Record<string, unknown>, enabled = true) =>
      renderToStaticMarkup(
        createElement(DocumentSplitList, {
          documents: [{ ...listRow, ...over }],
          selectedId: null,
          approvalEnabled: enabled,
        } as never),
      );

    for (const [view, render] of [["table", table], ["split list", split]] as const) {
      ok(
        `the ${view} shows a pending document as pending`,
        /Pending approval/.test(render({ approvalStatus: "PENDING" })),
      );
      ok(
        `  and a rejected one as rejected`,
        /Rejected/.test(render({ approvalStatus: "REJECTED" })),
      );
      ok(
        `  says nothing about one already approved`,
        !/Pending approval|Not submitted/.test(render({ approvalStatus: "APPROVED" })),
        "a document that cleared sign-off is simply a document again",
      );
      ok(
        `  and nothing at all when the type needs no approval`,
        !/Pending approval|Not submitted|Rejected/.test(render({ approvalStatus: "PENDING" }, false)),
        "otherwise every draft in the system carries a badge that means nothing",
      );
    }
    // Put it back so the rest of the suite reads the state it expects.
    await setState("APPROVED");

    // ── With approval off, nothing is in the way ─────────────────────────────────────────────────
    actorId = admin.id;
    await saveApprovalPolicy({ docType: "PROPOSAL", enabled: false, approverRoles: [], approverUserIds: [], managerApproves: false });
    /**
     * With the policy off, an unsigned document carries no mark at all.
     *
     * The assertion that stops the watermark becoming wallpaper: marking every draft in the system
     * would train people to ignore it, and then it says nothing on the one that matters.
     */
    await db.tradeDocument.update({ where: { id: doc.data.id }, data: { approvalStatus: "NOT_SUBMITTED" } });
    ok(
      "no watermark on a type that doesn't need approval",
      !/Yet to be Approved|Not Approved/i.test(await printed(doc.data.id)),
      "an unsigned document, but nothing asked for a signature",
    );
    await db.tradeDocument.update({ where: { id: doc.data.id }, data: { approvalStatus: "APPROVED" } });

    const freeIssue = await issueTradeDocument({ id: doc.data.id, generateEInvoice: false });
    ok(
      "switching approval off lets it be issued again",
      freeIssue.ok,
      freeIssue.ok ? "" : freeIssue.error,
    );

    // ── Thresholds, through the real actions ─────────────────────────────────────────────────────
    section("Approval only above a value, or past a discount — end to end");

    actorId = admin.id;
    const badValue = await saveApprovalPolicy({ docType: "PROPOSAL", enabled: true, approverRoles: ["ACCOUNTS"], approverUserIds: [], managerApproves: false, minValue: -1 });
    const badDiscount = await saveApprovalPolicy({ docType: "PROPOSAL", enabled: true, approverRoles: ["ACCOUNTS"], approverUserIds: [], managerApproves: false, maxDiscountPercent: 150 });
    ok("a negative value limit, or a discount limit over 100%, is refused", !badValue.ok && !badDiscount.ok);
    const withLimits = await saveApprovalPolicy({
      docType: "PROPOSAL", enabled: true, approverRoles: ["ACCOUNTS"], approverUserIds: [], managerApproves: false,
      minValue: 100_000, maxDiscountPercent: 10,
    });
    const storedLimits = await db.documentApprovalPolicy.findUnique({ where: { docType: "PROPOSAL" }, select: { minValue: true, maxDiscountPercent: true } });
    ok("proposals are set to need approval above ₹1,00,000, or past a 10% discount", withLimits.ok && Number(storedLimits?.minValue) === 100_000 && Number(storedLimits?.maxDiscountPercent) === 10);

    actorId = raiser.id;
    const raise = async (unitPrice: number, discountValue = 0) => {
      const made = await createTradeDocument({ ...payload, lines: [{ ...payload.lines[0], unitPrice, discountValue }] });
      if (!made.ok) throw new Error(`could not raise a proposal: ${made.error}`);
      created.documents.push(made.data.id);
      return made.data.id;
    };
    const { approvalContext } = await import("../src/actions/document-approval");

    // ₹50,000 + 18% GST = ₹59,000, well under the limit.
    const small = await raise(50_000);
    const smallContext = await approvalContext(small);
    ok("a ₹59,000 proposal doesn't need approval, and the screen says why", smallContext?.required === false && /No approval needed/.test(smallContext.why), smallContext?.why);
    ok("  there is nothing to submit", !(await submitForApproval({ id: small })).ok);
    ok("  and no watermark on its printed copy", !/Yet to be Approved|Not Approved/i.test(await printed(small)));
    const smallIssued = await issueTradeDocument({ id: small, generateEInvoice: false });
    ok("  it is issued straight away", smallIssued.ok, smallIssued.ok ? "" : smallIssued.error);
    const smallAudit = await db.auditLog.findFirst({ where: { entityId: small, entityLabel: { startsWith: "Issued" } }, select: { entityLabel: true } });
    ok("  and the log says it went through under the limits", !!smallAudit?.entityLabel.includes("under the approval limits"), smallAudit?.entityLabel);

    // ₹1,00,000 + 18% = ₹1,18,000, over it.
    const large = await raise(100_000);
    ok("a ₹1,18,000 proposal needs it", (await approvalContext(large))?.required === true);
    ok("  and can't be issued without it", !(await issueTradeDocument({ id: large, generateEInvoice: false })).ok);
    ok("  and its printed copy is watermarked", /Yet to be Approved/i.test(await printed(large)));

    // ₹50,000 less 15% — small, but given away.
    const discounted = await raise(50_000, 15);
    const discountedContext = await approvalContext(discounted);
    ok("a small proposal discounted 15% needs it", discountedContext?.required === true && /discounted 15%/.test(discountedContext.why), discountedContext?.why);
    ok("  and can be submitted for it", (await submitForApproval({ id: discounted })).ok);

    // The dodge: raised small, edited up past the limit, issued on the old footing.
    const creeping = await raise(50_000);
    const grown = await updateTradeDocument({ ...payload, id: creeping, lines: [{ ...payload.lines[0], unitPrice: 200_000 }] });
    ok("a small proposal edited up past the limit", grown.ok, grown.ok ? "" : grown.error);
    ok("  can't then be issued without approval", !(await issueTradeDocument({ id: creeping, generateEInvoice: false })).ok);

    // A foreign-currency quote is weighed in rupees: 59,000 at 2 rupees to the unit is ₹1,18,000.
    const foreign = await raise(50_000);
    await db.tradeDocument.update({ where: { id: foreign }, data: { currency: "USD", exchangeRate: 2 } });
    ok("a foreign-currency proposal is measured in rupees, not its own currency", (await approvalContext(foreign))?.required === true);

    // The list: the badge only where sign-off is actually wanted.
    const rowFor = (id: string) => ({ ...listRow, id, approvalStatus: "NOT_SUBMITTED" });
    const listed = renderToStaticMarkup(
      createElement(DocumentRows, {
        docType: "PROPOSAL" as const,
        documents: [rowFor(large)],
        eInvoiced: false,
        approvalEnabled: true,
        approvalRequiredIds: [],
      } as never),
    );
    ok("the list leaves the badge off a document under the limits", !/Not submitted/.test(listed));
  } finally {
    // The policy is shared state, not fixture — put it back exactly as it was found.
    if (hadPolicy) {
      await db.documentApprovalPolicy.update({ where: { docType: "PROPOSAL" }, data: hadPolicy as never }).catch(() => {});
    } else {
      await db.documentApprovalPolicy.delete({ where: { docType: "PROPOSAL" } }).catch(() => {});
    }

    /**
     * The notifications this raised on real accounts.
     *
     * Submitting fans out to everyone holding the approving role, which in this database is eight
     * actual people — so the probe leaves unread items on colleagues' bells unless they are cleared.
     * Matched on the link, which carries the probe document's id and so cannot catch anything real.
     */
    for (const id of created.documents) {
      await db.notification.deleteMany({ where: { link: `/documents/${id}` } }).catch(() => {});
    }

    for (const id of created.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    for (const id of created.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of created.items) await db.item.delete({ where: { id } }).catch(() => {});
    for (const id of created.users) {
      await db.notification.deleteMany({ where: { userId: id } }).catch(() => {});
      await db.auditLog.deleteMany({ where: { userId: id } }).catch(() => {});
      await db.user.delete({ where: { id } }).catch(() => {});
    }

    const strayNotifications = created.documents.length
      ? await db.notification.count({ where: { link: { in: created.documents.map((id) => `/documents/${id}`) } } })
      : 0;
    ok(
      "no notifications left on real accounts",
      strayNotifications === 0,
      `${strayNotifications} left — submitting fans out to everyone holding the approving role, who are real people here`,
    );

    const leftoverUsers = await db.user.count({ where: { name: { startsWith: TAG } } });
    const leftoverCompanies = await db.company.count({ where: { name: { startsWith: TAG } } });
    ok(
      "the fixture cleaned up after itself",
      leftoverUsers === 0 && leftoverCompanies === 0,
      `${leftoverUsers} users, ${leftoverCompanies} companies left behind`,
    );
    ok(
      "  and the proposal policy is back as it was found",
      (await db.documentApprovalPolicy.findUnique({ where: { docType: "PROPOSAL" }, select: { enabled: true } }))?.enabled ===
        (hadPolicy?.enabled ?? undefined),
      "this suite writes to shared settings, so it has to put them back",
    );
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll document approval checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
