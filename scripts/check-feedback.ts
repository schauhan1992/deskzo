/**
 * What a score means, and where it sends somebody.
 *
 * Two things here are worth checking rather than trusting. The boundary — "4 or above" has to mean
 * 4, and an off-by-one either sends an unhappy customer to a public review page or denies a happy
 * one the chance to leave a good word. And the invariant underneath the whole module: the response
 * is kept whatever the score. The gate decides where a person goes next, never whether we listen.
 *
 * Then, against the workspace database, who sees which feedback through the real list — a search
 * narrows what somebody may see and never widens it.
 *
 *   npm run check:feedback
 */
import "dotenv/config";
import Module from "node:module";
import {
  averageOf,
  clampRating,
  isValidRating,
  linkState,
  ratingTone,
  reviewInvitation,
  subjectOf,
  summarise,
  thresholdNote,
} from "../src/lib/feedback/rating";

let failures = 0;
function ok(label: string, pass: boolean, detail: string | number | null = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
}
function eq(label: string, actual: unknown, expected: unknown, why = "") {
  const pass = actual === expected;
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label} — ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}${why ? ` · ${why}` : ""}`,
  );
  if (!pass) failures += 1;
}
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-09-19");
const GOOGLE = "https://g.page/r/deskzo/review";

console.log("\n— The boundary —\n");

const at = (rating: number, minRating = 4) => reviewInvitation({ rating, minRating, reviewUrl: GOOGLE });

ok("5 is offered the review page", at(5).invite);
ok("4 is too — the threshold is inclusive", at(4).invite, "'4 or above' has to mean 4");
ok("3 is not", !at(3).invite);
ok("2 is not", !at(2).invite);
ok("1 is not", !at(1).invite);
ok("  and the reason says why, in words somebody can argue with", at(3).reason.includes("below the 4"), at(3).reason);
ok("  including that it stays with us", at(3).reason.includes("stays with us"));

// Moving the threshold moves the line and nothing else.
ok("At 5, a 4 is no longer offered", !at(4, 5).invite);
ok("  but a 5 still is", at(5, 5).invite);
ok("At 3, a 3 is offered", at(3, 3).invite);

console.log("\n— Everybody, which is the compliant setting —\n");

ok("At 1, even a 1-star is offered the page", at(1, 1).invite, "no filtering by sentiment at all");
ok("  and the reason says so plainly", at(1, 1).reason.includes("whatever they scored"), at(1, 1).reason);
ok(
  "  the settings note calls that the policy-clean setting",
  thresholdNote(1).tone === "default" && thresholdNote(1).text.includes("Google"),
  thresholdNote(1).text.slice(0, 60),
);
ok(
  "  and warns about anything higher",
  thresholdNote(4).tone === "amber" && thresholdNote(4).text.includes("gating"),
  "review gating is against Google's policy, and whoever sets it should know",
);
ok("  while still saying the feedback is kept", thresholdNote(4).text.includes("recorded here either way"));

console.log("\n— Nothing to send them to —\n");

const noUrl = reviewInvitation({ rating: 5, minRating: 4, reviewUrl: null });
ok("With no review page set, a 5 is not invited", !noUrl.invite);
ok("  and it says why rather than failing silently", noUrl.reason.includes("nowhere to send"), noUrl.reason);
eq("  with no url to link to", noUrl.url, null);
ok("A blank string counts as unset", !reviewInvitation({ rating: 5, minRating: 4, reviewUrl: "   " }).invite);

console.log("\n— Scores that aren't scores —\n");

ok("Zero is not a rating", !at(0).invite && !isValidRating(0));
ok("Six is not a rating", !at(6).invite && !isValidRating(6));
ok("Nor is 4.5", !isValidRating(4.5), "half stars are not a thing this form can produce");
eq("A threshold above 5 is clamped", clampRating(9), 5);
eq("A threshold below 1 is clamped", clampRating(0), 1);
eq("And nonsense lands on the bottom", clampRating(Number.NaN), 1);

console.log("\n— Colour —\n");

eq("5 is green", ratingTone(5), "green");
eq("4 is green", ratingTone(4), "green");
eq("3 is amber, not green", ratingTone(3), "amber", "a 3 is somebody being polite about a problem");
eq("2 is red", ratingTone(2), "red");
eq("Nothing rated is neutral", ratingTone(null), "default");

console.log("\n— Whether a link still works —\n");

const live = { status: "SENT" as const, expiresAt: d("2026-10-19") };
ok("A sent link inside its window works", linkState(live, NOW).usable);
ok("Past its expiry it doesn't", !linkState({ ...live, expiresAt: d("2026-09-18") }, NOW).usable);
ok("Expiring today still works", linkState({ ...live, expiresAt: d("2026-09-20") }, NOW).usable);
ok("An answered one doesn't", !linkState({ ...live, answered: true }, NOW).usable, "it works once");
ok("Neither does an answered status", !linkState({ status: "ANSWERED", expiresAt: null }, NOW).usable);
ok("Nor a withdrawn one", !linkState({ status: "CANCELLED", expiresAt: null }, NOW).usable);
ok("A link with no expiry set still works", linkState({ status: "SENT", expiresAt: null }, NOW).usable);

console.log("\n— Reading a pile of them —\n");

const answered = (rating: number, person: number | null, service: number | null, acknowledged = false) => ({
  response: {
    rating,
    personRating: person,
    serviceRating: service,
    acknowledgedAt: acknowledged ? d("2026-09-18") : null,
  },
});
const unanswered = { response: null };

const pile = [
  answered(5, 5, 4),
  answered(5, null, null),
  answered(4, 4, 3),
  answered(2, 1, 2),
  answered(3, 3, null, true),
  unanswered,
  unanswered,
  unanswered,
];
const s = summarise(pile);

eq("Asked", s.asked, 8);
eq("Answered", s.answered, 5);
eq("Response rate", s.responseRate, 63, "5 of 8 — the number that says whether the average means anything");
eq("Average", s.average, 3.8);
eq(
  "The person average ignores the ones nobody was asked about",
  s.personAverage,
  3.25,
  "13 over 4, not 13 over 5 — a blank is 'not asked', not zero",
);
eq("Same for the service average", s.serviceAverage, 3);
eq("Happy", s.happy, 3);
eq("Unhappy", s.unhappy, 2, "a 3 counts as unhappy");
eq("  of which one was answered", s.unanswered, 1);
eq("Distribution, 5s", s.distribution[5], 2);
eq("  4s", s.distribution[4], 1);
eq("  3s", s.distribution[3], 1);
eq("  2s", s.distribution[2], 1);
eq("  1s", s.distribution[1], 0);

const nobody = summarise([unanswered, unanswered]);
eq("Nothing answered gives no average rather than zero", nobody.average, null, "zero would read as everybody hated it");
eq("  but the response rate is still a real number", nobody.responseRate, 0);
const nothing = summarise([]);
eq("Nothing asked gives no rate at all", nothing.responseRate, null);
eq("  and no average", nothing.average, null);

eq("An average of nothing is null", averageOf([null, null]), null);
eq("  and nulls don't drag it down", averageOf([5, null, 5]), 5, "not 3.33");

console.log("\n— What it's about —\n");

eq("A typed label wins", subjectOf({ serviceLabel: "The M365 migration", ticket: { title: "Printer" } }), "The M365 migration");
eq("Then the ticket", subjectOf({ ticket: { title: "Printer offline" } }), "Printer offline");
eq("Then what they bought", subjectOf({ order: { item: { name: "Microsoft 365 Business Basic" } } }), "Microsoft 365 Business Basic");
eq("Then the visit", subjectOf({ visit: { purpose: "SUPPORT" } }), "A site visit");
eq("Then the person", subjectOf({ aboutUser: { name: "Priya" } }), "Working with Priya");
eq("And otherwise, the general question", subjectOf({}), "How we're doing");
eq("A blank label doesn't win", subjectOf({ serviceLabel: "   ", ticket: { title: "Printer offline" } }), "Printer offline");

// ─── Who sees which feedback, through the real list ──────────────────────────────────────────────
//
// Against the workspace database, on a fixture made here and removed in a finally: somebody without
// "See all customer feedback" sees only feedback about them, asked for by them, or on accounts they
// own or look after — and typing a search narrows that, never widens it (a search used to replace the
// visibility rule, so searching a company's name showed every score about everybody on it).

const MAIL = "@zzprobe-feedback.invalid";
const TAG = "Zzprobe Fb";
const ROLE = "ZZPROBE_FB";

async function whoSeesWhat() {
  console.log("\n— Who sees which feedback —\n");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the stand-ins below are in place
  const { directClient } = require("../src/lib/tenancy/direct-client") as typeof import("../src/lib/tenancy/direct-client");
  const db = directClient();
  // The list is a server action: whoever calls it is the fixture's viewer, or their manager.
  let actorId = "";
  const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
  const originalLoad = internals._load;
  internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
    if (request === "@/lib/session" || request.endsWith("lib/session")) {
      const user = async () => ({ id: actorId, role: ROLE, name: "Zzprobe Viewer", email: `viewer${MAIL}` });
      return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
    }
    return originalLoad.call(this, request, parent, isMain);
  } as typeof originalLoad;

  const cleanup = async () => {
    await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await db.userPermission.deleteMany({ where: { user: { email: { endsWith: MAIL } } } });
    await db.auditLog.deleteMany({ where: { user: { email: { endsWith: MAIL } } } });
    await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };
  await cleanup();
  try {
    await db.role.create({ data: { key: ROLE, name: "Zzprobe feedback" } });
    const person = (key: string) => db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key.toLowerCase()}${MAIL}`, role: ROLE, passwordHash: "x".repeat(60) } });
    const viewer = await person("Viewer");
    const colleague = await person("Colleague");
    const boss = await person("Boss");
    await db.userPermission.create({ data: { userId: boss.id, permission: "feedback.viewAll", allowed: true, reason: TAG } });
    // One account, looked after by the colleague; one score about the viewer on it, and one about the colleague.
    const company = await db.company.create({
      data: { name: `${TAG} Traders`, normalizedName: `${TAG} traders`.toLowerCase(), createdById: colleague.id, ownerUserId: colleague.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never,
    });
    const ask = (ref: string, aboutUserId: string, requestedById: string) =>
      db.feedbackRequest.create({ data: { token: `zzprobe-${ref}-${Math.random().toString(36).slice(2)}`, reference: `ZZPFB-${ref}`, companyId: company.id, aboutUserId, requestedById } });
    const aboutViewer = await ask("V1", viewer.id, colleague.id);
    const aboutColleague = await ask("C1", colleague.id, colleague.id);

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the session stand-in, so it reaches the action
    const { listFeedback } = require("../src/actions/feedback") as typeof import("../src/actions/feedback");
    const ids = (result: Awaited<ReturnType<typeof listFeedback>>) => new Set((result.rows as { id: string }[]).map((r) => r.id));

    actorId = viewer.id;
    const plain = ids(await listFeedback({}));
    ok("without the permission: the feedback about them, not a colleague's on the same account", plain.has(aboutViewer.id) && !plain.has(aboutColleague.id));
    const searched = ids(await listFeedback({ search: TAG }));
    ok("  and searching the account's name still shows only theirs", searched.has(aboutViewer.id) && !searched.has(aboutColleague.id), `${searched.size} shown`);
    const byReference = ids(await listFeedback({ search: "ZZPFB-C1" }));
    ok("  nor does searching the colleague's reference find it", !byReference.has(aboutColleague.id), `${byReference.size} shown`);

    actorId = boss.id;
    const all = ids(await listFeedback({ search: TAG }));
    ok("with \"See all customer feedback\", the same search finds both", all.has(aboutViewer.id) && all.has(aboutColleague.id), `${all.size} shown`);
    const narrowed = ids(await listFeedback({ search: "ZZPFB-V1" }));
    ok("  and a search still narrows", narrowed.has(aboutViewer.id) && !narrowed.has(aboutColleague.id), `${narrowed.size} shown`);
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }
}

whoSeesWhat()
  .catch((err) => {
    ok("the database checks ran to their end", false, err instanceof Error ? err.message : String(err));
  })
  .finally(() => {
    console.log(failures === 0 ? "\nAll feedback checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
