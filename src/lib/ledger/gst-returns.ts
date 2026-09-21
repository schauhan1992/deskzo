/**
 * The monthly GST returns, built from the documents already in the system.
 *
 * Two are filed and they are not the same shape, which is the whole reason both exist here:
 *
 *   GSTR-1 is a *list* of what was supplied — every B2B invoice, invoice by invoice, because the
 *   buyer's input credit is matched against it. Getting a line wrong here costs your customer their
 *   credit, not you.
 *
 *   GSTR-3B is a *summary* with the tax actually payable — output tax less the input credit claimed,
 *   which is what you pay. It is self-assessed, so it has to agree with the ledger rather than with
 *   a spreadsheet.
 *
 * Pure functions over plain rows, so both can be checked without a database — and they need
 * checking, because a return that is quietly wrong is discovered by a notice rather than by a test.
 */

export type ReturnDocument = {
  docNumber: string;
  docType: "INVOICE" | "CREDIT_NOTE" | "BILL";
  issueDate: Date;
  status: string;
  partyName: string;
  partyGstin: string | null;
  placeOfSupplyCode: string | null;
  reverseCharge?: boolean;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  total: number;
  lines: { hsnCode: string | null; name: string; unit: string | null; quantity: number; taxableValue: number; taxRatePercent: number; cgstAmount: number; sgstAmount: number; igstAmount: number }[];
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * A document only belongs in a return once it has actually been issued.
 *
 * Drafts are not supplies, and a cancelled invoice is not one either — including either is the
 * fastest way to file more output tax than was ever charged.
 */
export function countsForReturn(doc: Pick<ReturnDocument, "status">) {
  return doc.status !== "DRAFT" && doc.status !== "CANCELLED" && doc.status !== "EXPIRED" && doc.status !== "REJECTED";
}

// ─── GSTR-1: what we supplied ─────────────────────────────────────────────────

export type B2BInvoice = {
  gstin: string;
  partyName: string;
  docNumber: string;
  issueDate: Date;
  placeOfSupplyCode: string | null;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  total: number;
  /** A credit note reduces what was supplied, so it is carried separately rather than negated in. */
  isCreditNote: boolean;
};

export type B2CSummary = {
  placeOfSupplyCode: string | null;
  taxRatePercent: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
};

export type HsnRow = {
  hsnCode: string;
  description: string;
  unit: string | null;
  quantity: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  total: number;
};

export type Gstr1 = {
  b2b: B2BInvoice[];
  b2c: B2CSummary[];
  hsn: HsnRow[];
  totals: {
    b2bTaxable: number;
    b2cTaxable: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
    invoiceCount: number;
    creditNoteCount: number;
  };
  /** Things that will be rejected at the portal, found here instead. */
  problems: { docNumber: string; issue: string }[];
};

/**
 * Builds GSTR-1 from the period's sales documents.
 *
 * The B2B / B2C split is on whether the customer gave a GSTIN, because that is exactly what decides
 * it: a registered buyer needs the invoice listed to claim credit, an unregistered one does not and
 * only the totals are reported.
 */
export function buildGstr1(docs: ReturnDocument[]): Gstr1 {
  const sales = docs.filter((d) => (d.docType === "INVOICE" || d.docType === "CREDIT_NOTE") && countsForReturn(d));

  const b2b: B2BInvoice[] = [];
  const b2cMap = new Map<string, B2CSummary>();
  const hsnMap = new Map<string, HsnRow>();
  const problems: { docNumber: string; issue: string }[] = [];

  for (const doc of sales) {
    const isCreditNote = doc.docType === "CREDIT_NOTE";

    if (doc.partyGstin) {
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(doc.partyGstin)) {
        problems.push({ docNumber: doc.docNumber, issue: `${doc.partyGstin} isn't a valid GSTIN — the portal will reject this line.` });
      }
      if (!doc.placeOfSupplyCode) {
        problems.push({ docNumber: doc.docNumber, issue: "No place of supply, so the portal can't tell whether this is inter-state." });
      }
      b2b.push({
        gstin: doc.partyGstin,
        partyName: doc.partyName,
        docNumber: doc.docNumber,
        issueDate: doc.issueDate,
        placeOfSupplyCode: doc.placeOfSupplyCode,
        taxableValue: round2(doc.taxableValue),
        cgstAmount: round2(doc.cgstAmount),
        sgstAmount: round2(doc.sgstAmount),
        igstAmount: round2(doc.igstAmount),
        total: round2(doc.total),
        isCreditNote,
      });
    } else {
      // B2C is reported by place of supply and rate, not invoice by invoice — so the lines are what
      // matters, since one invoice can carry several rates.
      for (const line of doc.lines) {
        const key = `${doc.placeOfSupplyCode ?? ""}|${line.taxRatePercent}`;
        const sign = isCreditNote ? -1 : 1;
        const row = b2cMap.get(key) ?? {
          placeOfSupplyCode: doc.placeOfSupplyCode,
          taxRatePercent: line.taxRatePercent,
          taxableValue: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 0,
        };
        row.taxableValue = round2(row.taxableValue + sign * line.taxableValue);
        row.cgstAmount = round2(row.cgstAmount + sign * line.cgstAmount);
        row.sgstAmount = round2(row.sgstAmount + sign * line.sgstAmount);
        row.igstAmount = round2(row.igstAmount + sign * line.igstAmount);
        b2cMap.set(key, row);
      }
    }

    // The HSN summary covers everything, B2B and B2C alike.
    for (const line of doc.lines) {
      const code = line.hsnCode?.trim() || "";
      if (!code) {
        problems.push({ docNumber: doc.docNumber, issue: `"${line.name}" has no HSN or SAC code, and the summary requires one.` });
      }
      const key = code || "(none)";
      const sign = isCreditNote ? -1 : 1;
      const row = hsnMap.get(key) ?? {
        hsnCode: key,
        description: line.name,
        unit: line.unit,
        quantity: 0,
        taxableValue: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        total: 0,
      };
      row.quantity = round2(row.quantity + sign * line.quantity);
      row.taxableValue = round2(row.taxableValue + sign * line.taxableValue);
      row.cgstAmount = round2(row.cgstAmount + sign * line.cgstAmount);
      row.sgstAmount = round2(row.sgstAmount + sign * line.sgstAmount);
      row.igstAmount = round2(row.igstAmount + sign * line.igstAmount);
      row.total = round2(row.taxableValue + row.cgstAmount + row.sgstAmount + row.igstAmount);
      hsnMap.set(key, row);
    }
  }

  const signed = (d: ReturnDocument, v: number) => (d.docType === "CREDIT_NOTE" ? -v : v);
  const totals = sales.reduce(
    (t, d) => ({
      b2bTaxable: round2(t.b2bTaxable + (d.partyGstin ? signed(d, d.taxableValue) : 0)),
      b2cTaxable: round2(t.b2cTaxable + (d.partyGstin ? 0 : signed(d, d.taxableValue))),
      taxableValue: round2(t.taxableValue + signed(d, d.taxableValue)),
      cgst: round2(t.cgst + signed(d, d.cgstAmount)),
      sgst: round2(t.sgst + signed(d, d.sgstAmount)),
      igst: round2(t.igst + signed(d, d.igstAmount)),
      total: round2(t.total + signed(d, d.total)),
      invoiceCount: t.invoiceCount + (d.docType === "INVOICE" ? 1 : 0),
      creditNoteCount: t.creditNoteCount + (d.docType === "CREDIT_NOTE" ? 1 : 0),
    }),
    { b2bTaxable: 0, b2cTaxable: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, total: 0, invoiceCount: 0, creditNoteCount: 0 },
  );

  return {
    b2b: b2b.sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime()),
    b2c: [...b2cMap.values()].sort((a, b) => a.taxRatePercent - b.taxRatePercent),
    hsn: [...hsnMap.values()].sort((a, b) => b.taxableValue - a.taxableValue),
    totals,
    problems,
  };
}

