/**
 * A company that has been running this CRM for a year.
 *
 *   npm run db:seed:demo              # add it
 *   npm run db:seed:demo -- --reset   # remove a previous run first, then add it again
 *
 * A hundred people across eight departments with a real reporting line and permissions granted
 * through the app's own role presets; five hundred companies in the proportions a book actually
 * has; and twelve months of the work that hangs off them — leads, orders, subscriptions with their
 * renewal dates spread across the year ahead, payments, tickets, calls, visits, expenses and tasks.
 *
 * ## What makes it a demo rather than filler
 *
 * Everything hangs off something. A customer exists because a lead was won; the lead was won
 * because somebody owned it; the order references that lead's company and location; the payment
 * references the order. Click into any figure on any dashboard and the records underneath it
 * reconcile. Seeding each table independently is faster and produces a database that falls apart
 * the first time somebody looks closely.
 *
 * ## Safety
 *
 * It refuses to run against a database that already has real-looking data unless `--force` is
 * given, and everything it writes is tagged — companies carry the `seed-demo` tag, catalogue items
 * a `DMO-` SKU, people a `@demo.deskzo.invalid` address — so `--reset` removes exactly what a
 * previous run added and nothing else.
 *
 * The randomness is seeded, so a re-run produces the same company rather than a different one.
 *
 * ## What stays empty, and why
 *
 * Thirteen tables are left alone on purpose, and it is worth knowing which:
 *
 * - **Configuration** — the organisation's own details, branding, security settings and policy,
 *   module switches, role presets, document numbering and its counters. These are global and
 *   untagged, so `--reset` could not put the real values back, and a seed that overwrites the
 *   settings somebody spent an afternoon on is not a seed anybody runs twice.
 * - **Per-person interface state** — saved table layouts and screenshot allowances. These appear
 *   as people use the app, and inventing them puts other people's column choices on your screen.
 * - **`LedgerLock` and `FiscalYearClose`** — closing the books would refuse every posting dated
 *   inside the closed period, which is most of this data.
 * - **`MessageEvent`** — nothing has ever been sent from this installation, so nothing has been
 *   delivered, opened, clicked or bounced. Fabricating those would put an open rate on a
 *   dashboard, and an open rate is the kind of figure that ends up in a board pack.
 */
import { directClient } from "../src/lib/tenancy/direct-client";
import { seedPeople } from "./demo/people";
import { seedCompanies } from "./demo/companies";
import { seedCatalogue } from "./demo/catalogue";
import { seedActivity } from "./demo/activity";
import { seedDocuments } from "./demo/documents";
import { seedModules } from "./demo/modules";
import { seedExtras } from "./demo/extras";
import { seedDetail } from "./demo/detail";
import { seedFinance } from "./demo/finance";
import { seedReach } from "./demo/reach";
import { COVER_AREAS, resetCover } from "./demo/cover";
import { loadDemoContext } from "./demo/context";
import { BOOK_SIZE, COMPANY_AGE_DAYS, DEMO_EMAIL_DOMAIN, DEMO_SKU, DEMO_TAG, HEADCOUNT, log } from "./demo/shared";

const db = directClient();
const args = process.argv.slice(2);
const RESET = args.includes("--reset");
const FORCE = args.includes("--force");

