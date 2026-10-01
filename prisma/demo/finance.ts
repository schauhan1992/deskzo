import { PrismaClient, Prisma } from "@prisma/client";
import { monthlyCharge, endOfMonth, startOfMonth } from "../../src/lib/ledger/depreciation";
import {
  ensureChartOfAccounts,
  postDepreciationToLedger,
  postDocumentToLedger,
  postExpenseReimbursementToLedger,
  postExpenseToLedger,
  postPaymentToLedger,
  postPayrollPaymentToLedger,
  postPayrollToLedger,
} from "../../src/lib/ledger/journal";
import type { SeededCompany } from "./companies";
import { seedBankStatement } from "./detail";
import type { SeededPerson } from "./people";
import { chance, daysAgo, int, log, pick, some } from "./shared";

/**
 * The books, the fixed asset register, and the paperwork that follows somebody in and out.
 *
 * ## The ledger is posted, not written
 *
 * Every journal entry below comes out of `src/lib/ledger/journal.ts` — the same posting path the
 * application uses when an invoice is issued or a claim approved. Nothing here hand-writes a debit.
 *
 * That is not tidiness. A ledger is the one part of an ERP where invented data is actively harmful:
 * the first thing anybody does with a trial balance is add up a column, and a demo whose columns do
 * not agree teaches them to distrust the report rather than the data. Going through `writeEntry`
 * means every entry has passed the same three checks a real one does — at least two lines, no line
 * carrying both a debit and a credit, and debits equal to credits to the paisa.
 *
 * It also means the entries are *linked*: each one knows which invoice, receipt, claim or payroll
 * run produced it, so the drill-down from the P&L back to the document works.
 */

