/**
 * Who can open a project, and what it takes to see a stored password.
 *
 * Two things here are worth a check rather than a careful read.
 *
 * **Visibility is stakeholders-only**, which is stricter than anything else in the app. Every
 * other module's habit — "everyone signed in, filtered by account scope" — is wrong here, and a
 * single query that forgets to compose `visibleProjectsWhere` hands one customer's implementation
 * plan to somebody working on another. Nothing throws; the extra rows just appear.
 *
 * **Credentials are somebody else's systems.** Three protections guard them, and each fails
 * silently on its own: an encrypted column that gets selected into a list is a secret in the HTML,
 * a password prompt with no server-side comparison is theatre, and a reveal log nobody writes to
 * answers "who has seen this" with silence.
 *
 *   npm run check:projects
 *
 * The session substitution is the one `check-notes` documents. Everything deciding access — the
 * visibility filter, the permission resolver, bcrypt, the real actions — is the real code.
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against
 * a database with real data in it.
 */
import Module from "node:module";
import bcrypt from "bcryptjs";
import type { Role } from "@/lib/roles";
import { db } from "../src/lib/db";
import { milestonesFromTemplate, milestoneProgress, daysLate } from "../src/lib/projects/status";

const PREFIX = "ZZProject";
const EMAIL = "zzproject.";
const PASSWORD = "correct-horse-battery-staple";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

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

const projects = load("../src/actions/project") as typeof import("../src/actions/project");
const creds = load("../src/actions/project-credential") as typeof import("../src/actions/project-credential");
const dashboard = load("../src/actions/dashboard") as typeof import("../src/actions/dashboard");

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

