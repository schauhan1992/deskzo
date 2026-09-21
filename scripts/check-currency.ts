/**
 * That a foreign-currency document says one thing to the customer and another to the books.
 *
 * Those two numbers are supposed to differ — that is the entire feature — which is exactly why it
 * needs checking. The failure modes are quiet:
 *
 *   - a USD document posting 1,000 to the ledger as though it were rupees, and
 *   - a rupee document carrying a leftover rate from when somebody tried USD and changed back.
 *
 * Neither throws. The first understates revenue by a factor of eighty; the second overstates it.
 */
import { BASE_CURRENCY, CURRENCIES, formatMoney, formatRate, getCurrency, isBaseCurrency, rateHint, toBase } from "../src/lib/currency";
import { tradeDocumentSchema } from "../src/lib/validation/trade-document";
import { lookupRate } from "../src/lib/finance/exchange-rate";
import { amountInWords } from "../src/lib/gst-engine";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(t: string) {
  console.log(`\n— ${t} —\n`);
}

/** The minimum a document needs to parse, so each case below varies one thing. */
function draft(overrides: Record<string, unknown>) {
  const address = {
    attention: "",
    line1: "1 Example Road",
    line2: "",
    city: "Mumbai",
    state: "Maharashtra",
    stateCode: "27",
    pincode: "400001",
    country: "India",
    phone: "",
  };
  return {
    docType: "PROPOSAL",
    companyId: "c1",
    placeOfSupplyCode: "27",
    gstTreatment: "UNREGISTERED",
    issueDate: "2026-09-19",
    billing: address,
    shipping: address,
    shippingSameAsBilling: true,
    lines: [{ name: "Licence", quantity: 1, unitPrice: 1000, discountValue: 0, taxRatePercent: 0 }],
    ...overrides,
  };
}