export async function seedFinance(
  db: PrismaClient,
  companies: SeededCompany[],
  people: SeededPerson[],
  departments: Map<string, string>,
  adminId: string,
) {
  const controller = people.find((p) => p.title === "Finance Controller") ?? people[0]!;
  const hr = people.find((p) => p.title === "HR Manager") ?? people[0]!;

  // Idempotent, and cheap. Every posting below resolves its accounts by system key, so a chart with
  // one missing account fails the whole run with a message about the chart rather than about a
  // seed — which is the right message, but only if it is checked before four hundred entries are
  // half-written.
  await ensureChartOfAccounts();

  // ── Bank accounts ───────────────────────────────────────────────────────────────────────────
  /**
   * Each bank gets its own ledger account in the 111x range, which is what `ledgerAccountForNewBank`
   * in `src/actions/bank.ts` does. The demo deliberately leaves the shared `1110 Bank Accounts`
   * system account alone rather than claiming it for the first bank: it stays as the fallback every
   * posting falls back to, and `--reset` can then drop these three without touching the chart.
   */
  const bankParent = await db.ledgerAccount.findUnique({ where: { code: "1110" }, select: { parentId: true } });
  const BANKS = [
    ["HDFC — Current", "HDFC Bank", "50200012345678", "HDFC0000123", "Andheri East", true],
    ["ICICI — Collections", "ICICI Bank", "002705001234", "ICIC0000027", "Lower Parel", false],
    ["Kotak — Payroll", "Kotak Mahindra Bank", "1234567890", "KKBK0000456", "Powai", false],
  ] as const;

  let defaultBankId: string | null = null;
  for (const [i, [name, bank, number, ifsc, branch, isDefault]] of BANKS.entries()) {
    const ledger = await db.ledgerAccount.create({
      data: { code: `111${i + 1}`, name, type: "ASSET", parentId: bankParent?.parentId ?? null, isGroup: false },
      select: { id: true },
    });
    const row = await db.bankAccount.create({
      data: {
        name,
        bankName: bank,
        accountNumber: number,
        ifsc,
        branch,
        isDefault,
        ledgerAccountId: ledger.id,
        createdById: controller.id,
      },
      select: { id: true },
    });
    if (isDefault) defaultBankId = row.id;
  }
  log("Bank accounts", `${BANKS.length}, each with its own ledger account`);

  // Money that moved by transfer or cheque moved through a bank. Saying which one is what makes the
  // reconciliation screen answerable at all.
  if (defaultBankId) {
    await db.payment.updateMany({
      where: { method: { not: "CASH" }, bankAccountId: null },
      data: { bankAccountId: defaultBankId },
    });
  }

  // ── Fixed assets ────────────────────────────────────────────────────────────────────────────
  // Deliberately before the ledger run below: depreciation cannot be charged on a register that
  // does not exist yet.
  const ASSETS = [
    ["Office laptops — bulk purchase", "1210", 1450000, 3, "IT"],
    ["Conference room AV", "1210", 385000, 5, "Operations"],
    ["Server room UPS & racks", "1210", 620000, 7, "IT"],
    ["Firewall & core switches", "1210", 420000, 5, "IT"],
    ["Office furniture — second floor", "1220", 890000, 10, "Operations"],
    ["Workstations & storage — sales floor", "1220", 310000, 10, "Sales"],
    ["Company car — Maruti Dzire", "1230", 985000, 8, "Operations"],
    ["Delivery van", "1230", 742000, 8, "Support"],
  ] as const;

  const assetIds: string[] = [];
  for (const [i, [name, code, cost, life, dept]] of ASSETS.entries()) {
    const account = await db.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
    if (!account) continue;
    const row = await db.fixedAsset.create({
      data: {
        tag: `FA-${String(i + 1).padStart(4, "0")}`,
        name,
        purchasedOn: daysAgo(int(200, 900)),
        cost: new Prisma.Decimal(cost),
        // Five per cent left at the end of its life. Depreciation stops there rather than running
        // the book value down to nothing, which is what makes an eventual disposal show the right
        // gain instead of an invented one.
        salvageValue: new Prisma.Decimal(Math.round(cost * 0.05)),
        usefulLifeYears: life,
        method: "STRAIGHT_LINE",
        assetAccountId: account.id,
        departmentId: departments.get(dept) ?? null,
        custodianUserId: chance(0.5) ? pick(people).id : null,
        createdById: controller.id,
      },
      select: { id: true },
    });
    assetIds.push(row.id);
  }
  log("Fixed assets", `${assetIds.length} on the register`);

  // ── Posting the books ───────────────────────────────────────────────────────────────────────
  let entries = 0;
  const count = async (p: Promise<{ id: string } | null>) => {
    if (await p) entries += 1;
  };

  for (const doc of await db.tradeDocument.findMany({
    where: { docType: { in: ["INVOICE", "CREDIT_NOTE", "BILL"] } },
    select: { id: true },
  })) {
    await count(postDocumentToLedger(db, doc.id, controller.id));
  }
  const afterDocs = entries;

  for (const payment of await db.payment.findMany({ select: { id: true } })) {
    await count(postPaymentToLedger(db, payment.id, controller.id));
  }
  const afterPayments = entries;

  for (const expense of await db.expense.findMany({
    where: { status: { in: ["APPROVED", "REIMBURSED"] } },
    select: { id: true, status: true, reimbursedAt: true, spentOn: true },
  })) {
    await count(postExpenseToLedger(db, expense.id, controller.id));
    // The claim and the reimbursement are two events. Booking only the first leaves the employee
    // permanently owed on the balance sheet; booking only the second puts the cost in the wrong
    // month.
    if (expense.status === "REIMBURSED") {
      await count(
        postExpenseReimbursementToLedger(db, expense.id, controller.id, expense.reimbursedAt ?? expense.spentOn),
      );
    }
  }
  const afterExpenses = entries;

  for (const run of await db.payrollRun.findMany({ select: { id: true, month: true, year: true } })) {
    await count(postPayrollToLedger(db, run.id, controller.id));
    // Payday is the 7th of the month after the one that was run.
    await count(postPayrollPaymentToLedger(db, run.id, controller.id, new Date(Date.UTC(run.year, run.month, 7, 12))));
  }
  const afterPayroll = entries;

  // Twelve months of depreciation on each asset, charged month by month rather than as one lump —
  // the accumulated figure only comes out right if each month is charged against the one before it.
  for (const assetId of assetIds) {
    const asset = await db.fixedAsset.findUnique({
      where: { id: assetId },
      select: {
        cost: true, salvageValue: true, usefulLifeYears: true, method: true,
        ratePercent: true, purchasedOn: true, disposedOn: true,
      },
    });
    if (!asset) continue;
    let accumulated = 0;
    for (let back = 11; back >= 0; back--) {
      const when = daysAgo(back * 30);
      const year = when.getUTCFullYear();
      const month = when.getUTCMonth() + 1;
      const toDate = endOfMonth(year, month);
      const charge = monthlyCharge(
        {
          cost: Number(asset.cost),
          salvageValue: Number(asset.salvageValue),
          usefulLifeYears: asset.usefulLifeYears,
          method: asset.method,
          ratePercent: asset.ratePercent === null ? null : Number(asset.ratePercent),
          purchasedOn: asset.purchasedOn,
          disposedOn: asset.disposedOn,
          accumulated,
        },
        toDate,
      );
      if (charge <= 0) continue;
      await count(
        postDepreciationToLedger(db, {
          assetId,
          amount: charge,
          fromDate: startOfMonth(year, month),
          toDate,
          periodLabel: `${month}/${year}`,
          userId: controller.id,
        }),
      );
      accumulated += charge;
    }
  }

  const lines = await db.journalLine.count();
  log("Ledger", `${entries} entries, ${lines} lines — all balanced by writeEntry`);
  log(
    "  made up of",
    `${afterDocs} documents · ${afterPayments - afterDocs} receipts · ` +
      `${afterExpenses - afterPayments} claims · ${afterPayroll - afterExpenses} payroll · ` +
      `${entries - afterPayroll} depreciation`,
  );

  // Only now, because a statement row is matched to a bank line in the ledger and there were no
  // ledger lines to match against until the postings above had run.
  await seedBankStatement(db, people);

  // ── Employee paperwork ──────────────────────────────────────────────────────────────────────
  /**
   * A one-pixel PNG stands in for every attachment. The point of these rows is that the documents
   * tab is not empty and the counts are right — a demo has no business carrying anybody's actual
   * Aadhaar card, even an invented one.
   */
  const STUB =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  let docs = 0;
  let letters = 0;

  for (const person of some(people, 55)) {
    const types = some(
      ["CV", "PAN_CARD", "AADHAAR", "EDUCATION", "BANK_PROOF", "OFFER_LETTER", "INTERNAL"] as const,
      int(2, 5),
    );
    for (const type of types) {
      await db.employeeDocument.create({
        data: {
          userId: person.id,
          type,
          name: `${type.replace(/_/g, " ").toLowerCase()} — ${person.name}`,
          fileDataUrl: STUB,
          mimeType: "image/png",
          sizeBytes: 68,
          // Appraisal notes and warnings are kept *about* somebody, not *for* them.
          visibleToEmployee: type !== "INTERNAL",
          uploadedById: hr.id,
          createdAt: daysAgo(int(30, 800)),
        },
      });
      docs += 1;
    }

    for (const type of some(["OFFER", "APPOINTMENT", "CONFIRMATION", "INCREMENT", "APPRECIATION"] as const, int(0, 2))) {
      letters += 1;
      const issuedOn = daysAgo(int(20, 700));
      await db.employeeLetter.create({
        data: {
          userId: person.id,
          type,
          letterNumber: `WRF/${type.slice(0, 3)}/${issuedOn.getFullYear()}/${String(letters).padStart(4, "0")}`,
          subject: `${type.charAt(0)}${type.slice(1).toLowerCase()} — ${person.name}`,
          issuedOn,
          // Frozen, because a letter is a statement about what was true on the day it was signed.
          // Re-deriving it later from a salary structure that has since changed would make the copy
          // in somebody's file disagree with the copy in the system.
          payload: {
            name: person.name,
            designation: person.title,
            department: person.dept,
            issuedOn: issuedOn.toISOString().slice(0, 10),
          },
          body: `This is to confirm that ${person.name} is employed with Acme as ${person.title} in the ${person.dept} team.`,
          status: chance(0.9) ? "ISSUED" : "DRAFT",
          issuedById: hr.id,
          createdAt: issuedOn,
        },
      });
    }
  }
  log("Employee paperwork", `${docs} documents, ${letters} letters`);

  // ── Full & final for the people who left ────────────────────────────────────────────────────
  let settlements = 0;
  for (const leaver of await db.user.findMany({
    where: { employeeProfile: { exitedOn: { not: null } }, settlement: { is: null } },
    select: { id: true, employeeProfile: { select: { exitedOn: true, joinedOn: true } } },
  })) {
    const exitedOn = leaver.employeeProfile!.exitedOn!;
    const joinedOn = leaver.employeeProfile!.joinedOn ?? daysAgo(1200);
    const serviceYears = Math.round(((exitedOn.getTime() - joinedOn.getTime()) / (365 * 86400000)) * 100) / 100;

    const monthly = int(28000, 90000);
    const daily = Math.round(monthly / 30);
    const salaryDays = int(8, 28);
    const salaryAmount = salaryDays * daily;
    const encashDays = int(2, 14);
    const encashAmount = encashDays * daily;
    /**
     * Gratuity is payable after five completed years, on the Act's formula — fifteen days' pay for
     * each year, on a twenty-six-day month. A flat percentage would be simpler and would be the
     * wrong number for everybody.
     */
    const gratuity = serviceYears >= 5 ? Math.round((monthly * 15 * Math.floor(serviceYears)) / 26) : 0;
    const gross = salaryAmount + encashAmount + gratuity;

    const noticeShortfall = chance(0.25) ? int(5, 30) : 0;
    const noticeRecovery = noticeShortfall * daily;
    const pf = Math.round(salaryAmount * 0.12);
    const professionalTax = 200;
    const assetRecovery = chance(0.2) ? int(2000, 25000) : 0;
    const deductions = noticeRecovery + pf + professionalTax + assetRecovery;

    await db.finalSettlement.create({
      data: {
        userId: leaver.id,
        lastWorkingDay: exitedOn,
        serviceYears: new Prisma.Decimal(serviceYears),
        salaryDays: new Prisma.Decimal(salaryDays),
        salaryAmount: new Prisma.Decimal(salaryAmount),
        leaveEncashDays: new Prisma.Decimal(encashDays),
        leaveEncashAmount: new Prisma.Decimal(encashAmount),
        gratuityAmount: new Prisma.Decimal(gratuity),
        gratuityNote:
          gratuity > 0
            ? `Payable — ${serviceYears} years of service.`
            : `Not payable — ${serviceYears} years, short of the five the Act requires.`,
        grossPayable: new Prisma.Decimal(gross),
        noticeShortfallDays: new Prisma.Decimal(noticeShortfall),
        noticeRecovery: new Prisma.Decimal(noticeRecovery),
        pfDeduction: new Prisma.Decimal(pf),
        professionalTax: new Prisma.Decimal(professionalTax),
        assetRecovery: new Prisma.Decimal(assetRecovery),
        totalDeductions: new Prisma.Decimal(deductions),
        // Allowed to come out negative, and left to. Somebody who left without serving notice may
        // owe the company, and a settlement that cannot say so quietly writes the debt off.
        netPayable: new Prisma.Decimal(gross - deductions),
        status: pick(["PAID", "PAID", "APPROVED", "DRAFT"] as const),
        createdById: controller.id,
      },
    });
    settlements += 1;
  }
  log("Settlements", `${settlements} full & final for people who left`);

  // ── Delivery challans ───────────────────────────────────────────────────────────────────────
  let consignments = 0;
  const customers = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");
  const support = people.filter((p) => p.dept === "Support");
  for (const company of some(customers, 34)) {
    const status = pick(["DELIVERED", "DELIVERED", "DELIVERED", "IN_TRANSIT", "DISPATCHED", "DRAFT"] as const);
    const dispatchedOn = daysAgo(int(1, 240));
    const declaredValue = int(18000, 620000);
    /**
     * An e-way bill is required above ₹50,000, and it is required whether or not anything is being
     * sold — a laptop going out for repair needs one too. Tying it to the value rather than to the
     * reason is the whole point.
     */
    const needsEwayBill = declaredValue > 50000 && status !== "DRAFT";

    await db.consignment.create({
      data: {
        consignmentNumber: `DC/${dispatchedOn.getFullYear()}/${String(consignments + 1).padStart(4, "0")}`,
        reason: pick(["SALE_DELIVERY", "SALE_DELIVERY", "DEPLOYMENT", "REPAIR_OUT", "REPAIR_RETURN", "COLLECTION"] as const),
        status,
        fromLabel: "Acme — Andheri East, Mumbai",
        toCompanyId: company.id,
        toLocationId: company.locationId,
        toContactId: company.contactIds[0] ?? null,
        courier: pick(["Blue Dart", "Delhivery", "DTDC", "Gati", "Own vehicle"]),
        docketNumber: `${int(100000000, 999999999)}`,
        vehicleNumber: chance(0.3)
          ? `MH01${String.fromCharCode(65 + int(0, 25))}${String.fromCharCode(65 + int(0, 25))}${int(1000, 9999)}`
          : null,
        dispatchedOn: status === "DRAFT" ? null : dispatchedOn,
        expectedOn: new Date(dispatchedOn.getTime() + int(1, 5) * 86400000),
        deliveredOn: status === "DELIVERED" ? new Date(dispatchedOn.getTime() + int(1, 6) * 86400000) : null,
        receivedBy: status === "DELIVERED" ? pick(["Security desk", "Reception", "IT team", "Stores"]) : null,
        declaredValue: new Prisma.Decimal(declaredValue),
        interstate: company.stateCode !== "27",
        ewayBillNumber: needsEwayBill ? `${int(100000000000, 999999999999)}` : null,
        ewayBillValidUntil: needsEwayBill ? new Date(dispatchedOn.getTime() + int(1, 5) * 86400000) : null,
        createdById: (support.length > 0 ? pick(support) : pick(people)).id,
        createdAt: dispatchedOn,
      },
    });
    consignments += 1;
  }
  log("Consignments", `${consignments} delivery challans`);
  void adminId;
}
