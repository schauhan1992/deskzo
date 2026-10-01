/**
 * Foreign-currency documents the ledger booked at rate 1, found and posted again at their rate.
 *
 * Until the rate was part of what a document's posting read (journal.ts `documentPostingSelect`),
 * every invoice, credit note and bill in another currency posted its figures as though they were
 * rupees: a $1,000 invoice raised at ₹83.25 booked ₹1,000 of revenue and receivable. This finds each
 * issued one whose live entry's receivable or payable line is not `total × rate`, and repairs it the
 * way an accountant would — never by editing an entry:
 *
 *   · a reversal of the entry, with every line's branch, GSTIN and cost centre kept, and
 *   · the entry written again at the document's rate, under the original's branch and GSTIN,
 *
 * both through `writeEntry`, numbered from the counter and checked against the lock. Both are dated
 * on the original entry's date when that day is open, and on the first open day after the lock when
 * it is not — a closed period is corrected in an open one.
 *
 * Afterwards the re-post is the document's live entry (`currentDocumentEntry`): issuing again finds
 * it, a cancellation reverses it, and a second run finds nothing to do.
 *
 *   npm run ledger:repost-fx                         (scripts/ledger-repost-fx.ts)
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { BASE_CURRENCY, toBase } from "@/lib/currency";
import { bookingRate } from "@/lib/ledger/posting";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { istDateKey } from "@/lib/india-time";
import {
  DOCUMENT_SOURCES,
  documentPostingSelect,
  reversedLines,
  reversibleLineSelect,
  writeDocumentEntry,
  writeEntry,
} from "@/lib/ledger/journal";
import { firstOpenDate } from "@/lib/ledger/period";

type Tx = Prisma.TransactionClient;

export type FxMispost = {
  documentId: string;
  docType: string;
  docNumber: string;
  currency: string;
  rate: number;
  total: number;
  /** `total × rate`, what the receivable or payable should carry. */
  expected: number;
  /** What its live entry's receivable or payable line carries. */
  booked: number;
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  /**
   * Payments recorded against it in rupees at rate 1 — every one taken before the payment screens
   * carried the document's currency. They cleared the receivable by the rate-1 figure, so once the
   * document is at its rate they leave the difference open. The repair does not touch payments.
   */
  ratelessPayments: {
    count: number;
    amount: number;
    /** Each one, with the figures it booked and the ones it should have (`RatelessPayment`). */
    items: RatelessPayment[];
  };
};

/**
 * A payment against a foreign document that was recorded as rupees at rate 1, and what it should have
 * booked. Reported by the dry run and never changed by the repair: re-rating a payment is a decision
 * about the rate the money really came in at, which only somebody who saw the bank statement can make.
 *
 * The "should" figures are at the document's own rate — what the payment screens record by default
 * today — so the party clears exactly; the real rate on the day would add an exchange gain or loss on
 * top, which the dry run says in words rather than guessing.
 */
