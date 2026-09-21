/**
 * Whether the e-way bill rules are the rules.
 *
 * This is compliance, so "close enough" has a price list. The four things that go wrong:
 *
 *   · **No bill where one was needed.** Penalty of the tax due or ₹10,000, whichever is higher, and
 *     the goods and vehicle can be detained — so it lands on the customer's delivery too.
 *   · **A bill that expires mid-journey**, which in a roadside check is the same offence as having
 *     none. The arithmetic is a day per 200 km *or part thereof*, a day per **20** km for
 *     over-dimensional cargo, and the clock stops at midnight rather than 24 hours later.
 *   · **A threshold applied to the invoice instead of the consignment**, which misses every
 *     movement that is not a sale — the repair going out, the demo unit, the stock transfer.
 *   · **Cancelling after the window**, which the portal simply refuses.
 *
 *   · **A bill raised against the wrong thing.** The portal asks for a document type and number,
 *     and a roadside check compares the bill against the paper in the driver's hand — so the bill
 *     belongs to the document, not to our own idea of a consignment.
 *
 *   npm run check:eway
 *
 * Two halves. The first is pure — the rules, the payload, the mock provider, no database. The
 * second builds real documents and asks the real actions what they do with them, because the
 * expensive mistakes here live in the wiring rather than in the arithmetic: a list that calls a
 * document settled when its bill was cancelled, a Part B update accepted on a bill somebody else
 * raised, a save that quietly overwrites a bill already sitting at NIC.
 *
 * Everything is created under a reserved prefix and removed again, so it is safe to run against a
 * database with real data in it. Every count is asserted **relative to this suite's own fixture**,
 * never against the whole table.
 */
import {
  CANCELLATION_WINDOW_HOURS,
  KM_PER_DAY_ODC,
  KM_PER_DAY_REGULAR,
  THRESHOLD,
  endOfIndianDay,
  startOfIndianDay,
  ewayBillRequired,
  isValidAt,
  lastValidDay,
  missingForGeneration,
  normaliseVehicleNumber,
  standingOf,
  validityFor,
  withinCancellationWindow,
  type ConsignmentLike,
} from "../src/lib/eway/rules";
import { buildEwayPayload, portalDate, validateEwayPayload, type EwayDocument } from "../src/lib/eway/payload";
import { apportionLineValues, documentGoodsValue } from "../src/lib/eway/value";
import { deliveryStateCode } from "../src/lib/eway/documents";
import { subSupplyFor } from "../src/lib/eway/sub-supply";
import { createEwayProvider, parsePortalDate } from "../src/lib/eway/provider";
import Module from "node:module";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";

// ── Who the actions think is calling ──────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;

/**
 * The two module swaps, installed before `src/actions/eway.ts` is loaded for the first time.
 *
 * Matched on the resolved filename rather than on the text of the import, so it does not matter
 * whether a module reaches the session through `@/lib/session` or a relative path — both land on
 * the same file, and both get the stub. Loaded through `createRequire` rather than `import` for
 * the same reason check-notes does: an `import` is hoisted above this assignment and would get the
 * real session anyway.
 *
 * Everything that decides *behaviour* — the permission resolver, the rules, the provider — is still
 * the real code. Only "who is asking" is supplied.
 */
const load = Module.createRequire(__filename);
const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};

const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
]);

const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // Not resolvable from here, so it is certainly not one of ours — let the real loader raise it.
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const {
  associateEwayBill,
  cancelEwayBill,
  ewayDocuments,
  ewayForDocument,
  generateEwayBill,
  saveEwayDetails,
  updateEwayVehicle,
} = load("../src/actions/eway") as typeof import("../src/actions/eway");
const { listTransporters, saveTransporter, setTransporterActive } = load(
  "../src/actions/transporter",
) as typeof import("../src/actions/transporter");
const { lookupEwayBill } = load("../src/actions/eway") as typeof import("../src/actions/eway");
const { createConsignment, raiseDeliveryChallan } = load(
  "../src/actions/consignment",
) as typeof import("../src/actions/consignment");

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const consignment = (over: Partial<ConsignmentLike> = {}): ConsignmentLike => ({
  declaredValue: 80000,
  interstate: true,
  distanceKm: 350,
  vehicleType: "REGULAR",
  vehicleNumber: "MH12AB1234",
  ...over,
});

