import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../../src/lib/crypto";
import { newToken } from "../../src/lib/marketing/pipeline";
import type { SeededCompany } from "./companies";
import type { SeededPerson } from "./people";
import { chance, daysAgo, daysAhead, int, log, pick, some } from "./shared";

/**
 * The catalogue's shape, the people we pay for introductions, and the marketing module's
 * configuration.
 *
 * ## What is here, and what is deliberately not
 *
 * Journeys, their steps, the enrolments they produced and the tick log are all real: the steps that
 * ran are the ones that raise a **task** for an account manager, and those need no provider, no
 * sending domain and no consent — which is exactly the argument for building the automation before
 * the sending.
 *
 * What is missing is a send history. No message has a delivery, an open or a click against it, and
 * there are no `MessageEvent` rows at all, because nothing has ever been sent from this
 * installation. Inventing them would put an open rate on a dashboard, and an open rate is the kind
 * of number somebody screenshots into a board pack.
 */

export async function seedReach(
  db: PrismaClient,
  companies: SeededCompany[],
  people: SeededPerson[],
  adminId: string,
) {
  const sales = people.filter((p) => p.dept === "Sales");
  const marketer = people.find((p) => p.dept === "Marketing") ?? sales[0] ?? people[0]!;
  const anyone = (list: SeededPerson[]) => (list.length > 0 ? pick(list) : pick(people));
  // Customers we actually sell to. Suppliers, introducers and partners also sit at the CUSTOMER
  // stage, and enrolling a distributor in a renewal journey would put a task on somebody's list
  // about a subscription that distributor never bought.
  const customers = companies.filter((c) => c.stage === "CUSTOMER" && c.relationship === "CLIENT");

  // ── The catalogue's own shape ───────────────────────────────────────────────────────────────
  /**
   * Families group the SKUs a customer thinks of as one product — "Microsoft 365" rather than the
   * four seat types it is sold in. Without them a price list reads as a flat run of eighty lines,
   * which is how a catalogue becomes unusable rather than merely long.
   */
  const FAMILIES: Record<string, string[]> = {
    Microsoft: ["Microsoft 365", "Windows Server", "Azure"],
    Adobe: ["Creative Cloud", "Acrobat"],
    Autodesk: ["AutoCAD", "Fusion"],
    Dell: ["Latitude", "OptiPlex", "PowerEdge"],
    HP: ["ProBook", "LaserJet"],
    Lenovo: ["ThinkPad", "ThinkCentre"],
    Sophos: ["Firewall", "Endpoint"],
    Veeam: ["Backup"],
  };

  let families = 0;
  let grouped = 0;
  for (const brand of await db.brand.findMany({ select: { id: true, name: true } })) {
    for (const name of FAMILIES[brand.name] ?? []) {
      const family = await db.productFamily.create({ data: { brandId: brand.id, name }, select: { id: true } });
      families += 1;
      // Items whose name carries the family name join it. Matching on the name rather than
      // assigning at random is what makes the grouping mean anything once somebody opens it.
      const { count } = await db.item.updateMany({
        where: { brandId: brand.id, productFamilyId: null, name: { contains: name, mode: "insensitive" } },
        data: { productFamilyId: family.id },
      });
      grouped += count;
    }
  }
  log("Product families", `${families} families, ${grouped} SKUs grouped under them`);

  // ── The people we pay for an introduction ───────────────────────────────────────────────────
  const parties = companies.filter((c) => c.relationship === "COMMISSION_PARTY");
  let links = 0;
  let payAccounts = 0;
  for (const party of parties) {
    // Whose business they introduced. This link is what a commission statement is computed over.
    for (const customer of some(customers, int(1, 5))) {
      await db.commissionPartyLink.create({
        data: { commissionPartyId: party.id, companyId: customer.id, createdAt: daysAgo(int(60, 600)) },
      });
      links += 1;
    }
    await db.commissionPartyAccount.create({
      data: {
        commissionPartyId: party.id,
        label: "Primary — savings account",
        accountHolderName: party.name,
        panNumber: `AAAPZ${int(1000, 9999)}C`,
        bankAccountNumber: `${int(10000000, 99999999)}${int(100, 999)}`,
        bankIfsc: pick(["HDFC0000123", "ICIC0000027", "SBIN0001234", "UTIB0000456"]),
        bankName: pick(["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank"]),
        isDefault: true,
      },
    });
    payAccounts += 1;
    if (chance(0.3)) {
      await db.commissionPartyAccount.create({
        data: {
          commissionPartyId: party.id,
          label: "UPI",
          upiId: `${party.name.split(" ")[0]!.toLowerCase()}@okhdfcbank`,
          isDefault: false,
        },
      });
      payAccounts += 1;
    }
  }
  log("Commission parties", `${parties.length} introducers, ${links} accounts credited, ${payAccounts} payout details`);

  // ── The lead trail ──────────────────────────────────────────────────────────────────────────
  // Calls, notes and stage changes against the lead they happened on — the timeline a salesperson
  // reads before picking the phone up again.
  const NOTES: Record<string, string[]> = {
    CALL: [
      "Spoke to the IT head — budget sits with finance.",
      "Left a message, calling back Thursday.",
      "Walked through the renewal quote on the phone.",
    ],
    EMAIL: [
      "Sent the comparison sheet they asked for.",
      "Followed up on the quote from last week.",
      "Shared the Adobe volume pricing.",
    ],
    NOTE: [
      "Mid-audit; nothing moves until it closes.",
      "Incumbent contract ends in March.",
      "Decision maker changed — a new CTO has joined.",
    ],
    MEETING: [
      "Met at their office and demoed the portal.",
      "Teams call with procurement and IT.",
      "Site visit to scope the migration.",
    ],
    STAGE_CHANGE: [
      "Moved to negotiation.",
      "Marked qualified after the discovery call.",
      "Pushed back to nurture — no budget this quarter.",
    ],
  };

  const leads = await db.lead.findMany({ select: { id: true, ownerUserId: true, createdAt: true }, take: 400 });
  let activities = 0;
  let proposals = 0;
  for (const lead of some(leads, 220)) {
    const age = Math.max(2, Math.floor((Date.now() - lead.createdAt.getTime()) / 86400000));
    for (let i = 0; i < int(1, 5); i++) {
      const type = pick(["CALL", "CALL", "EMAIL", "NOTE", "MEETING", "STAGE_CHANGE"] as const);
      const occurredAt = daysAgo(int(1, age));
      await db.activity.create({
        data: {
          leadId: lead.id,
          userId: lead.ownerUserId ?? anyone(sales).id,
          type,
          notes: pick(NOTES[type]!),
          occurredAt,
          createdAt: occurredAt,
        },
      });
      activities += 1;
    }

    if (chance(0.45)) {
      const sentAt = daysAgo(int(2, Math.min(age, 300)));
      await db.proposal.create({
        data: {
          leadId: lead.id,
          sentByUserId: lead.ownerUserId ?? anyone(sales).id,
          status: pick(["SENT", "SENT", "ACCEPTED", "REJECTED", "DRAFT", "EXPIRED"] as const),
          sentAt,
          validUntil: new Date(sentAt.getTime() + 30 * 86400000),
          notes: chance(0.4) ? "Pricing held for thirty days." : null,
          createdAt: sentAt,
        },
      });
      proposals += 1;
    }
  }
  log("Lead trail", `${activities} activities, ${proposals} proposals`);

  // ── How mail would leave, if it were leaving ────────────────────────────────────────────────
  /**
   * Transactional and marketing mail are routed to different providers on purpose, and the demo
   * shows that split rather than hiding it: bulk volume from the domain that also carries your
   * invoices is how a bad campaign stops a purchase order arriving.
   *
   * The secrets are encrypted with `encryptSecret`, like every other credential in this system, and
   * are nonsense — nothing here can actually send.
   */
  const PROVIDERS = [
    ["m365", "Microsoft 365 SMTP", "EMAIL", true, 1, ["TRANSACTIONAL"], "Wroffy", "no-reply@wroffy.com"],
    ["resend", "Resend", "EMAIL", true, 2, ["MARKETING"], "Wroffy", "hello@mail.wroffy.com"],
    ["ses", "Amazon SES", "EMAIL", false, 3, ["MARKETING"], "Wroffy", "hello@mail.wroffy.com"],
    ["gupshup", "Gupshup WhatsApp", "WHATSAPP", false, 4, ["MARKETING"], null, null],
  ] as const;

  for (const [key, label, kind, enabled, priority, classes, fromName, fromEmail] of PROVIDERS) {
    await db.messagingProvider.create({
      data: {
        key,
        label,
        kind,
        enabled,
        priority,
        classes: [...classes],
        fromName,
        fromEmail,
        replyTo: fromEmail ? "sales@wroffy.com" : null,
        secretCipher: await encryptSecret(`demo-not-a-real-key-${key}`),
        dailyCap: kind === "EMAIL" ? 2000 : 500,
        lastVerifiedAt: enabled ? daysAgo(int(1, 20)) : null,
        verifyOk: enabled,
        // Said plainly, because a provider that looks configured and is not is worse than one that
        // is obviously off.
        verifyDetail: enabled ? "Demo credentials — nothing will actually send." : "Not configured.",
      },
    });
  }
  log("Providers", `${PROVIDERS.length} configured — transactional and marketing kept apart`);

  // ── Journeys ────────────────────────────────────────────────────────────────────────────────
  const JOURNEYS = [
    {
      name: "Renewal — 90 / 60 / 30 days",
      trigger: "SUBSCRIPTION_RENEWAL",
      steps: [
        { order: 0, delayDays: 0, taskTitle: "Check the renewal quote and the seat count", taskDueDays: 3 },
        { order: 1, delayDays: 30, taskTitle: "Call the customer about the renewal", taskDueDays: 2 },
        { order: 2, delayDays: 60, taskTitle: "Escalate — renewal is 30 days out and unconfirmed", taskDueDays: 1 },
      ],
    },
    {
      name: "Warranty expiring — offer AMC",
      trigger: "WARRANTY_EXPIRING",
      steps: [
        { order: 0, delayDays: 0, taskTitle: "Draft an AMC quote for the machines coming out of warranty", taskDueDays: 5 },
        { order: 1, delayDays: 14, taskTitle: "Follow up on the AMC quote", taskDueDays: 3 },
      ],
    },
    {
      name: "Lead stalled 21 days",
      trigger: "LEAD_STALLED",
      steps: [
        { order: 0, delayDays: 0, taskTitle: "Nothing has moved for three weeks — call it or close it", taskDueDays: 2 },
      ],
    },
  ];

  let steps = 0;
  let enrolments = 0;
  let raised = 0;
  for (const spec of JOURNEYS) {
    const journey = await db.journey.create({
      data: {
        name: spec.name,
        trigger: spec.trigger,
        status: "ACTIVE",
        // Once a subscription has been through the journey it does not go through it again for a
        // year, which is the difference between a reminder and a nuisance.
        reEnrolAfterDays: 365,
        createdById: marketer.id,
        createdAt: daysAgo(int(60, 300)),
        steps: {
          create: spec.steps.map((s) => ({
            order: s.order,
            delayDays: s.delayDays,
            channel: "TASK" as const,
            taskTitle: s.taskTitle,
            taskDetail: "Raised automatically by the journey.",
            taskDueDays: s.taskDueDays,
          })),
        },
      },
      include: { steps: { select: { id: true, order: true } } },
    });
    steps += journey.steps.length;

    for (const company of some(customers, int(6, 14))) {
      const status = pick(["ACTIVE", "ACTIVE", "COMPLETED", "EXITED"] as const);
      const enrolledAt = daysAgo(int(1, 120));
      const enrolment = await db.journeyEnrolment.create({
        data: {
          journeyId: journey.id,
          companyId: company.id,
          // The dedupe key: one subscription enrols once, not once per tick.
          triggerKey: `${spec.trigger.toLowerCase()}:${company.id}`,
          status,
          currentStep: status === "COMPLETED" ? journey.steps.length : int(0, journey.steps.length - 1),
          nextRunAt: status === "ACTIVE" ? daysAhead(int(1, 30)) : null,
          enrolledAt,
          exitedAt: status === "ACTIVE" ? null : daysAgo(int(0, 60)),
          exitReason: status === "EXITED" ? pick(["Renewed", "Converted", "Customer asked us to stop"]) : null,
        },
        select: { id: true },
      });
      enrolments += 1;

      // The step that has already run, as a message row of channel TASK — no provider involved,
      // which is the whole point of a task step.
      const step = journey.steps[0];
      if (step) {
        await db.marketingMessage.create({
          data: {
            token: newToken(),
            enrolmentId: enrolment.id,
            stepId: step.id,
            companyId: company.id,
            channel: "TASK",
            messageClass: "MARKETING",
            body: spec.steps[0]!.taskTitle,
            scheduledFor: enrolledAt,
            status: "SENT",
            sentAt: enrolledAt,
          },
        });
        raised += 1;
      }
    }
  }
  log("Journeys", `${JOURNEYS.length} active, ${steps} steps, ${enrolments} enrolments, ${raised} tasks raised`);

  // ── The tick log ────────────────────────────────────────────────────────────────────────────
  // Doubles as the watchdog: if the newest row here is old, the scheduler has stopped and the app
  // says so. A demo with no ticks at all looks exactly like a cron that died.
  let ticks = 0;
  for (let back = 0; back < 48; back++) {
    const startedAt = new Date(Date.now() - back * 5 * 60000);
    await db.marketingTick.create({
      data: {
        runId: `demo-${startedAt.getTime()}`,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + int(200, 2600)),
        enrolled: back % 7 === 0 ? int(1, 4) : 0,
        claimed: back % 5 === 0 ? int(1, 6) : 0,
        sent: back % 5 === 0 ? int(1, 6) : 0,
        failed: 0,
        suppressed: back % 11 === 0 ? 1 : 0,
      },
    });
    ticks += 1;
  }
  log("Scheduler", `${ticks} ticks logged — the most recent one minutes ago`);

  // ── Inbound forms ───────────────────────────────────────────────────────────────────────────
  /**
   * The questions each form asks, in the shape `InboundForm.fields` documents.
   *
   * Two of them are not the default set, on purpose: the page renders whatever is here, and a
   * demo where every form asks the same five questions cannot show that.
   */
  const QUOTE_FIELDS = [
    { key: "name", label: "Your name", type: "TEXT", required: true },
    { key: "email", label: "Work email", type: "EMAIL", required: true },
    { key: "companyName", label: "Company", type: "TEXT", required: true },
    { key: "phone", label: "Phone", type: "PHONE", required: false },
    { key: "seats", label: "How many seats?", type: "TEXT", required: true, placeholder: "e.g. 45" },
    {
      key: "plan",
      label: "Which plan are you looking at?",
      type: "SELECT",
      required: false,
      options: ["Business Basic", "Business Standard", "Business Premium", "E3", "E5", "Not sure yet"],
    },
    { key: "message", label: "Anything else?", type: "TEXTAREA", required: false },
  ];

  const AMC_FIELDS = [
    { key: "name", label: "Your name", type: "TEXT", required: true },
    { key: "email", label: "Work email", type: "EMAIL", required: true },
    { key: "companyName", label: "Company", type: "TEXT", required: true },
    { key: "phone", label: "Phone", type: "PHONE", required: true },
    { key: "machines", label: "How many machines?", type: "TEXT", required: true },
    {
      key: "cover",
      label: "What cover do you need?",
      type: "SELECT",
      required: true,
      options: ["Onsite, next business day", "Onsite, same day", "Return to base", "Advice only"],
    },
    { key: "onsite", label: "Are the machines all at one site?", type: "CHECKBOX", required: false },
    { key: "message", label: "Tell us what you have", type: "TEXTAREA", required: false },
  ];
  const FORMS = [
    {
      slug: "microsoft-365-quote",
      name: "Microsoft 365 quote request",
      headline: "Tell us how many seats you need",
      intro: "We will come back with pricing within one working day.",
      topic: "OFFERS" as const,
      fields: QUOTE_FIELDS,
    },
    {
      slug: "amc-enquiry",
      name: "AMC enquiry",
      headline: "Cover for machines out of warranty",
      intro: "Tell us what you have and we will quote for it.",
      topic: "SERVICE" as const,
      fields: AMC_FIELDS,
    },
  ];

  let submissions = 0;
  for (const spec of FORMS) {
    const form = await db.inboundForm.create({
      data: {
        slug: spec.slug,
        name: spec.name,
        headline: spec.headline,
        intro: spec.intro,
        topic: spec.topic,
        fields: spec.fields,
        createsLead: true,
        assignToUserId: anyone(sales).id,
        thankYouText: "Thanks — somebody will be in touch shortly.",
        active: true,
        createdById: marketer.id,
        ownerUserId: marketer.id,
        createdAt: daysAgo(int(90, 300)),
      },
      select: { id: true },
    });

    for (let i = 0; i < int(8, 18); i++) {
      const company = pick(companies);
      const first = pick(["Rahul", "Priya", "Vikram", "Ananya", "Karan", "Sneha"]);
      const slug = company.name.split(" ")[0]!.toLowerCase();
      await db.formSubmission.create({
        data: {
          formId: form.id,
          name: `${first} ${pick(["Mehta", "Nair", "Shetty", "Rao", "Joshi", "Iyer"])}`,
          email: `${first.toLowerCase()}@${slug}.example`,
          phone: `+91 9${int(1000, 9999)}${int(10000, 99999)}`,
          companyName: company.name,
          payload: Object.fromEntries([
            ["name", `${first} ${pick(["Mehta", "Nair", "Shetty"])}`],
            ["companyName", company.name],
            ...spec.fields
              .filter((f) => f.key === "seats" || f.key === "machines")
              .map((f) => [f.key, String(int(5, 400))]),
          ]),
          // A hash of where the submission came from, never the address itself — enough to rate
          // limit a flood without keeping a log of who visited a public page.
          sourceHash: newToken().slice(0, 22),
          createdAt: daysAgo(int(1, 280)),
        },
      });
      submissions += 1;
    }
  }
  log("Inbound forms", `${FORMS.length} public forms, ${submissions} submissions`);
  void adminId;
}
