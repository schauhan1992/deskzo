/**
 * The renewal Stage column, and the one-click renewal proposal that feeds it.
 *
 * Two things are being checked, and they are connected: the proposal button writes the link that
 * makes the stage say "Quoted", so a change to either one silently breaks the other.
 *
 * ## What is easy to get wrong here
 *
 *   · **The quantity and the price.** A renewal covers the parent *and* everything co-terminating
 *     with it, priced at the full-term figure — never the pro-rated one a mid-term addition was
 *     charged. Quoting ten seats at a part-term price for a twenty-seat renewal is silent, in the
 *     customer's favour, and nothing else notices.
 *   · **A pinned stage outliving the facts.** Somebody marks a renewal Lost, a colleague punches it
 *     a week later, and the column still says Lost. That is the column telling a plain lie about a
 *     live order.
 *
 * The pure half runs with no database at all. The rest goes through the real actions with a
 * substituted session, against its own ZZPROBE fixture, removed in a finally.
 *
 *   npm run check:renewal-stage
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import {
  RENEWAL_STAGES,
  SETTABLE_RENEWAL_STAGES,
  deriveRenewalStage,
  resolveRenewalStage,
  type RenewalSignals,
} from "../src/lib/renewals";
import { partyDetails } from "../src/lib/proposals/party";

const TAG = "ZZPROBE_RENEWAL";

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
    // The table is a client component and calls `useRouter` at the top. Rendering it to HTML is how
    // the column and the button are checked, so the hook needs something to return.
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/renewals",
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

const none: RenewalSignals = { renewed: false, quoted: false, contacted: false, taskRaised: false };
const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

async function main() {
  // ── The pure half ────────────────────────────────────────────────────────────────────────────
  section("Working the stage out from what happened");

  ok("nothing yet reads as not started", deriveRenewalStage(none) === "NOT_STARTED");
  ok("a task raised is the first rung", deriveRenewalStage({ ...none, taskRaised: true }) === "TASK_RAISED");
  ok("a call logged beats a task", deriveRenewalStage({ ...none, taskRaised: true, contacted: true }) === "CONTACTED");
  ok(
    "a quote beats a call",
    deriveRenewalStage({ ...none, taskRaised: true, contacted: true, quoted: true }) === "QUOTED",
  );
  ok(
    "the renewal itself beats everything",
    deriveRenewalStage({ renewed: true, quoted: true, contacted: true, taskRaised: true }) === "RENEWED",
  );
  ok(
    "progress is a high-water mark, not a timeline",
    deriveRenewalStage({ ...none, quoted: true, contacted: true }) === "QUOTED",
    "a call logged after the quote went out must not put the renewal back to Contacted",
  );

  section("A stage somebody pinned");

  const pinned = resolveRenewalStage({ override: "NEGOTIATING", signals: { ...none, contacted: true } });
  ok("a pinned stage wins over the derived one", pinned.key === "NEGOTIATING", `${pinned.key} / ${pinned.source}`);
  ok("  and is reported as set by hand", pinned.source === "manual");

  const agreeing = resolveRenewalStage({ override: "QUOTED", signals: { ...none, quoted: true } });
  ok(
    "a pin that agrees with the evidence is reported as derived",
    agreeing.source === "auto",
    "it is doing no work, and calling it manual would credit a person with what the record says anyway",
  );

  const overtaken = resolveRenewalStage({ override: "LOST", signals: { ...none, renewed: true } });
  ok(
    "a pinned LOST does not survive the renewal being punched",
    overtaken.key === "RENEWED" && overtaken.source === "auto",
    `${overtaken.key} — an order existing is a fact; "Lost" is an opinion since overtaken`,
  );
  ok(
    "  and the screen is told the pin was overtaken",
    overtaken.supersededManual === "LOST",
    "said out loud rather than dropped, because the reader is rarely the person who typed it",
  );

  const cleared = resolveRenewalStage({ override: null, signals: { ...none, contacted: true } });
  ok("clearing the pin hands the row back to the evidence", cleared.key === "CONTACTED" && cleared.source === "auto");

  ok(
    "only the three that cannot be inferred are offered in the picker",
    SETTABLE_RENEWAL_STAGES.map((s) => s.key).join(",") === "NEGOTIATING,ON_HOLD,LOST",
    SETTABLE_RENEWAL_STAGES.map((s) => s.key).join(", "),
  );
  ok(
    "every stage the enum can hold has a label",
    RENEWAL_STAGES.length === 8 && RENEWAL_STAGES.every((s) => s.label.length > 0),
    `${RENEWAL_STAGES.length} stages`,
  );

  section("Deriving the party from the site");

  const noState = partyDetails(
    { id: "x", address: null, city: null, state: null, pincode: null, gstNumber: null, gstTreatment: "UNREGISTERED" },
    "Nowhere Ltd",
  );
  ok(
    "no state and no GSTIN is refused",
    !noState.ok,
    "a missing place of supply is treated as inter-state, so drafting anyway would quietly put IGST on a local sale",
  );
  const registeredNoGstin = partyDetails(
    { id: "x", address: null, city: null, state: "Karnataka", pincode: null, gstNumber: null, gstTreatment: "REGISTERED_REGULAR" },
    "Acme",
  );
  ok("registered with no GSTIN is refused", !registeredNoGstin.ok);
  const badPin = partyDetails(
    { id: "x", address: "1 Road", city: "Bengaluru", state: "Karnataka", pincode: "56", gstNumber: null, gstTreatment: "UNREGISTERED" },
    "Acme",
  );
  ok(
    "a malformed PIN is dropped rather than refused",
    badPin.ok && badPin.data.address.pincode === "" && badPin.data.placeOfSupplyCode === "29",
    "a proposal is never e-invoiced, so refusing to draft one over an address typo is the wrong trade",
  );

  // ── Against the database ─────────────────────────────────────────────────────────────────────
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const { createProposalFromRenewal } = await import("../src/actions/renewal-proposal");
  const { setRenewalStage } = await import("../src/actions/renewal-stage");
  const { listRenewalsPaged } = await import("../src/actions/renewal");

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const ANNUAL = 3955;
  const SEATS = 10;
  const ADDON_SEATS = 5;

  const created: { documents: string[]; orders: string[]; companies: string[]; items: string[]; calls: string[] } = {
    documents: [], orders: [], companies: [], items: [], calls: [],
  };

  try {
    section("A renewal quote, in one click");

    const item = await db.item.create({
      data: {
        name: `${TAG} Microsoft 365 Business Standard`,
        sku: `${TAG}-SKU`, type: "SUBSCRIPTION", hsnCode: "997331", unit: "Licence",
        billingCycle: "ANNUAL", sellingPrice: ANNUAL, taxRatePercent: 18, createdById: actorId,
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
    const locationId = company.locations[0]!.id;

    const order = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId, itemId: item.id, quantity: SEATS,
        startDate: start, endDate: end, unitPrice: ANNUAL, fullTermUnitPrice: ANNUAL,
        orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(order.id);

    /**
     * Seats added mid-term, at a pro-rated price.
     *
     * This is the case the whole thing turns on: `unitPrice` here is a part-year figure, and a
     * renewal quoted from it under-bills by the part of the year that had already gone.
     */
    const addon = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId, itemId: item.id, quantity: ADDON_SEATS,
        parentId: order.id, businessType: "ADDON",
        startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)), endDate: end,
        unitPrice: 1200, fullTermUnitPrice: ANNUAL,
        orderStatus: "FULFILLED", addedByUserId: actorId,
      },
      select: { id: true },
    });
    created.orders.push(addon.id);

    const made = await createProposalFromRenewal({ companyProductId: order.id });
    ok("the button drafts a renewal proposal", made.ok, made.ok ? made.data.docNumber : made.error);
    if (!made.ok) return;
    created.documents.push(made.data.id);

    const doc = await db.tradeDocument.findUnique({
      where: { id: made.data.id },
      select: {
        docType: true, status: true, validUntil: true, notes: true, subtotal: true,
        lines: { select: { quantity: true, unitPrice: true, companyProductId: true, description: true, hsnCode: true } },
      },
    });
    const line = doc!.lines[0]!;

    ok("  it is a DRAFT proposal", doc?.docType === "PROPOSAL" && doc?.status === "DRAFT", `${doc?.docType}/${doc?.status}`);
    ok(
      "  the quantity covers the addon as well as the parent",
      Number(line.quantity) === SEATS + ADDON_SEATS,
      `${Number(line.quantity)} — ${SEATS} + ${ADDON_SEATS} added mid-term; quoting ${SEATS} is the classic renewal error`,
    );
    ok(
      "  priced at the full-term figure, not the pro-rated one",
      Number(line.unitPrice) === ANNUAL,
      `${inr(Number(line.unitPrice))} vs the addon's part-term ${inr(1200)} — quoting the latter under-bills silently`,
    );
    ok(
      "  and the total is the whole group",
      Number(doc!.subtotal) === ANNUAL * (SEATS + ADDON_SEATS),
      `${inr(Number(doc!.subtotal))}`,
    );
    ok(
      "  the line points back at the subscription being renewed",
      line.companyProductId === order.id,
      "this link is the only thing that keeps the Stage column honest",
    );
    ok(
      "  the new term starts the day after the old one ends",
      /New term \d{4}-\d{2}-\d{2} to/.test(doc?.notes ?? ""),
      doc?.notes?.split("\n")[0]?.slice(0, 90),
    );
    ok(
      "  and it expires with the subscription it renews",
      doc?.validUntil?.toISOString().slice(0, 10) === end.toISOString().slice(0, 10),
      doc?.validUntil?.toISOString().slice(0, 10),
    );

    const onAddon = await createProposalFromRenewal({ companyProductId: addon.id });
    ok(
      "an addon cannot be quoted for renewal on its own",
      !onAddon.ok,
      onAddon.ok ? "it was drafted" : onAddon.error,
    );

    section("The stage the list shows");

    const stageOf = async (id: string) => {
      const page = await listRenewalsPaged({ page: 1, pageSize: 200 });
      const row = page.rows.find((r) => r.id === id);
      return row?.stage ?? null;
    };

    const quoted = await stageOf(order.id);
    ok("the list reports it as Quoted", quoted?.key === "QUOTED", `${quoted?.key} / ${quoted?.source}`);
    ok(
      "  and links to the document behind that",
      quoted?.quote?.docNumber === made.data.docNumber,
      quoted?.quote?.docNumber,
    );

    // ── A pin, and what happens to it ────────────────────────────────────────────────────────────
    const pinnedResult = await setRenewalStage({
      companyProductId: order.id,
      stage: "LOST",
      note: "Went to the incumbent on price",
    });
    ok("a stage can be pinned by hand", pinnedResult.ok, pinnedResult.ok ? "" : pinnedResult.error);

    const lost = await stageOf(order.id);
    ok("  the list shows the pinned stage over the derived one", lost?.key === "LOST", lost?.key);
    ok("  attributed to whoever set it", lost?.setBy?.id === actorId && lost?.source === "manual", lost?.setBy?.name);
    ok("  with the reason kept", lost?.note === "Went to the incumbent on price", lost?.note);

    const derivedPin = await setRenewalStage({ companyProductId: order.id, stage: "QUOTED" });
    ok(
      "a derived stage cannot be pinned by hand",
      !derivedPin.ok,
      derivedPin.ok ? "it was set" : derivedPin.error,
    );

    /**
     * The case the precedence rule exists for: the renewal is punched a week after somebody wrote
     * it off.
     */
    const renewal = await db.companyProduct.create({
      data: {
        companyId: company.id, locationId, itemId: item.id, quantity: SEATS + ADDON_SEATS,
        startDate: new Date(end.getTime() + 86400_000),
        endDate: new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() + 1, 1)),
        unitPrice: ANNUAL, fullTermUnitPrice: ANNUAL, businessType: "RENEWAL",
        orderStatus: "PENDING_APPROVAL", addedByUserId: actorId, renewedFromId: order.id,
      },
      select: { id: true },
    });
    created.orders.unshift(renewal.id);

    const afterRenewal = await stageOf(order.id);
    ok(
      "punching the renewal overrides a pinned LOST",
      afterRenewal?.key === "RENEWED" && afterRenewal?.source === "auto",
      `${afterRenewal?.key} — the column must not say Lost beside a live renewal order`,
    );
    ok(
      "  and the overtaken pin is still reported",
      afterRenewal?.supersededManual === "LOST",
      "so the discrepancy is explained rather than silently contradicting whoever set it",
    );

    const quoteAfterRenewal = await createProposalFromRenewal({ companyProductId: order.id });
    ok(
      "a renewed subscription cannot be quoted again",
      !quoteAfterRenewal.ok,
      quoteAfterRenewal.ok ? "it was drafted" : quoteAfterRenewal.error,
    );

    /**
     * ── What the screen actually renders ────────────────────────────────────────────────────────
     *
     * The logic above is only worth having if the column and the button reach the page. Rendered
     * for real rather than reasoned about — the server component is an ordinary function, and this
     * is the only way to find out that a column somebody added to the registry is also in the table.
     */
    section("The column and the button on the page");

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { RenewalsTable } = await import("../src/components/renewals/renewals-table");

    const row = (await listRenewalsPaged({ page: 1, pageSize: 200 })).rows.find((r) => r.id === order.id)!;
    const markup = (over: Record<string, unknown> = {}) =>
      renderToStaticMarkup(
        createElement(RenewalsTable, {
          renewals: [{ ...row, ...over }] as never,
          users: [],
          canSetStage: true,
        }),
      );

    // By this point the fixture has been renewed, so this row is the "already punched" case.
    const html = markup();
    ok("the table has a Stage column", />Stage</.test(html), "added to the registry and to the table");
    ok("  showing the stage for the row", html.includes("Renewed"), "this row has been renewed by now");

    const notRenewed = markup({ renewedBy: null });
    ok(
      "a renewal not yet punched offers the proposal button",
      notRenewed.includes("Draft a renewal proposal"),
      "labelled, because it is icon-only",
    );
    ok(
      "  and one already punched does not",
      !html.includes("Draft a renewal proposal"),
      "quoting a renewal already punched would bill the same term twice",
    );

    /**
     * The "why" box has to be typeable.
     *
     * It shipped broken: the popover cancelled mousedown for everything in it, which is exactly how
     * a browser is told not to move focus, so the field could be clicked and never focused. Nothing
     * about the markup shows it — the input renders perfectly and simply does not work — so the rule
     * is asserted rather than looked at. Confirmed against a real browser with real clicks: blanket
     * cancelling gave focus "(none)" and typed "", the exemption gave focus on the field and "hello".
     */
    const { keepsFocusOnAnchor } = await import("../src/components/ui/anchored-popover");
    const target = (matchesField: boolean) =>
      ({ closest: (sel: string) => (matchesField && sel.includes("input") ? {} : null) }) as unknown as EventTarget;

    ok(
      "a popover lets a form field inside it take focus",
      keepsFocusOnAnchor(target(true)) === false,
      "otherwise the note box is clickable and untypeable",
    );
    ok(
      "  while everything else still keeps focus on the anchor",
      keepsFocusOnAnchor(target(false)) === true,
      "which is what stops the anchor's blur firing before an option click registers",
    );
    ok("  and a null target is treated as not-a-field", keepsFocusOnAnchor(null) === true);
    // Its own scrollbar is inside it too: a press there has the popover's box as its target, and an
    // outside-click check that missed it closed the panel as soon as anybody tried to scroll it.
    const { insideAnchoredPopover } = await import("../src/components/ui/anchored-popover");
    const box = { closest: (sel: string) => (sel === "[data-anchored-popover]" ? {} : null) } as unknown as EventTarget;
    ok("a press on a popover's own box — its scrollbar — counts as inside it", insideAnchoredPopover(box) && !insideAnchoredPopover(target(false)) && !insideAnchoredPopover(null));

    const readOnly = renderToStaticMarkup(
      createElement(RenewalsTable, { renewals: [row] as never, users: [], canSetStage: false }),
    );
    ok(
      "without permission the stage reads as information, not a control",
      !/aria-haspopup="menu"/.test(readOnly) && /aria-haspopup="menu"/.test(html),
      "a control that turns out not to work is worse than no control",
    );

    const cleared2 = await setRenewalStage({ companyProductId: order.id, stage: null });
    ok("the pin can be cleared", cleared2.ok, cleared2.ok ? "" : cleared2.error);
    const afterClear = await db.companyProduct.findUnique({
      where: { id: order.id },
      select: { renewalStage: true, renewalStageNote: true, renewalStageAt: true, renewalStageById: true },
    });
    ok(
      "  and the note and attribution go with it",
      afterClear?.renewalStage === null &&
        afterClear?.renewalStageNote === null &&
        afterClear?.renewalStageAt === null &&
        afterClear?.renewalStageById === null,
      "a reason left behind after the stage was cleared reads as though one were still set",
    );
  } finally {
    for (const id of created.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    for (const id of created.calls) await db.callLog.delete({ where: { id } }).catch(() => {});
    // Renewal first, then addon, then parent — each points at the one after it.
    for (const id of created.orders) await db.companyProduct.delete({ where: { id } }).catch(() => {});
    for (const id of created.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of created.items) await db.item.delete({ where: { id } }).catch(() => {});

    const leftover = await db.company.count({ where: { name: { startsWith: TAG } } });
    ok("the fixture cleaned up after itself", leftover === 0, `${leftover} companies left behind`);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll renewal stage checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
