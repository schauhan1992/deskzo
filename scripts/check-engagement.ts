/**
 * That "anonymous" is true, and not merely intended.
 *
 * Employees are shown a page telling them this channel cannot be traced back to them. That page is
 * only honest if the assertions below pass, which makes this the one check in the repository whose
 * failure is a broken promise to a person rather than a bug.
 *
 * Every way it fails is invisible from the screen:
 *
 *   - an author column filled out of habit,
 *   - an audit row saying "Priya submitted anonymous feedback" beside a feedback row dated today,
 *   - a full timestamp instead of a date, which correlates with a login and a door swipe,
 *   - `SurveyParticipation.responseId` written on an anonymous survey, which is a direct join,
 *   - or a result shown to two respondents, where the arithmetic names them.
 *
 *   npm run check:engagement
 *
 * The session substitution is the one `check-notes` documents. Everything deciding what is stored
 * is the real code, reached through the real actions.
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against
 * a database with real data in it.
 */
import Module from "node:module";
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { db } from "../src/lib/db";
import {
  MIN_RESPONSES_TO_REVEAL,
  isAcceptingResponses,
  isTargeted,
  needsSplash,
  submissionDate,
  summarise,
} from "../src/lib/engagement/anonymity";

const PREFIX = "ZZEngage";
const EMAIL = "zzengage.";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

type Actor = { id: string; name: string; email: string; role: Role };
let actor: Actor | null = null;
const actAs = (u: { id: string; name: string; email: string; role: Role }) => {
  actor = { id: u.id, name: u.name, email: u.email, role: u.role };
};

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn };
const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
]);
const realLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const feedback = load("../src/actions/internal-feedback") as typeof import("../src/actions/internal-feedback");
const surveys = load("../src/actions/survey") as typeof import("../src/actions/survey");

