/**
 * Agreeing the bank's record with ours.
 *
 * Pure, so the matching rules can be tested without a database — and they are worth testing, because
 * a wrong automatic match is worse than no match at all. It silently ties a statement row to the
 * wrong payment, both sides then look reconciled, and the real difference surfaces months later
 * with nothing to trace it back to.
 *
 * So the rule here is deliberately strict: an exact amount, a date within a few days, and only when
 * exactly one candidate fits. Anything else is left for a person.
 */

export type StatementRow = {
  id: string;
  date: Date;
  narration: string;
  reference: string | null;
  /** Signed: positive is money into the account. */
  amount: number;
};

export type BookRow = {
  /** The journal line id. */
  id: string;
  date: Date;
  narration: string;
  reference: string | null;
  /** Signed the same way: positive is money in, i.e. a debit to the bank account. */
  amount: number;
};

export type Suggestion = { statementLineId: string; bookLineId: string; confidence: "EXACT" | "LIKELY"; why: string };

/** How far apart a statement date and a book date may be and still be the same event. */
const NEAR_DAYS = 5;

function daysApart(a: Date, b: Date) {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86400000));
}

function normaliseRef(ref: string | null) {
  return (ref ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Pairs statement rows with book rows.
 *
 * Greedy and one-to-one: once a book line is spoken for it can't be matched again, which stops one
 * payment satisfying two statement rows of the same amount — the exact case that makes a
 * reconciliation look finished while being out by that amount.
 */
export function suggestMatches(statement: StatementRow[], book: BookRow[]): Suggestion[] {
  const out: Suggestion[] = [];
  const takenBook = new Set<string>();

  // Reference matches first. A UTR or cheque number appearing on both sides is the strongest signal
  // there is, and taking those first stops a weaker amount-and-date match stealing the line.
  for (const s of statement) {
    const ref = normaliseRef(s.reference);
    if (ref.length < 4) continue;
    const candidates = book.filter(
      (b) =>
        !takenBook.has(b.id) &&
        b.amount === s.amount &&
        normaliseRef(b.reference).length >= 4 &&
        (normaliseRef(b.reference) === ref ||
          normaliseRef(s.narration).includes(normaliseRef(b.reference))),
    );
    if (candidates.length === 1) {
      takenBook.add(candidates[0].id);
      out.push({
        statementLineId: s.id,
        bookLineId: candidates[0].id,
        confidence: "EXACT",
        why: "Same reference and the same amount",
      });
    }
  }

  const matchedStatement = new Set(out.map((m) => m.statementLineId));

  for (const s of statement) {
    if (matchedStatement.has(s.id)) continue;
    const candidates = book.filter(
      (b) => !takenBook.has(b.id) && b.amount === s.amount && daysApart(b.date, s.date) <= NEAR_DAYS,
    );
    // Only when it is unambiguous. Two payments of ₹50,000 in the same week are exactly the case
    // where guessing produces a reconciliation that is wrong and looks right.
    if (candidates.length !== 1) continue;
    takenBook.add(candidates[0].id);
    out.push({
      statementLineId: s.id,
      bookLineId: candidates[0].id,
      confidence: daysApart(candidates[0].date, s.date) === 0 ? "EXACT" : "LIKELY",
      why:
        daysApart(candidates[0].date, s.date) === 0
          ? "Same amount on the same day, and nothing else it could be"
          : `Same amount, ${daysApart(candidates[0].date, s.date)} day(s) apart, and nothing else it could be`,
    });
  }

  return out;
}

export type ReconciliationSummary = {
  /** What the bank says the balance is. */
  statementBalance: number;
  /** What the ledger says, as at the same date. */
  bookBalance: number;
  /** Book entries the bank hasn't shown yet — usually cheques that haven't been presented. */
  unmatchedBook: BookRow[];
  /** Statement rows with nothing behind them — usually charges and interest nobody has recorded. */
  unmatchedStatement: StatementRow[];
  /** The book balance adjusted for what is still in flight; this is the figure that should agree. */
  adjustedBalance: number;
  difference: number;
  reconciled: boolean;
};

/**
 * The reconciliation itself.
 *
 * `adjustedBalance` is the point of the whole exercise: the book balance plus everything the bank
 * has not yet seen. A reconciliation that only compares two closing figures tells you *that* you
 * are out; this tells you by what, and what is still in the post.
 */
export function reconcile(params: {
  statementBalance: number;
  bookBalance: number;
  statement: StatementRow[];
  book: BookRow[];
  matchedStatementIds: Set<string>;
  matchedBookIds: Set<string>;
}): ReconciliationSummary {
  const unmatchedStatement = params.statement.filter((s) => !params.matchedStatementIds.has(s.id));
  const unmatchedBook = params.book.filter((b) => !params.matchedBookIds.has(b.id));

  const inFlight = unmatchedBook.reduce((t, b) => t + b.amount, 0);
  const notInBooks = unmatchedStatement.reduce((t, s) => t + s.amount, 0);

  // Take the bank's figure back to what our books should say: remove what the bank has recorded and
  // we have not, and add back what we have recorded and the bank has not yet seen.
  const adjustedBalance = round2(params.statementBalance - notInBooks + inFlight);
  const difference = round2(params.bookBalance - adjustedBalance);

  return {
    statementBalance: round2(params.statementBalance),
    bookBalance: round2(params.bookBalance),
    unmatchedBook,
    unmatchedStatement,
    adjustedBalance,
    difference,
    reconciled: difference === 0,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Identifies a statement row well enough that importing the same statement twice is a no-op.
 *
 * Deliberately built from what the bank gave us rather than from a row number: the same statement
 * downloaded a second time will have the same date, amount, reference and narration, but need not
 * arrive in the same order or with the same surrounding rows.
 */
export function statementFingerprint(row: { date: string; amount: number; reference: string | null; narration: string }) {
  return [
    row.date,
    row.amount.toFixed(2),
    normaliseRef(row.reference),
    row.narration.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80),
  ].join("|");
}

/**
 * Reads a bank statement CSV.
 *
 * Indian bank exports vary wildly, so the columns are found by name rather than by position, and
 * both shapes are accepted: a single signed amount, or the separate debit and credit columns most
 * Indian banks produce. A row that yields no amount is skipped rather than imported as zero —
 * statements carry header junk, opening-balance lines and totals, and importing those as
 * transactions is how a reconciliation ends up permanently out.
 */
export function parseStatementCsv(text: string): { rows: { date: string; narration: string; reference: string | null; amount: number }[]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());

  /**
   * Finds a column by name.
   *
   * Short aliases like "dr" and "cr" are matched as whole words only, because a plain substring
   * search finds "cr" inside "Description" and then reads the narration as a credit column —
   * after which every row parses to zero and the whole statement is silently skipped.
   */
  const find = (...names: string[]) =>
    header.findIndex((h) => {
      const words = h.split(/[^a-z0-9]+/).filter(Boolean);
      return names.some((n) => (n.length <= 3 ? words.includes(n) : h.includes(n)));
    });

  const iDate = find("date", "txn date", "value date");
  const iNarration = find("narration", "description", "particulars", "remarks", "details");
  const iRef = find("ref", "cheque", "utr", "chq");
  const iAmount = find("amount");
  const iDebit = find("withdrawal", "debit", "dr");
  const iCredit = find("deposit", "credit", "cr");

  const rows: { date: string; narration: string; reference: string | null; amount: number }[] = [];
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const rawDate = iDate >= 0 ? cells[iDate]?.trim() : "";
    const date = parseDate(rawDate ?? "");
    if (!date) {
      skipped += 1;
      continue;
    }

    let amount = 0;
    if (iDebit >= 0 || iCredit >= 0) {
      const debit = toNumber(cells[iDebit]);
      const credit = toNumber(cells[iCredit]);
      amount = credit - debit;
    } else if (iAmount >= 0) {
      amount = toNumber(cells[iAmount]);
    }
    if (!amount) {
      skipped += 1;
      continue;
    }

    rows.push({
      date,
      narration: (iNarration >= 0 ? cells[iNarration] : "")?.trim() || "(no description)",
      reference: (iRef >= 0 ? cells[iRef]?.trim() : "") || null,
      amount: round2(amount),
    });
  }

  return { rows, skipped };
}

function toNumber(cell: string | undefined) {
  if (!cell) return 0;
  // Indian exports carry commas, currency symbols and the occasional trailing Cr/Dr.
  const cleaned = cell.replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** dd/mm/yyyy, dd-mm-yyyy and yyyy-mm-dd, which between them cover what Indian banks export. */
function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.exec(trimmed);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    if (Number(month) > 12) return null;
    return `${year}-${month}-${day}`;
  }
  return null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}
