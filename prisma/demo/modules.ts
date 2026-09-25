import { PrismaClient, Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { encryptSecret, digestSecret } from "../../src/lib/crypto";
import { generateCode } from "../../src/lib/visitors/invite-code";
import { normaliseCompany } from "../../src/lib/visitors/company-name";
import type { SeededCompany } from "./companies";
import type { SeededItem } from "./catalogue";
import type { SeededPerson } from "./people";
import { chance, daysAgo, daysAhead, duringWorkHours, int, log, personName, phone, pick, rnd, some, sometimeLastYear } from "./shared";

/**
 * The modules that hang off the CRM rather than sitting inside it.
 *
 * Projects, the credential vault, reception, the speak-up channel and the calling floor. Each is
 * seeded against the people and companies that already exist, so a project has a real customer and
 * real stakeholders, and a visitor is here to see somebody who works here.
 */

export async function seedModules(
  db: PrismaClient,
  companies: SeededCompany[],
  items: SeededItem[],
  people: SeededPerson[],
  departments: Map<string, string>,
) {
  const customers = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");
  const support = people.filter((p) => p.dept === "Support");
  const sales = people.filter((p) => p.dept === "Sales");
  const callers = people.filter((p) => p.title === "Calling Executive");
  const managers = people.filter((p) => p.isManager);
  const admin = people.find((p) => p.title === "Director")!;

  // ── Project types and the projects themselves ────────────────────────────────────────────────
  const TYPES: [name: string, steps: [string, number][]][] = [
    ["Mail migration", [["Kickoff & discovery", 0], ["Tenant prepared", 5], ["Pilot batch", 12], ["Bulk migration", 20], ["Cutover", 28], ["Hypercare & sign-off", 35]]],
    ["Website development", [["Requirements", 0], ["Wireframes", 10], ["Design sign-off", 20], ["Build", 45], ["UAT", 60], ["Go live", 70]]],
    ["Firewall implementation", [["Site survey", 0], ["Configuration", 7], ["Installation", 12], ["Policy tuning", 20], ["Handover", 25]]],
    ["Server & backup refresh", [["Audit", 0], ["Procurement", 10], ["Staging", 25], ["Cutover weekend", 35], ["Sign-off", 40]]],
    ["Security audit", [["Scoping", 0], ["Testing", 10], ["Draft report", 20], ["Remediation review", 35]]],
  ];

  const typeIds = new Map<string, string>();
  for (const [i, [name, steps]] of TYPES.entries()) {
    const row = await db.projectType.create({
      data: {
        name,
        sortOrder: i,
        templateMilestones: { create: steps.map(([stepName, dayOffset], j) => ({ name: stepName, dayOffset, sortOrder: j })) },
      },
      select: { id: true },
    });
    typeIds.set(name, row.id);
  }

  let projects = 0;
  let milestones = 0;
  let risks = 0;
  for (const company of some(customers, 38)) {
    const [typeName, steps] = pick(TYPES);
    const manager = pick(support.filter((p) => p.isManager).concat(sales.filter((p) => p.isManager)));
    const startDate = sometimeLastYear();
    const status = pick(["IN_PROGRESS", "IN_PROGRESS", "UAT", "COMPLETED", "COMPLETED", "PLANNING", "ON_HOLD"] as const);
    const health = status === "ON_HOLD" ? "OFF_TRACK" : pick(["ON_TRACK", "ON_TRACK", "ON_TRACK", "AT_RISK", "OFF_TRACK"] as const);
    const done = status === "COMPLETED";
    const value = int(80000, 1800000);

    const team = some(people.filter((p) => p.dept === "Support" || p.dept === "Presales & Solutions"), int(2, 4));
    const project = await db.project.create({
      data: {
        code: `PRJ-${startDate.getFullYear()}-${String(projects + 1).padStart(4, "0")}`,
        companyId: company.id,
        typeId: typeIds.get(typeName)!,
        name: `${typeName} — ${company.name.split(" ").slice(0, 2).join(" ")}`,
        description: "Scoped from the accepted proposal.",
        status,
        health,
        startDate,
        targetEndDate: new Date(startDate.getTime() + int(30, 120) * 86400000),
        actualEndDate: done ? new Date(startDate.getTime() + int(35, 150) * 86400000) : null,
        managerId: manager.id,
        value: new Prisma.Decimal(value),
        createdById: manager.id,
        createdAt: startDate,
        stakeholders: {
          create: [
            { userId: manager.id, role: "PROJECT_MANAGER", addedById: manager.id },
            ...team.filter((t) => t.id !== manager.id).map((t) => ({ userId: t.id, role: "TEAM_MEMBER" as const, addedById: manager.id })),
            ...some(company.contactIds, Math.min(2, company.contactIds.length)).map((contactId) => ({
              contactId,
              role: pick(["CUSTOMER_SPONSOR", "CUSTOMER_TECHNICAL"] as const),
              addedById: manager.id,
            })),
          ],
        },
        milestones: {
          // Completed projects have everything ticked; live ones are part-way through, which is
          // what makes the progress bar say something.
          create: steps.map(([name, dayOffset], j) => {
            const dueDate = new Date(startDate.getTime() + dayOffset * 86400000);
            const complete = done || (dueDate < new Date() && chance(0.75));
            return {
              name,
              dueDate,
              sortOrder: j,
              completedAt: complete ? dueDate : null,
              completedById: complete ? manager.id : null,
            };
          }),
        },
        billingMilestones: {
          create: [
            { label: "Advance", percent: new Prisma.Decimal(30), amount: new Prisma.Decimal(Math.round(value * 0.3)), status: "PAID", sortOrder: 0 },
            { label: "On UAT sign-off", percent: new Prisma.Decimal(40), amount: new Prisma.Decimal(Math.round(value * 0.4)), status: done ? "PAID" : "PENDING", sortOrder: 1 },
            { label: "On go-live", percent: new Prisma.Decimal(30), amount: new Prisma.Decimal(Math.round(value * 0.3)), status: done ? "INVOICED" : "PENDING", sortOrder: 2 },
          ],
        },
        updates: {
          create: Array.from({ length: int(1, 4) }, () => ({
            body: pick([
              "Pilot batch completed over the weekend. No mailbox issues reported.",
              "Customer has asked to push the cutover by a week — their audit is on.",
              "Hardware delivered. Staging starts Monday.",
              "Waiting on the customer's DNS access. Chased twice this week.",
              "Sign-off received. Moving to hypercare.",
            ]),
            health: pick(["ON_TRACK", "ON_TRACK", "AT_RISK"] as const),
            authorId: manager.id,
            at: daysAgo(int(1, 90)),
          })),
        },
        risks: {
          create: chance(0.55)
            ? [
                {
                  kind: pick(["RISK", "ISSUE"] as const),
                  title: pick([
                    "Customer has not frozen the change window",
                    "Legacy mailboxes larger than expected",
                    "Single point of contact is on leave",
                    "Third-party vendor slow to respond",
                    "Bandwidth at the site may not hold",
                  ]),
                  severity: pick(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const),
                  status: pick(["OPEN", "MITIGATING", "RESOLVED"] as const),
                  mitigation: chance(0.6) ? "Escalated to the account manager; weekly check-in agreed." : null,
                  ownerId: manager.id,
                  raisedById: pick(team).id,
                  raisedOn: daysAgo(int(5, 120)),
                },
              ]
            : [],
        },
      },
      select: { id: true, _count: { select: { milestones: true, risks: true } } },
    });
    projects += 1;
    milestones += project._count.milestones;
    risks += project._count.risks;
  }
  log("Projects", `${projects} with ${milestones} milestones and ${risks} risks`);

  // ── The credential vault ────────────────────────────────────────────────────────────────────
  const tags = await db.credentialTag.findMany({ select: { id: true, kind: true, name: true } });
  const categories = tags.filter((t) => t.kind === "CATEGORY");
  const accessTypes = tags.filter((t) => t.kind === "ACCESS_TYPE");

  const VAULT: [label: string, category: string, access: string, user: string, url: string][] = [
    ["GoDaddy — wroffy.com", "Domain", "Admin", "wroffy-admin", "sso.godaddy.com"],
    ["BigRock — client domains", "Domain", "Admin", "billing@wroffy", "manage.bigrock.in"],
    ["Hostinger VPS — web", "Hosting", "Admin", "root", "hpanel.hostinger.com"],
    ["AWS — production account", "Hosting", "Admin", "ops@wroffy", "console.aws.amazon.com"],
    ["cPanel — shared hosting", "Hosting", "cPanel", "wroffy", "srv22.host.example"],
    ["Microsoft Partner Center", "Partner portal", "Admin", "partner@wroffy", "partner.microsoft.com"],
    ["Adobe Reseller Console", "Partner portal", "Billing", "adobe@wroffy", "adminconsole.adobe.com"],
    ["Autodesk Partner Portal", "Partner portal", "User", "autodesk@wroffy", "partners.autodesk.com"],
    ["Ingram Micro — ordering", "Vendor portal", "Billing", "purchase@wroffy", "in.ingrammicro.com"],
    ["Redington — ordering", "Vendor portal", "Billing", "purchase@wroffy", "redingtongroup.com"],
    ["GST portal", "Government & tax", "Admin", "27AAACW1234F", "gst.gov.in"],
    ["Income Tax e-filing", "Government & tax", "Admin", "AAACW1234F", "incometax.gov.in"],
    ["EPFO employer portal", "Government & tax", "Admin", "MHBAN0012345", "unifiedportal-emp.epfindia.gov.in"],
    ["MCA21", "Government & tax", "User", "wroffy-mca", "mca.gov.in"],
    ["HDFC current account", "Banking & payments", "User", "wroffy-corp", "netbanking.hdfcbank.com"],
    ["Razorpay", "Banking & payments", "Admin", "ops@wroffy", "dashboard.razorpay.com"],
    ["Zoho Books", "Internal tool", "Admin", "accounts@wroffy", "books.zoho.in"],
    ["Google Workspace admin", "Email & collaboration", "Admin", "admin@wroffy", "admin.google.com"],
    ["Sophos Central Partner", "Partner portal", "Admin", "security@wroffy", "central.sophos.com"],
    ["LinkedIn company page", "Social & marketing", "Admin", "marketing@wroffy", "linkedin.com"],
  ];

  const controller = people.find((p) => p.title === "Finance Controller") ?? admin;
  const itLead = people.find((p) => p.title === "Support Lead") ?? admin;
  let credentials = 0;
  let shares = 0;
  let reveals = 0;

  const clientsForCredentials = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");

  for (const [label, category, access, username, url] of VAULT) {
    const owner = /Banking|Government|tax/.test(category) ? controller : itLead;
    const secret = `${pick(["Wr", "Kx", "Zt", "Qm"])}${randomBytes(6).toString("base64url")}!${int(10, 99)}`;
    const changedDaysAgo = int(20, 500);

    const credential = await db.vaultCredential.create({
      data: {
        loginName: label,
        categoryId: categories.find((c) => c.name === category)?.id ?? null,
        accessTypeId: accessTypes.find((a) => a.name === access)?.id ?? null,
        username,
        email: `${username.split("@")[0]}@wroffy.com`,
        loginUrl: url,
        phone: chance(0.4) ? phone() : null,
        secretCipher: await encryptSecret(secret),
        secretDigest: await digestSecret(secret),
        recoveryKeyCipher: chance(0.35) ? await encryptSecret(randomBytes(12).toString("base64url")) : null,
        remarks: chance(0.3) ? pick(["Two-step goes to the office mobile.", "Renewal billed annually in March.", "Shared with the vendor during onboarding — rotate after."]) : null,
        /**
         * Spread so that a handful land inside the thirty-day notice window and one or two have
         * already lapsed. A demo where nothing is close to expiring cannot show the thing the
         * expiry window is for.
         */
        billingExpiry: /Domain|Hosting|Partner|Vendor/.test(category)
          ? daysAhead(chance(0.35) ? int(-20, 28) : int(60, 320))
          : null,
        passwordChangedAt: daysAgo(changedDaysAgo),
        // A 90-day policy on the sensitive ones, which is what makes some of them show as overdue.
        rotateAfterDays: /Banking|Government|Domain/.test(category) ? 90 : chance(0.4) ? 180 : null,
        ownerId: owner.id,
        /**
         * Roughly a third are held on a customer's behalf — the hosting panel for a site we built,
         * the registrar for a domain in their name. Naming the client is what makes the filter
         * worth having: "what does this customer still have access to" is the question asked on
         * the day they leave, and it cannot be answered from a flag alone.
         */
        ...(chance(0.35) && clientsForCredentials.length > 0
          ? { ownership: "CLIENT" as const, companyId: pick(clientsForCredentials).id }
          : { ownership: "OURS" as const }),
        createdById: owner.id,
        createdAt: daysAgo(changedDaysAgo + int(0, 100)),
      },
      select: { id: true },
    });
    credentials += 1;

    // Shared the way they would be: the finance team on the banking logins, support on the rest.
    const withDept = /Banking|Government|tax/.test(category) ? "Accounts" : "Support";
    await db.vaultShare.create({
      data: {
        credentialId: credential.id,
        departmentId: departments.get(withDept)!,
        level: pick(["VIEW", "VIEW", "MANAGE"] as const),
        sharedById: owner.id,
      },
    });
    shares += 1;

    // Named people as well as the team, so the "shared with" row on the card has faces in it and
    // not only a department chip.
    for (const colleague of some(people.filter((p) => p.id !== owner.id && p.isManager), int(1, 4))) {
      await db.vaultShare.create({
        data: {
          credentialId: credential.id,
          userId: colleague.id,
          level: pick(["VIEW", "VIEW", "MANAGE"] as const),
          sharedById: owner.id,
        },
      });
      shares += 1;

      /**
       * And they have opened it, more than once.
       *
       * The access trail is the vault’s accountability story, and a trail with one line in it
       * demonstrates nothing — the question it answers is "who has had sight of this password",
       * which only becomes a real question once the answer is longer than a sentence.
       */
      for (let i = 0; i < int(0, 5); i++) {
        await db.vaultReveal.create({
          data: {
            credentialId: credential.id,
            userId: colleague.id,
            via: "SHARE",
            field: chance(0.12) ? "RECOVERY_KEY" : "PASSWORD",
            at: daysAgo(int(1, 300)),
          },
        });
        reveals += 1;
      }
    }

    // The owner reads their own, of course.
    for (let i = 0; i < int(1, 4); i++) {
      await db.vaultReveal.create({
        data: { credentialId: credential.id, userId: owner.id, via: "OWNER", field: "PASSWORD", at: daysAgo(int(1, 300)) },
      });
      reveals += 1;
    }

    // And occasionally an admin has had to go in over the top, which is the line somebody is
    // meant to notice when they open the trail.
    if (chance(0.25)) {
      await db.vaultReveal.create({
        data: { credentialId: credential.id, userId: admin.id, via: "ADMIN", field: "PASSWORD", at: daysAgo(int(1, 120)) },
      });
      reveals += 1;
    }
  }
  /**
   * A few people have pinned the handful they actually touch.
   *
   * Pins are per person, so they are seeded per person rather than on the credential — seeding
   * them the other way would produce one shortlist that everybody sees, which is the exact
   * mistake the model was shaped to prevent.
   */
  let pins = 0;
  const pinnable = await db.vaultCredential.findMany({ select: { id: true, ownerId: true } });
  for (const person of some(people, 22)) {
    const theirs = pinnable.filter((c) => c.ownerId === person.id);
    for (const credential of some(theirs.length > 0 ? theirs : pinnable, int(1, 3))) {
      await db.vaultPin.upsert({
        where: { userId_credentialId: { userId: person.id, credentialId: credential.id } },
        create: { userId: person.id, credentialId: credential.id },
        update: {},
      });
      pins += 1;
    }
  }
  /**
   * A few that were deleted, at different points in their sixty days.
   *
   * One of them is nearly out of time on purpose: an archive where everything has seven weeks
   * left cannot show the part that matters, which is the record somebody has to decide about
   * today.
   */
  const ARCHIVED = [
    ["Rackspace — legacy mail", 4, "Migrated to Microsoft 365, account closed."],
    ["Twitter Ads", 21, "Nobody has used this since the rebrand."],
    ["Old CI server", 57, "Server decommissioned."],
  ] as const;

  let archived = 0;
  for (const [name, daysAgoArchived, reason] of ARCHIVED) {
    const owner = pick(people);
    await db.vaultCredential.create({
      data: {
        loginName: name,
        username: "admin",
        secretCipher: await encryptSecret(`Arch-${int(100000, 999999)}`),
        secretDigest: await digestSecret(`Arch-${int(100000, 999999)}`),
        ownerId: owner.id,
        createdById: owner.id,
        createdAt: daysAgo(daysAgoArchived + int(200, 600)),
        archivedAt: daysAgo(daysAgoArchived),
        archivedById: admin.id,
        archiveReason: reason,
      },
    });
    archived += 1;
  }
  log("Vault archive", `${archived} deleted records waiting out their sixty days`);

  log("Vault", `${credentials} credentials, ${shares} shares, ${reveals} openings, ${pins} pins`);

  // ── Reception ───────────────────────────────────────────────────────────────────────────────
  const kiosk = await db.visitorKiosk.upsert({
    where: { token: "DEMO-RECEPTION-" + randomBytes(12).toString("base64url") },
    create: { name: "Main reception", token: randomBytes(24).toString("base64url"), createdById: admin.id },
    update: {},
    select: { id: true, name: true },
  });

  let visitors = 0;
  let invites = 0;
  for (let i = 0; i < 180; i++) {
    const at = duringWorkHours(sometimeLastYear());
    const host = pick(people);
    const purpose = pick(["MEETING", "MEETING", "MEETING", "INTERVIEW", "DELIVERY", "VENDOR"] as const);
    const company = purpose === "DELIVERY" ? pick(["Blue Dart", "Delhivery", "DTDC", "Ecom Express"]) : pick(companies).name;
    const today = at.toDateString() === new Date().toDateString();

    await db.visitorEntry.create({
      data: {
        kioskId: kiosk.id,
        purpose,
        hostUserId: host.id,
        departmentId: departments.get(host.dept) ?? null,
        name: personName(),
        phone: phone(),
        company,
        email: purpose === "DELIVERY" ? null : `visitor${i}@example.com`,
        checkedInAt: at,
        checkedOutAt: today ? null : new Date(at.getTime() + int(20, 180) * 60000),
        status: today ? "IN" : pick(["OUT", "OUT", "OUT", "ABANDONED"] as const),
        badgeNo: int(1, 40),
        companions: chance(0.2) ? { create: [{ name: personName() }] } : undefined,
      },
    });
    visitors += 1;
  }

  for (let i = 0; i < 14; i++) {
    const host = pick(people);
    await db.visitorInvite.create({
      data: {
        code: generateCode(),
        purpose: pick(["MEETING", "INTERVIEW"] as const),
        hostUserId: host.id,
        name: personName(),
        phone: phone(),
        email: `expected${i}@example.com`,
        company: pick(companies).name,
        expectedAt: daysAhead(int(0, 14)),
        expectedCompanions: chance(0.3) ? int(1, 3) : 0,
        createdById: host.id,
      },
    });
    invites += 1;
  }

  // The list of companies visitors come from learns from what was typed.
  const typed = new Set<string>();
  for (const entry of await db.visitorEntry.findMany({ select: { company: true } })) {
    if (!entry.company) continue;
    const normalizedName = normaliseCompany(entry.company);
    if (normalizedName.length < 2 || typed.has(normalizedName)) continue;
    typed.add(normalizedName);
    await db.visitorCompany.upsert({
      where: { normalizedName },
      create: { name: entry.company, normalizedName, source: "VISITOR", visitCount: int(1, 6), lastSeenAt: daysAgo(int(1, 90)) },
      update: { visitCount: { increment: 1 } },
    });
  }
  log("Reception", `${visitors} visitors, ${invites} expected, ${typed.size} companies remembered`);

  // ── Speak up, and forms ─────────────────────────────────────────────────────────────────────
  const FEEDBACK = [
    ["PRAISE", "The support team stayed back on Friday to finish a customer cutover. Nobody asked them to."],
    ["CONCERN", "The handover process between sales and delivery is not working. Things get promised that delivery hears about afterwards."],
    ["SUGGESTION", "Could we get a second monitor for the calling desks? It would save a lot of alt-tabbing."],
    ["GRIEVANCE", "Leave requests are sitting unapproved for weeks. It makes planning anything impossible."],
    ["CONCERN", "Targets were revised mid-quarter without anyone explaining why."],
    ["SUGGESTION", "A shared calendar for site visits would stop two engineers turning up at the same customer."],
    ["PRAISE", "Onboarding was genuinely good — laptop ready, accounts ready, somebody assigned to show me around."],
    ["CONCERN", "We are quoting delivery dates that purchase cannot meet."],
    ["SUGGESTION", "Please consider hybrid on Fridays."],
    ["GRIEVANCE", "Overtime on weekend cutovers is not being recognised in any way."],
  ];
  for (const [kind, body] of FEEDBACK) {
    const on = daysAgo(int(2, 180));
    await db.internalFeedback.create({
      data: {
        kind: kind as never,
        body,
        rating: chance(0.6) ? int(1, 5) : null,
        aboutUserId: chance(0.3) ? pick(managers).id : null,
        submittedOn: new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate())),
        reviewedAt: chance(0.4) ? daysAgo(int(1, 30)) : null,
        reviewedById: chance(0.4) ? people.find((p) => p.title === "HR Manager")?.id ?? null : null,
      },
    });
  }

  const hr = people.find((p) => p.title === "HR Manager") ?? admin;
  const survey = await db.survey.create({
    data: {
      kind: "FORM",
      title: "Quarterly pulse — how is it going?",
      description: "Five questions, anonymous, takes two minutes.",
      anonymous: true,
      mandatory: true,
      audience: "EVERYONE",
      status: "OPEN",
      expiresAt: daysAhead(12),
      createdById: hr.id,
      createdAt: daysAgo(6),
      questions: {
        create: [
          { kind: "RATING", prompt: "How are things at the moment?", required: true, sortOrder: 0 },
          { kind: "SCALE_1_10", prompt: "How likely are you to recommend working here?", required: true, sortOrder: 1 },
          { kind: "YES_NO", prompt: "Do you have what you need to do your job?", required: true, sortOrder: 2 },
          { kind: "SINGLE_CHOICE", prompt: "What would help most?", required: true, options: ["Better tools", "Clearer targets", "More training", "Flexible hours"], sortOrder: 3 },
          { kind: "TEXT", prompt: "Anything else?", required: false, sortOrder: 4 },
        ],
      },
    },
    include: { questions: { select: { id: true, kind: true, options: true } } },
  });

  // Enough responses to clear the five-reply threshold, so the results screen shows something.
  let responses = 0;
  for (const person of some(people, 34)) {
    const at = daysAgo(int(0, 5));
    const response = await db.surveyResponse.create({
      data: {
        surveyId: survey.id,
        submittedOn: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())),
        answers: {
          create: survey.questions.map((q) => ({
            questionId: q.id,
            number: q.kind === "RATING" ? int(2, 5) : q.kind === "SCALE_1_10" ? int(4, 10) : q.kind === "YES_NO" ? (chance(0.75) ? 1 : 0) : null,
            choices: q.kind === "SINGLE_CHOICE" ? [pick(q.options)] : [],
            text: q.kind === "TEXT" && chance(0.4) ? pick(["More clarity on incentives would help.", "Happy overall.", "The new laptops made a real difference."]) : null,
          })),
        },
      },
      select: { id: true },
    });
    // Anonymous, so participation records that they answered and never which response was theirs.
    await db.surveyParticipation.create({
      data: { surveyId: survey.id, userId: person.id, respondedAt: at, responseId: null },
    });
    responses += 1;
    void response;
  }

  const poll = await db.survey.create({
    data: {
      kind: "POLL",
      title: "Diwali party — which date works?",
      anonymous: false,
      mandatory: false,
      audience: "EVERYONE",
      status: "OPEN",
      expiresAt: daysAhead(5),
      createdById: hr.id,
      questions: { create: [{ kind: "SINGLE_CHOICE", prompt: "Pick a date", required: true, options: ["Friday 24th", "Saturday 25th", "Friday 31st"], sortOrder: 0 }] },
    },
    include: { questions: { select: { id: true, options: true } } },
  });
  for (const person of some(people, 22)) {
    const r = await db.surveyResponse.create({
      data: {
        surveyId: poll.id,
        submittedOn: new Date(),
        answers: { create: [{ questionId: poll.questions[0]!.id, choices: [pick(poll.questions[0]!.options)] }] },
      },
      select: { id: true },
    });
    // Attributed, so the link is written — openly, because the form said so.
    await db.surveyParticipation.create({
      data: { surveyId: poll.id, userId: person.id, respondedAt: new Date(), responseId: r.id },
    });
  }
  log("Engagement", `${FEEDBACK.length} anonymous items, 2 forms, ${responses + 22} responses`);

  // ── The calling floor ───────────────────────────────────────────────────────────────────────
  let workbooks = 0;
  let records = 0;
  for (const name of ["Mumbai manufacturing — cold list", "Pune IT services", "Renewals falling due — Q3", "Bengaluru mid-market"]) {
    const owner = pick(people.filter((p) => p.title === "Inside Sales Lead"));
    const pool = some(companies.filter((c) => c.stage === "PROSPECT" || c.stage === "LEAD"), int(30, 70));
    const team = some(callers, int(3, 6));
    const book = await db.workbook.create({
      data: {
        name,
        description: "Built from the company filters and shared with the calling team.",
        filters: { stage: ["PROSPECT", "LEAD"] },
        ownerUserId: owner.id,
        shared: true,
        mode: "COLD_CALLING",
        allocationMethod: "ROUND_ROBIN",
        startedAt: daysAgo(int(5, 90)),
        createdAt: daysAgo(int(10, 120)),
        records: {
          create: pool.map((c, i) => {
            const status = pick(["DONE", "DONE", "PENDING", "PENDING", "IN_PROGRESS", "SKIPPED"] as const);
            return {
              companyId: c.id,
              assignedToUserId: team[i % team.length]!.id,
              status,
              sortOrder: i,
              completedAt: status === "DONE" ? daysAgo(int(1, 60)) : null,
              handleSeconds: status === "DONE" ? int(40, 600) : null,
              outcomeNote: status === "DONE" ? pick(["Asked for a quote", "Callback next month", "Not interested", "Wrong number"]) : null,
            };
          }),
        },
      },
      select: { id: true },
    });
    workbooks += 1;
    records += pool.length;
    void book;
  }
  log("Calling lists", `${workbooks} workbooks, ${records} records allocated`);

  // ── IT assets ───────────────────────────────────────────────────────────────────────────────
  const hardware = items.filter((i) => i.type === "GOOD");
  let assets = 0;
  // Our own kit, issued to staff.
  for (const person of some(people, 55)) {
    const item = pick(hardware.filter((h) => /Latitude|ProBook|ThinkPad|OptiPlex/.test(h.name)));
    assets += 1;
    await db.asset.create({
      data: {
        assetTag: `WRF-${String(assets).padStart(4, "0")}`,
        name: item.name,
        serialNumber: randomBytes(4).toString("hex").toUpperCase(),
        kind: "LAPTOP",
        status: "ASSIGNED",
        make: item.brand,
        itemId: item.id,
        ownership: "INTERNAL",
        custodianUserId: person.id,
        warrantyEndsOn: daysAhead(int(-200, 700)),
        createdById: admin.id,
        createdAt: daysAgo(int(30, 900)),
      },
    });
  }
  // Customer kit we look after under AMC — the estate view.
  for (const company of some(customers, 30)) {
    for (let i = 0; i < int(1, 5); i++) {
      const item = pick(hardware);
      assets += 1;
      await db.asset.create({
        data: {
          assetTag: `CUS-${String(assets).padStart(4, "0")}`,
          name: item.name,
          serialNumber: randomBytes(4).toString("hex").toUpperCase(),
          kind: pick(["LAPTOP", "DESKTOP", "SERVER", "NETWORK", "PRINTER"] as const),
          status: "INSTALLED",
          make: item.brand,
          itemId: item.id,
          ownership: "CLIENT_OWNED",
          ownerCompanyId: company.id,
          siteCompanyId: company.id,
          locationId: company.locationId,
          warrantyEndsOn: daysAhead(int(-300, 600)),
          amcEndsOn: chance(0.5) ? daysAhead(int(-60, 400)) : null,
          createdById: pick(support).id,
          createdAt: daysAgo(int(30, 700)),
        },
      });
    }
  }
  log("IT assets", `${assets} — staff laptops and customer estate under AMC`);

  // ── Ticket comments ─────────────────────────────────────────────────────────────────────────
  let comments = 0;
  for (const ticket of await db.ticket.findMany({ select: { id: true, createdAt: true, assignedToUserId: true }, take: 140 })) {
    for (let i = 0; i < int(1, 4); i++) {
      await db.ticketComment.create({
        data: {
          ticketId: ticket.id,
          userId: ticket.assignedToUserId ?? pick(support).id,
          body: pick([
            "Called the user, took remote access. Outlook profile rebuilt.",
            "Waiting for the customer to confirm a window.",
            "Escalated to the vendor, ticket number shared.",
            "Licence reassigned, user confirmed it is working.",
            "Visited site, replaced the patch cable.",
            "Cannot reproduce — asked for a screenshot.",
          ]),
          createdAt: new Date(ticket.createdAt.getTime() + int(1, 72) * 3600000),
        },
      });
      comments += 1;
    }
  }
  log("Ticket comments", `${comments}`);

  void rnd;
}
