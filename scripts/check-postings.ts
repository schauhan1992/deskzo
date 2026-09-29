/**
 * Runs the posting engine over every issued document and asserts each entry balances.
 *
 * A double-entry bug doesn't announce itself — an invoice posts, the books look populated, and the
 * trial balance is quietly out by the TDS on one document. This walks real data because the failure
 * cases are the awkward ones: a TDS deduction, a negative round-off, freight on a credit note.
 *
 *   npm run check:postings
 */
import { directClient } from "../src/lib/tenancy/direct-client";
import { computeDocument, type SupplyType } from "../src/lib/gst-engine";
import {
  bookingRate,
  inRupees,
  postSalesInvoice,
  postCreditNote,
  postVendorBill,
  entryTotals,
  isBalanced,
  hasOneSidedLines,
  type DocumentFinancials,
} from "../src/lib/ledger/posting";

const db = directClient();

/**
 * The cases the seed data doesn't happen to contain. Each one runs through the real GST engine, so
 * the posting engine is checked against exactly the figures a document would carry — including the
 * signed withholding, which is the part easiest to get backwards.
 */
const SYNTHETIC: { name: string; supply: SupplyType; lines: Parameters<typeof computeDocument>[0]; extras: NonNullable<Parameters<typeof computeDocument>[2]> }[] = [
  { name: "plain intra-state", supply: "INTRA_STATE", lines: [{ quantity: 3, unitPrice: 1999, taxRatePercent: 18 }], extras: {} },
  { name: "inter-state with freight", supply: "INTER_STATE", lines: [{ quantity: 1, unitPrice: 133899, taxRatePercent: 18 }], extras: { shippingCharge: 1500, shippingTaxRatePercent: 18 } },
  { name: "TDS deducted 2%", supply: "INTRA_STATE", lines: [{ quantity: 10, unitPrice: 5000, taxRatePercent: 18 }], extras: { withholdingMode: "TDS", withholdingRatePercent: 2 } },
  { name: "TCS collected 1%", supply: "INTRA_STATE", lines: [{ quantity: 10, unitPrice: 5000, taxRatePercent: 18 }], extras: { withholdingMode: "TCS", withholdingRatePercent: 1 } },
  { name: "positive adjustment", supply: "INTRA_STATE", lines: [{ quantity: 1, unitPrice: 9999, taxRatePercent: 12 }], extras: { adjustment: 250 } },
  { name: "negative adjustment", supply: "INTRA_STATE", lines: [{ quantity: 1, unitPrice: 9999, taxRatePercent: 12 }], extras: { adjustment: -250 } },
  { name: "TDS + freight + adjustment", supply: "INTER_STATE", lines: [{ quantity: 4, unitPrice: 68500, discountMode: "PERCENT", discountValue: 5, taxRatePercent: 18 }], extras: { shippingCharge: 2200, shippingTaxRatePercent: 18, withholdingMode: "TDS", withholdingRatePercent: 10, adjustment: -99 } },
  { name: "no rounding", supply: "INTRA_STATE", lines: [{ quantity: 7, unitPrice: 1234.56, taxRatePercent: 5 }], extras: { roundOff: false } },
  { name: "zero rated", supply: "INTRA_STATE", lines: [{ quantity: 2, unitPrice: 500, taxRatePercent: 0 }], extras: {} },
];

/**
 * The rates the synthetic cases are also posted at. A foreign document posts every figure converted
 * at its rate (`inRupees`), and converted one at a time they need not add up to the converted total
 * — the paisa that makes an entry unbalanced, and a document impossible to issue (F1).
 */
const RATES = [1, 83.47, 91.123456];

function checkSynthetic() {
  let failures = 0;
  for (const c of SYNTHETIC) for (const rate of RATES) {
    const computed = computeDocument(c.lines, c.supply, c.extras);
    const f: DocumentFinancials = inRupees({
      companyId: "test-company",
      docNumber: c.name,
      taxableValue: computed.taxableValue,
      cgstAmount: computed.cgstAmount,
      sgstAmount: computed.sgstAmount,
      igstAmount: computed.igstAmount,
      shippingCharge: c.extras.shippingCharge ?? 0,
      withholdingAmount: computed.withholdingAmount,
      adjustment: computed.adjustment,
      adjustmentLabel: null,
      roundOff: computed.roundOff,
      total: computed.total,
    }, rate);
    for (const [kind, post] of [
      ["invoice", postSalesInvoice],
      ["credit note", postCreditNote],
      ["bill", postVendorBill],
    ] as const) {
      const draft = post(f);
      const totals = entryTotals(draft.lines);
      if (!isBalanced(draft.lines) || !hasOneSidedLines(draft.lines)) {
        failures++;
        console.log(`
✗ ${kind}: ${c.name} at ${rate}`);
        console.log(`  debits ${totals.debit.toFixed(2)}  credits ${totals.credit.toFixed(2)}  diff ${(totals.debit - totals.credit).toFixed(2)}`);
        console.log(`  taxable ${f.taxableValue}  gst ${(f.cgstAmount + f.sgstAmount + f.igstAmount).toFixed(2)}  withholding ${f.withholdingAmount}  adj ${f.adjustment}  round ${f.roundOff}  total ${f.total}`);
        for (const l of draft.lines) {
          console.log(`    ${l.account.padEnd(20)} ${String(l.debit || "").padStart(13)} ${String(l.credit || "").padStart(13)}`);
        }
      }
    }
  }
  console.log(`${SYNTHETIC.length * RATES.length * 3} synthetic posting(s) checked, at rates ${RATES.join(", ")}; ${failures} unbalanced.`);
  return failures;
}