async function main() {
  section("When a bill is needed");

  ok("over the threshold, inter-state", ewayBillRequired(consignment()).required);
  ok("well under it, not", !ewayBillRequired(consignment({ declaredValue: 12000 })).required);

  /**
   * The boundary, and it is "exceeding fifty thousand" — so exactly ₹50,000 does not need one and
   * one rupee more does. Off by one here is off by one in both directions on every consignment
   * priced at a round number, which is most of them.
   */
  ok("exactly at the threshold is below it", !ewayBillRequired(consignment({ declaredValue: THRESHOLD })).required, THRESHOLD);
  ok("a rupee over is above it", ewayBillRequired(consignment({ declaredValue: THRESHOLD + 1 })).required);

  {
    /**
     * The rule most often got wrong: the threshold is on the *consignment*, not on a sale. A laptop
     * going out for repair has no invoice at all and still needs a bill.
     */
    const repair = consignment({ reason: "REPAIR_OUT", declaredValue: 95000 });
    ok("a repair going out with no sale still needs one", ewayBillRequired(repair).required, ewayBillRequired(repair).because);
  }

  {
    const unknown = ewayBillRequired(consignment({ declaredValue: null }));
    // Unknown, not "no". A missing value is the commonest reason a bill never gets raised.
    ok("an undeclared value is not treated as under the threshold", !unknown.required && /declared/.test(unknown.because), unknown.because);
  }

  {
    // Several states set a higher floor for movement inside the state; none may lower the central
    // rule for movement across one.
    const intra = consignment({ interstate: false, declaredValue: 75000 });
    ok("a state's higher intra-state floor is honoured", !ewayBillRequired(intra, { intraStateThreshold: 100000 }).required);
    ok("  and the same value inter-state still needs one", ewayBillRequired(consignment({ declaredValue: 75000 }), { intraStateThreshold: 100000 }).required);
    ok("  with no state floor given, the central one applies", ewayBillRequired(intra).required);
  }

  {
    /**
     * Rule 138(1), first proviso: goods sent by a principal in one State to a job worker in another
     * need a bill **irrespective of value**. The threshold does not apply at all, which is why a
     * single switch going to Gujarat for repair — a few thousand rupees — was silently reported as
     * "not needed" everywhere in the app.
     */
    const tiny = consignment({ reason: "REPAIR_OUT", declaredValue: 4000, interstate: true });
    ok("inter-state job work needs one at any value", ewayBillRequired(tiny).required, ewayBillRequired(tiny).because);
    ok("  and says why, without mentioning a threshold", /irrespective|whatever/i.test(ewayBillRequired(tiny).because));

    const back = consignment({ reason: "REPAIR_RETURN", declaredValue: 4000, interstate: true });
    ok("  the return leg is the same rule", ewayBillRequired(back).required);

    // Not a licence to ignore the threshold everywhere: within the state the ordinary floor governs.
    const local = consignment({ reason: "REPAIR_OUT", declaredValue: 4000, interstate: false });
    ok("  intra-state job work under the floor does not", !ewayBillRequired(local).required);

    // And a high state floor cannot suppress the inter-state rule, which is central.
    ok(
      "  a raised intra-state floor cannot suppress it",
      ewayBillRequired(tiny, { intraStateThreshold: 100000 }).required,
    );

    // A sale of the same value is genuinely under the threshold — the reason is doing the work.
    ok("  while a sale of the same value is not", !ewayBillRequired(consignment({ declaredValue: 4000 })).required);
  }

  ok("every answer explains itself", [
    ewayBillRequired(consignment()),
    ewayBillRequired(consignment({ declaredValue: 100 })),
    ewayBillRequired(consignment({ declaredValue: null })),
  ].every((r) => r.because.length > 10));

  section("How long it lasts");

  const at = (iso: string) => new Date(iso);

  /**
   * An IST wall-clock time, as an instant.
   *
   * Written out with the offset so these assertions mean the same thing on a laptop in Pune and in
   * a container set to UTC. `new Date(2026, 8, 21, 23, 59)` means neither — it means whatever the
   * host says, which is how a whole block of this suite came to pass while the code under it put
   * midnight at half past five in the morning.
   */
  const ist = (wallClock: string) => new Date(`${wallClock}:00+05:30`);

  /** Whether an instant is exactly midnight in India — 18:30 UTC the evening before. */
  const isIstMidnight = (d: Date) => (d.getTime() + 5.5 * 3600_000) % 86_400_000 === 0;

  {
    // 350 km is two days: one per 200 "or part thereof".
    const v = validityFor(at("2026-09-21T09:00:00"), 350);
    ok("a day per 200 km, rounding up", v.days === 2, v.days);
    // An IST midnight is 18:30 UTC the evening before, so this is the host-independent way to say
    // "it lands on a midnight" — `getHours() === 0` says it lands on the *host's* midnight.
    ok("  and it ends at an Indian midnight, not 48 hours later", isIstMidnight(v.validUntil), v.validUntil.toISOString());
  }

  ok("exactly 200 km is one day", validityFor(at("2026-09-21T09:00:00"), KM_PER_DAY_REGULAR).days === 1);
  ok("  201 km is two", validityFor(at("2026-09-21T09:00:00"), KM_PER_DAY_REGULAR + 1).days === 2);
  ok("  1 km is still one day, never zero", validityFor(at("2026-09-21T09:00:00"), 1).days === 1);
  ok("  and an unknown distance gets the minimum rather than nothing", validityFor(at("2026-09-21T09:00:00"), null).days === 1);

  {
    /**
     * The multiplier that bites. The same 300 km trip is two days in a lorry and fifteen on an
     * over-dimensional trailer, and a system that used 200 for both would issue bills expiring
     * thirteen days early.
     */
    const regular = validityFor(at("2026-09-21T09:00:00"), 300, "REGULAR");
    const odc = validityFor(at("2026-09-21T09:00:00"), 300, "OVER_DIMENSIONAL_CARGO");
    ok("over-dimensional cargo gets a day per 20 km", odc.days === 15, odc.days);
    ok("  against two days for the same trip in a lorry", regular.days === 2, regular.days);
    ok("  and exactly 20 km is one day", validityFor(at("2026-09-21T09:00:00"), KM_PER_DAY_ODC, "OVER_DIMENSIONAL_CARGO").days === 1);
  }

  {
    /**
     * The one that catches people out — in the other direction from how this suite first read it.
     *
     * Validity ends at a midnight rather than 24 hours after issue, which is true, and from that it
     * is tempting to conclude that a bill raised at 11pm dies an hour later. It does not: Rule
     * 138(10) counts one day as expiring at the midnight of the day **following** generation, so an
     * 11pm bill on the 21st runs to the end of the 22nd. Asserting the tempting version is what kept
     * the off-by-one in the code — the check agreed with the bug.
     */
    const issued = ist("2026-09-21T23:00");
    const late = validityFor(issued, 150);
    ok("a bill raised at 11pm IST runs to the end of the next day", late.validUntil.getTime() === ist("2026-09-23T00:00").getTime(), late.validUntil.toISOString());
    ok("  which is 25 hours, not one", late.validUntil.getTime() - issued.getTime() === 25 * 3600000);
    ok("  and it is still good at nine the next morning", isValidAt(late.validUntil, ist("2026-09-22T09:00")));
  }

  section("Whether it is still good");

  ok("valid before the expiry", isValidAt(at("2026-09-23T00:00:00"), at("2026-09-22T18:00:00")));
  ok("not valid after it", !isValidAt(at("2026-09-23T00:00:00"), at("2026-09-23T01:00:00")));
  // At the moment itself it has expired: validity is "until", not "through".
  ok("not valid at the exact moment of expiry", !isValidAt(at("2026-09-23T00:00:00"), at("2026-09-23T00:00:00")));
  ok("no expiry recorded is not valid", !isValidAt(null, at("2026-09-22T00:00:00")));

  section("Cancelling");

  const made = at("2026-09-21T10:00:00");
  ok("within the window", withinCancellationWindow(made, at("2026-09-21T20:00:00")));
  ok("  right up to the last minute", withinCancellationWindow(made, at("2026-09-22T09:59:00")));
  ok("  and not a minute past", !withinCancellationWindow(made, at("2026-09-22T10:01:00")), `${CANCELLATION_WINDOW_HOURS}h`);
  ok("never generated, never cancellable", !withinCancellationWindow(null, at("2026-09-21T11:00:00")));

  section("What has to be filled in first");

  ok("a complete consignment is ready", missingForGeneration(consignment()).length === 0, missingForGeneration(consignment()).join(", "));
  ok("a missing value is named", missingForGeneration(consignment({ declaredValue: null })).some((m) => /value/.test(m)));
  ok("a missing distance is named", missingForGeneration(consignment({ distanceKm: null })).some((m) => /kilometre/.test(m)));

  {
    /**
     * Either a vehicle or a transporter, not both. The bill is routinely raised in the morning and
     * the lorry assigned at four, so demanding a vehicle number would block the ordinary case.
     */
    const noVehicle = consignment({ vehicleNumber: null, transporterId: "27AAAAA0000A1Z5" });
    ok("a transporter id is enough without a vehicle", missingForGeneration(noVehicle).length === 0, missingForGeneration(noVehicle).join(", "));
    const neither = consignment({ vehicleNumber: null, transporterId: null });
    ok("  but neither is not", missingForGeneration(neither).some((m) => /transporter/.test(m)));
  }

  ok("everything missing at once is reported at once", missingForGeneration({ declaredValue: null, interstate: true }).length === 3);

  section("Vehicle numbers");

  ok("spaces and dashes come out", normaliseVehicleNumber("MH 12 AB 1234") === "MH12AB1234");
  ok("lowercase is raised", normaliseVehicleNumber("mh12ab1234") === "MH12AB1234");
  ok("something too short is refused rather than passed on", normaliseVehicleNumber("MH12") === null);
  ok("empty is null", normaliseVehicleNumber("") === null && normaliseVehicleNumber(null) === null);

  section("What somebody should do about it");

  const now = at("2026-09-22T12:00:00");
  const standing = (over: Parameters<typeof standingOf>[0]) => standingOf(over, now);

  {
    const s = standing({ ...consignment(), status: "DRAFT" });
    ok("needed and still in draft is work to do", s.headline === "Needed" && s.tone === "warn", `${s.headline}/${s.tone}`);
  }
  {
    /**
     * The state this whole module exists to surface: goods already on the road without a bill. It
     * must not read the same as "needed, still in draft" — one is a task, the other is a lorry that
     * should not have left.
     */
    const s = standing({ ...consignment(), status: "IN_TRANSIT" });
    ok("needed and already moving is an emergency", s.tone === "danger", s.tone);
    ok("  and says so in words", /already left/.test(s.detail), s.detail);
  }
  {
    const s = standing({
      ...consignment(),
      status: "IN_TRANSIT",
      ewayBillNumber: "381234567890",
      ewayBillValidUntil: at("2026-09-25T00:00:00"),
    });
    ok("a live bill is fine", s.tone === "ok" && s.headline === "Valid", `${s.headline}/${s.tone}`);
  }
  {
    const s = standing({
      ...consignment(),
      status: "IN_TRANSIT",
      ewayBillNumber: "381234567890",
      ewayBillValidUntil: at("2026-09-21T00:00:00"),
    });
    ok("an expired bill on a moving lorry is an emergency", s.tone === "danger" && s.headline === "Expired", `${s.headline}/${s.tone}`);
    // Worth saying out loud, because a number on the screen reads as being covered.
    ok("  and says it counts the same as having none", /same as not having one/.test(s.detail), s.detail);
  }
  {
    const s = standing({ ...consignment(), status: "DRAFT", ewayBillStatus: "CANCELLED", ewayBillNumber: "381234567890" });
    ok("a cancelled bill does not read as valid", s.headline === "Cancelled", s.headline);
  }
  {
    const s = standing({ ...consignment({ declaredValue: 20000 }), status: "DRAFT" });
    ok("under the threshold is quiet, not green", s.tone === "muted" && s.headline === "Not needed", `${s.headline}/${s.tone}`);
  }

  section("The payload the portal wants");

  const document = (over: Partial<EwayDocument> = {}): EwayDocument => ({
    supplyType: "OUTWARD",
    subSupplyType: "SUPPLY",
    documentType: "INVOICE",
    documentNumber: "INV/26-27/0119",
    documentDate: at("2026-09-21T00:00:00"),
    from: { gstin: "27AAAAA0000A1Z5", tradeName: "Wroffy", address1: "1 Road", place: "Mumbai", pincode: "400001", stateCode: "27" },
    to: { gstin: "29BBBBB1111B1Z5", tradeName: "Acme", address1: "2 Street", place: "Bengaluru", pincode: "560001", stateCode: "29" },
    items: [{ productName: "Laptop", hsnCode: "84713010", quantity: 2, unit: "NOS", taxableValue: 80000 }],
    totalValue: 80000,
    totalInvoiceValue: 94400,
    transportMode: "ROAD",
    distanceKm: 980,
    vehicleNumber: "MH12AB1234",
    vehicleType: "REGULAR",
    ...over,
  });

  {
    const payload = buildEwayPayload(document());
    // Almost every field is a number standing for a word. Getting one wrong is a rejection with a
    // code, so each is asserted rather than trusted.
    ok("outward is O", payload.supplyType === "O", payload.supplyType);
    ok("a supply is sub-type 1", payload.subSupplyType === "1", payload.subSupplyType);
    ok("an invoice is INV", payload.docType === "INV", payload.docType);
    ok("road is mode 1", payload.transMode === "1", payload.transMode);
    ok("a regular vehicle is R", payload.vehicleType === "R", payload.vehicleType);
    ok("distance goes as a string", payload.transDistance === "980", payload.transDistance);
  }

  ok("a challan is CHL, not INV", buildEwayPayload(document({ documentType: "CHALLAN" })).docType === "CHL");
  ok("job work is sub-type 4", buildEwayPayload(document({ subSupplyType: "JOB_WORK" })).subSupplyType === "4");
  ok("over-dimensional cargo is O", buildEwayPayload(document({ vehicleType: "OVER_DIMENSIONAL_CARGO" })).vehicleType === "O");
  ok("rail is 2, air 3, ship 4", ["RAIL", "AIR", "SHIP"].map((m) => buildEwayPayload(document({ transportMode: m as EwayDocument["transportMode"] })).transMode).join(",") === "2,3,4");

  // dd/mm/yyyy — not the format anything else in this app uses, and not one Date produces.
  ok("dates go as dd/mm/yyyy", portalDate(at("2026-09-07T00:00:00")) === "07/09/2026", portalDate(at("2026-09-07T00:00:00")));

  {
    // "URP" — unregistered person — rather than a blank, which the portal rejects.
    const payload = buildEwayPayload(document({ to: { ...document().to, gstin: null } }));
    ok("an unregistered buyer goes as URP, not blank", payload.toGstin === "URP", payload.toGstin);
  }

  section("What the portal would refuse, said first");

  ok("a complete document has no problems", validateEwayPayload(document()).length === 0, validateEwayPayload(document()).join(" "));

  {
    const bad = validateEwayPayload(
      document({
        to: { ...document().to, pincode: "56001", stateCode: "abc", tradeName: "" },
        items: [{ productName: "Laptop", hsnCode: "84", quantity: 0, unit: "NOS", taxableValue: 1 }],
        distanceKm: 0,
        vehicleNumber: null,
        transporterId: null,
      }),
    );
    // Reported together: the portal returns these one at a time as codes, and each is something a
    // person has to go and find out.
    ok("every problem is reported at once", bad.length >= 6, bad.length);
    ok("  a short pincode is named", bad.some((b) => /pincode/.test(b)), bad.join(" "));
    ok("  a bad state code is named", bad.some((b) => /state code/.test(b)));
    ok("  a stub HSN is named", bad.some((b) => /HSN/.test(b)));
    ok("  a zero quantity is named", bad.some((b) => /quantity/.test(b)));
    ok("  and each is a sentence, not a code", bad.every((b) => b.length > 15 && /[.]$/.test(b)));
  }

  ok("no items at all is refused", validateEwayPayload(document({ items: [] })).some((b) => /no items/.test(b)));

  section("The portal's own date format");

  ok("dd/mm/yyyy hh:mm AM parses", parsePortalDate("22/09/2026 11:30:00 AM")?.getHours() === 11);
  ok("  PM is afternoon", parsePortalDate("22/09/2026 04:15:00 PM")?.getHours() === 16);
  ok("  midnight is 0, not 12", parsePortalDate("22/09/2026 12:05:00 AM")?.getHours() === 0);
  ok("  noon is 12", parsePortalDate("22/09/2026 12:05:00 PM")?.getHours() === 12);
  ok("  the date is read day-first", parsePortalDate("07/09/2026")?.getMonth() === 8);
  /**
   * Null rather than an Invalid Date. Storing NaN as an expiry would show every bill as expired,
   * which on this screen is a false compliance alarm on every consignment.
   */
  ok("nonsense is null, never an Invalid Date", parsePortalDate("not a date") === null && parsePortalDate("") === null && parsePortalDate(null) === null);

  section("The mock provider, end to end");

  {
    const provider = createEwayProvider({ provider: "mock", gstin: "27AAAAA0000A1Z5" });
    ok("mock is what you get without NIC credentials", provider.name === "mock", provider.name);

    const result = await provider.generate(document());
    if (!result.ok) {
      ok("a bill is issued", false, result.error);
    } else {
      ok("a bill is issued", true, result.ewayBillNumber);
      ok("  numbered the way the portal numbers them", /^3\d{11}$/.test(result.ewayBillNumber), result.ewayBillNumber);
      /**
       * The validity comes from the real rule, not from a stub. 980 km is five days, so the whole
       * expiry badge and the "extend it" prompt are exercised without portal access.
       */
      const expected = validityFor(result.ewayBillDate, 980, "REGULAR");
      ok("  valid for as long as the rule says", result.validUntil.getTime() === expected.validUntil.getTime(), expected.days + " days");
      ok("  which for 980 km is five days", expected.days === 5, expected.days);
    }

    ok("Part B updates", (await provider.updateVehicle({
      ewayBillNumber: "381234567890", vehicleNumber: "MH12AB1234", reasonCode: "4",
      reasonNote: "First vehicle", fromPlace: "Mumbai", fromStateCode: "27", transportMode: "ROAD",
    })).ok);
    ok("cancelling works", (await provider.cancel("381234567890", "2", "Order cancelled")).ok);

    const read = await provider.fetch("381234567890");
    ok("a bill can be read back from the portal", read.ok, read.ok ? read.ewayBillNumber : read.error);
    ok("  with both dates, which is the point of asking", read.ok && Boolean(read.ewayBillDate && read.validUntil));
    ok("  a number of the wrong length is refused before the call", !(await provider.fetch("1234")).ok);
  }

  ok("a NIC provider is chosen when configured", createEwayProvider({ provider: "nic_sandbox" }).name === "nic");
  ok("  and an unknown provider falls back to mock rather than to nothing", createEwayProvider({ provider: "whatever" }).name === "mock");

  section("A day, and the midnight at the end of it");

  /**
   * The off-by-one that a date field and a timezone make between them.
   *
   * `validUntil` is midnight at the *end* of the last valid day, so it reads as 00:00 the next
   * morning. Offered straight to a date input it names a day the bill does not cover; read back
   * with `new Date("2026-09-20")` it becomes UTC midnight, which in India is half past five that
   * morning — so a bill good all day would read expired before most people got to work.
   */
  {
    const generated = new Date(2026, 8, 20, 14, 30);
    const { validUntil } = validityFor(generated, 100, "REGULAR");
    /**
     * Rule 138(10): one day runs to the midnight of the day *following* generation, so a bill
     * raised on the 20th covers all of the 21st. Computing the 21st as the expiry — which this
     * suite used to assert — marked every bill in the system expired a day early.
     */
    /**
     * Every moment here is written as an IST wall-clock time with its offset spelled out, never as
     * `new Date(y, m, d, h)` — which reads the *host's* clock and so asserted nothing about India on
     * a machine set to UTC. These now fail if the day arithmetic drifts off IST, which is the whole
     * point of them.
     */
    ok("one day from the 20th expires at midnight IST starting the 22nd", validUntil.getTime() === ist("2026-09-22T00:00").getTime());
    ok("  so the last day it covers is the 21st", lastValidDay(validUntil) === "2026-09-21");
    ok("  still valid at a minute to midnight IST on the 21st", isValidAt(validUntil, ist("2026-09-21T23:59")));
    ok("  and not a minute after", !isValidAt(validUntil, ist("2026-09-22T00:01")));
    ok("  a bill raised at 11pm is not an hour old when it dies", isValidAt(validUntil, ist("2026-09-21T12:00")));

    const round = endOfIndianDay(lastValidDay(validUntil));
    ok("  the day survives a round trip through a date field", round?.getTime() === validUntil.getTime());

    const typed = endOfIndianDay("2026-09-20");
    ok("  a typed date covers all of that day, not none of it", isValidAt(typed!, ist("2026-09-20T09:00")));
    ok("  nonsense is null, never an Invalid Date", endOfIndianDay("not a date") === null);
  }

  {
    /**
     * The case that separates IST from the host clock: 2am in India on the 21st is still the
     * *20th* in UTC. A bill generated then covers the 21st and the 22nd, and expires at midnight
     * IST starting the 23rd.
     *
     * Computed on a UTC host the old way, this gave midnight UTC starting the 22nd — the wrong
     * calendar day and eighteen and a half hours early, on a bill whose goods are still moving.
     * Running this suite under `TZ=UTC` is what proves the fix rather than asserting it.
     */
    const lateNight = new Date("2026-09-21T02:00:00+05:30");
    const { validUntil } = validityFor(lateNight, 100, "REGULAR");

    ok("a bill raised at 2am IST belongs to that Indian day, not the UTC one", lastValidDay(validUntil) === "2026-09-22");
    ok("  expiring at midnight IST starting the 23rd", validUntil.getTime() === ist("2026-09-23T00:00").getTime());
    ok("  and still valid through the evening of the 22nd", isValidAt(validUntil, ist("2026-09-22T21:00")));

    // The same instant, expressed as UTC — identical answer, because the offset is fixed.
    const sameMoment = validityFor(new Date("2026-09-20T20:30:00Z"), 100, "REGULAR");
    ok("  the same instant written in UTC gives the same expiry", sameMoment.validUntil.getTime() === validUntil.getTime());

    // And the round trip through a date field stays on the Indian day.
    ok("  a date field round-trips without losing the day", endOfIndianDay(lastValidDay(validUntil))?.getTime() === validUntil.getTime());
    ok("  the start of an Indian day is 18:30 UTC the evening before", startOfIndianDay("2026-09-21")?.toISOString() === "2026-09-20T18:30:00.000Z");
  }

  section("What the portal is told the movement is for");

  /**
   * Sub-supply type is the field a roadside officer reads to decide whether the paperwork matches
   * the load, and every delivery challan declared 4 (Job Work) regardless — a laptop going back to
   * a vendor, stock between our own offices, kit deployed at a client, all of it.
   *
   * Job work means goods sent to somebody to have something done and returned. That is repair, and
   * nothing else on the list.
   */
  ok("out for repair is job work", subSupplyFor("DELIVERY_CHALLAN", "REPAIR_OUT") === "JOB_WORK");
  ok("  and back from repair is too", subSupplyFor("DELIVERY_CHALLAN", "REPAIR_RETURN") === "JOB_WORK");
  ok("  our own kit between our own sites is own use", subSupplyFor("DELIVERY_CHALLAN", "INTERNAL_TRANSFER") === "OWN_USE");
  ok("  a challan for a sale is still a supply", subSupplyFor("DELIVERY_CHALLAN", "SALE_DELIVERY") === "SUPPLY");
  // Saying "others" is what a person filling the form by hand would do, and is honest; picking a
  // near-miss category to avoid it is not.
  ok("  deploying to a client is none of them, and says so", subSupplyFor("DELIVERY_CHALLAN", "DEPLOYMENT") === "OTHERS");
  ok("  returning to a vendor likewise", subSupplyFor("DELIVERY_CHALLAN", "RETURN_TO_VENDOR") === "OTHERS");
  ok("  a challan raised by hand, with no consignment, likewise", subSupplyFor("DELIVERY_CHALLAN", null) === "OTHERS");
  ok("an invoice is a supply whatever it is attached to", subSupplyFor("INVOICE", "REPAIR_OUT") === "SUPPLY");
  ok("  and so is a credit note", subSupplyFor("CREDIT_NOTE", "INTERNAL_TRANSFER") === "SUPPLY");

  section("Which state the goods are going to");

  /**
   * Four fields can answer this, and reading only two of them made an ordinary invoice report that
   * it had no delivery state — on a screen that printed "Place of supply: 29 — Karnataka" six
   * inches further down.
   */
  ok("the shipping state code wins when it is there", deliveryStateCode({ shippingStateCode: "27", placeOfSupplyCode: "29" }) === "27");
  ok("  the place of supply answers when it is not", deliveryStateCode({ placeOfSupplyCode: "29" }) === "29");
  ok("  then the buyer's own GSTIN", deliveryStateCode({ buyerGstin: "29AAACX1234F1Z5" }) === "29");
  ok(
    "  and the billing state last, because a bill-to is often a head office the goods never see",
    deliveryStateCode({ billingStateCode: "07" }) === "07",
  );
  ok("  none of them is null, not an empty string", deliveryStateCode({}) === null);
  ok("  a GSTIN with a state code that does not exist is not one", deliveryStateCode({ buyerGstin: "99AAACX1234F1Z5" }) === null);

  section("What the goods are worth, when the paperwork says nothing");

  /**
   * The defect this section exists for.
   *
   * A delivery challan totals nil, correctly — nothing is being supplied. Reading that total as the
   * value of the goods put a ₹6.15 lakh movement of three laptops under "no bill needed, ₹0 is not
   * above ₹50,000". Wrong, and reassuring, which is the worst pair.
   */
  ok(
    "an invoice states its own value",
    documentGoodsValue({ total: 615000, lines: [{ quantity: 3, unitPrice: 205000, taxableValue: 615000 }] }) === 615000,
  );
  ok(
    "a nil-total challan falls back to the consignment's declared value",
    documentGoodsValue({
      total: 0,
      consignmentValues: [615451],
      lines: [{ quantity: 3, unitPrice: 205000, taxableValue: 0 }],
    }) === 615451,
  );
  ok(
    "  and to its own lines when there is no consignment either",
    documentGoodsValue({ total: 0, lines: [{ quantity: 3, unitPrice: 205000, taxableValue: 0 }] }) === 615000,
  );
  ok(
    "  nil only when all three are nil",
    documentGoodsValue({ total: 0, lines: [{ quantity: 1, unitPrice: 0, taxableValue: 0 }] }) === 0,
  );

  const mixed = [
    { quantity: 3, unitPrice: 200000, taxableValue: 0 },
    { quantity: 1, unitPrice: 1000, taxableValue: 0 },
  ];
  const apportioned = apportionLineValues(mixed, 601000);
  ok("line values are apportioned by what each line is worth", Math.round(apportioned[0]!) === 600000, apportioned.map(Math.round).join(" + "));
  ok("  and they add back up to the declared value", Math.round(apportioned.reduce((a, b) => a + b, 0)) === 601000);
  ok(
    "  a document that states its own values is left alone",
    apportionLineValues([{ quantity: 1, unitPrice: 10, taxableValue: 500 }], 999)[0] === 500,
  );
  ok(
    "  and priceless lines split evenly rather than dividing by zero",
    apportionLineValues([{ quantity: 1, unitPrice: 0, taxableValue: 0 }, { quantity: 1, unitPrice: 0, taxableValue: 0 }], 100).every(
      (v) => v === 50,
    ),
  );

  await documents();

  console.log(failures === 0 ? "\nAll e-way bill checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

// ─── The second half: real documents, real actions ────────────────────────────────────────────

const PREFIX = "ZZEway";

/**
 * The portal settings this suite needs, put back exactly as they were.
 *
 * `generateEwayBill` refuses without a configured portal, so a run against an unconfigured database
 * would exercise nothing but the refusal. Flipping it to the mock provider for the duration is the
 * only way to reach the code that matters — and the restore is in a `finally`, because leaving
 * somebody's live NIC settings pointed at a mock would be a far worse bug than the one this suite
 * is looking for.
 */
async function withMockPortal<T>(run: () => Promise<T>): Promise<T> {
  const before = await db.organisationSettings.findUnique({
    where: { id: "global" },
    select: { einvoiceEnabled: true, einvoiceProvider: true, ewayEnabled: true },
  });

  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", einvoiceEnabled: true, einvoiceProvider: "mock", ewayEnabled: true },
    update: { einvoiceEnabled: true, einvoiceProvider: "mock", ewayEnabled: true },
  });

  try {
    return await run();
  } finally {
    if (before) {
      await db.organisationSettings.update({
        where: { id: "global" },
        data: {
          einvoiceEnabled: before.einvoiceEnabled,
          einvoiceProvider: before.einvoiceProvider,
          ewayEnabled: before.ewayEnabled,
        },
      });
    } else {
      // No row existed, so the upsert above is what created one — and leaving it behind would turn
      // a database with no settings into one with e-invoicing switched on against a mock portal.
      await db.organisationSettings.deleteMany({ where: { id: "global" } });
    }
  }
}

