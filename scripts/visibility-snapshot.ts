/**
 * How many records of each kind every user can actually see.
 *
 * Run before and after a scoping change and diff the two. This is the only honest way to know what
 * a row-level change did, because the failure that matters is invisible from the inside: a filter
 * that is too narrow produces a support ticket within the hour, and one that is forgotten produces
 * nothing at all — the person simply keeps seeing everybody's accounts, and nobody reports it.
 *
 *   npm run visibility:snapshot > before.txt
 *   ... change scoping ...
 *   npm run visibility:snapshot > after.txt && diff before.txt after.txt
 */
import { db } from "../src/lib/db";
import { accountScopeIds } from "../src/lib/authz/company-scope";

async function main() {
  const users = await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, email: true, role: true, isSuperAdmin: true },
    orderBy: [{ role: "asc" }, { email: "asc" }],
  });

  const totals = {
    companies: await db.company.count({ where: { relationshipType: "CLIENT" } }),
    orders: await db.companyProduct.count(),
    payments: await db.payment.count(),
    leads: await db.lead.count(),
    tickets: await db.ticket.count(),
    contacts: await db.contact.count(),
  };
  console.log(`# Totals: ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`# Columns: companies orders payments leads tickets contacts  (scope = number of account managers visible through, or ALL)`);
  console.log("");

  for (const u of users) {
    const ids = await accountScopeIds(u.id);
    const scope = ids === null ? {} : { ownerUserId: { in: ids } };
    const via = ids === null ? {} : { company: { ownerUserId: { in: ids } } };

    const [companies, orders, payments, leads, tickets, contacts] = await Promise.all([
      db.company.count({ where: { relationshipType: "CLIENT", ...scope } }),
      db.companyProduct.count({ where: via }),
      db.payment.count({ where: via }),
      db.lead.count({ where: via }),
      db.ticket.count({ where: via }),
      db.contact.count({ where: via }),
    ]);

    const owned = await db.company.count({ where: { ownerUserId: u.id } });
    const label = ids === null ? "ALL" : `${ids.length}`;
    console.log(
      `${u.email.padEnd(32)} [${u.role}${u.isSuperAdmin ? "+super" : ""}] scope=${label.padStart(3)} owns=${String(owned).padStart(3)}  ` +
        `${String(companies).padStart(4)} ${String(orders).padStart(4)} ${String(payments).padStart(4)} ` +
        `${String(leads).padStart(4)} ${String(tickets).padStart(4)} ${String(contacts).padStart(4)}`,
    );
  }

  // Unowned records are invisible to everyone without companies.viewAll, by design. Printing the
  // number keeps that decision honest: if it is most of the database, somebody should know.
  const unowned = await db.company.count({ where: { relationshipType: "CLIENT", ownerUserId: null } });
  console.log(`\n# Client companies with no account manager: ${unowned} of ${totals.companies}`);
  console.log("# These are hidden from anybody without companies.viewAll — a deliberate choice, not an accident.");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
