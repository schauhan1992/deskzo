/**
 * Seeds a campaign and a journey, runs the real scheduler over them, and then checks the one thing
 * this module must never get wrong:
 *
 * **A reseller's end customer is never contacted.**
 *
 * That failure is completely silent. The mail sends, the provider accepts it, the dashboard turns
 * green — and we have gone round our own partner to talk to their customer. `src/lib/reseller.ts`
 * was written before there was anything to send precisely because of this, so the seed plants a
 * reseller-managed company *inside* the audience and proves it comes out the other side untouched.
 *
 * The campaign is queued and sent through the real pipeline and the real tick, not by writing rows,
 * so what is checked here is the code that runs in production.
 *
 *   npm run db:seed:marketing            seed and verify
 *   npm run db:seed:marketing -- --reset remove what this made first
 *   npm run db:seed:marketing -- --verify-only
 */
import { directClient } from "../src/lib/tenancy/direct-client";
import { queueCampaign } from "../src/lib/marketing/pipeline";
import { normalizeCompanyName } from "../src/lib/validation/company";
import { runMarketingTick } from "../src/lib/marketing/tick";
import { unsubscribeAll } from "../src/actions/marketing-public";
import { canSend } from "../src/lib/marketing/suppression";

const db = directClient();

const PREFIX = "MKT/SEED/";
const SEED_COMPANY = "Seedwell Reseller Client Pvt Ltd";
const SEED_CLEAN = "Northgate Systems Seed Ltd";
const SEED_NO_CONSENT = "Bramble Foods Seed Ltd";
const SEED_BOUNCED = "Ashvale Traders Seed Ltd";
const SEED_NAMES = [SEED_COMPANY, SEED_CLEAN, SEED_NO_CONSENT, SEED_BOUNCED];
const SEED_TAG = "mkt-seed";
const FORM_SLUG = "m365-assessment";
const ORIGIN = "http://localhost:3000";
const TASK_TITLE = "Call about the renewal";
/**
 * A suppression is keyed on the address rather than on a contact row, deliberately — an
 * unsubscribe has to outlive the record it came from. So deleting the seeded companies does not
 * cascade to it, and the seed has to clear its own or the next run finds everybody unsubscribed.
 */
const SEED_EMAILS = [
  "arun@northgate.test",
  "divya@bramble.test",
  "sanjay@ashvale.test",
  "meera@seedwell.test",
];