// ─── GSTR-3B: what we owe ─────────────────────────────────────────────────────

export type Gstr3bHead = { cgst: number; sgst: number; igst: number };

export type Gstr3bDiscrepancy = {
  label: string;
  fromDocuments: number;
  fromLedger: number;
  difference: number;
  /**
   * Which way it goes, because the two mean opposite things and need opposite responses.
   *
   * `UNSUPPORTED` — the documents claim more than the books can show. This is the dangerous one: a
   * figure filed that nothing backs is what a departmental audit finds.
   *
   * `UNDER_CLAIMED` — the books hold more than the documents show. Nobody will come after you for
   * this; you are simply leaving your own money behind. Almost always expense claims carrying tax.
   */
  direction: "UNSUPPORTED" | "UNDER_CLAIMED";
};

export type Gstr3b = {
  outward: { taxableValue: number } & Gstr3bHead;
  /**
   * Eligible input credit, and where it came from.
   *
   * The total is taken from the ledger rather than from vendor bills alone, because credit is
   * claimable on any inward supply backed by a tax invoice — an employee's hotel bill is as
   * claimable as a distributor's. Filing only what the Bills list happens to hold means
   * under-claiming every month by whatever the team spent.
   */
  inward: { taxableValue: number; fromBills: Gstr3bHead; fromOther: Gstr3bHead } & Gstr3bHead;
  /** Output tax less the credit claimed. */
  netPayable: Gstr3bHead & { total: number };
  carriedForward: Gstr3bHead;
  /** What the ledger's own tax accounts say. */
  ledger: { outputCgst: number; outputSgst: number; outputIgst: number; inputCgst: number; inputSgst: number; inputIgst: number } | null;
  discrepancies: Gstr3bDiscrepancy[];
};

