/**
 * Switches the customer portal on and issues a link to a real customer.
 *
 *   npm run db:seed:portal
 *
 * Picks a company that actually has subscriptions, invoices and tickets, so the page has something
 * on it — a portal seeded against an empty customer shows three headings and the word "nothing",
 * which tells you nothing about whether it works.
 *
 * Prints the link. Open it in a private window: it needs no sign-in, which is the whole point.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";

async function main() {
  const user = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
  if (!user) throw new Error("No admin user — seed the app first.");

  /**
   * A customer with something to look at, and not one a reseller owns.
   *
   * Ordered by how much they have, because the most interesting portal is the fullest one.
   */
  const candidates = await db.company.findMany({
    where: {
      relationshipType: "CLIENT",
      managedByResellerId: null,
      products: { some: { orderStatus: { in: ["APPROVED", "PROCESSING", "FULFILLED"] } } },
      contacts: { some: {} },
    },
    select: {
      id: true,
      name: true,
      contacts: { select: { id: true, name: true, email: true }, take: 1 },
      _count: { select: { products: true, tradeDocuments: true, tickets: true } },
    },
    take: 60,
  });

  const best = candidates
    .filter((c) => c.contacts.length > 0)
    .sort(
      (a, b) =>
        b._count.products + b._count.tradeDocuments * 2 + b._count.tickets * 2 -
        (a._count.products + a._count.tradeDocuments * 2 + a._count.tickets * 2),
    )[0];

  if (!best) {
    console.log("\n  No customer with orders and a contact. Seed the demo data first:\n");
    console.log("    npm run db:seed:demo\n");
    process.exitCode = 1;
    return;
  }

  // On, but only for chosen customers — the state a business should start in, not "everybody".
  await db.portalSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      enabled: true,
      access: "SELECTED",
      showSubscriptions: true,
      showInvoices: true,
      showTickets: true,
      allowRenewalRequest: true,
      allowSeatRequest: true,
      allowQuestion: true,
      welcomeMessage: "Anything urgent, call your account manager on 022-4000 1234.",
      updatedById: user.id,
    },
    update: { enabled: true, access: "SELECTED", updatedById: user.id },
  });

  await db.company.update({ where: { id: best.id }, data: { portalEnabled: true } });

  const contact = best.contacts[0]!;
  await db.portalLogin.deleteMany({ where: { companyId: best.id, personName: contact.name } });

  const token = randomBytes(24).toString("base64url");
  await db.portalLogin.create({
    data: {
      token,
      companyId: best.id,
      contactId: contact.id,
      personName: contact.name,
      personEmail: contact.email,
      createdById: user.id,
    },
  });

  console.log(`\n  Portal is on, for selected customers only.`);
  console.log(`  Granted to ${best.name} — ${best._count.products} orders, ${best._count.tradeDocuments} documents, ${best._count.tickets} tickets.`);
  console.log(`  Link issued to ${contact.name}${contact.email ? ` <${contact.email}>` : ""}.\n`);
  console.log(`    http://localhost:3000/portal/${token}\n`);
  console.log(`  Settings: /settings/portal · Requests: /customer-requests · Grant: the Portal tab on a company.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