async function makeDocument(
  companyId: string,
  userId: string,
  suffix: string,
  total = 615000,
  addressed = true,
) {
  // Split out because it is the number the lines carry, and the nil-total case needs them to keep
  // it while the document total goes to zero — which is exactly what a real challan looks like.
  const unitPrice = 205000;
  return db.tradeDocument.create({
    data: {
      docNumber: `${PREFIX}/${suffix}`,
      docType: "DELIVERY_CHALLAN",
      direction: "SALES",
      status: "ISSUED",
      companyId,
      createdById: userId,
      // 27 is Maharashtra, 29 is Karnataka — so this crosses a line and the central threshold bites
      // whatever any state has set for movement inside its own borders.
      sellerGstin: "27AABCW1234F1Z5",
      buyerGstin: "29AAACX1234F1Z5",
      shippingStateCode: addressed ? "29" : null,
      shippingLine1: addressed ? "Plot 4, Whitefield" : null,
      shippingCity: addressed ? "Bengaluru" : null,
      shippingPincode: addressed ? "560066" : null,
      total: new Prisma.Decimal(total),
      lines: {
        create: [
          {
            name: `${PREFIX} laptop`,
            hsnCode: "84713010",
            unit: "NOS",
            quantity: new Prisma.Decimal(3),
            unitPrice: new Prisma.Decimal(unitPrice),
            // Nil on purpose: a challan charges nothing, which is exactly the case that used to
            // declare zero rupees of goods to the portal.
            taxableValue: new Prisma.Decimal(0),
          },
        ],
      },
    },
    select: { id: true, docNumber: true },
  });
}