export type RatelessPayment = {
  paymentId: string;
  paymentSeq: number;
  paidOn: Date;
  /** The figure on the payment, which is really in the document's currency. */
  amount: number;
  /** What its posting took off the party: the amount as rupees. */
  booked: number;
  /** What it should take off the party: amount × the document's rate. */
  expected: number;
  /** `expected − booked`: left on the party until the payment is re-rated. */
  open: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The live-entry filter, as journal.ts `currentDocumentEntry` asks it. */
const LIVE = { source: { in: [...DOCUMENT_SOURCES] }, reversesId: null, reversedBy: { is: null } } satisfies Prisma.JournalEntryWhereInput;

/** The party account a document's own posting runs through: the receivable, or for a bill the payable. */
function partyKey(docType: string) {
  return docType === "BILL" ? SYSTEM_ACCOUNTS.AP : SYSTEM_ACCOUNTS.AR;
}

/** Every issued foreign-currency document whose live entry does not carry `total × rate`. */
export async function findFxMisposts(client: Tx | PrismaClient): Promise<FxMispost[]> {
  const docs = await client.tradeDocument.findMany({
    where: {
      docType: { in: [...DOCUMENT_SOURCES] },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      // A rupee document is booked as written, whatever rate it carries (posting.ts `bookingRate`).
      currency: { not: BASE_CURRENCY },
      journalEntries: { some: LIVE },
      // Re-posting writes the plain invoice entry, with no deferral. Every rate-1 posting predates
      // Revenue & Close, so none should have a schedule — but one that does is left alone rather than
      // re-posted without its deferred revenue.
      revenueSchedules: { none: {} },
      revenueAdjustments: { none: {} },
    },
    orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }],
    select: {
      id: true, docType: true, docNumber: true, currency: true, exchangeRate: true, total: true,
      journalEntries: {
        where: LIVE,
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true, entryNumber: true, date: true,
          lines: { select: { debit: true, credit: true, account: { select: { systemKey: true } } } },
        },
      },
      payments: {
        orderBy: { createdAt: "asc" },
        select: { amount: true, payment: { select: { id: true, paymentSeq: true, paidOn: true, currency: true, exchangeRate: true } } },
      },
    },
  });

  const found: FxMispost[] = [];
  for (const doc of docs) {
    const entry = doc.journalEntries[0];
    if (!entry) continue;
    const rate = bookingRate(doc);
    const total = Number(doc.total);
    const expected = toBase(total, rate);
    const key = partyKey(doc.docType);
    const booked = round2(
      entry.lines.filter((l) => l.account.systemKey === key).reduce((t, l) => t + Number(l.debit) + Number(l.credit), 0),
    );
    if (Math.abs(booked - expected) < 0.005) continue;

    const rateless = doc.payments.filter(
      (p) => p.payment.currency === BASE_CURRENCY && Number(p.payment.exchangeRate) === 1,
    );
    const items: RatelessPayment[] = rateless.map((p) => {
      const amount = Number(p.amount);
      const booked = round2(amount);
      const should = toBase(amount, rate);
      return {
        paymentId: p.payment.id,
        paymentSeq: p.payment.paymentSeq,
        paidOn: p.payment.paidOn,
        amount,
        booked,
        expected: should,
        open: round2(should - booked),
      };
    });
    found.push({
      documentId: doc.id,
      docType: doc.docType,
      docNumber: doc.docNumber,
      currency: doc.currency,
      rate,
      total,
      expected,
      booked,
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.date,
      ratelessPayments: {
        count: rateless.length,
        amount: round2(rateless.reduce((t, p) => t + Number(p.amount), 0)),
        items,
      },
    });
  }
  return found;
}

/**
 * Reverses a document's live entry and posts it again at its rate, in the caller's transaction.
 *
 * Reads everything again inside the transaction, and does nothing when the live entry is no longer
 * wrong — another run got there first, or the document was cancelled in between.
 */
export async function repostFxDocument(
  tx: Tx,
  documentId: string,
  userId: string,
): Promise<{ date: Date; reversal: { id: string; entryNumber: string }; repost: { id: string; entryNumber: string } } | null> {
  const doc = await tx.tradeDocument.findUnique({ where: { id: documentId }, select: documentPostingSelect });
  if (!doc) return null;
  const original = await tx.journalEntry.findFirst({
    where: { documentId, ...LIVE },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, entryNumber: true, date: true, companyId: true,
      lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect },
    },
  });
  if (!original) return null;

  const party = await tx.ledgerAccount.findUnique({ where: { systemKey: partyKey(doc.docType) }, select: { id: true } });
  const partyLines = original.lines.filter((l) => l.accountId === party?.id);
  const booked = round2(partyLines.reduce((t, l) => t + Number(l.debit) + Number(l.credit), 0));
  const rate = bookingRate(doc);
  if (Math.abs(booked - toBase(Number(doc.total), rate)) < 0.005) return null;

  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const date = firstOpenDate(original.date, lock?.lockedUntil);
  const moved = date.getTime() !== original.date.getTime() ? `, dated ${istDateKey(date)} as ${istDateKey(original.date)} is closed` : "";

  const reversal = await writeEntry(tx, {
    date,
    narration: `Reversal of ${original.entryNumber} — ${doc.docNumber} was booked at rate 1, posted again at ${doc.currency} ${rate}${moved}`,
    source: "MANUAL",
    userId,
    lines: reversedLines(original.lines),
    documentId: doc.id,
    companyId: original.companyId,
    reversesId: original.id,
  });

  // Under the original's branch and GSTIN — every line of a document's posting carries the same two,
  // so the party line's are the entry's.
  const tagged = partyLines[0] ?? original.lines[0];
  const repost = await writeDocumentEntry(tx, doc, userId, {
    date,
    note: `at ${doc.currency} ${rate}, replacing ${original.entryNumber}`,
    tags: { branchId: tagged?.branchId ?? null, gstRegistrationId: tagged?.gstRegistrationId ?? null },
  });

  return { date, reversal, repost };
}

