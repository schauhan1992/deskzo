import type { PrismaClient } from "@prisma/client";
import type { DemoContext } from "../context";
import { DEMO_EMAIL_DOMAIN } from "../shared";
import seedOrders from "./orders";
import seedFinanceCover from "./finance";
import seedCrm, { resetCrm } from "./crm";
import seedReach from "./reach";
import seedPeopleYear from "./people";

/**
 * The coverage seeds (owner, 3 Oct 2026: "data in all the modules and add-ons, every stage and every
 * scenario, 50 people and their journey over the last year"): everything the main demo seed leaves out
 * — the newer modules and add-ons, and every status, stage and kind a record can be in — added on top
 * of the same people and accounts. `npm run db:seed:demo` runs them all, in this order, after the rest;
 * `npx tsx prisma/demo/run-cover.ts <area>` runs one.
 *
 * The order matters:
 *   1. orders   — the scenario orders, items, purchase, rebates and vendor credits the rest point at;
 *   2. finance  — documents, payments, collections and the books, on those orders;
 *   3. crm      — credit ratings worked out by the app's own engine once the invoices are all there,
 *                 then leads, visits, meetings and custom fields;
 *   4. reach    — marketing decides who can be reached from the invoices and tickets as they stand;
 *   5. people   — last: joining and leaving dates, awards and the activity trail are read from
 *                 everything the others did.
 */

export type CoverArea = { key: string; label: string; seed: (db: PrismaClient, ctx: DemoContext) => Promise<void> };

export const COVER_AREAS: CoverArea[] = [
  { key: "orders", label: "Orders, purchase, rebates, stock and IT assets", seed: seedOrders },
  { key: "finance", label: "Documents, collections, credit, the books and Revenue & Close", seed: seedFinanceCover },
  { key: "crm", label: "Accounts, leads, calls, visits, meetings and custom fields", seed: seedCrm },
  { key: "reach", label: "Marketing, forms, feedback, the portal and projects", seed: seedReach },
  { key: "people", label: "Each person's year: HR, payroll, targets, wins and their trail", seed: seedPeopleYear },
];

/**
 * For `--reset`, before anything else goes: what the coverage seeds add that the demo's own reset does
 * not take with the demo's companies and people, or that would block it (a Restrict on a journal entry,
 * a vendor, or whoever recorded it). Scoped to the demo's own rows wherever the table says whose a row
 * is; the books' schedules and the month-end close are cleared whole, as the reset clears the ledger
 * they post into.
 */
export async function resetCover(db: PrismaClient, companyIds: string[], userIds: string[]): Promise<void> {
  // Revenue & Close and the prepaid/accrual schedules point at journal entries and documents.
  await db.revenueSchedule.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.accountingSchedule.deleteMany({});
  await db.fluxNote.deleteMany({});
  await db.closeTask.deleteMany({});
  await db.closeMonth.deleteMany({});
  // Restrict on the vendor, the customer, or who decided.
  await db.vendorCredit.deleteMany({ where: { vendorId: { in: companyIds } } });
  await db.creditDecision.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.paymentFollowUp.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.documentApprovalPolicy.deleteMany({ where: { updatedById: { in: userIds } } });
  await db.transporter.deleteMany({ where: { createdById: { in: userIds } } });
  await db.rebateProgramme.deleteMany({ where: { OR: [{ vendorId: { in: companyIds } }, { updatedById: { in: userIds } }] } });
  // Stock with no customer or holder: the demo's own asset delete doesn't reach it.
  await db.assetMovement.deleteMany({ where: { asset: { assetTag: { startsWith: "DMO-A" } } } });
  await db.asset.deleteMany({ where: { assetTag: { startsWith: "DMO-A" } } });
  await resetCrm(db, companyIds);
  // The people's year: what names a demo person without cascading with them.
  await db.permissionChange.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { subjectUserId: { in: userIds } }] } });
  await db.activityLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userEmail: { endsWith: DEMO_EMAIL_DOMAIN } }] } });
  await db.announcement.deleteMany({ where: { createdById: { in: userIds } } });
  await db.helpLink.deleteMany({ where: { createdById: { in: userIds } } });
  // Marketing that demo people made and the demo's own reset doesn't clear.
  await db.marketingList.deleteMany({ where: { createdById: { in: userIds } } });
  // Wins: awards and announcements name nobody in a column, so they are found by who won them.
  const won = await db.prizeWinner.findMany({ where: { userId: { in: userIds } }, select: { race: true, period: true }, distinct: ["race", "period"] });
  await db.prizeWinner.deleteMany({ where: { userId: { in: userIds } } });
  await db.activityAward.deleteMany({ where: { period: { in: won.filter((w) => w.race === "MOST_ACTIVE").map((w) => w.period) } } });
  await db.prizeAnnouncement.deleteMany({ where: { OR: [{ announcedById: { in: userIds } }, ...won.map((w) => ({ race: w.race, period: w.period }))] } });
  await db.prize.deleteMany({ where: { updatedById: { in: userIds } } });
  // The "prizes up for grabs" celebrations of announcements just removed.
  await db.$executeRawUnsafe(`DELETE FROM "celebrations" WHERE "occasionKey" LIKE 'prizes:%' AND substring("occasionKey" from 8) NOT IN (SELECT "id" FROM "prize_announcements")`);
  // Reception: the visitor companies the people seed typed in or took on as vendors.
  await db.visitorCompany.deleteMany({ where: { OR: [{ source: "VENDOR", companyId: { in: companyIds } }, { source: "MANUAL", companyId: null }] } });
  await db.celebration.deleteMany({ where: { OR: [{ subjectUserId: { in: userIds } }, { createdById: { in: userIds } }] } });
}