async function makeUser(name: string, role: Role, departmentId?: string) {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL}${name.toLowerCase()}@example.invalid`,
      passwordHash: await bcrypt.hash("x", 4),
      role,
      active: true,
      departmentId: departmentId ?? null,
    },
  });
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.internalFeedback.deleteMany({ where: { body: { startsWith: PREFIX } } });
  await db.survey.deleteMany({ where: { title: { startsWith: PREFIX } } });
  if (ids.length > 0) {
    await db.feedbackQuota.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  section("The rules, without a database");

  const now = new Date("2026-09-19T14:32:17.482Z");
  const coarse = submissionDate(now);
  ok(
    "A submission date carries no time",
    coarse.getUTCHours() === 0 && coarse.getUTCMinutes() === 0 && coarse.getUTCSeconds() === 0,
    `${coarse.toISOString()} — a timestamp to the second correlates with a login and a door swipe`,
  );

  ok("The threshold is five", MIN_RESPONSES_TO_REVEAL === 5);
  for (const n of [0, 1, 2, 3, 4]) {
    const r = summarise("YES_NO", [{ number: 1, text: null, choices: [] }], [], n);
    if (r.kind !== "hidden") ok(`  ${n} responses stays hidden`, false, `it showed ${r.kind}`);
  }
  ok("  four responses reveals nothing", summarise("YES_NO", [], [], 4).kind === "hidden");
  ok(
    "  and five reveals",
    summarise("RATING", [{ number: 4, text: null, choices: [] }], [], 5).kind === "numeric",
  );
  const hidden = summarise("TEXT", [{ number: null, text: "secret", choices: [] }], [], 2);
  ok(
    "  a hidden result carries no answers at all",
    hidden.kind === "hidden" && !JSON.stringify(hidden).includes("secret"),
    "hiding it on screen while shipping it in the payload is not hiding it",
  );

  const openish = { status: "OPEN" as const, opensAt: null, expiresAt: null };
  ok("An open form accepts answers", isAcceptingResponses(openish, now));
  ok(
    "  an expired one does not, whatever its status says",
    !isAcceptingResponses({ ...openish, expiresAt: new Date(now.getTime() - 1000) }, now),
    "'we'll close it later' is how a form stays open for a year",
  );
  ok("  and one that has not opened yet does not", !isAcceptingResponses({ ...openish, opensAt: new Date(now.getTime() + 1000) }, now));

  ok(
    "A skipped splash comes back next session",
    needsSplash({ mandatory: true, ...openish }, null, false, now) &&
      !needsSplash({ mandatory: true, ...openish }, null, true, now),
  );
  ok(
    "  and stops once it is answered",
    !needsSplash({ mandatory: true, ...openish }, { respondedAt: now }, false, now),
  );

  ok(
    "A department form reaches its department and nobody else",
    isTargeted({ audience: "DEPARTMENT", targets: [{ userId: null, departmentId: "d1" }] }, { id: "u", departmentId: "d1" }) &&
      !isTargeted({ audience: "DEPARTMENT", targets: [{ userId: null, departmentId: "d1" }] }, { id: "u", departmentId: "d2" }),
  );

  // ── Cast ──────────────────────────────────────────────────────────────────────────────────────
  const dept = await db.department.create({ data: { name: `${PREFIX} Ops` } });
  const hr = await makeUser("HR", "MANAGEMENT");
  const worker = await makeUser("Worker", "SALES", dept.id);
  const subject = await makeUser("Subject", "SALES");
  const outsider = await makeUser("Outsider", "SALES");

  section("Anonymous feedback stores nothing about its sender");

  actAs(worker);
  const sent = await feedback.submitAnonymousFeedback({
    kind: "CONCERN",
    aboutUserId: subject.id,
    rating: 2,
    body: `${PREFIX} the handover process is not working and nobody owns it`,
  });
  ok("It is accepted", sent.ok, sent.ok ? `${sent.data.remainingToday} left today` : sent.error);

  const stored = await db.internalFeedback.findFirstOrThrow({ where: { body: { startsWith: PREFIX } } });

  /**
   * The exact shape of the row, asserted as a set rather than against a list of forbidden names.
   *
   * A deny-list only catches the column names somebody thought of. This fails the moment *any*
   * column is added, which forces whoever adds one to come here and say why it is safe — and two
   * of the columns present are identity columns that are entirely legitimate:
   * `aboutUserId` is the subject, and `reviewedById` is the HR person who read it. Neither is the
   * author, and there is no column for the author.
   */
  const EXPECTED = [
    "id", "kind", "aboutUserId", "rating", "body", "submittedOn",
    "reviewedAt", "reviewedById", "reviewNote",
  ].sort();
  const columns = Object.keys(stored).sort();
  ok(
    "The row is exactly the columns it is meant to be, and none of them is the author",
    JSON.stringify(columns) === JSON.stringify(EXPECTED),
    columns.join(", "),
  );
  ok(
    "  no column names a submitter",
    !columns.some((c) => /^(submittedBy|submitterId|authorId|createdById|fromUserId|ipAddress|userAgent|sessionId)$/i.test(c)),
  );
  ok(
    "  its date carries no time",
    stored.submittedOn.getUTCHours() === 0 && stored.submittedOn.getUTCMinutes() === 0,
    stored.submittedOn.toISOString(),
  );

  // The mistake that would be easiest to make out of habit, since every other action audits.
  const audits = await db.auditLog.findMany({ where: { userId: worker.id }, select: { entityLabel: true, entityType: true } });
  ok(
    "Nothing was written to the audit trail",
    audits.length === 0,
    audits.length === 0
      ? "an audit row beside a same-day feedback row is a join"
      : audits.map((a) => `${a.entityType}: ${a.entityLabel}`).join(" | "),
  );

  const quota = await db.feedbackQuota.findFirstOrThrow({ where: { userId: worker.id } });
  ok(
    "The rate limit counted them without storing what they wrote",
    quota.count === 1 && !Object.keys(quota).some((c) => /body|text|content|feedbackId/i.test(c)),
    Object.keys(quota).join(", "),
  );
  ok(
    "  and there is no column anywhere joining the two",
    !Object.keys(stored).some((c) => /quota/i.test(c)) && !Object.keys(quota).some((c) => /feedback/i.test(c)),
    "the roll marks you off, the ballot goes in the box, and the two are never brought together",
  );

  actAs(outsider);
  ok("Somebody without the permission sees nothing", (await feedback.listInternalFeedback()) === null);

  actAs(hr);
  const forHr = await feedback.listInternalFeedback();
  // Found by id rather than asserted to be the only row. This check has to pass against a
  // database somebody is actually using, and "exactly one piece of feedback exists anywhere" is
  // only true of an empty one.
  const mine = forHr?.find((f) => f.id === stored.id) ?? null;
  ok("HR sees the item", mine !== null, `${forHr?.length ?? 0} visible to HR`);
  ok(
    "  and it names who it is about, never who wrote it",
    mine !== null && mine.aboutUser?.id === subject.id && !JSON.stringify(mine).includes(worker.id),
    "the person it is about is the point; the person who wrote it is not recorded to be shown",
  );

  section("An anonymous survey keeps no link to the respondent");

  actAs(hr);
  const made = await surveys.saveSurvey({
    kind: "FORM",
    title: `${PREFIX} How is it going`,
    anonymous: true,
    mandatory: true,
    audience: "EVERYONE",
    status: "OPEN",
    questions: [
      { kind: "RATING", prompt: "How are things?", required: true, options: [] },
      { kind: "TEXT", prompt: "Anything else?", required: false, options: [] },
    ],
  });
  ok("A form is created", made.ok, made.ok ? "" : made.error);
  if (!made.ok) return;
  const surveyId = made.data.id;

  const toFill = await (async () => {
    actAs(worker);
    return surveys.getSurveyToFill(surveyId);
  })();
  ok("The worker can open it", toFill !== null && toFill.open);
  ok("  and it tells them it is anonymous", toFill?.anonymous === true, "somebody deciding how frankly to answer needs to know");

  const answered = await surveys.submitResponse({
    surveyId,
    answers: [
      { questionId: toFill!.questions[0]!.id, number: 2 },
      { questionId: toFill!.questions[1]!.id, text: `${PREFIX} the deadlines are unrealistic` },
    ],
  });
  ok("They can answer", answered.ok, answered.ok ? "" : answered.error);

  const participation = await db.surveyParticipation.findFirstOrThrow({ where: { surveyId, userId: worker.id } });
  ok("Participation records that they answered", participation.respondedAt !== null);
  ok(
    "  and responseId is null, which is the whole promise",
    participation.responseId === null,
    "this column is the only path from a person to their answers",
  );
  const response = await db.surveyResponse.findFirstOrThrow({ where: { surveyId } });
  ok(
    "The response row has no respondent column",
    !Object.keys(response).some((c) => /userId|respondentId|createdBy|ip/i.test(c)),
    Object.keys(response).join(", "),
  );
  ok("  and its date carries no time", response.submittedOn.getUTCHours() === 0);
  ok(
    "No audit entry names the respondent",
    (await db.auditLog.count({ where: { userId: worker.id, entityType: "SurveyResponse" } })) === 0,
  );

  const again = await surveys.submitResponse({ surveyId, answers: [{ questionId: toFill!.questions[0]!.id, number: 5 }] });
  ok("They cannot answer twice", !again.ok, again.ok ? "it accepted a second" : again.error);

  section("Results stay hidden until five have answered");

  actAs(hr);
  const early = await surveys.surveyResults(surveyId);
  ok("With one response, every question is hidden", early !== null && early.questions.every((q) => q.result.kind === "hidden"));
  ok(
    "  and the written answer is nowhere in the payload",
    early !== null && !JSON.stringify(early).includes("deadlines are unrealistic"),
    "this is the one that would leak a verbatim quote from a team of three",
  );
  ok("  the count itself is shown, which is safe", early?.responseCount === 1);

  // Four more, so the threshold is crossed rather than approached.
  for (const n of [1, 2, 3, 4]) {
    const extra = await makeUser(`Extra${n}`, "SALES");
    actAs(extra);
    const f = await surveys.getSurveyToFill(surveyId);
    await surveys.submitResponse({
      surveyId,
      answers: [{ questionId: f!.questions[0]!.id, number: 4 }, { questionId: f!.questions[1]!.id, text: `${PREFIX} fine` }],
    });
  }

  actAs(hr);
  const full = await surveys.surveyResults(surveyId);
  ok("At five, results appear", full !== null && full.questions[0]!.result.kind === "numeric");
  ok(
    "  and the average is right",
    full !== null && full.questions[0]!.result.kind === "numeric" && full.questions[0]!.result.average === 3.6,
    full !== null && full.questions[0]!.result.kind === "numeric" ? String(full.questions[0]!.result.average) : "",
  );
  ok(
    "Every participation on an anonymous survey has a null responseId",
    (await db.surveyParticipation.count({ where: { surveyId, responseId: { not: null } } })) === 0,
    "if this ever fails, the feature is broken in the one way that matters",
  );

  section("An attributed survey says so, and links openly");

  actAs(hr);
  const named = await surveys.saveSurvey({
    kind: "POLL",
    title: `${PREFIX} Office lunch`,
    anonymous: false,
    mandatory: false,
    audience: "EVERYONE",
    status: "OPEN",
    questions: [{ kind: "SINGLE_CHOICE", prompt: "Which?", required: true, options: ["Thali", "Biryani"] }],
  });
  if (!named.ok) return;
  actAs(worker);
  const pollForm = await surveys.getSurveyToFill(named.data.id);
  ok("  it tells them it is attributed", pollForm?.anonymous === false);
  await surveys.submitResponse({
    surveyId: named.data.id,
    answers: [{ questionId: pollForm!.questions[0]!.id, choices: ["Thali"] }],
  });
  const namedPart = await db.surveyParticipation.findFirstOrThrow({ where: { surveyId: named.data.id, userId: worker.id } });
  ok(
    "  and the link is written, because it was never hidden",
    namedPart.responseId !== null,
    "an attributed poll is not a failure of anonymity — it is a different promise, kept",
  );

  actAs(hr);
  const flip = await surveys.saveSurvey({
    id: named.data.id,
    kind: "POLL",
    title: `${PREFIX} Office lunch`,
    anonymous: true,
    mandatory: false,
    audience: "EVERYONE",
    status: "OPEN",
    questions: [{ kind: "SINGLE_CHOICE", prompt: "Which?", required: true, options: ["Thali", "Biryani"] }],
  });
  ok(
    "Anonymity cannot be flipped once people have answered",
    !flip.ok,
    flip.ok ? "IT FLIPPED" : flip.error,
  );

  console.log(failures === 0 ? "\nAll engagement checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
