/**
 * Seeds a run of customer feedback and then checks the one thing this module must never get wrong:
 * **every answer is recorded, whatever the score.**
 *
 * The gate decides where a customer is sent afterwards. It is not allowed to decide whether we keep
 * what they said — and that failure would be silent, because a system that quietly drops bad
 * reviews looks, from the inside, like a business with no unhappy customers.
 *
 * The responses are submitted through the real `submitFeedback` action rather than written as rows,
 * so what is checked here is the code that runs in production, not a copy of it.
 *
 *   npm run db:seed:feedback            seed and verify
 *   npm run db:seed:feedback -- --reset remove what this made first
 *   npm run db:seed:feedback -- --verify-only
 */
import { randomBytes } from "node:crypto";
import { directClient } from "../src/lib/tenancy/direct-client";
import { submitFeedback } from "../src/actions/feedback-public";
import { linkState, summarise } from "../src/lib/feedback/rating";

const db = directClient();

const REVIEW_URL = "https://g.page/r/wroffy-seed/review";
const MIN_RATING = 4;
const REF_PREFIX = "FB/SEED/";

const dateOnly = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
const TODAY = dateOnly(new Date());
const daysFrom = (n: number) => new Date(TODAY.getTime() + n * 86400000);

/** The run: what was asked, and what came back. A spread, because a page of 5s proves nothing. */
const SCENARIO: {
  rating: number;
  person: number | null;
  service: number | null;
  comment: string;
  aboutNobody?: boolean;
}[] = [
  { rating: 5, person: 5, service: 5, comment: "Sorted the whole migration over a weekend. Faultless." },
  // Asked about the company rather than about anybody, so the person question was never put — a
  // null there has to mean "not asked", not "scored zero".
  { rating: 5, person: null, service: 5, comment: "", aboutNobody: true },
  { rating: 4, person: 4, service: 3, comment: "Good work, though the licences took a week longer than promised." },
  { rating: 3, person: 4, service: 2, comment: "The engineer was fine. The switch has failed twice since." },
  { rating: 2, person: 2, service: 1, comment: "Nobody called back for four days. We had twelve people unable to work." },
];

async function reset() {
  await db.feedbackRequest.deleteMany({ where: { reference: { startsWith: REF_PREFIX } } });
  await db.organisationSettings.updateMany({
    where: { id: "global" },
    data: { feedbackReviewUrl: null, feedbackReviewMinRating: 4, feedbackLinkDays: 30 },
  });
  console.log("Removed the previous feedback seed, and cleared the review page setting.");
}

