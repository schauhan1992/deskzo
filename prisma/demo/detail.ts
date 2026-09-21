import { PrismaClient, Prisma } from "@prisma/client";
import { encryptSecret } from "../../src/lib/crypto";
import { computeDocument, resolveSupplyType, type LineInput } from "../../src/lib/gst-engine";
import { statementFingerprint } from "../../src/lib/ledger/reconcile";
import type { SeededItem } from "./catalogue";
import type { SeededPerson } from "./people";
import { chance, daysAgo, daysAhead, duringWorkHours, int, log, pick, rnd, some } from "./shared";

/**
 * The detail behind the headline records.
 *
 * Everything here hangs off something that already exists, and every one of these tables is the
 * answer to a question somebody asks on a screen they have already opened: what does this project's
 * agreement say, what is the login for that hosting panel, who is actually working this calling
 * list, what did this person do before they joined, which bank rows have been agreed and which have
 * not. Empty, each of those screens reads as broken rather than as new.
 *
 * Runs before the ledger is posted, because the credit notes it raises have to be posted along with
 * everything else.
 */

/** Maharashtra, so Mumbai and Pune customers are intra-state. Same as the invoice seed. */
const SELLER_STATE = "27";

/**
 * A one-pixel PNG standing in for a scanned page.
 *
 * Deliberately an image rather than a stub PDF: a scan is what these documents actually are in this
 * business, and an image that opens is better than a PDF that does not. Nothing in a demo should
 * carry a real agreement, so the content is a pixel and the filename carries the meaning.
 */
