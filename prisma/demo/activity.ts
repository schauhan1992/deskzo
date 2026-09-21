import { PrismaClient, Prisma } from "@prisma/client";
import type { SeededCompany } from "./companies";
import type { SeededItem } from "./catalogue";
import type { SeededPerson } from "./people";
import {
  chance,
  daysAgo,
  daysAhead,
  duringWorkHours,
  int,
  log,
  pick,
  rnd,
  some,
  sometimeLastYear,
} from "./shared";

/**
 * A year of the business actually running.
 *
 * ## Everything hangs off something
 *
 * A won lead has a quotation; a quotation that was accepted has an invoice; an invoice that is paid
 * has a payment against it; a subscription sold has a renewal date twelve months out. Seeding these
 * independently produces a database that looks full and falls apart the moment somebody clicks
 * through — an invoice for a company with no order, a payment against nothing.
 *
 * So this walks the chain. It is slower than bulk inserts and worth it: every figure on every
 * dashboard reconciles with the records underneath it, which is the only way a demo survives being
 * poked at.
 *
 * ## The shape of a year
 *
 * Renewals are the heart of this business, so subscriptions are dated across the whole twelve
 * months ahead — some expiring next week, some expired and not yet chased, most comfortably out.
 * That is what makes the renewals screen and its notifications say something on the day it is
 * opened rather than being uniformly empty or uniformly red.
 */

/** One annual term, counted the way `termDays` counts it: both ends included. */
const TERM_DAYS = 365;
/**
 * How many of something a customer of this size would buy.
 *
 * Price is the best available proxy for what a line item is. Nobody buys twenty-two rack servers at
 * once — they buy one, maybe two — while a company does buy a hundred and forty mailbox licences.
 * Getting this wrong is what produces a demo with a single order worth a crore sitting next to a
 * pipeline that makes no sense.
 *
 * Seat-based subscriptions are additionally capped at the customer's own headcount, because
 * selling 150 licences to a company of 24 people is the kind of detail somebody notices.
 */
function quantityFor(item: SeededItem, employeeCount: number): number {
  if (item.type === "SUBSCRIPTION") {
    // Anything priced like a per-seat licence scales with the company; the big-ticket engineering
    // seats and consumption commitments do not.
    if (item.price > 40000) return int(1, 4);
    const cap = Math.max(3, Math.round(employeeCount * (0.3 + rnd() * 0.6)));
    return Math.min(cap, int(5, 160));
  }
  if (item.type === "SERVICE") {
    // Per-unit services (per mailbox, per visit) go large; fixed-scope ones are bought once.
    return item.price <= 3000 ? int(10, Math.max(20, employeeCount)) : 1;
  }
  // Hardware, by how expensive it is.
  if (item.price > 250000) return int(1, 2);
  if (item.price > 80000) return int(1, 4);
  if (item.price > 30000) return int(1, 12);
  return int(2, 40);
}