async function main() {
  const admin = await db.user.findFirstOrThrow({ where: { role: "ADMIN" }, select: { id: true } });
  const people = await db.user.findMany({
    where: { active: true, employeeProfile: { isNot: null } },
    select: { id: true, name: true },
    take: 4,
  });
  if (people.length === 0) {
    throw new Error("No employees found. Run `npm run db:seed:hr` first — feedback is about somebody.");
  }

  const clients = await db.company.findMany({
    where: { relationshipType: "CLIENT", managedByResellerId: null, contacts: { some: {} } },
    orderBy: { name: "asc" },
    take: 4,
    select: { id: true, name: true, contacts: { select: { id: true, name: true, email: true, phone: true }, take: 1 } },
  });
  if (clients.length === 0) throw new Error("No client companies with contacts found. Run the main seed first.");

  // A known configuration, so the scenario is the same every time it runs. These are the only four
  // columns touched, and `--reset` puts them back.
  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      legalName: "",
      feedbackReviewUrl: REVIEW_URL,
      feedbackReviewMinRating: MIN_RATING,
    },
    update: { feedbackReviewUrl: REVIEW_URL, feedbackReviewMinRating: MIN_RATING },
  });
  console.log(`Settings: review page set, offered from ${MIN_RATING}/5 and above.`);

  let n = 0;
  const reference = () => `${REF_PREFIX}${String(++n).padStart(4, "0")}`;

  async function ask(params: {
    client: (typeof clients)[number];
    aboutUserId: string | null;
    serviceLabel: string | null;
    sentDaysAgo: number;
    expiresInDays: number;
  }) {
    const contact = params.client.contacts[0];
    return db.feedbackRequest.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        reference: reference(),
        companyId: params.client.id,
        contactId: contact?.id ?? null,
        sentToName: contact?.name ?? null,
        sentToEmail: contact?.email ?? null,
        sentToPhone: contact?.phone ?? null,
        aboutUserId: params.aboutUserId,
        serviceLabel: params.serviceLabel,
        status: "SENT",
        sentAt: daysFrom(-params.sentDaysAgo),
        expiresAt: daysFrom(params.expiresInDays),
        requestedById: admin.id,
      },
      select: { id: true, token: true, reference: true },
    });
  }

  const SUBJECTS = [
    "The Microsoft 365 rollout",
    "The laptop order",
    "Our AMC this year",
    "The printer call-out",
    "The firewall replacement",
  ];

  // ── The five that were answered ────────────────────────────────────────────
  for (const [i, answer] of SCENARIO.entries()) {
    const client = clients[i % clients.length];
    const person = people[i % people.length];
    const request = await ask({
      client,
      aboutUserId: answer.aboutNobody ? null : person.id,
      serviceLabel: SUBJECTS[i],
      sentDaysAgo: 20 - i * 3,
      expiresInDays: 10,
    });

    // Through the real action, exactly as the customer's browser calls it.
    const result = await submitFeedback({
      token: request.token,
      rating: answer.rating,
      personRating: answer.person ?? undefined,
      serviceRating: answer.service ?? undefined,
      comment: answer.comment,
    });
    if (!result.ok) throw new Error(`${request.reference}: ${result.error}`);

    console.log(
      `  ${request.reference}  ${client.name} rated ${answer.rating}/5 — ${
        result.data.invite ? "offered the review page" : "kept here, nobody sent anywhere"
      }`,
    );
  }

  // ── Three that were never answered ─────────────────────────────────────────
  //
  // The reason a request and a response are separate rows. Silence after a bad job is the most
  // common outcome of all, and a model that only stored answers would report a perfect score.
  await ask({
    client: clients[0],
    aboutUserId: people[0].id,
    serviceLabel: "The switch install",
    sentDaysAgo: 4,
    expiresInDays: 26,
  });
  await ask({
    client: clients[clients.length - 1],
    aboutUserId: null,
    serviceLabel: null,
    sentDaysAgo: 9,
    expiresInDays: 21,
  });
  // One that ran out. It is not the same as being ignored, and the page should not pretend it is.
  await ask({
    client: clients[1 % clients.length],
    aboutUserId: people[1 % people.length].id,
    serviceLabel: "The Adobe renewal",
    sentDaysAgo: 60,
    expiresInDays: -5,
  });

  console.log("  3 more asked and unanswered, one of them expired.");
}

