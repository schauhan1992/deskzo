/**
 * Posts every already-issued document and recorded payment to the ledger.
 *
 * The ledger arrived after the documents did, so without this the books open empty while the
 * invoices they should describe already exist. Idempotent — `postDocumentToLedger` skips anything
 * already posted — so it's safe to re-run after a partial failure.
 *
 *   npm run ledger:backfill
 */
import { directClient } from "../src/lib/tenancy/direct-client";
import { ensureChartOfAccounts, postDocumentToLedger, postPaymentToLedger } from "../src/lib/ledger/journal";

const db = directClient();

async function main() {
  await ensureChartOfAccounts();

  // Whoever the entries are attributed to has to be a real user; an admin is the honest choice for
  // a backfill, since no one actually keyed these.
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true, name: true } });
  if (!admin) throw new Error("No active admin to attribute the backfill to.");

  const docs = await db.tradeDocument.findMany({
    where: {
      docType: { in: ["INVOICE", "CREDIT_NOTE", "BILL"] },
      status: { notIn: ["DRAFT", "CANCELLED"] },
      journalEntries: { none: {} },
    },
    orderBy: { issueDate: "asc" },
    select: { id: true, docNumber: true, docType: true },
  });

  let posted = 0;
  const failures: string[] = [];
  for (const doc of docs) {
    try {
      const entry = await db.$transaction((tx) => postDocumentToLedger(tx, doc.id, admin.id));
      if (entry) {
        posted++;
        console.log(`  ${doc.docType.padEnd(12)} ${doc.docNumber.padEnd(24)} → ${entry.entryNumber}`);
      }
    } catch (error) {
      failures.push(`${doc.docNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const payments = await db.payment.findMany({
    where: { journalEntries: { none: {} } },
    orderBy: { paidOn: "asc" },
    select: { id: true, amount: true, company: { select: { name: true } } },
  });

  let paid = 0;
  for (const payment of payments) {
    try {
      const entry = await db.$transaction((tx) => postPaymentToLedger(tx, payment.id, admin.id));
      if (entry) {
        paid++;
        console.log(`  PAYMENT      ₹${Number(payment.amount).toFixed(2).padEnd(23)} → ${entry.entryNumber}  ${payment.company.name}`);
      }
    } catch (error) {
      failures.push(`payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\nPosted ${posted} document(s) and ${paid} payment(s).`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await db.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