/**
 * Builds GSTR-3B from the documents and the ledger together.
 *
 * The two sides are not treated the same, and that asymmetry is the whole design:
 *
 *   *Output* tax comes from the documents. You cannot owe output tax without having issued an
 *   invoice, so the invoices are the authority and the ledger is the check. If the ledger disagrees,
 *   something posted that shouldn't have, or an invoice never posted at all.
 *
 *   *Input* tax comes from the ledger. Credit is claimable on any inward supply with a valid tax
 *   invoice, and plenty of those never become a Bill in the system — an employee's hotel bill, a
 *   card payment for software. The bills are a subset, so filing them alone under-claims.
 *
 * Each head is netted on its own, because a credit under one head cannot simply be set against a
 * liability under another beyond the prescribed order.
 */
export function buildGstr3b(params: {
  outwardDocs: ReturnDocument[];
  inwardDocs: ReturnDocument[];
  ledger?: Gstr3b["ledger"];
}): Gstr3b {
  const sum = (docs: ReturnDocument[]) =>
    docs.filter(countsForReturn).reduce(
      (t, d) => {
        const sign = d.docType === "CREDIT_NOTE" ? -1 : 1;
        return {
          taxableValue: round2(t.taxableValue + sign * d.taxableValue),
          cgst: round2(t.cgst + sign * d.cgstAmount),
          sgst: round2(t.sgst + sign * d.sgstAmount),
          igst: round2(t.igst + sign * d.igstAmount),
        };
      },
      { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 },
    );

  const outward = sum(params.outwardDocs);
  const fromBills = sum(params.inwardDocs);

  // Credit from everything else the books recorded — expense claims, mostly. Never negative: a
  // ledger holding *less* than the bills means a bill did not post, which is a problem to fix, not
  // a credit to subtract.
  const other = (ledgerValue: number | undefined, billValue: number) =>
    ledgerValue === undefined ? 0 : Math.max(0, round2(ledgerValue - billValue));

  const fromOther: Gstr3bHead = {
    cgst: other(params.ledger?.inputCgst, fromBills.cgst),
    sgst: other(params.ledger?.inputSgst, fromBills.sgst),
    igst: other(params.ledger?.inputIgst, fromBills.igst),
  };

  const inward = {
    taxableValue: fromBills.taxableValue,
    cgst: round2(fromBills.cgst + fromOther.cgst),
    sgst: round2(fromBills.sgst + fromOther.sgst),
    igst: round2(fromBills.igst + fromOther.igst),
    fromBills: { cgst: fromBills.cgst, sgst: fromBills.sgst, igst: fromBills.igst },
    fromOther,
  };

  const net = (out: number, input: number) => round2(out - input);
  const netPayable = {
    cgst: Math.max(0, net(outward.cgst, inward.cgst)),
    sgst: Math.max(0, net(outward.sgst, inward.sgst)),
    igst: Math.max(0, net(outward.igst, inward.igst)),
    total: 0,
  };
  netPayable.total = round2(netPayable.cgst + netPayable.sgst + netPayable.igst);

  // More credit than liability is not a refund; it carries forward.
  const carriedForward = {
    cgst: Math.max(0, net(inward.cgst, outward.cgst)),
    sgst: Math.max(0, net(inward.sgst, outward.sgst)),
    igst: Math.max(0, net(inward.igst, outward.igst)),
  };

  const discrepancies: Gstr3bDiscrepancy[] = [];
  if (params.ledger) {
    // Output only. The input side no longer has a "discrepancy" to report — the ledger *is* the
    // figure being filed, and what the bills don't cover is shown as its own line instead.
    const checks: [string, number, number][] = [
      ["Output CGST", outward.cgst, params.ledger.outputCgst],
      ["Output SGST", outward.sgst, params.ledger.outputSgst],
      ["Output IGST", outward.igst, params.ledger.outputIgst],
    ];
    for (const [label, fromDocuments, fromLedger] of checks) {
      const difference = round2(fromDocuments - fromLedger);
      if (difference === 0) continue;
      discrepancies.push({
        label,
        fromDocuments,
        fromLedger,
        difference,
        direction: difference > 0 ? "UNSUPPORTED" : "UNDER_CLAIMED",
      });
    }
  }

  return { outward, inward, netPayable, carriedForward, ledger: params.ledger ?? null, discrepancies };
}