/**
 * Whether the ledger still agrees with the documents.
 *
 * The posting engine being correct doesn't mean the books are: a code path that cancels a document
 * without reversing its entry leaves revenue in the accounts for an invoice that no longer exists,
 * and nothing about that looks wrong until someone reads the P&L. This catches it.
 */
async function checkDrift() {
  let failures = 0;

  const unposted = await db.tradeDocument.findMany({
    where: {
      docType: { in: ["INVOICE", "CREDIT_NOTE", "BILL"] },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      journalEntries: { none: {} },
    },
    select: { docNumber: true, docType: true },
  });
  for (const d of unposted) {
    failures++;
    console.log(`✗ ${d.docType} ${d.docNumber} is issued but has no ledger entry.`);
  }

  const cancelled = await db.tradeDocument.findMany({
    where: { status: "CANCELLED", journalEntries: { some: {} } },
    select: {
      docNumber: true,
      journalEntries: { select: { entryNumber: true, reversesId: true, reversedBy: { select: { id: true } } } },
    },
  });
  for (const d of cancelled) {
    const live = d.journalEntries.filter((e) => !e.reversesId && !e.reversedBy);
    for (const e of live) {
      failures++;
      console.log(`✗ ${d.docNumber} is cancelled but ${e.entryNumber} has not been reversed.`);
    }
  }

  const rows: { entryNumber: string }[] = await db.$queryRaw`
    SELECT e."entryNumber" FROM journal_lines l
    JOIN journal_entries e ON e.id = l."entryId"
    GROUP BY e."entryNumber" HAVING SUM(l.debit) <> SUM(l.credit)`;
  for (const r of rows) {
    failures++;
    console.log(`✗ ${r.entryNumber} does not balance in the database.`);
  }

  console.log(`Ledger checked against ${unposted.length + cancelled.length} document(s); ${failures} problem(s).`);
  return failures;
}

async function main() {
  const docs = await db.tradeDocument.findMany({
    where: { docType: { in: ["INVOICE", "CREDIT_NOTE", "BILL"] }, status: { not: "DRAFT" } },
    select: {
      docType: true, docNumber: true, companyId: true,
      taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true,
      shippingCharge: true, withholdingAmount: true, adjustment: true, adjustmentLabel: true,
      roundOff: true, total: true, currency: true, exchangeRate: true,
    },
  });

  let failures = checkSynthetic();
  failures += await checkDrift();
  for (const doc of docs) {
    // In rupees at the document's rate, as journal.ts posts it.
    const f: DocumentFinancials = inRupees({
      companyId: doc.companyId,
      docNumber: doc.docNumber,
      taxableValue: Number(doc.taxableValue),
      cgstAmount: Number(doc.cgstAmount),
      sgstAmount: Number(doc.sgstAmount),
      igstAmount: Number(doc.igstAmount),
      shippingCharge: Number(doc.shippingCharge),
      withholdingAmount: Number(doc.withholdingAmount),
      adjustment: Number(doc.adjustment),
      adjustmentLabel: doc.adjustmentLabel,
      roundOff: Number(doc.roundOff),
      total: Number(doc.total),
    }, bookingRate(doc));
    const draft =
      doc.docType === "INVOICE" ? postSalesInvoice(f) : doc.docType === "CREDIT_NOTE" ? postCreditNote(f) : postVendorBill(f);

    const totals = entryTotals(draft.lines);
    if (!isBalanced(draft.lines) || !hasOneSidedLines(draft.lines)) {
      failures++;
      console.log(`\n✗ ${doc.docType} ${doc.docNumber}`);
      console.log(`  debits ${totals.debit.toFixed(2)}  credits ${totals.credit.toFixed(2)}  diff ${(totals.debit - totals.credit).toFixed(2)}`);
      console.log(`  taxable ${f.taxableValue}  gst ${f.cgstAmount + f.sgstAmount + f.igstAmount}  withholding ${f.withholdingAmount}  adj ${f.adjustment}  round ${f.roundOff}  total ${f.total}`);
      for (const l of draft.lines) {
        console.log(`    ${l.account.padEnd(20)} ${String(l.debit || "").padStart(13)} ${String(l.credit || "").padStart(13)}`);
      }
    }
  }

  console.log(`\n${docs.length} document(s) checked, ${failures} unbalanced.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main();