export async function seedActivity(
  db: PrismaClient,
  companies: SeededCompany[],
  items: SeededItem[],
  people: SeededPerson[],
) {
  const sales = people.filter((p) => p.dept === "Sales");
  const callers = people.filter((p) => p.dept === "Inside Sales");
  const support = people.filter((p) => p.dept === "Support");
  const accounts = people.filter((p) => p.dept === "Accounts");
  const purchase = people.filter((p) => p.dept === "Purchase");
  const field = people.filter((p) => p.title === "Field Engineer");

  const customers = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");
  const liveLeads = companies.filter((c) => c.stage === "LEAD");
  const prospects = companies.filter((c) => c.stage === "PROSPECT");
  const subscriptions = items.filter((i) => i.type === "SUBSCRIPTION");
  const goods = items.filter((i) => i.type === "GOOD");
  const services = items.filter((i) => i.type === "SERVICE");

  // ── Leads ───────────────────────────────────────────────────────────────────────────────────
  let leadCount = 0;
  let requirementCount = 0;
  const wonLeads: { id: string; company: SeededCompany; ownerId: string; value: number; at: Date }[] = [];

  const leadTitles = [
    "M365 renewal and seat expansion",
    "Laptop refresh — 40 units",
    "Firewall replacement",
    "Adobe CC licences for the design team",
    "AutoCAD subscription renewal",
    "Server and backup refresh",
    "Email migration from on-prem Exchange",
    "Endpoint security for 120 seats",
    "Meeting room AV",
    "Annual maintenance contract",
    "Wi-Fi coverage across the plant",
    "NAS for design file storage",
  ];

  for (const company of [...customers, ...liveLeads, ...some(prospects, 60)]) {
    const count = company.stage === "CUSTOMER" ? int(1, 4) : company.stage === "LEAD" ? int(1, 2) : 1;
    for (let i = 0; i < count; i++) {
      const owner = company.ownerId ?? pick(sales).id;
      const createdAt = sometimeLastYear();
      // Customers have won leads behind them; live leads are mid-pipeline; prospects mostly died.
      const status =
        company.stage === "CUSTOMER"
          ? pick(["WON", "WON", "WON", "LOST"] as const)
          : company.stage === "LEAD"
            ? pick(["NEW", "CONTACTED", "QUALIFYING", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION"] as const)
            : pick(["LOST", "DISQUALIFIED", "CONTACTED"] as const);

      const picked = some([...subscriptions, ...goods, ...services], int(1, 3));
      const value = picked.reduce((sum, item) => sum + item.price * int(1, 25), 0);

      const lead = await db.lead.create({
        data: {
          companyId: company.id,
          contactId: company.contactIds[0] ?? null,
          title: pick(leadTitles),
          status,
          estimatedValue: new Prisma.Decimal(value),
          expectedCloseDate: daysAhead(int(-120, 90)),
          ownerUserId: owner,
          sourcedByUserId: chance(0.5) ? pick(callers).id : owner,
          createdByUserId: owner,
          createdAt,
          updatedAt: new Date(createdAt.getTime() + int(1, 60) * 86400000),
          lostReason: status === "LOST" ? pick(["Price", "Went with incumbent", "Budget pulled", "No response"]) : null,
          requirements: {
            create: picked.map((item) => ({
              itemId: item.id,
              quantity: int(1, 25),
              notes: chance(0.3) ? "Confirmed on the call" : null,
            })),
          },
        },
        select: { id: true },
      });
      leadCount += 1;
      requirementCount += picked.length;
      if (status === "WON") wonLeads.push({ id: lead.id, company, ownerId: owner, value, at: createdAt });
    }
  }
  log("Leads", `${leadCount} with ${requirementCount} requirement lines, ${wonLeads.length} won`);

  // ── Orders and subscriptions ────────────────────────────────────────────────────────────────
  let orderCount = 0;
  let renewalsDue = 0;
  const orders: { id: string; company: SeededCompany; value: number; at: Date }[] = [];

  for (const won of wonLeads) {
    const lineCount = int(1, 3);
    for (let i = 0; i < lineCount; i++) {
      const item = pick(items);
      const unitPrice = Math.round(item.price * (0.88 + rnd() * 0.14));
      const quantity = quantityFor(item, won.company.employeeCount);

      /**
       * When this was sold.
       *
       * Most orders follow their lead by a few weeks. A fifth of the subscriptions are backdated
       * well beyond that, and they are the important ones: a subscription sold within the last
       * twelve months cannot have lapsed yet, so without them the renewals screen shows nothing
       * overdue and the module looks like it does nothing. A real book always has a tail of
       * renewals somebody did not chase.
       */
      const isSub = item.type === "SUBSCRIPTION";

      /**
       * For a subscription, pick when it *expires* and work backwards to when it was sold.
       *
       * The other way round — pick a sale date and add a year — leaves the renewal pipeline to
       * chance, and chance produced two renewals in the next thirty days out of a hundred and
       * forty subscriptions. That is the one bucket the renewals screen exists for.
       *
       * Deciding the expiry directly means the shape is stated rather than hoped for: a tail of
       * lapsed ones nobody chased, a working list for this month, a quarter's visibility ahead,
       * and the bulk comfortably out.
       */
      const expiresIn = isSub
        ? pick([
            ...Array.from({ length: 18 }, () => int(-300, -5)),
            ...Array.from({ length: 22 }, () => int(0, 30)),
            ...Array.from({ length: 20 }, () => int(31, 90)),
            ...Array.from({ length: 40 }, () => int(91, 365)),
          ])
        : null;

      /**
       * Clamped to today rather than skipped.
       *
       * A lead won last week plus a six-week lag lands in the future, and skipping those left won
       * deals with nothing sold against them — which is the most obvious tell that a database was
       * generated rather than lived in. The order simply books on the most recent working day
       * instead, which is what would have happened.
       */
      /**
       * A year back from the expiry is 364 days, not 365.
       *
       * A term runs to the day *before* its anniversary — 29/10/2025 to 28/10/2026 — which is what
       * `nextTerm` produces and what `termDays` counts, inclusively, as 365. Taking a flat 365 back
       * from the end date makes every seeded term 366 days long, and then every pro-rata figure
       * worked out against it is a day's worth wrong and the panel says “366 days” to somebody who
       * knows perfectly well the year is not a leap year.
       */
      const nominal = isSub
        ? daysAhead(expiresIn! - (TERM_DAYS - 1))
        : new Date(won.at.getTime() + int(3, 45) * 86400000);
      const soldOn = nominal > new Date() ? daysAgo(int(0, 5)) : nominal;

      const endDate = isSub ? daysAhead(expiresIn!) : null;
      if (endDate && endDate <= daysAhead(45)) renewalsDue += 1;

      const order = await db.companyProduct.create({
        data: {
          companyId: won.company.id,
          locationId: won.company.locationId,
          itemId: item.id,
          quantity,
          unitPrice: new Prisma.Decimal(unitPrice),
          purchasePrice: new Prisma.Decimal(Math.round(item.cost * (0.97 + rnd() * 0.06))),
          startDate: soldOn,
          endDate,
          orderStatus: pick(["FULFILLED", "FULFILLED", "FULFILLED", "PROCESSING", "APPROVED"] as const),
          businessType: isSub
            ? pick(["NEW", "NEW", "RENEWAL", "NEW_TO_US_RENEWAL", "ADDON"] as const)
            : "NEW",
          addedByUserId: won.ownerId,
          purchasedByUserId: chance(0.8) ? pick(purchase).id : null,
          accountsApprovedByUserId: chance(0.85) ? pick(accounts).id : null,
          accountsApprovedAt: soldOn,
          createdAt: soldOn,
          fulfilledAt: soldOn,
          poNumber: `PO/${int(1000, 9999)}`,
        },
        select: { id: true },
      });
      orders.push({ id: order.id, company: won.company, value: unitPrice * quantity, at: soldOn });
      orderCount += 1;
    }
  }
  log("Orders", `${orderCount} lines, ${renewalsDue} renewals falling due within 45 days`);

  // ── Payments ────────────────────────────────────────────────────────────────────────────────
  let paymentCount = 0;
  let paymentValue = 0;
  for (const order of orders) {
    if (!chance(0.72)) continue;
    // Part payments are normal in this trade — an advance, then the balance on delivery.
    const parts = chance(0.25) ? 2 : 1;
    const total = Math.round(order.value * 1.18);
    for (let i = 0; i < parts; i++) {
      const amount = parts === 1 ? total : Math.round(total * (i === 0 ? 0.4 : 0.6));
      const paidOn = new Date(order.at.getTime() + int(5, 75) * 86400000);
      if (paidOn > new Date()) continue;
      await db.payment.create({
        data: {
          companyId: order.company.id,
          // Money coming in. Allocation to a specific invoice is the settlement module's job and
          // is left to it — an unallocated receipt is a real state the app already models.
          direction: "RECEIVED",
          amount: new Prisma.Decimal(amount),
          paidOn,
          method: pick(["BANK_TRANSFER", "BANK_TRANSFER", "BANK_TRANSFER", "UPI", "CHEQUE"] as const),
          reference: `UTR${int(100000000, 999999999)}`,
          recordedByUserId: pick(accounts).id,
          createdAt: paidOn,
        },
      });
      paymentCount += 1;
      paymentValue += amount;
    }
  }
  log("Payments", `${paymentCount} totalling ₹${(paymentValue / 10000000).toFixed(2)} crore`);

  // ── Tickets ─────────────────────────────────────────────────────────────────────────────────
  const ticketTitles = [
    "Outlook not syncing after password change",
    "Cannot print to the shared printer",
    "Licence shows expired on two machines",
    "VPN drops every few minutes",
    "New joiner needs a mailbox",
    "Laptop very slow after update",
    "Backup job failed last night",
    "Firewall blocking the ERP port",
    "Shared drive permissions",
    "Teams call quality poor from the plant",
    "Need an additional AutoCAD seat",
    "Server disk nearly full",
  ];
  let ticketCount = 0;
  let openTickets = 0;
  for (const company of customers) {
    for (let i = 0; i < int(0, 6); i++) {
      const createdAt = duringWorkHours(sometimeLastYear());
      const status = pick(["CLOSED", "CLOSED", "RESOLVED", "RESOLVED", "IN_PROGRESS", "OPEN", "ON_HOLD"] as const);
      const closed = status === "CLOSED" || status === "RESOLVED";
      await db.ticket.create({
        data: {
          companyId: company.id,
          contactId: company.contactIds[0] ?? null,
          title: pick(ticketTitles),
          description: "Reported by the customer over the phone.",
          priority: pick(["LOW", "MEDIUM", "MEDIUM", "HIGH", "URGENT"] as const),
          ticketType: pick(["PRODUCT_SUPPORT", "INSTALLATION", "TRAINING", "DEMO", "OTHER"] as const),
          status,
          assignedToUserId: pick(support).id,
          createdByUserId: pick([...support, ...sales]).id,
          createdAt,
          resolvedAt: closed ? new Date(createdAt.getTime() + int(1, 96) * 3600000) : null,
          closedAt: status === "CLOSED" ? new Date(createdAt.getTime() + int(2, 120) * 3600000) : null,
        },
      });
      ticketCount += 1;
      if (!closed) openTickets += 1;
    }
  }
  log("Tickets", `${ticketCount}, ${openTickets} still open`);

  // ── Calls ───────────────────────────────────────────────────────────────────────────────────
  // The calling team works prospects, which is where most of this volume is.
  let callCount = 0;
  for (const company of [...prospects, ...liveLeads]) {
    for (let i = 0; i < int(0, 5); i++) {
      const startedAt = duringWorkHours(sometimeLastYear());
      const outcome = pick([
        "CONNECTED", "CONNECTED", "NO_ANSWER", "NO_ANSWER", "BUSY",
        "SWITCHED_OFF", "CALLBACK_REQUESTED", "NOT_INTERESTED", "WRONG_NUMBER",
      ] as const);
      await db.callLog.create({
        data: {
          companyId: company.id,
          contactId: company.contactIds[0] ?? null,
          phoneNumber: `+91 9${int(100000000, 999999999)}`,
          outcome,
          startedAt,
          durationSeconds: outcome === "CONNECTED" ? int(45, 900) : int(3, 25),
          notes: outcome === "CONNECTED" ? pick(["Asked for a quote", "Renewal is in March", "Send the deck", "Not the right person"]) : null,
          userId: pick(callers).id,
          createdAt: startedAt,
        },
      });
      callCount += 1;
    }
  }
  log("Call logs", `${callCount}`);

  // ── Field visits ────────────────────────────────────────────────────────────────────────────
  let visitCount = 0;
  for (const company of some(customers, Math.floor(customers.length * 0.6))) {
    for (let i = 0; i < int(1, 3); i++) {
      const scheduledFor = duringWorkHours(sometimeLastYear());
      const done = scheduledFor < new Date();
      await db.visit.create({
        data: {
          companyId: company.id,
          locationId: company.locationId,
          userId: pick([...field, ...sales]).id,
          purpose: pick([
            "DELIVERY_INSTALLATION",
            "SUPPORT_ESCALATION",
            "RELATIONSHIP_BUILDING",
            "REQUIREMENT_GATHERING",
            "PAYMENT_FOLLOW_UP",
            "PRODUCT_DEMO",
          ] as const),
          scheduledFor,
          checkInAt: done ? scheduledFor : null,
          checkOutAt: done ? new Date(scheduledFor.getTime() + int(30, 240) * 60000) : null,
          status: done ? "COMPLETED" : "PLANNED",
          outcome: done ? "Attended, customer satisfied." : null,
          createdAt: scheduledFor,
        },
      });
      visitCount += 1;
    }
  }
  log("Field visits", `${visitCount}`);

  // ── Expenses ────────────────────────────────────────────────────────────────────────────────
  let expenseCount = 0;
  for (const person of [...field, ...sales]) {
    for (let i = 0; i < int(2, 10); i++) {
      const spentOn = sometimeLastYear();
      const status = pick(["REIMBURSED", "REIMBURSED", "APPROVED", "SUBMITTED", "DRAFT", "REJECTED"] as const);
      await db.expense.create({
        data: {
          userId: person.id,
          amount: new Prisma.Decimal(int(180, 4800)),
          spentOn,
          description: pick(["Client visit — cab", "Fuel top-up", "Site travel", "Customer lunch", "Parking & tolls", "Courier to customer"]),
          category: pick(["TRAVEL", "FUEL", "TOLL_PARKING", "MEALS", "CLIENT_ENTERTAINMENT", "COURIER"] as const),
          status,
          createdAt: spentOn,
        },
      });
      expenseCount += 1;
    }
  }
  log("Expenses", `${expenseCount} claims`);

  // ── Tasks ───────────────────────────────────────────────────────────────────────────────────
  let taskCount = 0;
  for (const person of people) {
    for (let i = 0; i < int(1, 8); i++) {
      const createdAt = sometimeLastYear();
      const done = chance(0.65);
      const company = chance(0.7) ? pick(companies) : null;
      await db.task.create({
        data: {
          title: pick([
            "Follow up on the quotation",
            "Send renewal reminder",
            "Collect PO",
            "Chase payment",
            "Schedule the site survey",
            "Share the comparison sheet",
            "Call back after month end",
            "Update the licence count",
          ]),
          dueDate: daysAhead(int(-90, 30)),
          done,
          doneAt: done ? new Date(createdAt.getTime() + int(1, 30) * 86400000) : null,
          assignedToUserId: person.id,
          createdByUserId: chance(0.6) ? person.id : pick(people).id,
          companyId: company?.id ?? null,
          createdAt,
        },
      });
      taskCount += 1;
    }
  }
  log("Tasks", `${taskCount}`);

  // ── Sticky notes ────────────────────────────────────────────────────────────────────────────
  let noteCount = 0;
  for (const person of some(people, 40)) {
    for (let i = 0; i < int(1, 3); i++) {
      await db.stickyNote.create({
        data: {
          ownerUserId: person.id,
          body: pick([
            "Chase the PO from purchase before Friday.",
            "Renewal list for March — start calling next week.",
            "Customer wants the invoice split across two POs.",
            "Check stock before promising delivery.",
            "Ask accounts about the pending credit note.",
          ]),
          color: pick(["YELLOW", "BLUE", "GREEN", "PINK"] as const),
          visibility: pick(["PRIVATE", "PRIVATE", "TEAM"] as const),
          pinned: chance(0.25),
          createdAt: daysAgo(int(1, 120)),
        },
      });
      noteCount += 1;
    }
  }
  log("Sticky notes", `${noteCount}`);

  return { leadCount, orderCount, paymentCount, ticketCount, callCount, visitCount, expenseCount, taskCount };
}