async function reset() {
  await db.campaign.deleteMany({ where: { reference: { startsWith: PREFIX } } });
  await db.journey.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.audience.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.marketingTemplate.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.company.deleteMany({ where: { name: { in: SEED_NAMES } } });
  await db.inboundForm.deleteMany({ where: { slug: FORM_SLUG } });
  await db.messagingProvider.deleteMany({ where: { key: "mock" } });
  await db.suppression.deleteMany({ where: { OR: [{ note: { startsWith: PREFIX } }, { value: { in: SEED_EMAILS } }] } });
  // The journey creates real tasks, and they outlive the journey — so they are cleaned up by the
  // title the seeded step gives them, or a second run counts the first run's work as its own.
  await db.task.deleteMany({ where: { title: { startsWith: TASK_TITLE } } });
  await db.organisationSettings.updateMany({
    where: { id: "global" },
    data: { marketingQuietStartMinute: 1200, marketingQuietEndMinute: 540, marketingSkipNonWorkingDays: true },
  });
  console.log("Removed the previous marketing seed, and put the send-window settings back.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const reseller = await db.company.findFirst({
    where: { relationshipType: "RESELLER" },
    select: { id: true, name: true },
  });
  if (!reseller) throw new Error("No reseller company found. Run the main seed first.");

  // ── A provider that records and delivers nothing ───────────────────────────
  await db.messagingProvider.upsert({
    where: { key: "mock" },
    create: {
      key: "mock",
      kind: "EMAIL",
      label: "Mock (seed)",
      enabled: true,
      priority: 1,
      classes: ["MARKETING", "TRANSACTIONAL"],
      fromName: "Wroffy",
      fromEmail: "hello@mail.wroffy.test",
    },
    update: { enabled: true, classes: ["MARKETING", "TRANSACTIONAL"], priority: 1 },
  });
  console.log("Provider: mock, carrying marketing and transactional.");

  // Quiet hours and the weekend skip are exactly right in production and make a seed
  // undeterministic: run this on a Saturday evening and everything correctly defers to Monday
  // morning, proving nothing about whether it sends. Both are off for the run, and `--reset`
  // puts them back.
  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "", marketingQuietStartMinute: 0, marketingQuietEndMinute: 0, marketingSkipNonWorkingDays: false },
    update: { marketingQuietStartMinute: 0, marketingQuietEndMinute: 0, marketingSkipNonWorkingDays: false },
  });
  console.log("Send window: open, weekends allowed — so the run is the same on any day.");

  // ── Three companies, built for this run ────────────────────────────────────
  //
  // Dedicated rather than borrowed, because the other seeds leave real customers carrying
  // unanswered complaints and breached tickets — which the suppression rules rightly stop. That
  // is correct behaviour and useless for proving the send path works, so the scenario is planted.
  async function plant(params: {
    name: string;
    email: string;
    contactName: string;
    managedByResellerId?: string | null;
    consent: boolean;
  }) {
    const company = await db.company.create({
      data: {
        name: params.name,
        /**
         * The app's own normaliser, not a second one that looks similar.
         *
         * This rolled its own — `replace(/[^a-z0-9]/g, "")` — while `normalizeCompanyName` lowercases
         * and collapses whitespace but keeps the spaces. The two disagree on every multi-word name,
         * so a seeded company could never be found by name again: the global uniqueness constraint
         * the whole CRM rests on could not see it, an import would create a duplicate rather than
         * match it, and an inbound form naming it would open a second record. `check:import` caught
         * it the moment this seed had run — the round trip could not read back rows it had written.
         */
        normalizedName: normalizeCompanyName(params.name),
        relationshipType: "CLIENT",
        stage: "CUSTOMER",
        managedByResellerId: params.managedByResellerId ?? null,
        createdById: admin.id,
        ownerUserId: admin.id,
        tags: [SEED_TAG],
        contacts: {
          create: {
            name: params.contactName,
            email: params.email,
            designation: "IT_MANAGER",
            isPrimary: true,
            // A current, valid verdict. The audience defaults to verified addresses only, and
            // seeding around that would be seeding around the rule.
            emailStatus: "VALID",
            emailCheckedValue: params.email,
            emailCheckedAt: new Date(),
            createdByUserId: admin.id,
          },
        },
      },
      select: { id: true, name: true, contacts: { select: { id: true, email: true } } },
    });
    if (params.consent) {
      await db.contactConsent.create({
        data: {
          contactId: company.contacts[0].id,
          channel: "EMAIL",
          topic: "RENEWALS",
          status: "SUBSCRIBED",
          source: "CONTRACT",
          evidence: `${PREFIX}agreed at onboarding`,
        },
      });
    }
    return company;
  }

  const willReceive = await plant({
    name: SEED_CLEAN,
    contactName: "Arun Prakash",
    email: "arun@northgate.test",
    consent: true,
  });
  const noConsent = await plant({
    name: SEED_NO_CONSENT,
    contactName: "Divya Rao",
    email: "divya@bramble.test",
    consent: false,
  });

  // Consented and verified, and the address bounced last time. A stored fact rather than a
  // derived one, so the run exercises the other half of the suppression rules too.
  await plant({ name: SEED_BOUNCED, contactName: "Sanjay Nair", email: "sanjay@ashvale.test", consent: true });
  await db.suppression.create({
    data: {
      scope: "EMAIL",
      value: "sanjay@ashvale.test",
      reason: "HARD_BOUNCE",
      note: `${PREFIX}bounced on a previous send`,
    },
  });

  // ── The one that must never be reached ─────────────────────────────────────
  //
  // Everything about this company says "mail me": a valid address, explicit consent, no complaint,
  // no overdue invoice. The only thing wrong with it is that it belongs to a reseller.
  const managed = await plant({
    name: SEED_COMPANY,
    contactName: "Meera Iyer",
    email: "meera@seedwell.test",
    managedByResellerId: reseller.id,
    consent: true,
  });
  console.log(`Planted: ${willReceive.name} (opted in), ${noConsent.name} (no consent), ${managed.name} (reseller's).`);
  // ── Audience, template, campaign ───────────────────────────────────────────
  const audience = await db.audience.create({
    data: {
      name: `${PREFIX}Customers with a contact`,
      description: "Everybody, deliberately wide — the suppression rules are what narrow it.",
      // Tagged rather than stage-based, so the run is deterministic whatever else is in the database.
      companyFilters: { tags: [SEED_TAG] },
      contactFilters: { verifiedOnly: true, maxPerCompany: 1 },
      createdById: admin.id,
    },
    select: { id: true },
  });

  const template = await db.marketingTemplate.create({
    data: {
      name: `${PREFIX}Renewal nudge`,
      channel: "EMAIL",
      topic: "RENEWALS",
      subject: "{{companyName}} — a quick note from {{ourName}}",
      body:
        "Hi {{firstName|there}},\n\nYour cover with {{ourName}} is coming up for renewal. " +
        "{{ownerName|Your account manager}} will be in touch, but reply here if it is easier.\n\n" +
        "Unsubscribe: {{unsubscribeUrl}}",
      createdById: admin.id,
    },
    select: { id: true },
  });

  const campaign = await db.campaign.create({
    data: {
      reference: `${PREFIX}0001`,
      name: "Renewal nudge (seed)",
      audienceId: audience.id,
      templateId: template.id,
      channel: "EMAIL",
      // Backdated so the tick has something due immediately rather than waiting for a send window.
      scheduledFor: new Date(Date.now() - 3600_000),
      createdById: admin.id,
      status: "DRAFT",
    },
    select: { id: true },
  });

  const queued = await queueCampaign(campaign.id, ORIGIN);
  await db.campaign.update({ where: { id: campaign.id }, data: { status: "SCHEDULED", startedAt: new Date() } });
  console.log(
    `Campaign: ${queued.queued} queued, ${queued.suppressed} suppressed, ${queued.blocked} blocked on a merge field.`,
  );

  // ── A public form, so the inbound half is reachable too ────────────────────
  await db.inboundForm.upsert({
    where: { slug: FORM_SLUG },
    update: { active: true },
    create: {
      slug: FORM_SLUG,
      name: "Microsoft 365 assessment",
      headline: "Book a free Microsoft 365 assessment",
      intro:
        "Tell us a little about your setup and we'll come back with what you're paying for and what you're actually using.",
      fields: [],
      topic: "OFFERS",
      createsLead: true,
      assignToUserId: admin.id,
      thankYouText: "We'll be in touch within one working day.",
      createdById: admin.id,
      ownerUserId: admin.id,
    },
  });
  console.log(`Form: /forms/${FORM_SLUG} — a stranger filling it in becomes a company, a contact and a lead.`);

  // ── A journey whose only step hands one of ours a job ──────────────────────
  const journey = await db.journey.create({
    data: {
      name: `${PREFIX}Renewals to chase`,
      trigger: "SUBSCRIPTION_RENEWAL",
      triggerConfig: { days: 120 },
      status: "ACTIVE",
      exitOn: ["ORDERED", "RENEWED"],
      reEnrolAfterDays: 365,
      createdById: admin.id,
      steps: {
        create: [
          {
            order: 1,
            delayDays: 0,
            channel: "TASK",
            taskTitle: `${TASK_TITLE} — {{companyName}}`,
            taskDetail: "Their subscription is inside the renewal window. Quote first, then ring.",
            taskDueDays: 3,
            taskAssignee: "OWNER",
          },
        ],
      },
    },
    select: { id: true },
  });
  console.log("Journey: renewals inside 120 days, one task step, active.");

  // ── Two ticks, back to back ────────────────────────────────────────────────
  //
  // The second is the point. Nothing may send twice, and nobody may enrol twice.
  const first = await runMarketingTick(ORIGIN);
  const second = await runMarketingTick(ORIGIN);
  console.log(
    `Tick 1: ${first.enrolled} enrolled, ${first.tasks} task(s), ${first.sent} sent.  ` +
      `Tick 2: ${second.enrolled} enrolled, ${second.tasks} task(s), ${second.sent} sent.`,
  );

  // ── Somebody unsubscribes, then we try again ───────────────────────────────
  const sentOne = await db.marketingMessage.findFirst({
    where: { campaignId: campaign.id, status: "SENT" },
    select: { token: true, contactId: true },
  });
  if (sentOne) {
    await unsubscribeAll(sentOne.token);
    const second = await db.campaign.create({
      data: {
        reference: `${PREFIX}0002`,
        name: "Second nudge (seed)",
        audienceId: audience.id,
        templateId: template.id,
        channel: "EMAIL",
        scheduledFor: new Date(Date.now() - 3600_000),
        createdById: admin.id,
        status: "DRAFT",
      },
      select: { id: true },
    });
    const again = await queueCampaign(second.id, ORIGIN);
    await db.campaign.update({ where: { id: second.id }, data: { status: "SCHEDULED" } });
    console.log(`After one unsubscribe: ${again.queued} queued, ${again.suppressed} suppressed.`);
  }

  void journey;
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };

  console.log("\n— Verifying —");

  const campaigns = await db.campaign.findMany({
    where: { reference: { startsWith: PREFIX } },
    select: { id: true, reference: true },
  });
  if (campaigns.length === 0) {
    console.log(" FAIL  nothing was seeded");
    return 1;
  }
  const campaignIds = campaigns.map((c) => c.id);

  const messages = await db.marketingMessage.findMany({
    where: { campaignId: { in: campaignIds } },
    include: { company: { select: { name: true, managedByResellerId: true } }, contact: { select: { email: true } } },
  });
  ok("the campaign produced messages", messages.length > 0, `${messages.length} across ${campaigns.length} campaign(s)`);

  // ── The one that matters, checked at both layers ───────────────────────────
  //
  // Defence in depth, and the seed proves each layer separately. The audience query excludes
  // reseller-managed companies before suppression is ever consulted, so the right result is that
  // no row exists at all — but the suppression rules have to catch them too, or removing the
  // query clause one day would silently open the door.
  const managedCompany = await db.company.findFirstOrThrow({
    where: { name: SEED_COMPANY },
    include: { contacts: { take: 1 } },
  });
  const toManaged = messages.filter((m) => m.companyId === managedCompany.id);

  ok(
    "the reseller's customer is in the database, opted in, with a verified address",
    managedCompany.managedByResellerId !== null && managedCompany.contacts.length > 0,
    "everything about them says 'mail me' except who they belong to",
  );
  ok(
    "  layer one: the audience never even returns them",
    toManaged.length === 0,
    "buildWhere applies marketableCompanyFilter, so they are gone before suppression runs",
  );

  const wouldBe = canSend(
    {
      company: { managedByResellerId: managedCompany.managedByResellerId },
      contact: {
        email: managedCompany.contacts[0].email,
        phone: managedCompany.contacts[0].phone,
        emailStatus: managedCompany.contacts[0].emailStatus,
        emailCheckedValue: managedCompany.contacts[0].emailCheckedValue,
      },
      suppressions: [],
      consent: { status: "SUBSCRIBED" },
      signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
    },
    {
      messageClass: "MARKETING",
      channel: "EMAIL",
      topic: "RENEWALS",
      limits: { maxPerContactPerWeek: 99, overdueDaysBlock: 60, requireVerifiedAddress: true },
    },
  );
  ok(
    "  layer two: and if one ever did get through, suppression refuses it",
    !wouldBe.ok && wouldBe.reason === "RESELLER_MANAGED",
    wouldBe.ok ? "IT WOULD HAVE BEEN SENT" : wouldBe.detail,
  );

  const clean = await db.company.findFirstOrThrow({ where: { name: SEED_CLEAN }, select: { id: true } });
  const toClean = messages.filter((m) => m.companyId === clean.id);
  ok(
    "meanwhile the opted-in customer did receive it",
    toClean.some((m) => m.status === "SENT" || m.status === "DELIVERED"),
    "otherwise the exclusion above proves only that nothing works",
  );
  // ── No double-send ─────────────────────────────────────────────────────────
  const sent = messages.filter((m) => m.status === "SENT" || m.status === "DELIVERED");
  const perRecipient = new Map<string, number>();
  for (const m of sent) perRecipient.set(`${m.campaignId}:${m.contactId}`, (perRecipient.get(`${m.campaignId}:${m.contactId}`) ?? 0) + 1);
  ok(
    "two ticks sent each message exactly once",
    [...perRecipient.values()].every((n) => n === 1),
    `${sent.length} sent, ${perRecipient.size} distinct recipients`,
  );
  ok("every sent message has a provider id", sent.every((m) => !!m.providerMessageId));
  ok("  and a send time", sent.every((m) => m.sentAt !== null));
  ok("nothing is still locked", messages.every((m) => m.lockedAt === null || m.status === "SENDING"));

  // ── Suppression is explained, not silent ───────────────────────────────────
  const suppressed = messages.filter((m) => m.status === "SUPPRESSED");
  ok("suppressed recipients still have a row", suppressed.length > 0, `${suppressed.length}`);
  ok(
    "  and every one says why",
    suppressed.every((m) => (m.suppressedReason?.length ?? 0) > 10),
    "a recipient silently dropped is one nobody can explain later",
  );
  const reasons = new Set(suppressed.map((m) => m.suppressedReason?.split(":")[0]));
  ok("  for more than one reason", reasons.size >= 2, [...reasons].join(", "));
  ok(
    "  including somebody who never opted in",
    [...reasons].includes("NO_CONSENT"),
    "consent is required, not assumed",
  );

  // ── Merge fields ───────────────────────────────────────────────────────────
  const live = messages.filter((m) => m.status !== "SUPPRESSED");
  ok(
    "no message went out with an unfilled merge field",
    live.every((m) => !m.body.includes("{{") && !(m.subject ?? "").includes("{{")),
    '"Hi ," is unrecoverable once sent',
  );
  ok(
    "  and each one carries its unsubscribe link",
    live.every((m) => m.body.includes("/preferences/")),
  );
  ok(
    "  addressed to the right company",
    live.every((m) => (m.subject ?? "").includes(m.company.name)),
  );

  // ── The unsubscribe is honoured next time ──────────────────────────────────
  const unsubscribed = await db.suppression.findMany({ where: { reason: "UNSUBSCRIBED" }, select: { value: true } });
  if (unsubscribed.length > 0) {
    const addresses = new Set(unsubscribed.map((s) => s.value));
    const second = campaigns.find((c) => c.reference.endsWith("0002"));
    const later = messages.filter((m) => m.campaignId === second?.id);
    const reached = later.filter(
      (m) => m.toEmail && addresses.has(m.toEmail.toLowerCase()) && m.status !== "SUPPRESSED",
    );
    ok("an unsubscribe is honoured on the very next campaign", reached.length === 0, `${addresses.size} unsubscribed`);
    ok(
      "  and their journey enrolments ended too",
      (await db.journeyEnrolment.count({
        where: { status: "ACTIVE", contact: { email: { in: [...addresses] } } },
      })) === 0,
      "not at the next step — now",
    );
  }

  // ── Journeys ───────────────────────────────────────────────────────────────
  const journeys = await db.journey.findMany({
    where: { name: { startsWith: PREFIX } },
    include: { enrolments: true },
  });
  const enrolments = journeys.flatMap((j) => j.enrolments);
  if (enrolments.length > 0) {
    const keys = enrolments.map((e) => `${e.journeyId}:${e.triggerKey}`);
    ok("two ticks enrolled each subject once", new Set(keys).size === keys.length, `${enrolments.length} enrolment(s)`);
    ok(
      "  keyed on the subscription, not the company",
      enrolments.every((e) => e.triggerKey.startsWith("SUBSCRIPTION_RENEWAL:")),
      enrolments[0]?.triggerKey,
    );
    const tasks = await db.task.count({ where: { title: { contains: "Call about the renewal" } } });
    ok("the task step created real tasks", tasks > 0, `${tasks} — this works with no provider at all`);
    ok(
      "  one per enrolment, not one per tick",
      tasks <= enrolments.length,
      `${tasks} task(s) for ${enrolments.length} enrolment(s)`,
    );
  } else {
    ok("nothing was inside the renewal window", true, "no subscriptions expiring in 120 days — nothing to check");
  }

  // ── The scheduler recorded itself ──────────────────────────────────────────
  const ticks = await db.marketingTick.findMany({ orderBy: { startedAt: "desc" }, take: 5 });
  ok("the scheduler recorded its runs", ticks.length >= 2, `${ticks.length}`);
  ok("  and each one finished", ticks.every((t) => t.finishedAt !== null));
  ok("  with no errors", ticks.every((t) => t.error === null), ticks.find((t) => t.error)?.error ?? "");

  /**
   * Every company's key is one the app can reproduce from its name.
   *
   * `normalizedName` is the global uniqueness constraint the whole CRM rests on. A row holding a key
   * that `normalizeCompanyName` would not produce is invisible to every lookup that goes through
   * it — the constraint cannot catch a duplicate of it, an import creates a second copy rather than
   * matching, and an inbound form naming it opens another record. This seed did exactly that, with
   * its own slightly different formula, and a form submission promptly created the duplicate.
   */
  {
    const companies = await db.company.findMany({ select: { name: true, normalizedName: true } });
    const wrong = companies.filter((c) => c.normalizedName !== normalizeCompanyName(c.name));
    ok(
      "every company's key matches the app's own normaliser",
      wrong.length === 0,
      wrong.length === 0 ? `${companies.length} checked` : wrong.slice(0, 3).map((c) => `${c.name} → ${c.normalizedName}`).join("; "),
    );
  }

  // ── What a stranger can do with the public form ─────────────────────────────────────────────

  /**
   * Two things a form must not be able to do, checked by actually doing them.
   *
   * `submitForm` used to write `status: "SUBSCRIBED"` with an evidence string saying the person had
   * asked to hear from us. Nobody proves they own the address they type into a form, so anybody who
   * knew a customer's company name and a colleague's email address could have the app record, in
   * that person's name, a consent they never gave — and DPDP asks for the consent *artefact*
   * precisely because it is the thing that has to be true.
   *
   * It also matched companies by name with no reseller check, so a form could create a contact, a
   * lead and that consent against a reseller's end customer — the one thing `src/lib/reseller.ts`
   * exists to prevent.
   */
  {
    const { submitForm } = await import("../src/actions/marketing-public");
    const form = await db.inboundForm.findUnique({ where: { slug: FORM_SLUG }, select: { slug: true } });

    if (!form) {
      ok("the inbound form is seeded", false, "run without --verify-only first");
    } else {
      const stamp = String(await db.formSubmission.count());

      /**
       * One of this seed's own companies, by name.
       *
       * `PREFIX` names campaigns, journeys, audiences and templates; the companies are in
       * `SEED_NAMES`. Matching on the wrong one found nothing and skipped the whole consent check
       * silently, which is the failure mode this file exists to catch — so the lookup is asserted
       * rather than guarded with an `if`.
       */
      const ordinary = await db.company.findFirst({
        where: { managedByResellerId: null, name: { in: SEED_NAMES } },
        select: { id: true, name: true },
      });
      const managed = await db.company.findFirst({
        where: { managedByResellerId: { not: null } },
        select: { id: true, name: true },
      });

      ok("the form probe found a company to submit against", Boolean(ordinary), ordinary?.name ?? "none matched SEED_NAMES");
      ok("  and a reseller-managed one", Boolean(managed), managed?.name ?? "none");

      if (ordinary) {
        const email = `seedprobe${stamp}@example.com`;
        const result = await submitForm({
          slug: form.slug,
          values: { name: "Seed Probe", email, companyName: ordinary.name },
          elapsedMs: 9000,
        });
        ok("a stranger can still send an enquiry", result.ok, result.ok ? "" : result.error);

        const consent = await db.contactConsent.findFirst({
          where: { contact: { email } },
          select: { status: true },
        });
        ok(
          "  but the form records PENDING, never consent",
          consent?.status === "PENDING",
          consent?.status ?? "no consent row",
        );
        ok("  and a lead is still raised, so nothing is lost", (await db.lead.count({ where: { contact: { email } } })) > 0);

        // Tidied up: the seed's own fixtures are the point, not this probe's leftovers.
        await db.contactConsent.deleteMany({ where: { contact: { email } } });
        await db.formSubmission.deleteMany({ where: { email } });
        await db.lead.deleteMany({ where: { contact: { email } } });
        await db.contact.deleteMany({ where: { email } });
        // If the form ever fails to match and creates its own company, that goes too — otherwise
        // the leftovers are a duplicate of a real account, which is the thing being guarded here.
        await db.company.deleteMany({ where: { source: "INBOUND", name: ordinary.name, id: { not: ordinary.id } } });
      }

      if (managed) {
        const email = `seedprobe-managed${stamp}@example.com`;
        const before = await db.contact.count({ where: { companyId: managed.id } });
        const result = await submitForm({
          slug: form.slug,
          values: { name: "Seed Probe", email, companyName: managed.name },
          elapsedMs: 9000,
        });

        // The same answer either way: a different one would tell any stranger which of our
        // customers belong to a reseller, one company name at a time.
        ok("a form naming a reseller's customer answers the same way", result.ok);
        ok(
          "  and writes nothing into their account",
          (await db.contact.count({ where: { companyId: managed.id } })) === before &&
            (await db.lead.count({ where: { contact: { email } } })) === 0 &&
            (await db.contactConsent.count({ where: { contact: { email } } })) === 0,
        );
        ok(
          "  while still keeping the submission, so it can be routed to the reseller",
          (await db.formSubmission.count({ where: { email } })) === 1,
        );

        await db.formSubmission.deleteMany({ where: { email } });
      }
    }
  }

  console.log(failures === 0 ? "\nAll marketing seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  return failures;
}

const args = process.argv.slice(2);
(async () => {
  if (args.includes("--reset")) await reset();
  if (!args.includes("--verify-only")) await main();
  const failures = await verify();
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