async function documents() {
  const user = await db.user.findFirst({
    where: { isSuperAdmin: true },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!user) {
    section("Real documents, through the real actions");
    ok("a super admin exists to act as", false, "seed the database first");
    return;
  }
  actor = { id: user.id, name: user.name, email: user.email, role: String(user.role) };

  // A previous run that died mid-way leaves its company behind, and the unique name would then
  // fail every run after it — which reads as a broken suite rather than as leftovers.
  const stale = await db.company.findFirst({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  if (stale) {
    await db.ewayBill.deleteMany({ where: { document: { companyId: stale.id } } });
    await db.assetMovement.deleteMany({ where: { asset: { assetTag: { startsWith: PREFIX } } } });
    await db.consignment.deleteMany({ where: { toCompanyId: stale.id } });
    await db.asset.deleteMany({ where: { assetTag: { startsWith: PREFIX } } });
    await db.tradeDocument.deleteMany({ where: { companyId: stale.id } });
    await db.transporter.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await db.company.delete({ where: { id: stale.id } });
  }

  const company = await db.company.create({
    data: {
      name: `${PREFIX} Buyer`,
      normalizedName: `${PREFIX} buyer`,
      relationshipType: "CLIENT",
      createdById: user.id,
    },
    select: { id: true },
  });

  /**
   * Scoped to the fixture company rather than to the name prefix alone.
   *
   * The challan `raiseDeliveryChallan` produces is numbered by the real sequence — DC/2026-27/0003,
   * not ZZEway/003 — so a prefix match misses it and leaves a foreign key pointing at a company
   * this is about to delete. Everything here belongs to one company; deleting by that is both
   * complete and impossible to widen by accident.
   */
  const cleanup = async () => {
    const docs = { where: { OR: [{ docNumber: { startsWith: PREFIX } }, { companyId: company.id }] } };
    await db.ewayBill.deleteMany({ where: { document: docs.where } });
    await db.assetMovement.deleteMany({ where: { asset: { assetTag: { startsWith: PREFIX } } } });
    await db.consignment.deleteMany({ where: { toCompanyId: company.id } });
    await db.asset.deleteMany({ where: { assetTag: { startsWith: PREFIX } } });
    await db.tradeDocument.deleteMany(docs);
    await db.transporter.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
  };

  try {
    await withMockPortal(async () => {
      section("Transporters are records, not typing");

      const first = await saveTransporter({
        name: `${PREFIX} Carrier`,
        gstin: "27AAACG1234F1Z1",
        defaultMode: "ROAD",
      });
      ok("a transporter saves", first.ok, first.ok ? "" : first.error);
      const transporterId = first.ok ? first.data.id : "";

      const dupe = await saveTransporter({ name: `${PREFIX} carrier`, defaultMode: "ROAD" });
      // Case-insensitively, because "Gati" and "GATI" being two rows is the whole failure the table
      // exists to stop.
      ok("  a second one by the same name is refused", !dupe.ok, dupe.ok ? "accepted a duplicate" : dupe.error);

      const badGstin = await saveTransporter({ name: `${PREFIX} Short`, gstin: "27AAACG12", defaultMode: "ROAD" });
      ok("  a malformed GSTIN is refused rather than stored", !badGstin.ok, badGstin.ok ? "stored it" : badGstin.error);

      ok("  retiring one works", (await setTransporterActive({ id: transporterId, active: false })).ok);
      const afterRetire = await listTransporters({ q: PREFIX });
      ok("    it comes off the picker", afterRetire.ok && afterRetire.data.length === 0);
      const visible = await listTransporters({ q: PREFIX, includeRetired: true });
      // Retired, never deleted: every consignment they ever carried names them.
      ok("    but is still there when retired ones are asked for", visible.ok && visible.data.length === 1);
      await setTransporterActive({ id: transporterId, active: true });

      section("A challan, from needed to cancelled");

      const doc = await makeDocument(company.id, user.id, "001");

      let view = await ewayForDocument(doc.id);
      if (!view.ok) {
        ok("the document loads", false, view.error);
        return;
      }
      ok("a 6.15 lakh inter-state movement needs a bill", view.data.required, view.data.because);
      ok("  with no bill against it yet", view.data.bill === null);
      ok(
        "  and the distance is named as what is missing",
        view.data.missing.some((m) => /distance/i.test(m)),
        view.data.missing.join(", "),
      );

      /** This suite's own rows only — a count against the whole table would pass or fail on data it never wrote. */
      const mine = async (status: string) => {
        const list = await ewayDocuments({ status, page: 1, pageSize: 200, q: PREFIX });
        return list.ok ? list.data.rows.filter((r) => r.docNumber.startsWith(PREFIX)) : [];
      };

      ok("  so it shows in the to-do list", (await mine("pending")).length === 1);

      const details = {
        documentId: doc.id,
        declaredValue: 615000,
        interstate: true,
        transporterId,
        transportMode: "ROAD" as const,
        vehicleType: "REGULAR" as const,
        vehicleNumber: null,
        transportDocNumber: `${PREFIX}-LR-1`,
      };

      const noDistance = await saveEwayDetails({ ...details, distanceKm: 0 });
      ok("zero kilometres is refused", !noDistance.ok, noDistance.ok ? "accepted" : noDistance.error);

      const saved = await saveEwayDetails({ ...details, distanceKm: 980 });
      ok("980 km with a transporter saves", saved.ok, saved.ok ? "" : saved.error);

      view = await ewayForDocument(doc.id);
      ok(
        "  and nothing is missing now — the transporter's GSTIN stands in for the lorry",
        view.ok && view.data.missing.length === 0,
        view.ok ? view.data.missing.join(", ") : "",
      );

      const generated = await generateEwayBill(doc.id);
      ok("the bill is raised", generated.ok, generated.ok ? generated.data.ewayBillNumber : generated.error);

      view = await ewayForDocument(doc.id);
      const raised = view.ok ? view.data.bill : null;
      ok("  twelve digits, as the portal issues them", /^\d{12}$/.test(raised?.ewayBillNumber ?? ""));
      ok(
        "  valid for five days, which is 980 km at 200 a day",
        Boolean(
          raised?.validUntil &&
            raised.ewayBillDate &&
            raised.validUntil.getTime() === validityFor(raised.ewayBillDate, 980, "REGULAR").validUntil.getTime(),
        ),
      );
      ok("  standing reads Valid", view.ok && view.data.standing.headline === "Valid", view.ok ? view.data.standing.headline : "");
      ok("  it leaves the to-do list", (await mine("pending")).length === 0);
      ok("  and appears among the live ones", (await mine("generated")).length === 1);

      const reSave = await saveEwayDetails({ ...details, declaredValue: 1, distanceKm: 10 });
      // The failure this stops: Part A edited here while NIC still holds the original, so the screen
      // and the paper in the driver's hand quietly disagree.
      ok(
        "Part A cannot be edited behind a bill already at the portal",
        !reSave.ok,
        reSave.ok ? "let it through" : reSave.error,
      );

      const partB = await updateEwayVehicle({
        documentId: doc.id,
        vehicleNumber: "mh 12 ab 1234",
        reasonCode: "4",
        reasonNote: "Assigned",
      });
      ok("Part B takes the vehicle", partB.ok, partB.ok ? partB.data.vehicleNumber : partB.error);
      ok("  normalised the way the portal wants it", partB.ok && partB.data.vehicleNumber === "MH12AB1234");

      view = await ewayForDocument(doc.id);
      ok("  and it can still be cancelled inside the 24 hours", view.ok && view.data.canCancel);

      const cancelled = await cancelEwayBill({
        documentId: doc.id,
        reasonCode: "2",
        remark: `${PREFIX} test cancellation`,
      });
      ok("cancelling works", cancelled.ok, cancelled.ok ? "" : cancelled.error);

      view = await ewayForDocument(doc.id);
      ok(
        "  the number survives it — a bill was raised, and the record should say so",
        view.ok && Boolean(view.data.bill?.ewayBillNumber),
      );
      ok("  it counts as cancelled, not as live", (await mine("cancelled")).length === 1);
      ok(
        "  and the document returns to the to-do list, because nothing valid covers it now",
        (await mine("pending")).length === 1,
      );

      section("A bill somebody raised on the portal");

      const other = await makeDocument(company.id, user.id, "002");

      const shortNumber = await associateEwayBill({
        documentId: other.id,
        ewayBillNumber: "1234",
        ewayBillDate: "2026-09-20",
        validUntil: "2026-09-25",
      });
      ok("a number that is not twelve digits is refused", !shortNumber.ok, shortNumber.ok ? "accepted" : shortNumber.error);

      const backwards = await associateEwayBill({
        documentId: other.id,
        ewayBillNumber: "381234567890",
        ewayBillDate: "2026-09-25",
        validUntil: "2026-09-20",
      });
      ok("  expiring before it was raised is refused", !backwards.ok, backwards.ok ? "accepted" : backwards.error);

      const associated = await associateEwayBill({
        documentId: other.id,
        ewayBillNumber: "381234567890",
        ewayBillDate: "2026-09-20",
        validUntil: "2026-09-25",
      });
      ok("a real one records", associated.ok, associated.ok ? "" : associated.error);

      const otherView = await ewayForDocument(other.id);
      ok("  marked as somebody else's", otherView.ok && otherView.data.bill?.associated === true);
      ok("  so we do not offer to cancel it", otherView.ok && !otherView.data.canCancel);

      const theirPartB = await updateEwayVehicle({ documentId: other.id, vehicleNumber: "MH12AB9999", reasonCode: "4" });
      // Offering a button the API would reject is worse than not offering it, and the action refuses
      // even if something finds a way to call it.
      ok(
        "  and Part B on it is refused rather than attempted",
        !theirPartB.ok,
        theirPartB.ok ? "attempted it" : theirPartB.error,
      );

      section("A challan that charges nothing");

      /**
       * The defect that shipped, caught end to end.
       *
       * The document total is nil — correctly, because nothing is being supplied — while three
       * laptops worth six lakhs are on the back of a lorry. Read the total and the app says no bill
       * is needed. Nobody would have queried that answer, which is what made it dangerous.
       */
      const challan = await makeDocument(company.id, user.id, "004", 0);
      const challanView = await ewayForDocument(challan.id);
      ok(
        "a nil-total challan still needs a bill",
        challanView.ok && challanView.data.required,
        challanView.ok ? challanView.data.because : challanView.error,
      );
      ok(
        "  valued from its lines rather than from its total",
        challanView.ok && challanView.data.total === 615000,
        challanView.ok ? String(challanView.data.total) : "",
      );
      ok("  and it is on the to-do list", (await mine("pending")).some((r) => r.docNumber.endsWith("004")));

            section("A document the portal would not take");

      /**
       * The other defect that shipped, and the more embarrassing one.
       *
       * `raiseDeliveryChallan` loaded the destination address and then never wrote it onto the
       * document. Every challan it produced had no delivery pincode and no state code, which the
       * portal refuses outright — so "Raise the e-way bill" was a button that was always enabled and
       * always failed, and the only way to find out was to press it.
       */
      const noAddress = await makeDocument(company.id, user.id, "005", 615000, false);
      await saveEwayDetails({
        documentId: noAddress.id,
        declaredValue: 615000,
        interstate: true,
        distanceKm: 420,
        transporterId,
        transportMode: "ROAD",
        vehicleType: "REGULAR",
        vehicleNumber: "MH04CD9911",
        transportDocNumber: null,
      });

      await db.tradeDocument.update({
        where: { id: noAddress.id },
        // The shape the seeded invoices are actually in: no shipping block, no buyer GSTIN, but a
        // place of supply, because that is what the tax was worked out against.
        data: { buyerGstin: null, placeOfSupplyCode: "29" },
      });

      const bareView = await ewayForDocument(noAddress.id);
      ok(
        "the transport details are complete",
        bareView.ok && bareView.data.missing.length === 0,
        bareView.ok ? bareView.data.missing.join(", ") : "",
      );
      ok(
        "  but the missing pincode is named before the button is pressed",
        bareView.ok && bareView.data.missingOnDocument.some((m) => /pincode/i.test(m)),
        bareView.ok ? bareView.data.missingOnDocument.join(" and ") : "",
      );
      ok(
        "  and the state is not, because the place of supply already gives it",
        bareView.ok && !bareView.data.missingOnDocument.some((m) => /state/i.test(m)),
        bareView.ok ? bareView.data.missingOnDocument.join(" and ") : "",
      );

      const refused = await generateEwayBill(noAddress.id);
      ok("  and the portal refuses it, in its own words", !refused.ok, refused.ok ? "accepted it" : refused.error);

      section("The challan a consignment raises");

      /**
       * Where both of the compliance defects in this module actually lived.
       *
       * `raiseDeliveryChallan` is the only thing in the app that produces a document for goods that
       * are not being sold, and it got the two things such a document exists to state wrong: it
       * omitted the HSN of what was moving, and it loaded the delivery address and then never wrote
       * it down. Both are invisible on screen — the challan looks complete — and both are refused
       * flatly by the portal. So the challan is built here for real and inspected in the database.
       */
      const site = await db.companyLocation.create({
        data: {
          companyId: company.id,
          label: `${PREFIX} Head office`,
          address: "Plot 4, Whitefield",
          city: "Bengaluru",
          state: "Karnataka",
          pincode: "560066",
          gstNumber: "29AAACX1234F1Z5",
        },
        select: { id: true },
      });

      const item = await db.item.findFirst({ where: { hsnCode: { not: null } }, select: { id: true, hsnCode: true } });
      const asset = await db.asset.create({
        data: {
          assetTag: `${PREFIX}-A1`,
          serialNumber: `${PREFIX}-SN-1`,
          name: `${PREFIX} laptop`,
          kind: "LAPTOP",
          status: "IN_STOCK",
          purchaseCost: new Prisma.Decimal(205000),
          itemId: item?.id ?? null,
          createdById: user.id,
        },
        select: { id: true },
      });

      const movement = await createConsignment({
        reason: "REPAIR_OUT",
        assetIds: [asset.id],
        toCompanyId: company.id,
        toLocationId: site.id,
        transporterId,
        interstate: true,
      });
      ok("a consignment is raised", movement.ok, movement.ok ? movement.data.consignmentNumber : movement.error);
      if (!movement.ok) return;

      const challanDoc = await raiseDeliveryChallan(movement.data.id);
      ok("  and it produces a delivery challan", challanDoc.ok, challanDoc.ok ? challanDoc.data.docNumber : challanDoc.error);
      if (!challanDoc.ok) return;

      const built = await db.tradeDocument.findUnique({
        where: { id: challanDoc.data.documentId },
        select: {
          total: true,
          shippingPincode: true,
          shippingStateCode: true,
          shippingCity: true,
          sellerGstin: true,
          lines: { select: { hsnCode: true, unitPrice: true, taxableValue: true } },
        },
      });

      ok("  it charges nothing, which is what makes it a challan", Number(built?.total) === 0);
      ok("  but it states the delivery pincode", built?.shippingPincode === "560066", built?.shippingPincode ?? "blank");
      ok("  and the delivery state code", built?.shippingStateCode === "29", built?.shippingStateCode ?? "blank");
      ok(
        "  and it carries the HSN of what is moving",
        Boolean(built?.lines.every((l) => l.hsnCode)),
        built?.lines.map((l) => l.hsnCode ?? "blank").join(", "),
      );
      ok(
        "  and each line states what the thing is worth, even at nil tax",
        Boolean(built?.lines.every((l) => Number(l.unitPrice) > 0)),
      );

      const builtView = await ewayForDocument(challanDoc.data.documentId);
      ok(
        "  so the bill it needs has nothing standing in its way but the transport details",
        builtView.ok && builtView.data.required && builtView.data.missingOnDocument.length === 0,
        builtView.ok ? builtView.data.missingOnDocument.join(", ") || "nothing missing" : builtView.error,
      );

      await saveEwayDetails({
        documentId: challanDoc.data.documentId,
        declaredValue: 205000,
        interstate: true,
        distanceKm: 420,
        transporterId,
        transportMode: "ROAD",
        vehicleType: "REGULAR",
        vehicleNumber: "MH04CD9911",
        transportDocNumber: null,
      });
      const builtBill = await generateEwayBill(challanDoc.data.documentId);
      // The whole point, end to end: a movement that is not a sale, on a document that charges
      // nothing, with a bill the portal accepts.
      ok("  and the bill goes through", builtBill.ok, builtBill.ok ? builtBill.data.ewayBillNumber : builtBill.error);

      {
        /**
         * Two clicks, one bill.
         *
         * Everything `generateEwayBill` did before calling NIC was a read, so two requests arriving
         * together both saw an empty row, both called the portal, and NIC issued **two live e-way
         * bills against one consignment** — of which only the second was ever recorded here. The
         * first then existed nowhere in this app: not on the document, not cancellable, and still
         * attached to the goods on the road.
         *
         * Asserted by actually racing them rather than by reading the code, because the whole class
         * of bug is invisible to a sequential test — the old version passes every single-call check
         * in this file.
         */
        // A second challan of its own, so the race starts from a row with no number on it.
        const racerAsset = await db.asset.create({
          data: {
            assetTag: `${PREFIX}-A2`,
            serialNumber: `${PREFIX}-SN-2`,
            name: `${PREFIX} laptop two`,
            kind: "LAPTOP",
            status: "IN_STOCK",
            purchaseCost: new Prisma.Decimal(205000),
            itemId: item?.id ?? null,
            createdById: user.id,
          },
          select: { id: true },
        });
        const racerMovement = await createConsignment({
          reason: "REPAIR_OUT",
          assetIds: [racerAsset.id],
          toCompanyId: company.id,
          toLocationId: site.id,
          transporterId,
          interstate: true,
        });
        if (!racerMovement.ok) throw new Error(racerMovement.error);
        const racerChallan = await raiseDeliveryChallan(racerMovement.data.id);
        if (!racerChallan.ok) throw new Error(racerChallan.error);
        const racer = racerChallan.data.documentId;

        await saveEwayDetails({
          documentId: racer,
          declaredValue: 205000,
          interstate: true,
          distanceKm: 420,
          transporterId,
          transportMode: "ROAD",
          vehicleType: "REGULAR",
          vehicleNumber: "MH04CD9912",
          transportDocNumber: null,
        });

        const [first, second] = await Promise.all([
          generateEwayBill(racer),
          generateEwayBill(racer),
        ]);

        const winners = [first, second].filter((r) => r.ok);
        ok("two simultaneous requests raise exactly one bill", winners.length === 1, `${winners.length} succeeded`);

        const loser = [first, second].find((r) => !r.ok);
        ok("  and the loser is told why, not left silent", Boolean(loser && /already being raised|already has/.test(loser.error)), loser && !loser.ok ? loser.error : "none");

        const rows = await db.ewayBill.findMany({ where: { documentId: racer }, select: { ewayBillNumber: true, generatingAt: true } });
        const numbered = rows.filter((r) => r.ewayBillNumber);
        ok("  one number on the document, not two", numbered.length === 1, numbered.map((r) => r.ewayBillNumber).join(", "));
        ok("  and the claim is released, so a later attempt is not blocked", rows.every((r) => r.generatingAt === null));
      }

      section("Reading a bill back, and the module switch");

      const looked = await lookupEwayBill("381234567890");
      ok("the portal lookup answers", looked.ok, looked.ok ? looked.data.ewayBillNumber : looked.error);
      ok(
        "  it reads, it does not write",
        (await db.ewayBill.count({ where: { ewayBillNumber: "381234567890", associated: false } })) === 0,
      );
      ok("  and a short number never reaches the portal", !(await lookupEwayBill("99")).ok);

      /**
       * The switch is enforced where the data is read, not only in the nav.
       *
       * A hidden menu item is not a boundary: the document page draws its own panel and the list has
       * its own URL, so both have to refuse.
       */
      await db.organisationSettings.update({ where: { id: "global" }, data: { ewayEnabled: false } });
      const offView = await ewayForDocument(challanDoc.data.documentId);
      const offList = await ewayDocuments({ status: "all", page: 1, pageSize: 10 });
      ok("switched off, a document has no panel", !offView.ok, offView.ok ? "still returned one" : offView.error);
      ok("  and the list refuses too", !offList.ok);
      await db.organisationSettings.update({ where: { id: "global" }, data: { ewayEnabled: true } });
      ok("  switched back on, it is there again", (await ewayForDocument(challanDoc.data.documentId)).ok);

      section("Under the threshold");

      const small = await makeDocument(company.id, user.id, "003", 18000);
      const smallView = await ewayForDocument(small.id);
      ok(
        "an 18,000 rupee movement needs no bill",
        smallView.ok && !smallView.data.required,
        smallView.ok ? smallView.data.because : "",
      );
      ok("  and is not on the to-do list", (await mine("pending")).every((r) => !r.docNumber.endsWith("003")));
      ok("  but is still in the full list, so it can be looked up", (await mine("all")).some((r) => r.docNumber.endsWith("003")));
    });
  } finally {
    await cleanup();
    await db.$disconnect();
  }
}

main();