// ─── TDS ──────────────────────────────────────────────────────────────────────

export type TdsRow = {
  docNumber: string;
  issueDate: Date;
  partyName: string;
  partyPan: string | null;
  taxableValue: number;
  /** Positive: the amount withheld. */
  amount: number;
};

export type TdsSummary = {
  /** Deducted from vendors and owed to the government. */
  payable: TdsRow[];
  /** Withheld by customers from what they paid us — an asset we later claim. */
  receivable: TdsRow[];
  totals: { payable: number; receivable: number };
  /** The 7th of the following month, which is the date that matters. */
  dueOn: string;
  problems: { docNumber: string; issue: string }[];
};

/**
 * What was withheld, both ways.
 *
 * The due date is the point of the report. TDS deducted in a month is payable by the 7th of the
 * next, and interest runs from the day after at 1.5% a month — so the useful question is never "how
 * much did we deduct" but "how much is due, and by when".
 */
export function buildTdsSummary(params: { docs: ReturnDocument[]; withholdings: { docNumber: string; issueDate: Date; partyName: string; partyPan: string | null; taxableValue: number; withholdingAmount: number; isPurchase: boolean }[]; month: number; year: number }): TdsSummary {
  const payable: TdsRow[] = [];
  const receivable: TdsRow[] = [];
  const problems: { docNumber: string; issue: string }[] = [];

  for (const w of params.withholdings) {
    // The stored figure is signed: negative is TDS, positive is TCS. Only TDS belongs here.
    if (w.withholdingAmount >= 0) continue;
    const row: TdsRow = {
      docNumber: w.docNumber,
      issueDate: w.issueDate,
      partyName: w.partyName,
      partyPan: w.partyPan,
      taxableValue: round2(w.taxableValue),
      amount: round2(Math.abs(w.withholdingAmount)),
    };
    // Without a PAN the deduction is at 20% and the return will not validate, so it is worth saying
    // before the 7th rather than after.
    if (!w.partyPan) {
      problems.push({ docNumber: w.docNumber, issue: `No PAN on file for ${w.partyName} — the return won't validate, and the rate should be 20%.` });
    }
    if (w.isPurchase) payable.push(row);
    else receivable.push(row);
  }

  const due = new Date(Date.UTC(params.year, params.month, 7));
  return {
    payable: payable.sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime()),
    receivable: receivable.sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime()),
    totals: {
      payable: round2(payable.reduce((t, r) => t + r.amount, 0)),
      receivable: round2(receivable.reduce((t, r) => t + r.amount, 0)),
    },
    dueOn: due.toISOString().slice(0, 10),
    problems,
  };
}
