import { PrismaClient, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { SeededCompany } from "./companies";
import type { SeededPerson } from "./people";
import {
  DEMO_EMAIL_DOMAIN,
  chance,
  daysAgo,
  daysAhead,
  int,
  log,
  personName,
  phone,
  pick,
  some,
  sometimeLastYear,
} from "./shared";
import { HANDOVER_ROTATION_DAYS } from "../../src/lib/vault/policy";
import { areaByKey } from "../../src/lib/handover/areas";

/**
 * Everything else: HR, the ledger, targets, incentives, marketing and customer feedback.
 *
 * These are the modules a company switches on in its second month rather than its first, and each
 * is seeded against the people and customers that already exist — so a payslip belongs to somebody
 * on the org chart, a target belongs to a salesperson who has orders behind it, and a feedback
 * request went to a customer who actually has a ticket.
 */

const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function seedExtras(
  db: PrismaClient,
  companies: SeededCompany[],
  people: SeededPerson[],
  departments: Map<string, string>,
  adminId: string,
  /** Somebody working out their notice, whose handover is in progress rather than finished. */
  leaving: SeededPerson | null,
) {
  // Individual contributors in sales — the people targets and incentives are set for. Falls
  // back to the whole department rather than an empty list, because an empty one crashes a
  // pick() forty lines later and the cause is nowhere near the symptom.
  const salesFloor = people.filter((p) => p.dept === "Sales" && !p.isManager);
  const sales = salesFloor.length > 0 ? salesFloor : people.filter((p) => p.dept === "Sales");
  const support = people.filter((p) => p.dept === "Support");
  const customers = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");
  const hr = people.find((p) => p.title === "HR Manager") ?? people[0]!;
  const controller = people.find((p) => p.title === "Finance Controller") ?? people[0]!;

  // ── The HR calendar ─────────────────────────────────────────────────────────────────────────
  const year = new Date().getFullYear();
  const HOLIDAYS: [string, string, boolean][] = [
    ["Republic Day", `${year}-01-26`, false],
    ["Holi", `${year}-03-14`, false],
    ["Good Friday", `${year}-04-18`, true],
    ["Eid al-Fitr", `${year}-03-31`, true],
    ["Independence Day", `${year}-08-15`, false],
    ["Ganesh Chaturthi", `${year}-08-27`, false],
    ["Gandhi Jayanti", `${year}-10-02`, false],
    ["Dussehra", `${year}-10-02`, true],
    ["Diwali", `${year}-10-20`, false],
    ["Diwali (Bhai Dooj)", `${year}-10-23`, true],
    ["Christmas", `${year}-12-25`, false],
  ];
  for (const [name, date, optional] of HOLIDAYS) {
    await db.holiday.create({ data: { name, date: new Date(`${date}T00:00:00.000Z`), optional } });
  }

  const LEAVE_TYPES: [code: string, name: string, quota: number, paid: boolean][] = [
    ["CL", "Casual leave", 12, true],
    ["SL", "Sick leave", 8, true],
    ["EL", "Earned leave", 18, true],
    ["LOP", "Loss of pay", 0, false],
  ];
  const leaveTypes = new Map<string, string>();
  for (const [i, [code, name, annualQuota, paid]] of LEAVE_TYPES.entries()) {
    const row = await db.leaveType.create({
      data: { code, name, annualQuota: new Prisma.Decimal(annualQuota), paid, sortOrder: i, accrual: code === "EL" ? "MONTHLY" : "ANNUAL" },
      select: { id: true },
    });
    leaveTypes.set(code, row.id);
  }
  log("HR calendar", `${HOLIDAYS.length} holidays, ${LEAVE_TYPES.length} leave types`);

  // ── Salary, leave and attendance ────────────────────────────────────────────────────────────
  let structures = 0;
  let balances = 0;
  let requests = 0;
  for (const person of people) {
    // Roughly aligned to the roster's pay bands, split the way an Indian payslip is.
    const gross = person.isManager ? int(90000, 260000) : int(22000, 95000);
    const basic = Math.round(gross * 0.5);
    await db.salaryStructure.create({
      data: {
        userId: person.id,
        effectiveFrom: daysAgo(int(200, 900)),
        basic: new Prisma.Decimal(basic),
        hra: new Prisma.Decimal(Math.round(basic * 0.4)),
        conveyance: new Prisma.Decimal(1600),
        medical: new Prisma.Decimal(1250),
        specialAllowance: new Prisma.Decimal(gross - basic - Math.round(basic * 0.4) - 2850),
        pfApplicable: basic <= 15000 || chance(0.8),
        esiApplicable: gross <= 21000,
        ptApplicable: true,
        createdById: controller.id,
      },
    });
    structures += 1;

    for (const [code, id] of leaveTypes) {
      if (code === "LOP") continue;
      const quota = LEAVE_TYPES.find((t) => t[0] === code)![2];
      await db.leaveBalance.create({
        data: {
          userId: person.id,
          typeId: id,
          year,
          opening: new Prisma.Decimal(chance(0.4) ? int(0, 5) : 0),
          credited: new Prisma.Decimal(quota),
          used: new Prisma.Decimal(int(0, Math.floor(quota * 0.7))),
        },
      });
      balances += 1;
    }

    for (let i = 0; i < int(0, 4); i++) {
      const from = sometimeLastYear();
      const days = int(1, 3);
      await db.leaveRequest.create({
        data: {
          userId: person.id,
          typeId: pick([...leaveTypes.values()].slice(0, 3)),
          fromDate: dateOnly(from),
          toDate: dateOnly(new Date(from.getTime() + (days - 1) * 86400000)),
          days: new Prisma.Decimal(days),
          reason: pick(["Family function", "Not well", "Personal work", "Travelling home", "Child's school event"]),
          status: pick(["APPROVED", "APPROVED", "APPROVED", "PENDING", "REJECTED", "CANCELLED"] as const),
          approverId: chance(0.8) ? hr.id : null,
          decidedAt: chance(0.8) ? new Date(from.getTime() - 86400000) : null,
        },
      });
      requests += 1;
    }
  }
  log("Payroll setup", `${structures} salary structures, ${balances} leave balances, ${requests} leave requests`);

  // Sixty days of attendance for everybody — enough for the screens to be full without writing
  // twenty-six thousand rows for a year nobody will scroll back through.
  let attendance = 0;
  const holidayKeys = new Set(HOLIDAYS.map(([, d]) => d));
  for (let back = 1; back <= 60; back += 1) {
    const day = dateOnly(daysAgo(back));
    const dow = day.getUTCDay();
    const key = day.toISOString().slice(0, 10);
    const isWeekend = dow === 0;
    const isHoliday = holidayKeys.has(key);

    const rows: Prisma.AttendanceDayCreateManyInput[] = people.map((person) => {
      const status = isHoliday ? "HOLIDAY" : isWeekend ? "WEEK_OFF" : pick([
        "PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT", "PRESENT",
        "WORK_FROM_HOME", "ON_LEAVE", "HALF_DAY", "ABSENT",
      ] as const);
      const working = status === "PRESENT" || status === "WORK_FROM_HOME" || status === "HALF_DAY";
      const checkIn = working ? new Date(day.getTime() + (9 * 60 + int(0, 75)) * 60000) : null;
      return {
        userId: person.id,
        date: day,
        status,
        checkInAt: checkIn,
        checkOutAt: checkIn ? new Date(checkIn.getTime() + (status === "HALF_DAY" ? int(210, 260) : int(490, 620)) * 60000) : null,
        workedMinutes: checkIn ? (status === "HALF_DAY" ? int(210, 260) : int(490, 620)) : 0,
      };
    });
    await db.attendanceDay.createMany({ data: rows, skipDuplicates: true });
    attendance += rows.length;
  }
  log("Attendance", `${attendance} day records across 60 days`);

  // ── Payroll ─────────────────────────────────────────────────────────────────────────────────
  let payslips = 0;
  for (let back = 1; back <= 2; back++) {
    const when = new Date();
    when.setMonth(when.getMonth() - back);
    const run = await db.payrollRun.create({
      data: {
        month: when.getMonth() + 1,
        year: when.getFullYear(),
        status: back === 1 ? "LOCKED" : "PAID",
        lockedAt: daysAgo(back * 30 - 2),
        lockedById: controller.id,
        paidAt: back === 2 ? daysAgo(back * 30 - 1) : null,
        createdById: controller.id,
      },
      select: { id: true },
    });

    for (const person of people) {
      const structure = await db.salaryStructure.findFirst({ where: { userId: person.id }, orderBy: { effectiveFrom: "desc" } });
      if (!structure) continue;
      const basic = Number(structure.basic);
      const hra = Number(structure.hra);
      const others = Number(structure.conveyance) + Number(structure.medical) + Number(structure.specialAllowance);
      const gross = basic + hra + others;
      const lop = chance(0.15) ? int(1, 2) : 0;
      const monthDays = 30;
      const paidDays = monthDays - lop;
      const earned = Math.round((gross * paidDays) / monthDays);
      const pf = structure.pfApplicable ? Math.round(Math.min(basic, 15000) * 0.12) : 0;
      const pt = 200;
      const deductions = pf + pt;

      await db.payslip.create({
        data: {
          runId: run.id,
          userId: person.id,
          monthDays: new Prisma.Decimal(monthDays),
          paidDays: new Prisma.Decimal(paidDays),
          lopDays: new Prisma.Decimal(lop),
          basic: new Prisma.Decimal(Math.round((basic * paidDays) / monthDays)),
          hra: new Prisma.Decimal(Math.round((hra * paidDays) / monthDays)),
          conveyance: structure.conveyance,
          medical: structure.medical,
          specialAllowance: structure.specialAllowance,
          grossEarnings: new Prisma.Decimal(earned),
          pfEmployee: new Prisma.Decimal(pf),
          pfEmployer: new Prisma.Decimal(pf),
          professionalTax: new Prisma.Decimal(pt),
          totalDeductions: new Prisma.Decimal(deductions),
          netPay: new Prisma.Decimal(earned - deductions),
          employerCost: new Prisma.Decimal(earned + pf),
        },
      });
      payslips += 1;
    }
  }
  log("Payroll", `2 runs, ${payslips} payslips`);

  // ── Hiring ──────────────────────────────────────────────────────────────────────────────────
  let candidates = 0;
  for (const role of ["Account Manager", "Support Engineer", "Calling Executive", "Presales Consultant", "Accounts Executive"]) {
    for (let i = 0; i < int(2, 5); i++) {
      const name = personName();
      await db.candidate.create({
        data: {
          name,
          email: `${name.toLowerCase().replace(" ", ".")}${i}@applicant.example`,
          phone: phone(),
          designation: role,
          departmentId: departments.get(pick(["Sales", "Support", "Inside Sales", "Accounts"]))!,
          status: pick(["PROSPECT", "PROSPECT", "OFFERED", "ACCEPTED", "JOINED", "DECLINED", "WITHDRAWN"] as const),
          role: pick(["SALES", "SUPPORT", "ACCOUNTS", "CALLING"] as const),
          offeredCtc: new Prisma.Decimal(int(300000, 1400000)),
          expectedJoining: daysAhead(int(5, 60)),
          source: pick(["Naukri", "Referral", "LinkedIn", "Walk-in"]),
          managerId: pick(people.filter((p) => p.isManager)).id,
          ownerId: hr.id,
          createdAt: sometimeLastYear(),
        },
      });
      candidates += 1;
    }
  }
  log("Hiring", `${candidates} candidates in the pipeline`);

  // ── Celebrations ────────────────────────────────────────────────────────────────────────────
  for (const [kind, title, message] of [
    ["ACHIEVEMENT", "Q2 target smashed", "The Mumbai team closed 118% of target. Well done."],
    ["FESTIVAL", "Happy Diwali", "Office closed 20th and 23rd. Have a good break."],
    ["MILESTONE", "500th customer", "We signed our five hundredth customer this month."],
    ["WELCOME", "Welcome aboard", "Three new joiners on the support desk this week."],
  ] as const) {
    await db.celebration.create({
      data: {
        kind,
        title,
        message,
        startsOn: daysAgo(int(1, 40)),
        endsOn: daysAhead(int(1, 20)),
        audience: "EVERYONE",
        createdById: hr.id,
      },
    });
  }

  // ── Targets and incentives ──────────────────────────────────────────────────────────────────
  const quarterStart = new Date();
  quarterStart.setMonth(Math.floor(quarterStart.getMonth() / 3) * 3, 1);
  const quarterEnd = new Date(quarterStart);
  quarterEnd.setMonth(quarterEnd.getMonth() + 3, 0);

  const scheme = await db.incentiveScheme.create({
    data: {
      name: "Sales incentive — 2% of collected value",
      description: "Paid on collection, not on invoicing, once 80% of target is met.",
      metric: "COLLECTED_VALUE",
      basis: "PERCENT_OF_ACHIEVEMENT",
      thresholdPercent: new Prisma.Decimal(80),
      ratePercent: new Prisma.Decimal(2),
      requiresCollection: true,
      createdById: controller.id,
    },
    select: { id: true },
  });
  await db.incentiveScheme.create({
    data: {
      name: "Calling bonus — per connected call",
      metric: "CALLS_CONNECTED",
      basis: "PER_UNIT",
      perUnitAmount: new Prisma.Decimal(12),
      capAmount: new Prisma.Decimal(8000),
      createdById: controller.id,
    },
  });

  let targets = 0;
  let earnings = 0;
  for (const person of sales) {
    await db.target.create({
      data: {
        metric: "INVOICED_VALUE",
        period: "QUARTER",
        scope: "USER",
        userId: person.id,
        fromDate: quarterStart,
        toDate: quarterEnd,
        label: `${person.name.split(" ")[0]} — this quarter`,
        value: new Prisma.Decimal(int(1500000, 6000000)),
        incentiveSchemeId: scheme.id,
        createdById: controller.id,
      },
    });
    targets += 1;

    if (chance(0.5)) {
      const amount = int(4000, 60000);
      await db.incentiveEarning.create({
        data: {
          userId: person.id,
          schemeId: scheme.id,
          fromDate: daysAgo(90),
          toDate: daysAgo(1),
          label: "Last quarter — collected value",
          amount: new Prisma.Decimal(amount),
          workings: `2% of ₹${(amount * 50).toLocaleString("en-IN")} collected, threshold met.`,
          status: pick(["DUE", "APPROVED", "PAID", "HELD"] as const),
          createdById: controller.id,
        },
      });
      earnings += 1;
    }
  }
  // Two department-level targets, so the scope filter has something to show.
  for (const dept of ["Sales", "Support"]) {
    await db.target.create({
      data: {
        metric: dept === "Sales" ? "LEADS_WON" : "TICKETS_RESOLVED",
        period: "QUARTER",
        scope: "DEPARTMENT",
        departmentId: departments.get(dept)!,
        fromDate: quarterStart,
        toDate: quarterEnd,
        label: `${dept} — this quarter`,
        value: new Prisma.Decimal(dept === "Sales" ? 60 : 220),
        createdById: controller.id,
      },
    });
    targets += 1;
  }
  log("Targets", `${targets} targets, 2 incentive schemes, ${earnings} earnings`);

  // ── Marketing ───────────────────────────────────────────────────────────────────────────────
  const marketer = people.find((p) => p.dept === "Management") ?? people[0]!;
  const audience = await db.audience.create({
    data: {
      name: "Customers with renewals in 60 days",
      description: "Anybody with a subscription expiring soon, excluding reseller-managed accounts.",
      companyFilters: { stage: ["CUSTOMER"], hasRenewalWithinDays: 60 },
      contactFilters: { isPrimary: true },
      createdById: marketer.id,
    },
    select: { id: true },
  });
  const template = await db.marketingTemplate.create({
    data: {
      name: "Renewal reminder — 60 days",
      subject: "Your {{product}} renewal is due on {{renewalDate}}",
      body: "Hello {{firstName}},\n\nYour {{product}} subscription renews on {{renewalDate}}. Shall we raise the quotation?\n\n{{senderName}}",
      channel: "EMAIL",
      topic: "RENEWALS",
      createdById: marketer.id,
    },
    select: { id: true },
  });
  await db.campaign.create({
    data: {
      reference: "CMP-2026-0001",
      name: "Q3 renewal reminders",
      audienceId: audience.id,
      templateId: template.id,
      status: "DRAFT",
      createdById: marketer.id,
    },
  });
  log("Marketing", "1 audience, 1 template, 1 campaign (draft — nothing is sent)");

  // ── Customer feedback ───────────────────────────────────────────────────────────────────────
  let requested = 0;
  let answered = 0;
  for (const company of some(customers, 45)) {
    const request = await db.feedbackRequest.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        reference: `FB-${String(requested + 1).padStart(5, "0")}`,
        companyId: company.id,
        contactId: company.contactIds[0] ?? null,
        requestedById: pick(support).id,
        aboutUserId: pick(support).id,
        serviceLabel: pick(["Ticket resolution", "On-site visit", "Installation", "Renewal"]),
        status: "SENT",
        sentAt: daysAgo(int(3, 120)),
        expiresAt: daysAhead(int(1, 30)),
      },
      select: { id: true },
    });
    requested += 1;

    if (chance(0.55)) {
      const rating = pick([5, 5, 4, 4, 4, 3, 2]);
      await db.feedbackResponse.create({
        data: {
          requestId: request.id,
          rating,
          comment: rating >= 4
            ? pick(["Quick and professional.", "Engineer knew what he was doing.", "Sorted the same day."])
            : pick(["Took three follow-ups.", "Issue came back a week later."]),
          acknowledgedAt: rating <= 3 && chance(0.6) ? daysAgo(int(1, 20)) : null,
        },
      });
      answered += 1;
    }
  }
  log("Customer feedback", `${requested} requests, ${answered} answered`);

  // ── Asset movements, domains, a handover and a consignment ──────────────────────────────────
  let movements = 0;
  for (const asset of await db.asset.findMany({ where: { custodianUserId: { not: null } }, take: 60, select: { id: true, custodianUserId: true, createdAt: true } })) {
    await db.assetMovement.create({
      data: {
        assetId: asset.id,
        type: "ASSIGNED",
        occurredAt: asset.createdAt,
        toUserId: asset.custodianUserId,
        recordedById: adminId,
        acknowledgedAt: chance(0.7) ? new Date(asset.createdAt.getTime() + 86400000) : null,
      },
    });
    movements += 1;
  }

  let domains = 0;
  for (const company of some(customers, 40)) {
    await db.domainProfile.create({
      data: {
        companyId: company.id,
        domain: `${company.name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14)}.example`,
        emailProvider: pick(["Microsoft 365", "Google Workspace", "Zoho Mail", "On-premise Exchange"]),
        mxHosts: pick([["wroffy-mail.protection.outlook.com"], ["aspmx.l.google.com"], ["mx.zoho.in"]]),
        // The reason this module exists: a customer on Google Workspace is a Microsoft 365
        // conversation waiting to happen, and one with no DMARC is a security conversation.
        platform: pick(["WordPress", "Shopify", "Custom", "Wix"]),
        hostProvider: pick(["AWS", "GoDaddy", "Hostinger", "DigitalOcean"]),
        registrar: pick(["GoDaddy", "BigRock", "Namecheap"]),
        expiresOn: daysAhead(int(-40, 500)),
        spfRecord: chance(0.8) ? "v=spf1 include:spf.protection.outlook.com -all" : null,
        dmarcRecord: chance(0.5) ? "v=DMARC1; p=none; rua=mailto:dmarc@example.com" : null,
        dmarcPolicy: pick(["none", "quarantine", "reject"]),
        dkimFound: chance(0.55),
        fetchedAt: daysAgo(int(1, 200)),
      },
    });
    domains += 1;
  }
  log("Estate", `${movements} asset movements, ${domains} customer domains profiled`);

  /**
   * Two people have left, and their work has been handed on.
   *
   * Run through the real `HANDOVER_AREAS` rather than by writing the end state directly: the areas'
   * own `give` functions are what move a credential, set its re-key deadline and fold a duplicate
   * share into the stronger of the two. Writing the result by hand here would mean the demo showed
   * something the application does not actually produce, which is the one thing a demo must not do.
   *
   * The second handover is deliberately three months old with its deadline missed, because "change
   * this within a fortnight" and "you were told to change this in June" look different on the card
   * and both are worth seeing.
   */
  const leavers = await db.user.findMany({
    where: { active: false, email: { endsWith: DEMO_EMAIL_DOMAIN } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  let handovers = 0;
  let rekeyed = 0;

  for (const [index, leaver] of leavers.entries()) {
    const recent = index === 0;
    const when = recent ? daysAgo(int(3, 11)) : daysAgo(int(88, 96));

    /**
     * Give them something to hand over first.
     *
     * The seed made everybody else the owner, so without this the leaver holds nothing and the
     * handover screen is a list of zeroes — which demonstrates the feature exists and nothing else.
     */
    const theirs = some(
      await db.vaultCredential.findMany({
        // Not one the earlier leaver already handed over. Two handovers touching the same record
        // means the second one's deadline lands on the first one's credential — a login handed
        // over last week showing a re-key that was due in June, which is a state the application
        // would never produce.
        where: { rotateBy: null },
        orderBy: { loginName: "asc" },
        select: { id: true },
      }),
      recent ? 5 : 3,
    );
    if (theirs.length === 0) continue;
    await db.vaultCredential.updateMany({
      where: { id: { in: theirs.map((c) => c.id) } },
      data: { ownerId: leaver.id },
    });

    // And a couple of logins somebody else lent them, which have to move too.
    const lent = some(
      await db.vaultCredential.findMany({
        where: { ownerId: { not: leaver.id }, shares: { none: { userId: leaver.id } } },
        select: { id: true },
      }),
      2,
    );
    const lentShares = [];
    for (const credential of lent) {
      lentShares.push(
        await db.vaultShare.create({
          data: {
            credentialId: credential.id,
            userId: leaver.id,
            level: pick(["VIEW", "MANAGE"] as const),
            sharedById: adminId,
          },
          select: { id: true },
        }),
      );
    }

    /**
     * Split between two successors, because that is the point of the area being splittable: the
     * domains go to one person and the finance portals to another. One successor inheriting a
     * leaver's entire keyring replaces a departed account with a single point of failure.
     */
    const successors = some(people, 2);
    const half = Math.ceil(theirs.length / 2);
    const split: [string, { id: string }[]][] = [
      [successors[0]!.id, theirs.slice(0, half)],
      [successors[1]?.id ?? successors[0]!.id, theirs.slice(half)],
    ];

    const credentialArea = areaByKey.get("vault-credentials")!;
    const shareArea = areaByKey.get("vault-shares")!;
    const lines: { areaKey: string; areaLabel: string; toUserId: string; count: number }[] = [];

    for (const [toUserId, group] of split) {
      if (group.length === 0) continue;
      await credentialArea.give(db, group.map((c) => c.id), toUserId, { actorId: hr.id, fromUserId: leaver.id });
      lines.push({ areaKey: credentialArea.key, areaLabel: credentialArea.label, toUserId, count: group.length });
      rekeyed += group.length;
    }

    if (lentShares.length > 0) {
      await shareArea.give(db, lentShares.map((s) => s.id), successors[0]!.id, {
        actorId: hr.id,
        fromUserId: leaver.id,
      });
      lines.push({
        areaKey: shareArea.key,
        areaLabel: shareArea.label,
        toUserId: successors[0]!.id,
        count: lentShares.length,
      });
    }

    /**
     * The older handover's deadline has already passed. `give` always sets it a fortnight out from
     * now, so it is backdated here to the day the handover actually happened — the alternative is a
     * three-month-old handover whose re-key is somehow still pending, which is not a state the
     * application can produce.
     */
    if (!recent) {
      await db.vaultCredential.updateMany({
        where: { id: { in: theirs.map((c) => c.id) } },
        data: { rotateBy: new Date(when.getTime() + HANDOVER_ROTATION_DAYS * 86400000) },
      });
    }

    await db.handover.create({
      data: {
        fromUserId: leaver.id,
        performedById: hr.id,
        reason: recent ? "Resigned — last working day 30 September" : "Resigned — left at the end of June",
        createdAt: when,
        lines: {
          create: [
            { areaKey: "accounts-owned", areaLabel: "Accounts they own", toUserId: successors[0]!.id, count: int(4, 12) },
            { areaKey: "leads", areaLabel: "Open leads", toUserId: successors[0]!.id, count: int(1, 6) },
            { areaKey: "tasks", areaLabel: "Open tasks", toUserId: successors[1]?.id ?? successors[0]!.id, count: int(1, 5) },
            ...lines,
          ],
        },
      },
    });
    handovers += 1;
  }

  /**
   * And one handover that is still happening.
   *
   * The two above are finished and their people are gone. This one belongs to somebody still at
   * their desk working out their notice, which is the state their own page is written for — and
   * the only one in which they can still sign in and read it.
   *
   * Their accounts and leads have moved; their stored logins deliberately have not yet, because a
   * half-finished handover is the normal state of one and a demo where every handover is complete
   * cannot show the screen doing its job.
   */
  if (leaving) {
    const successor = pick(people.filter((p) => p.id !== leaving.id));
    await db.handover.create({
      data: {
        fromUserId: leaving.id,
        performedById: hr.id,
        reason: "Resigned — working out notice",
        createdAt: daysAgo(int(1, 5)),
        lines: {
          create: [
            { areaKey: "accounts-owned", areaLabel: "Accounts they own", toUserId: successor.id, count: int(3, 9) },
            { areaKey: "leads", areaLabel: "Open leads", toUserId: successor.id, count: int(1, 4) },
          ],
        },
      },
    });
    log("In progress", `${leaving.name} is serving notice — part of their book has moved to ${successor.name}`);
  }

  const flagged = await db.vaultCredential.count({ where: { rotateBy: { not: null } } });
  log("Handover", `${handovers} from people who left — ${flagged} logins inherited and flagged to re-key`);
  void rekeyed;
}