const SCAN = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function seedDetail(
  db: PrismaClient,
  items: SeededItem[],
  people: SeededPerson[],
  departments: Map<string, string>,
  adminId: string,
) {
  const sales = people.filter((p) => p.dept === "Sales");
  const accounts = people.filter((p) => p.dept === "Accounts");
  const support = people.filter((p) => p.dept === "Support");
  const hr = people.find((p) => p.title === "HR Manager") ?? people[0]!;
  const anyone = (list: SeededPerson[]) => (list.length > 0 ? pick(list) : pick(people));

  // ── Project documents and credentials ───────────────────────────────────────────────────────
  const projects = await db.project.findMany({ select: { id: true, name: true, managerId: true, createdById: true } });
  const DOCS = [
    ["AGREEMENT", "Master services agreement (signed)"],
    ["NDA", "Mutual NDA"],
    ["SOW", "Statement of work"],
    ["DESIGN", "Solution design"],
    ["SIGN_OFF", "UAT sign-off"],
    ["HANDOVER", "Handover note"],
    ["REPORT", "Migration report"],
  ] as const;

  const CREDS = [
    ["cPanel — production", "https://cp.hosting.example/login", "root"],
    ["Registrar account", "https://registrar.example/signin", "billing@wroffy.com"],
    ["Microsoft 365 partner portal", "https://partner.microsoft.com", "admin@tenant.onmicrosoft.com"],
    ["Firewall admin", "https://10.0.0.1", "wroffy-admin"],
    ["SMTP relay", "https://relay.example/console", "relay-user"],
    ["Backup console", "https://backup.example", "svc-backup"],
  ] as const;

  let projectDocs = 0;
  let projectCreds = 0;
  let reveals = 0;
  for (const project of projects) {
    for (const [type, name] of some(DOCS, int(1, 4))) {
      await db.projectDocument.create({
        data: {
          projectId: project.id,
          type,
          name: `${name} — ${project.name}`,
          fileDataUrl: SCAN,
          mimeType: "image/png",
          sizeBytes: 68,
          uploadedById: project.managerId ?? project.createdById,
          createdAt: daysAgo(int(10, 300)),
        },
      });
      projectDocs += 1;
    }

    for (const [label, url, username] of some(CREDS, int(0, 3))) {
      const rotatedAt = daysAgo(int(20, 400));
      const credential = await db.projectCredential.create({
        data: {
          projectId: project.id,
          label,
          username,
          url,
          // Encrypted the same way the action encrypts it, so the reveal path decrypts what the seed
          // wrote. A seed that stored plain text would make the one screen whose whole purpose is
          // that nothing is stored in the clear a lie.
          secretCipher: encryptSecret(`Dm0-${int(100000, 999999)}-${label.slice(0, 3).toLowerCase()}`),
          note: chance(0.4) ? "Two-step is on the shared mailbox." : null,
          rotatedAt,
          expiresAt: chance(0.5) ? new Date(rotatedAt.getTime() + 365 * 86400000) : null,
          createdById: project.managerId ?? project.createdById,
          createdAt: rotatedAt,
        },
        select: { id: true },
      });
      projectCreds += 1;

      // Reveals are the audit trail — the record exists so "who looked at this, and when" has an
      // answer. A credentials store with no reveal log is a shared password with extra steps.
      for (let i = 0; i < int(0, 3); i++) {
        await db.credentialReveal.create({
          data: { credentialId: credential.id, userId: anyone(support).id, at: daysAgo(int(1, 120)) },
        });
        reveals += 1;
      }
    }
  }
  log("Project files", `${projectDocs} documents, ${projectCreds} credentials, ${reveals} reveals logged`);

  // ── Resellers ───────────────────────────────────────────────────────────────────────────────
  // The companies seed already put end customers behind resellers; this is the reseller's own side
  // of that relationship — the agreement, the tier, and the prices they buy at.
  const resellerIds = [
    ...new Set(
      (await db.company.findMany({ where: { managedByResellerId: { not: null } }, select: { managedByResellerId: true } }))
        .map((c) => c.managedByResellerId!)
        .filter(Boolean),
    ),
  ];
  let resellerPrices = 0;
  for (const companyId of resellerIds) {
    const signedOn = daysAgo(int(120, 700));
    await db.resellerProfile.create({
      data: {
        companyId,
        status: pick(["ACTIVE", "ACTIVE", "ACTIVE", "ONBOARDING", "SUSPENDED"] as const),
        tier: pick(["SILVER", "SILVER", "GOLD", "PLATINUM"] as const),
        agreementSignedOn: signedOn,
        agreementReference: `RSL/${signedOn.getFullYear()}/${int(100, 999)}`,
        agreementApprovedByUserId: anyone(sales).id,
        creditLimit: new Prisma.Decimal(int(2, 25) * 100000),
        discountPercent: new Prisma.Decimal(int(4, 18)),
        activatedAt: signedOn,
        createdAt: signedOn,
      },
    });
    for (const item of some(items, int(2, 6))) {
      await db.resellerItemPrice.create({
        data: {
          resellerId: companyId,
          itemId: item.id,
          // Below list, which is the entire point of a reseller price list.
          price: new Prisma.Decimal(Math.round(item.price * (0.72 + rnd() * 0.16))),
          createdAt: signedOn,
        },
      });
      resellerPrices += 1;
    }
  }
  log("Resellers", `${resellerIds.length} profiles, ${resellerPrices} agreed prices`);

  // ── What an order cost us beyond the purchase price ─────────────────────────────────────────
  const orderLines = await db.companyProduct.findMany({ select: { id: true }, take: 400 });
  let orderExpenses = 0;
  for (const line of some(orderLines, 90)) {
    for (const type of some(["COMMISSION", "FREIGHT", "INSTALLATION", "OTHER"] as const, int(1, 2))) {
      await db.orderExpense.create({
        data: {
          companyProductId: line.id,
          type,
          amount: new Prisma.Decimal(int(500, 24000)),
          notes: type === "COMMISSION" ? "Introducer commission" : null,
          createdAt: daysAgo(int(1, 340)),
        },
      });
      orderExpenses += 1;
    }
  }
  log("Order costs", `${orderExpenses} freight, commission and installation lines`);

  // ── Credit notes ────────────────────────────────────────────────────────────────────────────
  /**
   * Raised against real invoices and applied to them, because a credit note that sits unapplied
   * tells you nothing — the figure that matters is what the customer still owes after it.
   *
   * The tax goes through `computeDocument`, the same engine the invoices went through. Taking a
   * proportion of each stored figure instead looks right and is not: rounding each component
   * independently leaves the parts a few paise off the total, and the posting engine rejects an
   * entry that does not balance — correctly, and loudly.
   */
  const creditable = await db.tradeDocument.findMany({
    where: { docType: "INVOICE", status: { in: ["PAID", "PARTIALLY_PAID", "ISSUED"] } },
    select: {
      id: true, docNumber: true, companyId: true, locationId: true, issueDate: true,
      placeOfSupplyCode: true, salespersonId: true,
      lines: {
        select: {
          itemId: true, name: true, hsnCode: true, unit: true, quantity: true,
          unitPrice: true, taxRatePercent: true,
        },
        take: 1,
      },
    },
    take: 80,
  });

  let creditNotes = 0;
  for (const invoice of some(creditable, 14)) {
    const line = invoice.lines[0];
    if (!line) continue;

    // One line of the invoice credited in full — a returned licence or a machine sent back, which
    // is what a credit note usually is. A proportion of everything is not.
    const input: LineInput = {
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      discountMode: "PERCENT",
      discountValue: 0,
      taxRatePercent: Number(line.taxRatePercent),
    };
    const computed = computeDocument([input], resolveSupplyType(SELLER_STATE, invoice.placeOfSupplyCode ?? SELLER_STATE));

    const raised = new Date((invoice.issueDate ?? daysAgo(60)).getTime() + int(5, 60) * 86400000);
    const dated = raised > new Date() ? daysAgo(int(1, 20)) : raised;
    const fy = dated.getMonth() >= 3 ? dated.getFullYear() : dated.getFullYear() - 1;

    const note = await db.tradeDocument.create({
      data: {
        docNumber: `CN/${String(fy).slice(2)}-${String(fy + 1).slice(2)}/${String(creditNotes + 1).padStart(4, "0")}`,
        docType: "CREDIT_NOTE",
        direction: "SALES",
        status: "ISSUED",
        companyId: invoice.companyId,
        locationId: invoice.locationId,
        againstDocumentId: invoice.id,
        placeOfSupplyCode: invoice.placeOfSupplyCode,
        gstTreatment: "REGISTERED_REGULAR",
        salespersonId: invoice.salespersonId,
        createdById: anyone(accounts).id,
        issueDate: dated,
        reference: `Against ${invoice.docNumber}`,
        notes: pick([
          "Licence returned within the cancellation window.",
          "Billing correction — quantity overstated.",
          "Goodwill credit agreed with the account manager.",
        ]),
        subtotal: new Prisma.Decimal(computed.subtotal),
        discountTotal: new Prisma.Decimal(computed.discountTotal),
        taxableValue: new Prisma.Decimal(computed.taxableValue),
        cgstAmount: new Prisma.Decimal(computed.cgstAmount),
        sgstAmount: new Prisma.Decimal(computed.sgstAmount),
        igstAmount: new Prisma.Decimal(computed.igstAmount),
        roundOff: new Prisma.Decimal(computed.roundOff),
        total: new Prisma.Decimal(computed.total),
        createdAt: dated,
        lines: {
          create: [{
            itemId: line.itemId,
            name: line.name,
            hsnCode: line.hsnCode,
            unit: line.unit,
            quantity: new Prisma.Decimal(input.quantity),
            unitPrice: new Prisma.Decimal(input.unitPrice),
            taxRatePercent: new Prisma.Decimal(input.taxRatePercent ?? 18),
            taxableValue: new Prisma.Decimal(computed.lines[0]!.taxableValue),
            cgstAmount: new Prisma.Decimal(computed.lines[0]!.cgstAmount),
            sgstAmount: new Prisma.Decimal(computed.lines[0]!.sgstAmount),
            igstAmount: new Prisma.Decimal(computed.lines[0]!.igstAmount),
            lineTotal: new Prisma.Decimal(computed.lines[0]!.lineTotal),
            sortOrder: 0,
          }],
        },
      },
      select: { id: true, total: true },
    });

    await db.creditNoteApplication.create({
      data: {
        creditNoteId: note.id,
        invoiceId: invoice.id,
        amount: note.total,
        appliedByUserId: anyone(accounts).id,
        createdAt: dated,
      },
    });
    creditNotes += 1;
  }
  log("Credit notes", `${creditNotes}, each applied to the invoice it credits`);

  // ── Contact verification ────────────────────────────────────────────────────────────────────
  const contacts = await db.contact.findMany({ select: { id: true, companyId: true, email: true, phone: true }, take: 400 });
  let verifications = 0;
  for (const contact of some(contacts, 120)) {
    const field = chance(0.6) ? "EMAIL" : "PHONE";
    const original = (field === "EMAIL" ? contact.email : contact.phone) ?? "";
    if (!original) continue;
    const status = pick(["CORRECT", "CORRECT", "CORRECT", "CORRECTED", "WRONG"] as const);
    const verifiedAt = daysAgo(int(1, 200));
    await db.contactVerification.create({
      data: {
        companyId: contact.companyId,
        contactId: contact.id,
        field,
        originalValue: original,
        // A correction carries the new value; "wrong" carries none, because knowing it is wrong and
        // knowing what it should be are different facts and only one of them was established.
        correctedValue: status === "CORRECTED" ? original.replace(/^[^@]*/, (s) => `${s}.new`) : null,
        status,
        note: status === "WRONG" ? "Number unobtainable — left the company." : null,
        verifiedByUserId: anyone(support).id,
        verifiedAt,
        appliedAt: status === "CORRECTED" ? verifiedAt : null,
        appliedByUserId: status === "CORRECTED" ? anyone(support).id : null,
      },
    });
    verifications += 1;
  }
  log("Contact checks", `${verifications} numbers and addresses verified`);

  // ── Incentive slabs ─────────────────────────────────────────────────────────────────────────
  // A scheme with no slabs pays the same rate whether somebody hit 40% or 140% of quota, which is
  // not an incentive scheme.
  let slabs = 0;
  for (const scheme of await db.incentiveScheme.findMany({ select: { id: true } })) {
    for (const [from, to, rate] of [
      [80, 100, 1],
      [100, 120, 2],
      [120, null, 3.5],
    ] as const) {
      await db.incentiveSlab.create({
        data: {
          schemeId: scheme.id,
          fromPercent: new Prisma.Decimal(from),
          toPercent: to === null ? null : new Prisma.Decimal(to),
          ratePercent: new Prisma.Decimal(rate),
        },
      });
      slabs += 1;
    }
  }
  log("Incentive slabs", `${slabs} across the schemes`);

  // ── Who is working the calling lists ────────────────────────────────────────────────────────
  const workbooks = await db.workbook.findMany({ select: { id: true, ownerUserId: true, dueAt: true } });
  const callers = people.filter((p) => p.dept === "Calling" || p.dept === "Sales");
  let assignees = 0;
  for (const workbook of workbooks) {
    for (const caller of some(callers, int(2, 5))) {
      await db.workbookAssignee.create({
        data: {
          workbookId: workbook.id,
          userId: caller.id,
          assignedByUserId: workbook.ownerUserId,
          assignedAt: daysAgo(int(2, 60)),
          dueAt: workbook.dueAt,
          completedAt: chance(0.35) ? daysAgo(int(1, 20)) : null,
        },
      });
      assignees += 1;
    }
  }
  log("Calling allocation", `${assignees} callers across ${workbooks.length} workbooks`);

  // ── Who each survey was put in front of ─────────────────────────────────────────────────────
  /**
   * The engagement seed's pulse and party poll go to everyone, which is right for both. These two
   * are the other halves of the same feature — one aimed at a couple of teams, one at a named list
   * of people — because an audience control with only one of its three settings ever used is a
   * control nobody can tell works.
   *
   * A company-wide survey gets no target rows at all. Everybody is the audience, and writing a
   * hundred rows to say so produces a list that is wrong the moment somebody joins.
   */
  let surveyTargets = 0;
  const deptIds = [...departments.values()];

  const teamVote = await db.survey.create({
    data: {
      kind: "POLL",
      title: "Support & IT — which on-call rota do you prefer?",
      description: "Only the two teams it affects are being asked.",
      anonymous: false,
      mandatory: false,
      audience: "DEPARTMENT",
      status: "OPEN",
      expiresAt: daysAhead(9),
      createdById: hr.id,
      createdAt: daysAgo(4),
      questions: {
        create: [{
          kind: "SINGLE_CHOICE",
          prompt: "Pick a rota",
          required: true,
          options: ["One week in four", "Two days in eight", "Alternate weekends"],
          sortOrder: 0,
        }],
      },
    },
    select: { id: true },
  });
  for (const departmentId of some(deptIds, 2)) {
    await db.surveyTarget.create({ data: { surveyId: teamVote.id, departmentId } });
    surveyTargets += 1;
  }

  const namedForm = await db.survey.create({
    data: {
      kind: "FORM",
      title: "Probation review — self assessment",
      description: "Sent to the people whose probation ends this quarter.",
      anonymous: false,
      mandatory: true,
      audience: "INDIVIDUAL",
      status: "OPEN",
      expiresAt: daysAhead(14),
      createdById: hr.id,
      createdAt: daysAgo(3),
      questions: {
        create: [
          { kind: "TEXT", prompt: "What went well in your first six months?", required: true, sortOrder: 0 },
          { kind: "TEXT", prompt: "What would you like more support with?", required: false, sortOrder: 1 },
          { kind: "RATING", prompt: "How settled do you feel?", required: true, sortOrder: 2 },
        ],
      },
    },
    select: { id: true },
  });
  for (const person of some(people, 9)) {
    await db.surveyTarget.create({ data: { surveyId: namedForm.id, userId: person.id } });
    surveyTargets += 1;
  }

  // The daily cap on anonymous feedback — the one rate limit that can be kept without knowing who
  // wrote what, because it counts a sender's submissions and stores nothing else about them.
  let quotas = 0;
  for (const person of some(people, 40)) {
    await db.feedbackQuota.create({
      data: { userId: person.id, onDate: daysAgo(int(0, 30)), count: int(1, 3) },
    });
    quotas += 1;
  }
  log("Engagement reach", `2 targeted surveys, ${surveyTargets} targets, ${quotas} daily quotas`);

  // ── Where people worked before ──────────────────────────────────────────────────────────────
  const PRIOR = ["Redington India", "Ingram Micro", "Savex Technologies", "Rashi Peripherals", "Softcell", "Orbit Techsol", "Embee Software", "Team Computers", "Compufield", "Allied Digital"];
  let history = 0;
  for (const person of some(people, 62)) {
    for (let i = 0; i < int(1, 3); i++) {
      const toDate = daysAgo(int(400, 2500));
      const fromDate = new Date(toDate.getTime() - int(400, 1400) * 86400000);
      await db.employmentHistory.create({
        data: {
          userId: person.id,
          companyName: pick(PRIOR),
          designation: pick(["Executive", "Senior Executive", "Team Lead", "Assistant Manager", "Manager"]),
          location: pick(["Mumbai", "Pune", "Bengaluru", "Delhi"]),
          fromDate,
          toDate,
          lastDrawnCtc: new Prisma.Decimal(int(3, 18) * 100000),
          reasonForLeaving: pick(["Better opportunity", "Relocation", "Role change", "Company restructuring"]),
          referenceName: chance(0.5) ? "Reporting manager" : null,
          // Only some are verified, which is the honest state of any HR file and the reason the
          // column exists at all.
          verifiedAt: chance(0.45) ? daysAgo(int(30, 700)) : null,
          verifiedById: chance(0.45) ? hr.id : null,
        },
      });
      history += 1;
    }
  }
  log("Employment history", `${history} previous roles on file`);

  // ── Attendance: the machine at the door, and the corrections it causes ──────────────────────
  const devices: { id: string; serialNumber: string }[] = [];
  for (const [serial, name, location] of [
    ["ZK8000-A1", "Main entrance", "Andheri East — reception"],
    ["ZK8000-B2", "Second floor", "Andheri East — 2nd floor"],
  ] as const) {
    const device = await db.biometricDevice.create({
      data: {
        serialNumber: serial,
        name,
        location,
        timezone: "Asia/Kolkata",
        deviceModel: "ZKTeco uFace 800",
        firmware: "Ver 6.60",
        lastSeenAt: daysAgo(0),
        active: true,
      },
      select: { id: true, serialNumber: true },
    });
    devices.push(device);
  }

  let punches = 0;
  for (const person of some(people, 45)) {
    for (let back = 0; back < 10; back++) {
      const day = daysAgo(back);
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      for (const [hour, type] of [[9, 0], [18, 1]] as const) {
        const at = new Date(day);
        at.setHours(hour, int(0, 55), int(0, 59), 0);
        const device = pick(devices);
        await db.biometricPunch.create({
          data: {
            deviceId: device.id,
            // What the machine knows somebody by. Matching it to a user is a separate step, and
            // sometimes it fails — which is exactly why the raw row is kept.
            deviceUserId: String(1000 + (int(0, 200))),
            userId: chance(0.9) ? person.id : null,
            punchedAt: at,
            punchType: type,
            verifyMode: 1,
            // What the device actually sent, kept verbatim. When a punch cannot be matched to
            // anybody, this line is the only evidence of what came through the door.
            raw: `${device.serialNumber}|${at.toISOString()}|${type}`,
            processedAt: chance(0.9) ? at : null,
          },
        });
        punches += 1;
      }
    }
  }

  let regularisations = 0;
  for (const person of some(people, 26)) {
    const date = daysAgo(int(1, 45));
    const status = pick(["APPROVED", "APPROVED", "PENDING", "REJECTED"] as const);
    await db.attendanceRegularisation.create({
      data: {
        userId: person.id,
        date,
        requestedStatus: pick(["PRESENT", "WORK_FROM_HOME", "HALF_DAY"] as const),
        reason: pick([
          "Client visit straight from home — no punch at the door.",
          "Biometric did not read my finger; security has the register entry.",
          "Worked from home with the manager's approval.",
          "Forgot to punch out after the evening deployment.",
        ]),
        requestedCheckIn: duringWorkHours(date),
        status,
        approverId: status === "PENDING" ? null : hr.id,
        decidedAt: status === "PENDING" ? null : daysAgo(int(0, 40)),
        decisionNote: status === "REJECTED" ? "No supporting record for that day." : null,
        createdAt: date,
      },
    });
    regularisations += 1;
  }
  log("Attendance source", `${devices.length} devices, ${punches} punches, ${regularisations} regularisations`);

  // ── Consent, and who must not be contacted ──────────────────────────────────────────────────
  /**
   * Consent is recorded as an artefact rather than a flag — channel, topic, where it came from and
   * when — because that is what the DPDP Act asks to see, and a boolean cannot answer "on what
   * basis did you mail them".
   */
  let consents = 0;
  for (const contact of some(contacts, 220)) {
    for (const topic of some(["RENEWALS", "OFFERS", "PRODUCT_NEWS", "EVENTS", "NEWSLETTER", "SERVICE"] as const, int(1, 3))) {
      const status = pick(["SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "UNSUBSCRIBED", "PENDING"] as const);
      const capturedAt = daysAgo(int(5, 500));
      await db.contactConsent.create({
        data: {
          contactId: contact.id,
          channel: "EMAIL",
          topic,
          status,
          source: pick(["CONTRACT", "FORM", "IMPORT", "VERBAL", "PREFERENCE_CENTRE"] as const),
          evidence: pick(["Signed order form, clause 9.", "Opted in on the renewal reminder page.", "Confirmed on a recorded call."]),
          capturedAt,
          capturedById: anyone(sales).id,
          withdrawnAt: status === "UNSUBSCRIBED" ? daysAgo(int(1, 120)) : null,
        },
      });
      consents += 1;
    }
  }

  let suppressions = 0;
  for (const contact of some(contacts, 18)) {
    if (!contact.email) continue;
    await db.suppression.create({
      data: {
        scope: "EMAIL",
        value: contact.email.toLowerCase(),
        reason: pick(["HARD_BOUNCE", "HARD_BOUNCE", "UNSUBSCRIBED", "COMPLAINT", "MANUAL"] as const),
        note: "Recorded by the demo seed.",
        createdById: adminId,
        createdAt: daysAgo(int(1, 200)),
      },
    });
    suppressions += 1;
  }
  for (const domain of ["competitor.example", "no-contact.example"]) {
    await db.suppression.create({
      data: { scope: "DOMAIN", value: domain, reason: "MANUAL", note: "Do not market to this domain.", createdById: adminId },
    });
    suppressions += 1;
  }
  log("Consent", `${consents} recorded, ${suppressions} addresses and domains suppressed`);
}

/**
 * A bank statement for the default account, built from the payments that actually moved.
 *
 * Kept here rather than invented: a reconciliation screen is only worth looking at if the rows
 * agree with the ledger, and the whole exercise is finding the handful that do not. So most lines
 * come from real receipts, a few are the bank's own charges that nobody has booked yet, and the
 * match is left half-done — which is what a reconciliation in progress looks like.
 */
export async function seedBankStatement(db: PrismaClient, people: SeededPerson[]) {
  const bank = await db.bankAccount.findFirst({ where: { isDefault: true }, select: { id: true, ledgerAccountId: true } });
  if (!bank) return;
  const controller = people.find((p) => p.title === "Finance Controller") ?? people[0]!;

  const receipts = await db.payment.findMany({
    where: { direction: "RECEIVED", bankAccountId: bank.id },
    select: { amount: true, paidOn: true, reference: true, company: { select: { name: true } } },
    orderBy: { paidOn: "desc" },
    take: 110,
  });

  const rows = receipts.map((r) => ({
    date: r.paidOn.toISOString().slice(0, 10),
    amount: Number(r.amount),
    reference: r.reference,
    narration: `NEFT CR ${r.company.name}`.slice(0, 80),
  }));
  for (let i = 0; i < 6; i++) {
    rows.push({
      date: daysAgo(int(1, 90)).toISOString().slice(0, 10),
      amount: -int(180, 2400),
      reference: null,
      narration: pick(["BANK CHARGES", "NEFT CHARGES GST", "ACCOUNT MAINTENANCE FEE"]),
    });
  }

  // Bank lines in the ledger, so a matched statement row points at a real posting.
  const bankLines = await db.journalLine.findMany({
    where: { accountId: bank.ledgerAccountId, debit: { gt: 0 } },
    select: { id: true },
    take: 200,
  });

  let imported = 0;
  let matched = 0;
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const fingerprint = statementFingerprint(row);
    // Importing the same statement twice is the classic way this table gets corrupted, so the
    // fingerprint is unique per account — and the seed respects it rather than working around it.
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const line = row.amount > 0 && i < bankLines.length && chance(0.75) ? bankLines[i] : null;
    await db.bankStatementLine.create({
      data: {
        bankAccountId: bank.id,
        date: new Date(`${row.date}T00:00:00.000Z`),
        narration: row.narration,
        reference: row.reference,
        amount: new Prisma.Decimal(row.amount),
        fingerprint,
        matchedLineId: line?.id ?? null,
        matchedAt: line ? daysAgo(int(0, 30)) : null,
        matchedById: line ? controller.id : null,
      },
    });
    imported += 1;
    if (line) matched += 1;
  }

  const bookBalance = int(4000000, 9000000);
  const statementBalance = bookBalance + int(-140000, 140000);
  await db.bankReconciliation.create({
    data: {
      bankAccountId: bank.id,
      statementDate: daysAgo(int(1, 30)),
      statementBalance: new Prisma.Decimal(statementBalance),
      bookBalance: new Prisma.Decimal(bookBalance),
      // Written down rather than recomputed on read. What the difference was on the day somebody
      // signed the reconciliation off is the fact being recorded.
      difference: new Prisma.Decimal(statementBalance - bookBalance),
      note: "Cheques issued late in the month had not presented.",
      completedById: controller.id,
    },
  });

  log("Bank statement", `${imported} rows imported, ${matched} agreed against the ledger, 1 reconciliation`);
}