async function makeUser(name: string, role: Role) {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL}${name.toLowerCase()}@example.invalid`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role,
      active: true,
    },
  });
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const projectRows = await db.project.findMany({ where: { code: { startsWith: "PRJ-" }, name: { startsWith: PREFIX } }, select: { id: true } });
  const projectIds = projectRows.map((p) => p.id);

  if (projectIds.length > 0) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.projectType.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (ids.length > 0) {
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  await cleanup();

  section("Dates and progress, without a database");

  const template = [
    { name: "Kickoff", note: null, dayOffset: 0, sortOrder: 0 },
    { name: "Pilot batch", note: null, dayOffset: 7, sortOrder: 1 },
    { name: "Cutover", note: null, dayOffset: 30, sortOrder: 2 },
  ];
  const start = new Date("2026-03-02T00:00:00.000Z");
  const dated = milestonesFromTemplate(template, start);
  ok("A template dates from the project's start", dated[0]!.dueDate?.toISOString().slice(0, 10) === "2026-03-02", dated[0]!.dueDate?.toISOString().slice(0, 10));
  ok("  and offsets land on the right day", dated[2]!.dueDate?.toISOString().slice(0, 10) === "2026-04-01", dated[2]!.dueDate?.toISOString().slice(0, 10));
  ok(
    "  a project with no start date gets no invented dates",
    milestonesFromTemplate(template, null).every((m) => m.dueDate === null),
    "dating a project that starts in three months as though it started today is worse than no date",
  );

  ok(
    "Progress with no milestones is unknown, not zero",
    milestoneProgress([]).percent === null,
    "a bar at 0% on a nearly finished project is worse than no bar",
  );
  ok(
    "  and counts what is actually done",
    milestoneProgress([{ completedAt: new Date() }, { completedAt: null }, { completedAt: null }]).percent === 33,
  );
  ok(
    "Lateness is measured against the promised date",
    daysLate({ targetEndDate: new Date("2026-03-01"), actualEndDate: new Date("2026-03-11"), status: "COMPLETED" }, new Date("2026-04-01")) === 10,
  );
  ok(
    "  and a project finished early is not late",
    daysLate({ targetEndDate: new Date("2026-03-31"), actualEndDate: new Date("2026-03-11"), status: "COMPLETED" }, new Date("2026-04-01")) === null,
  );

  // ── Cast ──────────────────────────────────────────────────────────────────────────────────────
  const manager = await makeUser("Manager", "MANAGEMENT");
  const member = await makeUser("Member", "SUPPORT");
  const outsider = await makeUser("Outsider", "SUPPORT");
  const admin = await makeUser("Admin", "ADMIN");

  const company = await db.company.create({
    data: { name: `${PREFIX} Customer`, normalizedName: `${PREFIX.toLowerCase()} customer`, createdById: admin.id },
  });

  actAs(manager);
  const type = await db.projectType.create({
    data: {
      name: `${PREFIX} Mail migration`,
      templateMilestones: { create: template.map((t, i) => ({ name: t.name, dayOffset: t.dayOffset, sortOrder: i })) },
    },
  });

  const created = await projects.saveProject({
    companyId: company.id,
    typeId: type.id,
    name: `${PREFIX} Exchange to M365`,
    managerId: manager.id,
    startDate: "2026-03-02",
    targetEndDate: "2026-04-01",
    applyTemplate: true,
  });
  ok("A project is created", created.ok, created.ok ? created.data.id : created.error);
  if (!created.ok) return;
  const projectId = created.data.id;

  const stored = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { code: true, milestones: true } });
  ok("  it gets a reference", /^PRJ-\d{4}-\d{4}$/.test(stored.code), stored.code);
  ok("  and the type's standard plan is on it", stored.milestones.length === 3, `${stored.milestones.length} milestones`);

  section("Stakeholders only");

  actAs(manager);
  ok("The manager can see it", (await projects.getProject(projectId)) !== null);

  actAs(outsider);
  ok(
    "Somebody not on it cannot",
    (await projects.getProject(projectId)) === null,
    "an implementation carries the customer's systems, headcount and passwords",
  );
  ok("  and it is absent from their list", (await projects.listProjects()).every((p) => p.id !== projectId));

  actAs(admin);
  ok(
    "An admin can, through projects.viewAll",
    (await projects.getProject(projectId)) !== null,
    "without an override the module is unadministrable once the last stakeholder leaves",
  );

  actAs(manager);
  const added = await projects.addStakeholder({ projectId, userId: member.id, role: "TECHNICAL_LEAD" });
  ok("Adding somebody works", added.ok, added.ok ? "" : added.error);

  actAs(member);
  ok("  and that is what grants them sight of it", (await projects.getProject(projectId)) !== null);
  ok("  it is now in their list", (await projects.listProjects()).some((p) => p.id === projectId));

  actAs(manager);
  const twice = await projects.addStakeholder({ projectId, userId: member.id, role: "TEAM_MEMBER" });
  ok("  adding them twice is refused", !twice.ok, twice.ok ? "it went through" : twice.error);

  const managerRow = await db.projectStakeholder.findFirstOrThrow({ where: { projectId, userId: manager.id } });
  const removeManager = await projects.removeStakeholder(managerRow.id);
  ok("  and the manager cannot be removed from their own project", !removeManager.ok, removeManager.ok ? "" : removeManager.error);

  const told = await db.notification.count({ where: { userId: member.id } });
  ok("The person added is told", told > 0, "a silent grant of access is one nobody reviews");

  section("Credentials: what it takes to see one");

  actAs(manager);
  const savedCred = await creds.saveCredential({
    projectId,
    label: "M365 global admin",
    username: "admin@customer.example",
    secret: "s3cr3t-value",
  });
  ok("A credential is stored", savedCred.ok, savedCred.ok ? "" : savedCred.error);
  if (!savedCred.ok) return;

  const raw = await db.projectCredential.findUniqueOrThrow({ where: { id: savedCred.data.id }, select: { secretCipher: true } });
  ok(
    "It is not in the database in the clear",
    !raw.secretCipher.includes("s3cr3t-value"),
    "this is what defeats a stolen backup",
  );

  // The rule the whole module rests on.
  const detail = await projects.getProject(projectId);
  ok(
    "The project page carries no credentials at all",
    detail !== null && !("credentials" in detail),
    "a masked field is HTML — the value would already be in the response",
  );

  // projects.credentials is granted to nobody by default, including Management.
  const noKey = await creds.listCredentials(projectId);
  ok("Nobody holds the credential key by default", !noKey.ok, noKey.ok ? "the manager could already read them" : noKey.error);

  await db.userPermission.create({
    data: { userId: manager.id, permission: "projects.credentials", allowed: true, grantedById: admin.id },
  });
  const listed = await creds.listCredentials(projectId);
  ok("Granted it, the manager sees the list", listed.ok, listed.ok ? `${listed.data.length}` : listed.error);
  ok(
    "  and the list carries no secret",
    listed.ok && !JSON.stringify(listed.data).includes("s3cr3t-value") && !JSON.stringify(listed.data).includes("secretCipher"),
    "not even the ciphertext — there is no reason for it to leave the server",
  );

  const wrongPassword = await creds.revealCredential(savedCred.data.id, "not-the-password");
  ok("A wrong password reveals nothing", !wrongPassword.ok, wrongPassword.ok ? "IT REVEALED IT" : wrongPassword.error);
  ok(
    "  and the failed attempt is recorded",
    (await db.auditLog.count({ where: { userId: manager.id, entityLabel: { contains: "Failed reveal" } } })) === 1,
    "somebody guessing at a colleague's password is what this is here to make visible",
  );
  ok(
    "  a failed attempt is not logged as a view",
    (await db.credentialReveal.count({ where: { credentialId: savedCred.data.id } })) === 0,
  );

  const revealed = await creds.revealCredential(savedCred.data.id, PASSWORD);
  ok("The right password reveals it", revealed.ok && revealed.data.secret === "s3cr3t-value", revealed.ok ? "" : revealed.error);
  ok(
    "  and the view is recorded against the credential",
    (await db.credentialReveal.count({ where: { credentialId: savedCred.data.id, userId: manager.id } })) === 1,
    "so 'who has seen this' is answerable when deciding what to rotate",
  );
  ok(
    "  the manager is not notified about their own view",
    (await db.notification.count({ where: { userId: manager.id, type: "PROJECT_CREDENTIAL_VIEWED" } })) === 0,
    "telling somebody about their own action trains them to ignore the notification",
  );

  // Somebody on the project, holding the key, but not the manager.
  await db.userPermission.create({
    data: { userId: member.id, permission: "projects.credentials", allowed: true, grantedById: admin.id },
  });
  actAs(member);
  const byMember = await creds.revealCredential(savedCred.data.id, PASSWORD);
  ok("A colleague on the project can reveal it too", byMember.ok, byMember.ok ? "" : byMember.error);
  ok(
    "  and the project manager is told",
    (await db.notification.count({ where: { userId: manager.id, type: "PROJECT_CREDENTIAL_VIEWED" } })) === 1,
    "quiet harvesting becomes visible rather than only discoverable afterwards",
  );

  actAs(outsider);
  await db.userPermission.create({
    data: { userId: outsider.id, permission: "projects.credentials", allowed: true, grantedById: admin.id },
  });
  const byOutsider = await creds.revealCredential(savedCred.data.id, PASSWORD);
  ok(
    "Holding the key is not enough without being on the project",
    !byOutsider.ok,
    byOutsider.ok ? "IT REVEALED IT" : byOutsider.error,
  );
  const outsiderList = await creds.listCredentials(projectId);
  ok("  and they cannot list them either", !outsiderList.ok, outsiderList.ok ? "" : outsiderList.error);

  section("The dashboard widget");

  // A widget is exactly where a visibility rule leaks: nobody screenshots a home screen, and a
  // count that is one too high is invisible until somebody clicks it and gets a 404.
  // A proposed project is not work in progress, and a home screen that lists everything quoted
  // is one people stop reading.
  actAs(member);
  const beforeWon = await dashboard.getDashboardSummary();
  ok(
    "A proposed project is not on the widget",
    beforeWon.projects?.active === 0,
    "it has not been won — a dashboard listing everything quoted is one nobody reads",
  );

  actAs(manager);
  await projects.saveProject({
    id: projectId,
    companyId: company.id,
    name: `${PREFIX} Exchange to M365`,
    managerId: manager.id,
    status: "IN_PROGRESS",
    targetEndDate: "2026-04-01",
  });

  actAs(member);
  const mine = await dashboard.getDashboardSummary();
  ok(
    "Somebody on the project sees it on their dashboard",
    mine.projects !== null && mine.projects.items.some((p) => p.id === projectId),
    `${mine.projects?.active ?? 0} live`,
  );

  actAs(outsider);
  const theirs = await dashboard.getDashboardSummary();
  ok(
    "Somebody not on it does not",
    theirs.projects !== null && !theirs.projects.items.some((p) => p.id === projectId),
    "the widget composes listProjects rather than re-deriving the rule",
  );
  ok(
    "  and it is not in their count either",
    theirs.projects?.active === 0,
    `${theirs.projects?.active} — a count that outruns the list is the same leak, just quieter`,
  );

  actAs(admin);
  const adminView = await dashboard.getDashboardSummary();
  ok(
    "Even projects.viewAll does not widen the widget",
    adminView.projects !== null && !adminView.projects.items.some((p) => p.id === projectId),
    "a home screen is personal — wanting every project is what the Projects page is for",
  );

  section("Rotation");

  actAs(manager);
  const before = await db.projectCredential.findUniqueOrThrow({ where: { id: savedCred.data.id }, select: { secretCipher: true, rotatedAt: true } });
  await creds.saveCredential({ id: savedCred.data.id, projectId, label: "M365 global admin", secret: "new-value" });
  const after = await db.projectCredential.findUniqueOrThrow({ where: { id: savedCred.data.id }, select: { secretCipher: true, rotatedAt: true } });
  ok("Changing the secret changes the stored cipher", before.secretCipher !== after.secretCipher);
  ok("  and dates the rotation", after.rotatedAt !== null && before.rotatedAt?.getTime() !== after.rotatedAt.getTime(), "which is what makes 'last changed in 2023' visible");

  await creds.saveCredential({ id: savedCred.data.id, projectId, label: "M365 global admin — renamed" });
  const kept = await creds.revealCredential(savedCred.data.id, PASSWORD);
  ok(
    "Editing without a new secret keeps the old one",
    kept.ok && kept.data.secret === "new-value",
    "renaming a credential must not blank it",
  );

  console.log(failures === 0 ? "\nAll project checks passed." : `\n${failures} check(s) FAILED.`);
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