/** Removes a previous run, in foreign-key order. Touches nothing that is not tagged. */
async function reset() {
  const users = await db.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_DOMAIN } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { tags: { has: DEMO_TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);

  // What the coverage seeds added first — some of it points at the ledger and the people below.
  await resetCover(db, companyIds, userIds);

  /**
   * Order matters, and the database enforces it.
   *
   * Four layers: the ledger, which points at almost everything; then everything that points at a
   * company, then the companies; everything that points at a person, then the people. A delete in
   * the wrong order does not corrupt anything — the foreign key refuses it — but it does stop the
   * reset halfway, which leaves a half-removed demo that is worse than either state.
   */

  // ── The ledger, first ─────────────────────────────────────────────────────────────────────
  // A journal entry names the invoice, receipt, claim or payroll run that produced it, so the
  // entries go before any of those. Lines cascade with their entry — but a matched statement row
  // points at a line, so the statement goes before the entries.
  await db.bankReconciliation.deleteMany({});
  await db.bankStatementLine.deleteMany({});
  await db.depreciationCharge.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.fixedAsset.deleteMany({});
  await db.consignment.deleteMany({});
  await db.bankAccount.deleteMany({});
  // Only the three the demo created. `1110 Bank Accounts` is a system account and stays.
  await db.ledgerAccount.deleteMany({ where: { code: { in: ["1111", "1112", "1113"] } } });

  // ── The marketing module's own rows ───────────────────────────────────────
  // A message names its enrolment and its company, so it goes before either.
  await db.messageEvent.deleteMany({});
  await db.marketingMessage.deleteMany({});
  await db.journeyEnrolment.deleteMany({});
  await db.journeyStep.deleteMany({});
  await db.journey.deleteMany({});
  await db.marketingTick.deleteMany({});
  await db.messagingProvider.deleteMany({});
  await db.formSubmission.deleteMany({});
  await db.inboundForm.deleteMany({});

  // ── Everything that references a company ──────────────────────────────────────────────────
  await db.paymentAllocation.deleteMany({ where: { payment: { companyId: { in: companyIds } } } });
  await db.creditNoteApplication.deleteMany({ where: { invoice: { companyId: { in: companyIds } } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.payment.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.assetMovement.deleteMany({ where: { asset: { OR: [{ ownerCompanyId: { in: companyIds } }, { custodianUserId: { in: userIds } }] } } });
  await db.asset.deleteMany({ where: { OR: [{ ownerCompanyId: { in: companyIds } }, { siteCompanyId: { in: companyIds } }, { custodianUserId: { in: userIds } }] } });
  await db.credentialReveal.deleteMany({ where: { credential: { project: { companyId: { in: companyIds } } } } });
  await db.projectCredential.deleteMany({ where: { project: { companyId: { in: companyIds } } } });
  await db.projectDocument.deleteMany({ where: { project: { companyId: { in: companyIds } } } });
  await db.project.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.projectType.deleteMany({});
  await db.feedbackRequest.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.domainProfile.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.workbookAssignee.deleteMany({ where: { workbook: { ownerUserId: { in: userIds } } } });
  await db.workbook.deleteMany({ where: { ownerUserId: { in: userIds } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.visit.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.task.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { assignedToUserId: { in: userIds } }, { createdByUserId: { in: userIds } }] } });
  await db.orderExpense.deleteMany({ where: { companyProduct: { companyId: { in: companyIds } } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.activity.deleteMany({ where: { lead: { companyId: { in: companyIds } } } });
  await db.proposal.deleteMany({ where: { lead: { companyId: { in: companyIds } } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contactVerification.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contactConsent.deleteMany({ where: { contact: { companyId: { in: companyIds } } } });
  await db.suppression.deleteMany({});
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.resellerItemPrice.deleteMany({ where: { resellerId: { in: companyIds } } });
  await db.resellerProfile.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.commissionPartyLink.deleteMany({ where: { commissionPartyId: { in: companyIds } } });
  await db.commissionPartyAccount.deleteMany({ where: { commissionPartyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.stockMovement.deleteMany({ where: { item: { sku: { startsWith: DEMO_SKU } } } });
  await db.item.deleteMany({ where: { sku: { startsWith: DEMO_SKU } } });
  await db.productFamily.deleteMany({});

  // ── Everything that references a person ───────────────────────────────────────────────────
  if (userIds.length > 0) {
    await db.handover.deleteMany({ where: { fromUserId: { in: userIds } } });
    // A generated letter owns its document, so the documents go first.
    await db.employeeDocument.deleteMany({ where: { userId: { in: userIds } } });
    await db.employeeLetter.deleteMany({ where: { userId: { in: userIds } } });
    await db.finalSettlement.deleteMany({ where: { userId: { in: userIds } } });
    await db.vaultPin.deleteMany({ where: { userId: { in: userIds } } });
    await db.vaultCredential.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.visitorEntry.deleteMany({ where: { OR: [{ hostUserId: { in: userIds } }, { kiosk: { createdById: { in: userIds } } }] } });
    await db.visitorInvite.deleteMany({ where: { hostUserId: { in: userIds } } });
    await db.visitorKiosk.deleteMany({ where: { createdById: { in: userIds } } });
    await db.visitorCompany.deleteMany({ where: { source: "VISITOR" } });
    await db.surveyTarget.deleteMany({ where: { survey: { createdById: { in: userIds } } } });
    await db.survey.deleteMany({ where: { createdById: { in: userIds } } });
    await db.internalFeedback.deleteMany({});
    await db.feedbackQuota.deleteMany({ where: { userId: { in: userIds } } });
    await db.payslip.deleteMany({ where: { userId: { in: userIds } } });
    await db.payrollRun.deleteMany({});
    await db.attendanceDay.deleteMany({ where: { userId: { in: userIds } } });
    await db.attendanceRegularisation.deleteMany({ where: { userId: { in: userIds } } });
    await db.biometricPunch.deleteMany({});
    await db.biometricDevice.deleteMany({});
    await db.leaveRequest.deleteMany({ where: { userId: { in: userIds } } });
    await db.leaveBalance.deleteMany({ where: { userId: { in: userIds } } });
    await db.salaryStructure.deleteMany({ where: { userId: { in: userIds } } });
    await db.leaveType.deleteMany({});
    await db.holiday.deleteMany({});
    await db.incentiveEarning.deleteMany({ where: { userId: { in: userIds } } });
    await db.target.deleteMany({});
    await db.incentiveSlab.deleteMany({});
    await db.incentiveScheme.deleteMany({});
    await db.campaign.deleteMany({});
    await db.marketingTemplate.deleteMany({});
    await db.audience.deleteMany({});
    await db.candidate.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.celebration.deleteMany({ where: { createdById: { in: userIds } } });
    await db.stickyNote.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await db.expense.deleteMany({ where: { userId: { in: userIds } } });
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
    await db.employmentHistory.deleteMany({ where: { userId: { in: userIds } } });
    await db.employeeProfile.deleteMany({ where: { userId: { in: userIds } } });
    // Managers before reports, or the self-reference blocks the delete.
    await db.user.updateMany({ where: { managerId: { in: userIds } }, data: { managerId: null } });

    /**
     * Anything a demo person created but this reset does not own.
     *
     * `Company.createdById` is required and has no cascade, so a company created by a demo user but
     * not carrying the demo tag — one another seed made while signed in as them — blocks the whole
     * user delete with a foreign-key error, and the reset stops half-done.
     *
     * Reassigned to the surviving admin rather than deleted. This reset is only entitled to remove
     * what it created, and a row it did not tag is somebody else's; moving the authorship is enough
     * to let the people go, and leaves the record for whoever does own it to clean up.
     */
    const survivor = await db.user.findFirst({
      where: { id: { notIn: userIds }, active: true },
      orderBy: { isSuperAdmin: "desc" },
      select: { id: true },
    });
    if (survivor) {
      const orphaned = await db.company.updateMany({
        where: { createdById: { in: userIds } },
        data: { createdById: survivor.id },
      });
      if (orphaned.count > 0) log("Reassigned", `${orphaned.count} company record(s) another seed left behind`);
    }

    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }

  log("Reset", `${companyIds.length} companies and ${userIds.length} people removed`);
}

/**
 * Whether it is safe to write.
 *
 * A seed that quietly doubles somebody's real database is worse than one that refuses. Anything
 * already present that is not tagged as demo data counts as real.
 */
async function safetyCheck() {
  const [realCompanies, realUsers] = await Promise.all([
    db.company.count({ where: { NOT: { tags: { has: DEMO_TAG } } } }),
    db.user.count({ where: { email: { not: { endsWith: DEMO_EMAIL_DOMAIN } } } }),
  ]);

  // One or two real users is a fresh install with an admin account, which is the expected state.
  if (realCompanies > 0 || realUsers > 3) {
    console.error(
      [
        "",
        "  This database already holds data that is not from this seed:",
        `    ${realCompanies} companies and ${realUsers} users.`,
        "",
        "  Seeding on top would mix demo records into real ones and the two would be hard to",
        "  separate afterwards. Nothing has been written.",
        "",
        "  If you meant to do it anyway:  npm run db:seed:demo -- --force",
        "",
      ].join("\n"),
    );
    return false;
  }
  return true;
}

async function main() {
  const started = Date.now();
  const months = Math.round(COMPANY_AGE_DAYS / 30);
  console.log(
    `\nSeeding a ${months}-month-old company: ${HEADCOUNT} people, ${BOOK_SIZE} accounts.\n` +
      `Everything is dated inside those ${COMPANY_AGE_DAYS} days, except subscription terms —\n` +
      `a reseller takes over tenancies that were already running, and those expiries are what\n` +
      `keeps the renewals screen worth looking at.\n`,
  );

  if (RESET) await reset();
  if (!FORCE && !(await safetyCheck())) {
    process.exitCode = 1;
    return;
  }

  // Everything is created "by" the first admin, which is what a real import would look like.
  const admin = await db.user.findFirst({
    where: { role: "ADMIN", email: { not: { endsWith: DEMO_EMAIL_DOMAIN } } },
    select: { id: true, name: true },
  });
  if (!admin) {
    console.error("  No admin account found. Run `npm run db:bootstrap` first.\n");
    process.exitCode = 1;
    return;
  }
  log("Creating as", admin.name);

  const { people, departments, leaving } = await seedPeople(db);
  const items = await seedCatalogue(db, admin.id);
  const companies = await seedCompanies(db, people, admin.id, BOOK_SIZE);
  await seedActivity(db, companies, items, people);
  await seedDocuments(db, companies, items, people);
  await seedModules(db, companies, items, people, departments);
  await seedExtras(db, companies, people, departments, admin.id, leaving);
  // Before the ledger, because the credit notes it raises have to be posted with everything else.
  await seedDetail(db, items, people, departments, admin.id);
  await seedReach(db, companies, people, admin.id);
  // Last, because it posts the books: the invoices, credit notes, receipts, claims and payroll runs
  // it reads have to exist before there is anything to post.
  await seedFinance(db, companies, people, departments, admin.id);
  // Then everything the above leaves out: every module and add-on, every status, stage and kind
  // (prisma/demo/cover). Each reads the company back as it stands by then.
  for (const area of COVER_AREAS) {
    console.log(`
— ${area.label} —`);
    await area.seed(db, await loadDemoContext(db));
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\nDone in ${seconds}s.\n`);
  console.log("  None of them has a password: sign in as yourself and use View as to see the app as any of them.");
  console.log(`  Their addresses all end ${DEMO_EMAIL_DOMAIN}\n`);
  // The single-module seeds (db:seed:hr, db:seed:accounting and the rest) each build their own
  // narrow fixture and are still there for working on one module in isolation. They are not a
  // follow-up to this one — everything they cover is above, hanging off the same companies and
  // people, and running them on top would add a second unrelated set beside it.
  console.log("  Everything is there: books, payroll, attendance, projects, vault and reception.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