/** Who the repair's entries are attributed to: the workspace's one super admin. */
export async function repairActor(client: Tx | PrismaClient) {
  const admin = await client.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true, email: true } });
  if (!admin) throw new Error("This workspace has no super admin to attribute the repair to.");
  return admin;
}

export type RepairOutcome = {
  found: FxMispost[];
  repaired: { docNumber: string; reversal: string; repost: string; date: Date }[];
  failures: { docNumber: string; error: string }[];
};

/**
 * The whole repair on one workspace's database: what is wrong, and — with `apply` — each document
 * put right in a transaction of its own, so one that fails (a chart somebody broke, say) leaves the
 * others repaired and is reported rather than stopping the run.
 */
export async function repairFxPostings(
  client: PrismaClient,
  options: { apply: boolean; say?: (line: string) => void },
): Promise<RepairOutcome> {
  const say = options.say ?? (() => {});
  const found = await findFxMisposts(client);
  const outcome: RepairOutcome = { found, repaired: [], failures: [] };
  if (found.length === 0) {
    say("  Nothing to repair: every foreign-currency document is booked at its rate.");
    return outcome;
  }

  const lock = await client.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const m of found) {
    const on = firstOpenDate(m.entryDate, lock?.lockedUntil);
    say(
      `  ${m.docType.padEnd(11)} ${m.docNumber}  ${m.currency} ${m.total.toFixed(2)} @ ${m.rate}` +
        `  booked ${inr(m.booked)}, should be ${inr(m.expected)}  (${m.entryNumber}, ${istDateKey(m.entryDate)}` +
        `${on.getTime() !== m.entryDate.getTime() ? ` → re-posted ${istDateKey(on)}, after the lock` : ""})`,
    );
    if (m.ratelessPayments.count > 0) {
      const open = round2(m.ratelessPayments.items.reduce((t, p) => t + p.open, 0));
      say(
        `      ${m.ratelessPayments.count} payment(s) against it were recorded in rupees at rate 1 (${m.ratelessPayments.amount.toFixed(2)});` +
          ` they are not re-posted, so ${inr(open)} stays open on the party until they are.`,
      );
      // What each should have been: in the document's currency, clearing amount × its rate. Nothing is
      // written for them, with or without --apply.
      for (const p of m.ratelessPayments.items) {
        say(
          `        payment #${p.paymentSeq} (${istDateKey(p.paidOn)}): recorded ₹${p.amount.toFixed(2)} at 1, clearing ${inr(p.booked)};` +
            ` as ${m.currency} ${p.amount.toFixed(2)} at the document's ${m.rate} it clears ${inr(p.expected)}, leaving ${inr(p.open)} open.` +
            ` Re-rated to the rate it really came in at, the difference from ${inr(p.expected)} is an exchange gain or loss.`,
        );
      }
    }
  }
  if (!options.apply) {
    say(`  ${found.length} document(s) would be repaired. Nothing was written — run again with --apply.`);
    return outcome;
  }

  const actor = await repairActor(client);
  for (const m of found) {
    try {
      const done = await client.$transaction((tx) => repostFxDocument(tx, m.documentId, actor.id));
      if (!done) continue;
      outcome.repaired.push({ docNumber: m.docNumber, reversal: done.reversal.entryNumber, repost: done.repost.entryNumber, date: done.date });
      say(`  ✓ ${m.docNumber}: reversed by ${done.reversal.entryNumber}, posted again as ${done.repost.entryNumber} on ${istDateKey(done.date)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failures.push({ docNumber: m.docNumber, error: message });
      say(`  ✗ ${m.docNumber}: ${message}`);
    }
  }
  say(`  Repaired ${outcome.repaired.length} of ${found.length}, as ${actor.name}.`);
  return outcome;
}