async function verify() {
  let failures = 0;
  const ok = (label: string, pass: boolean, detail = "") => {
    console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) failures += 1;
  };

  console.log("\n— Verifying —");

  const requests = await db.feedbackRequest.findMany({
    where: { reference: { startsWith: REF_PREFIX } },
    orderBy: { reference: "asc" },
    include: { response: true, company: { select: { name: true } } },
  });

  if (requests.length === 0) {
    console.log(" FAIL  nothing was seeded");
    return 1;
  }

  ok("the run was seeded", requests.length === 8, `${requests.length} asked`);

  const answered = requests.filter((r) => r.response !== null);
  ok("five of them replied", answered.length === 5, `${answered.length}`);

  // ── The one that matters ───────────────────────────────────────────────────
  const unhappy = answered.filter((r) => r.response!.rating <= 3);
  ok(
    "every low score was recorded, in full",
    unhappy.length === 2 && unhappy.every((r) => r.response!.comment !== null && r.response!.comment.length > 10),
    "the gate decides where somebody is sent, never whether we keep what they said",
  );
  const worst = answered.find((r) => r.response!.rating === 2);
  ok(
    "  including the two-star, word for word",
    !!worst?.response?.comment?.includes("twelve people"),
    worst?.response?.comment?.slice(0, 48),
  );
  ok(
    "  with the sub-scores it came with",
    worst?.response?.personRating === 2 && worst?.response?.serviceRating === 1,
    "person 2, service 1 — the two questions are kept apart",
  );

  // ── The gate ───────────────────────────────────────────────────────────────
  const invited = answered.filter((r) => r.response!.reviewInvited);
  ok("three were offered the review page", invited.length === 3, `${invited.length}`);
  ok(
    "  and every one of them scored 4 or 5",
    invited.every((r) => r.response!.rating >= MIN_RATING),
    invited.map((r) => r.response!.rating).join(", "),
  );
  ok(
    "nobody below 4 was offered it",
    unhappy.every((r) => !r.response!.reviewInvited),
    `rated ${unhappy.map((r) => r.response!.rating).join(" and ")}`,
  );
  ok(
    "the threshold in force is frozen on each response",
    answered.every((r) => r.response!.reviewMinRatingAtTime === MIN_RATING),
    "changing the setting next month must not rewrite what happened",
  );
  ok(
    "nothing is recorded as having opened the review page it was never offered",
    answered.every((r) => !r.response!.reviewOpenedAt || r.response!.reviewInvited),
  );

  // ── Links ──────────────────────────────────────────────────────────────────
  ok(
    "every answered request is closed",
    answered.every((r) => r.status === "ANSWERED"),
    "a request that still reads as open would be asked again",
  );
  ok(
    "  so none of their links still works",
    answered.every(
      (r) => !linkState({ status: r.status, expiresAt: r.expiresAt, answered: !!r.response }).usable,
    ),
    "one answer per link",
  );

  // Proved rather than assumed: a second attempt on a spent token is refused.
  const spent = answered[0];
  const again = await submitFeedback({ token: spent.token, rating: 5, comment: "second go" });
  ok("answering twice is refused", !again.ok, again.ok ? "IT WENT THROUGH" : again.error);
  const stillOne = await db.feedbackResponse.count({ where: { requestId: spent.id } });
  ok("  and nothing was written by the attempt", stillOne === 1, `${stillOne} response on that request`);

  // An expired link is refused too, and says the same thing — a different message would tell an
  // outsider which tokens are real.
  const expired = requests.find(
    (r) => !r.response && r.expiresAt !== null && r.expiresAt < new Date(),
  );
  ok("one link ran out", !!expired, expired?.reference);
  if (expired) {
    const late = await submitFeedback({ token: expired.token, rating: 5 });
    ok("  an expired link is refused", !late.ok);
    ok(
      "  with the same wording as a spent one",
      !late.ok && !again.ok && late.error === again.error,
      "telling them apart would say which tokens exist",
    );
  }

  const bogus = await submitFeedback({ token: randomBytes(24).toString("base64url"), rating: 5 });
  ok("a token nobody issued is refused", !bogus.ok);
  ok(
    "  and it reads the same as every other failure",
    !bogus.ok && !again.ok && bogus.error === again.error,
    bogus.ok ? "" : bogus.error,
  );

  // ── The numbers on the page ────────────────────────────────────────────────
  const summary = summarise(requests);
  ok("the average is what was rated", summary.average === 3.8, `${summary.average}`);
  ok(
    "  and the response rate counts the silence",
    summary.responseRate === 63,
    `${summary.responseRate}% — 5 of 8, which is what makes the average readable`,
  );
  ok("two low scores are waiting for somebody", summary.unanswered === 2, `${summary.unanswered}`);

  // ── Shape ──────────────────────────────────────────────────────────────────
  const tokens = new Set(requests.map((r) => r.token));
  ok("no two requests share a token", tokens.size === requests.length);
  ok("every token is long enough to be unguessable", requests.every((r) => r.token.length >= 32), "192 bits");
  // Proved rather than assumed: a response cannot outlive the request it answers. Feedback with
  // no customer attached to it is unattributable, and would quietly skew every average it lands in.
  const throwaway = await db.feedbackRequest.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      reference: `${REF_PREFIX}9999`,
      companyId: requests[0].companyId,
      status: "SENT",
      sentAt: TODAY,
      expiresAt: daysFrom(5),
      requestedById: requests[0].requestedById,
    },
    select: { id: true, token: true },
  });
  await submitFeedback({ token: throwaway.token, rating: 5, comment: "about to be deleted" });
  const before = await db.feedbackResponse.count({ where: { requestId: throwaway.id } });
  await db.feedbackRequest.delete({ where: { id: throwaway.id } });
  const after = await db.feedbackResponse.count({ where: { requestId: throwaway.id } });
  ok("a response can't outlive the request it answers", before === 1 && after === 0, "deleting one takes the other");

  // Somebody was named on most of them, and the sub-score is only there when they were.
  const noPerson = answered.filter((r) => r.aboutUserId === null);
  ok(
    "a response only carries a person's score when a person was named",
    noPerson.every((r) => r.response!.personRating === null),
    `${noPerson.length} asked about nobody in particular`,
  );

  console.log(failures === 0 ? "\nAll feedback seed checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
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