async function main() {
  section("The registry");

  ok("Rupees are the base", BASE_CURRENCY === "INR" && CURRENCIES[0]!.code === "INR");
  ok("  every code is distinct", new Set(CURRENCIES.map((c) => c.code)).size === CURRENCIES.length, `${CURRENCIES.length}`);
  ok(
    "  and each has a symbol and a sane precision",
    CURRENCIES.every((c) => c.symbol.length > 0 && c.decimals >= 0 && c.decimals <= 3),
    CURRENCIES.map((c) => `${c.code}:${c.decimals}`).join(" "),
  );
  ok(
    "The yen has no paise",
    getCurrency("JPY").decimals === 0,
    "¥1,200.00 marks a document out as produced by somebody who does not deal in yen",
  );
  ok("An unknown code falls back to rupees rather than throwing", getCurrency("XYZ").code === "INR");

  section("Formatting");

  ok("Rupees group the Indian way", formatMoney(19968543, "INR").includes("1,99,68,543"), formatMoney(19968543, "INR"));
  ok("  and dollars the other way", formatMoney(19968543, "USD").includes("19,968,543"), formatMoney(19968543, "USD"));
  ok("  a yen amount shows no decimals", !formatMoney(1200, "JPY").includes("."), formatMoney(1200, "JPY"));
  ok("  and nothing formats as an empty string", formatMoney(null) === "—", formatMoney(null));

  ok("isBaseCurrency treats an absent code as rupees", isBaseCurrency(undefined) && isBaseCurrency("INR") && !isBaseCurrency("USD"));
  ok(
    "The rate hint reads rupees-per-unit, the way people quote it",
    rateHint("USD", 83.25).startsWith("1 USD = "),
    `${rateHint("USD", 83.25)} — inverted, somebody enters 0.012`,
  );
  ok("  and there is no hint on a rupee document", rateHint("INR", 1) === "");

  section("Conversion");

  ok("A thousand dollars at 83.25 is ₹83,250", toBase(1000, 83.25) === 83250, String(toBase(1000, 83.25)));
  ok("  rounded to the paisa, not beyond", toBase(1000, 83.2567) === 83256.7, String(toBase(1000, 83.2567)));
  ok("  and a rate of 1 changes nothing", toBase(4999.5, 1) === 4999.5, String(toBase(4999.5, 1)));

  section("What the schema refuses");

  const rupeeDefault = tradeDocumentSchema.safeParse(draft({}));
  ok(
    "A document with no currency named is a rupee document at rate 1",
    rupeeDefault.success && rupeeDefault.data.currency === "INR" && rupeeDefault.data.exchangeRate === 1,
    rupeeDefault.success ? `${rupeeDefault.data.currency} @ ${rupeeDefault.data.exchangeRate}` : "did not parse",
  );

  const foreign = tradeDocumentSchema.safeParse(draft({ currency: "USD", exchangeRate: 83.25 }));
  ok("A dollar document with a rate is accepted", foreign.success, foreign.success ? "" : JSON.stringify(foreign.error.issues[0]));

  const stale = tradeDocumentSchema.safeParse(draft({ currency: "INR", exchangeRate: 83.25 }));
  ok(
    "A rupee document with a leftover rate is refused",
    !stale.success,
    "this is the one that silently multiplies every posting by eighty-three",
  );

  const zero = tradeDocumentSchema.safeParse(draft({ currency: "USD", exchangeRate: 0 }));
  ok("A rate of zero is refused", !zero.success, "it would post the entire invoice as nothing");

  const negative = tradeDocumentSchema.safeParse(draft({ currency: "USD", exchangeRate: -83 }));
  ok("  and so is a negative one", !negative.success);

  const slipped = tradeDocumentSchema.safeParse(draft({ currency: "USD", exchangeRate: 8325000 }));
  ok(
    "  and a slipped decimal past the ceiling",
    !slipped.success,
    "a fat-fingered rate posts a lakh of revenue as a crore, and nothing else would catch it",
  );

  const unknown = tradeDocumentSchema.safeParse(draft({ currency: "XYZ", exchangeRate: 2 }));
  ok("A currency that does not exist is refused", !unknown.success, "rather than stored and rendered as a fallback");

  section("Pricing a catalogue item into a foreign-currency document");

  // The form's own conversion, reproduced exactly. This is the most expensive mistake the
  // document form could make: a ₹72,500 laptop dropped into a dollar quote as $72,500 looks
  // entirely normal and is off by a factor of eighty in the customer's favour.
  const priceIn = (rupees: number, code: string, rate: number) => {
    if (isBaseCurrency(code) || rate <= 0) return rupees;
    const factor = 10 ** getCurrency(code).decimals;
    return Math.round((rupees / rate) * factor) / factor;
  };

  ok(
    "A rupee catalogue price converts into the document's currency",
    priceIn(72500, "USD", 83.25) === 870.87,
    `₹72,500 at 83.25 is ${formatMoney(priceIn(72500, "USD", 83.25), "USD")}`,
  );
  ok(
    "  rounded to that currency's own precision",
    Number.isInteger(priceIn(72500, "JPY", 0.56)),
    `${formatMoney(priceIn(72500, "JPY", 0.56), "JPY")} — the yen has no fractional unit`,
  );
  ok("  and a rupee document leaves the price alone", priceIn(72500, "INR", 1) === 72500);
  ok(
    "  a nonsense rate leaves it alone rather than dividing by zero",
    priceIn(72500, "USD", 0) === 72500,
    "Infinity in a price field is worse than an unconverted one",
  );
  ok(
    "  and converting back lands within a rounding step",
    Math.abs(priceIn(72500, "USD", 83.25) * 83.25 - 72500) < 1,
    "the round trip must not drift far enough to change what is invoiced",
  );

  section("The printed rate has to reconcile with the printed rupee total");

  // A customer who multiplies the rate on the page by the foreign total must land on the rupee
  // total on the same page. Formatting the rate to the rupee's two places breaks that: the
  // document then contradicts itself and the discrepancy looks like an error in our favour.
  const shown = 26.0682;
  ok("A rate keeps the precision it converts at", formatRate(shown) === "₹26.0682", formatRate(shown));
  ok(
    "  and the printed figures reconcile",
    toBase(32000, Number(formatRate(shown).replace(/[^0-9.]/g, ""))) === toBase(32000, shown),
    `32,000 × ${formatRate(shown)} = ${formatMoney(toBase(32000, shown), "INR")}`,
  );
  ok("  a whole rate is not padded to six places", formatRate(83) === "₹83.00", formatRate(83));
  ok("  a two-place rate is left alone", formatRate(83.25) === "₹83.25", formatRate(83.25));
  ok("  and a missing rate is not rendered as zero", formatRate(null) === "—", formatRate(null));

  section("The amount in words, which is the figure that governs");

  // On a dispute the words beat the numerals, so this is the one field on the document where
  // being approximately right is worth nothing.
  ok(
    "A rupee total groups in lakh and crore",
    amountInWords(870000, "INR") === "Eight Lakh Seventy Thousand Rupees Only",
    amountInWords(870000, "INR"),
  );
  ok(
    "  the same total in dollars groups the western way",
    amountInWords(870000, "USD") === "Eight Hundred Seventy Thousand Dollars Only",
    amountInWords(870000, "USD"),
  );
  ok(
    "  and names the currency it is actually in",
    amountInWords(25, "AED").includes("Dirhams") && amountInWords(25, "SAR").includes("Riyals"),
    `${amountInWords(25, "AED")} / ${amountInWords(25, "SAR")}`,
  );
  ok(
    "  defaulting to rupees for every caller that predates multi-currency",
    amountInWords(870000) === amountInWords(870000, "INR"),
    "the payslip and the GST invoice both rely on this",
  );

  ok("One unit is singular", amountInWords(1, "USD") === "One Dollar Only", amountInWords(1, "USD"));
  ok(
    "  and a currency with no plural form keeps its own",
    amountInWords(5000, "JPY") === "Five Thousand Yen Only",
    amountInWords(5000, "JPY"),
  );
  ok(
    "  the yen never shows a subunit it does not have",
    amountInWords(5000.5, "JPY") === amountInWords(5000, "JPY"),
    amountInWords(5000.5, "JPY"),
  );

  // Both of these produced wrong words before the rewrite, and neither threw.
  ok(
    "A subunit that rounds to a whole unit is carried, not printed",
    amountInWords(1.999, "INR") === "Two Rupees Only",
    `${amountInWords(1.999, "INR")} — not "One Rupee and Hundred Paise"`,
  );
  ok(
    "  and a total past ninety-nine crore is still nameable",
    amountInWords(1000000000, "INR") === "One Hundred Crore Rupees Only",
    amountInWords(1000000000, "INR"),
  );
  ok(
    "  no amount renders the word 'undefined'",
    ![0, 1, 0.5, 99, 1.999, 870000, 1e9, 1.2e10, -4500.75].some((n) =>
      CURRENCIES.some((c) => amountInWords(n, c.code).includes("undefined")),
    ),
    "every offered currency, across the scale boundaries",
  );
  ok("  a negative total says so", amountInWords(-4500, "USD").startsWith("Minus"), amountInWords(-4500, "USD"));
  ok("  and zero is spelled out", amountInWords(0, "AED") === "Zero Dirhams Only", amountInWords(0, "AED"));

  section("What the rate lookup refuses before it reaches the network");

  // Only the guards are checked here, not the fetch. A check that depends on somebody else's CDN
  // fails on a train and gets ignored a week later, which is worse than not having it — so the
  // network path is verified by hand when the provider changes and these cover the rest.
  const refusals = await Promise.all([
    lookupRate("INR", "2026-09-18"),
    lookupRate("XYZ", "2026-09-18"),
    lookupRate("USD", "18/09/2026"),
    lookupRate("USD", ""),
  ]);

  ok("A rupee document is turned away", !refusals[0]!.ok && refusals[0]!.reason.includes("rupee"));
  ok("  a currency we do not offer is refused", !refusals[1]!.ok, "before any request is made");
  ok("  a day-first date is refused", !refusals[2]!.ok, "the provider wants ISO and would 404 on anything else");
  ok("  and an empty date is too", !refusals[3]!.ok);
  ok(
    "  every refusal explains itself",
    refusals.every((r) => !r.ok && r.reason.length > 10),
    "the message goes straight under the rate field, so it has to be worth reading",
  );

  console.log(failures === 0 ? "\nAll currency checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
