/**
 * Who can read a sticky note, asked of the real code and a real database.
 *
 * The visibility rules *are* the feature. A note is a scratchpad, and a scratchpad somebody else can
 * read is not one — the moment a person suspects otherwise they stop writing in it, and the module
 * is dead without anything having thrown. The failure is silent in both directions: nothing tells a
 * reader that a note was not meant for them, nobody reports seeing something they should not have,
 * and there is no screen anywhere that answers "who can read this".
 *
 * It also cannot be checked by reading the code. The answer to "can she see it" depends on the
 * owner's department, the viewer's department, who reports to whom, which company the note is stuck
 * to, who manages that account, and three permission rows — all at once. So this builds a small
 * organisation, writes notes in it, and asks the real `listNotes` what each person can see.
 *
 *   npm run check:notes
 *
 * ## The session substitution, and why it is not cheating
 *
 * `src/actions/note.ts` is a `"use server"` module: every export starts with `requireUser()`, which
 * resolves an Auth.js session from the request's cookies. A script has no request, so `headers()`
 * throws long before any of the interesting code runs.
 *
 * The answer is to swap exactly two modules as they load, and nothing else:
 *
 *   @/lib/session   `requireUser()` returns whichever member of the cast the check is acting as.
 *                   This supplies an identity. It decides nothing.
 *   next/cache      `revalidatePath()` wants a render store. Which pages get re-rendered is not a
 *                   security property, so a no-op costs the check nothing.
 *
 * Everything that decides who sees what — `readableNotesWhere`, `accountScopeIds`, `can()`, the
 * ownership test in `ownedNote` — is the real code, reached by calling the real exported actions.
 * That is the whole point. A check that rebuilt the visibility query in order to test the visibility
 * query would pass on the morning the real one started leaking.
 *
 * ## TEAM means department, and this file is where that is decided
 *
 * The doc comment on `enum StickyNoteVisibility` still describes TEAM as the reporting line — the
 * owner, their manager, and their reports. The implementation uses `User.departmentId`, equal and
 * non-null on both sides. Those two rules hand the same note to different people, so the cast is
 * built to tell them apart: two of the owner's direct reports sit outside their department, and
 * neither may see a TEAM note. If somebody later "fixes" the code to match the schema comment, that
 * assertion fails loudly instead of quietly widening the audience.
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against a
 * database with real data in it.
 */
import Module from "node:module";
import type { Role } from "@prisma/client";
import { db } from "../src/lib/db";

const PREFIX = "ZZNoteCheck";
const EMAIL_PREFIX = "zznotecheck.";

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
function actAs(next: Actor) {
  actor = next;
}

/**
 * The two module swaps, installed before `src/actions/note.ts` is loaded for the first time.
 *
 * Matched on the resolved filename rather than on the text of the import, so it does not matter
 * whether a module reaches the session through `@/lib/session` or a relative path — both land on
 * the same file, and both get the stub.
 */
const load = Module.createRequire(__filename);
const moduleInternals = Module as unknown as {
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
const cacheStub = {
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: <T>(fn: T) => fn,
};

const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
]);

const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    // Not resolvable from here, so it is certainly not one of ours — let the real loader raise it.
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const notes = load("../src/actions/note") as typeof import("../src/actions/note");
const dashboard = load("../src/actions/dashboard") as typeof import("../src/actions/dashboard");
const notify = load("../src/lib/notify") as typeof import("../src/lib/notify");

// ── The cast ────────────────────────────────────────────────────────────────────────────────────

type Cast = {
  manager: Actor;
  teammate: Actor;
  outsider: Actor;
  loner: Actor;
  superAdmin: Actor;
  companyId: string;
};

async function makeUser(
  slug: string,
  name: string,
  opts: { role: Role; departmentId?: string | null; managerId?: string | null; isSuperAdmin?: boolean },
): Promise<Actor> {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL_PREFIX}${slug}@example.invalid`,
      passwordHash: "x".repeat(60),
      role: opts.role,
      active: true,
      departmentId: opts.departmentId ?? null,
      managerId: opts.managerId ?? null,
      isSuperAdmin: opts.isSuperAdmin ?? false,
    },
    select: { id: true, name: true, email: true, role: true },
  });
}

/**
 * Permissions are pinned per user rather than left to the role defaults.
 *
 * A per-user row is rule 3 in the resolver and beats both the role and the downline, so these
 * assertions keep meaning what they say on the day somebody re-tunes what SALES comes with.
 */
async function pinPermission(userId: string, permission: string, allowed: boolean) {
  await db.userPermission.create({ data: { userId, permission, allowed, reason: `${PREFIX} fixture` } });
}

async function buildCast(): Promise<Cast> {
  const deptA = await db.department.create({ data: { name: `${PREFIX} Department A` } });
  const deptB = await db.department.create({ data: { name: `${PREFIX} Department B` } });

  const manager = await makeUser("manager", "Manager", { role: "SALES", departmentId: deptA.id });
  const teammate = await makeUser("teammate", "Teammate", {
    role: "SALES",
    departmentId: deptA.id,
    managerId: manager.id,
  });
  // Department B, but still reporting to the manager. This is the person who separates "TEAM is the
  // department" from "TEAM is the reporting line" — the two rules disagree about exactly them.
  const outsider = await makeUser("outsider", "Outsider", {
    role: "SALES",
    departmentId: deptB.id,
    managerId: manager.id,
  });
  const loner = await makeUser("loner", "Loner", { role: "SALES", departmentId: null, managerId: manager.id });
  // A super admin is always also an ADMIN — the schema has a CHECK constraint saying so. Given a
  // department on purpose, so the PRIVATE assertions below rule out the strongest account in the
  // system sitting in the same room as the author.
  const superAdmin = await makeUser("superadmin", "Super Admin", {
    role: "ADMIN",
    departmentId: deptA.id,
    isSuperAdmin: true,
  });

  for (const user of [manager, teammate, outsider, loner]) {
    // Without this the record gate would be switched off for anyone whose role happens to carry
    // `companies.viewAll`, and section 5 would pass by not testing anything.
    await pinPermission(user.id, "companies.viewAll", false);
    await pinPermission(user.id, "notes.broadcast", user.id === manager.id);
  }

  const company = await db.company.create({
    data: {
      name: `${PREFIX} Alpha`,
      normalizedName: `${PREFIX.toLowerCase()} alpha`,
      relationshipType: "CLIENT",
      stage: "CUSTOMER",
      ownerUserId: manager.id,
      createdById: manager.id,
    },
    select: { id: true },
  });

  return { manager, teammate, outsider, loner, superAdmin, companyId: company.id };
}

// ── Asking the real action ──────────────────────────────────────────────────────────────────────

/** Archived notes included throughout, so nothing can pass by having quietly fallen off the board. */
async function boardOf(viewer: Actor): Promise<Awaited<ReturnType<typeof notes.listNotes>>> {
  actAs(viewer);
  return notes.listNotes({ includeArchived: true });
}

async function sees(viewer: Actor, noteId: string): Promise<boolean> {
  return (await boardOf(viewer)).some((note) => note.id === noteId);
}

/** A fixture note, written by the real `createNote` so the create path is exercised too. */
async function writeNote(owner: Actor, input: Record<string, unknown>): Promise<string> {
  actAs(owner);
  const result = await notes.createNote({ ...input, body: `${PREFIX} ${String(input.body ?? "note")}` });
  if (!result.ok) throw new Error(`the fixture note could not be written: ${result.error}`);
  return result.data.id;
}

// ── Everything this check creates, removed again ────────────────────────────────────────────────
// Idempotent, and run before as well as after, so a run that dies half way still leaves the
// database as it found it.

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);

  if (userIds.length || companyIds.length) {
    await db.stickyNote.deleteMany({
      where: { OR: [{ ownerUserId: { in: userIds } }, { companyId: { in: companyIds } }] },
    });
  }
  if (companyIds.length) await db.company.deleteMany({ where: { id: { in: companyIds } } });
  if (userIds.length) {
    // The database refuses to delete a super admin outright — see the trigger in
    // 20260920090000_protect_super_admin. Revoking the flag is the documented first step, and it
    // needs a real super admin to still be there afterwards, which `requireASuperAdminElsewhere`
    // established before the cast was built.
    await db.user.updateMany({ where: { id: { in: userIds }, isSuperAdmin: true }, data: { isSuperAdmin: false } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

/**
 * The fixture includes a super admin, and the database will not let the last one be removed. So an
 * installation with none of its own would gain an undeletable `ZZNoteCheck` account the first time
 * this ran — checked up front rather than discovered during teardown.
 */
async function requireASuperAdminElsewhere() {
  const others = await db.user.count({
    where: { isSuperAdmin: true, active: true, role: "ADMIN", email: { not: { startsWith: EMAIL_PREFIX } } },
  });
  if (others === 0) {
    throw new Error(
      "This check creates a super admin of its own and cannot remove it unless the installation " +
        "already has one. Run npm run db:bootstrap first.",
    );
  }
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────

async function run(cast: Cast) {
  const { manager, teammate, outsider, loner, superAdmin } = cast;
  const everyoneElse = [teammate, outsider, loner, superAdmin];

  section("PRIVATE means private");

  /**
   * The most important assertion in this file.
   *
   * There is deliberately no permission that lifts PRIVATE, and an admin bypass would not be a
   * smaller version of the feature — it would be the end of it. The value of a scratchpad is that
   * its author writes in it without composing; the half-formed thought about a customer, the note
   * about a colleague, the thing that is wrong until it is right. One person discovering that an
   * admin read theirs is enough for everybody to start writing for an audience, and a sticky note
   * written for an audience is just a worse email. So "nobody, including the strongest account in
   * the system" is the whole promise, and it is checked here against a super admin who is also in
   * the author's own department and is also their colleague's manager.
   */
  const privateNote = await writeNote(manager, { body: "the private one" });
  ok("Its author sees it", await sees(manager, privateNote));
  ok("  the colleague at the next desk does not", !(await sees(teammate, privateNote)), "same department, same manager");
  ok("  nor does anyone in another department", !(await sees(outsider, privateNote)));
  ok("  nor somebody with no department at all", !(await sees(loner, privateNote)));
  ok(
    "  nor a super admin",
    !(await sees(superAdmin, privateNote)),
    "holds every permission in the system, shares the author's department, and still cannot read it",
  );

  section("TEAM is the department, not the reporting line");

  const managerTeamNote = await writeNote(manager, { body: "the manager's team note", visibility: "TEAM" });
  const teammateTeamNote = await writeNote(teammate, { body: "the teammate's team note", visibility: "TEAM" });

  ok("A team note reaches the owner's department", await sees(teammate, managerTeamNote));
  ok(
    "  and the same the other way round",
    await sees(manager, teammateTeamNote),
    "symmetric by construction: if you can read mine, I can read yours",
  );
  ok(
    "  but not a direct report in another department",
    !(await sees(outsider, managerTeamNote)),
    "reports to the author — the reporting-line rule in the schema comment would have handed it over",
  );
  ok("  and not their note either", !(await sees(outsider, teammateTeamNote)));
  ok(
    "  the super admin sees it, and only because they share the department",
    await sees(superAdmin, managerTeamNote),
    "the same account that could not read the private note",
  );

  section("TEAM with no department is PRIVATE");

  const lonerTeamNote = await writeNote(loner, { body: "a team of one", visibility: "TEAM" });
  ok("Its author still sees it", await sees(loner, lonerTeamNote));
  ok(
    "  their own manager does not",
    !(await sees(manager, lonerTeamNote)),
    "an owner with no department shares with nobody, rather than with everybody else unassigned",
  );
  for (const viewer of [teammate, outsider, superAdmin]) {
    ok(`  nor does ${viewer.name}`, !(await sees(viewer, lonerTeamNote)));
  }

  section("EVERYONE reaches everyone");

  const broadcast = await writeNote(manager, { body: "the announcement", visibility: "EVERYONE" });
  ok("Its author sees it", await sees(manager, broadcast));
  for (const viewer of everyoneElse) {
    ok(`  and so does ${viewer.name}`, await sees(viewer, broadcast));
  }

  section("The record test is an AND, not an OR");

  const attached = await writeNote(manager, {
    body: "they always order in March",
    visibility: "EVERYONE",
    companyId: cast.companyId,
  });
  ok("The account manager sees the note on their own account", await sees(manager, attached));
  ok(
    "  somebody outside that account's scope does not, though it says EVERYONE",
    !(await sees(outsider, attached)),
    "otherwise a broadcast note is a way to read an account nobody gave you",
  );
  ok(
    "  and that same person does see an unattached EVERYONE note",
    await sees(outsider, broadcast),
    "so it is the attachment hiding it, not something else about them",
  );

  actAs(outsider);
  const strayAttach = await notes.createNote({
    body: `${PREFIX} writing on somebody else's account`,
    companyId: cast.companyId,
  });
  ok(
    "  nor can they write onto it in the first place",
    !strayAttach.ok,
    strayAttach.ok ? "the note was created" : strayAttach.error,
  );

  // The mirror image, and the one people find surprising: the record test applies to your own notes
  // too. Reassigned to the super admin rather than to anyone in the manager's downline, because a
  // report's accounts are still inside their manager's scope.
  await db.company.update({ where: { id: cast.companyId }, data: { ownerUserId: superAdmin.id } });
  ok(
    "A note stuck to an account follows the account, not its author",
    !(await sees(manager, attached)),
    "reassign the account and the note leaves the old manager's board — see src/actions/note.ts",
  );
  await db.company.update({ where: { id: cast.companyId }, data: { ownerUserId: manager.id } });
  ok("  and comes back when the account does", await sees(manager, attached));

  section("Only the author writes");

  const teamNoteBefore = await db.stickyNote.findUniqueOrThrow({
    where: { id: managerTeamNote },
    select: { body: true, visibility: true, archivedAt: true },
  });

  actAs(teammate);
  const foreignEdit = await notes.updateNote({
    id: managerTeamNote,
    body: "rewritten by somebody who can read it",
    visibility: "TEAM",
  });
  ok("An edit to somebody else's note is refused", !foreignEdit.ok, foreignEdit.ok ? "the write went through" : foreignEdit.error);

  const foreignArchive = await notes.setNoteArchived(managerTeamNote, true);
  ok("  and so is archiving it", !foreignArchive.ok, foreignArchive.ok ? "it was archived" : foreignArchive.error);

  const foreignDelete = await notes.deleteNote(managerTeamNote);
  ok("  and deleting it", !foreignDelete.ok, foreignDelete.ok ? "it was deleted" : foreignDelete.error);

  const teamNoteAfter = await db.stickyNote.findUnique({
    where: { id: managerTeamNote },
    select: { body: true, visibility: true, archivedAt: true },
  });
  ok(
    "  and the note is exactly as it was",
    teamNoteAfter !== null &&
      teamNoteAfter.body === teamNoteBefore.body &&
      teamNoteAfter.visibility === teamNoteBefore.visibility &&
      teamNoteAfter.archivedAt === null,
    "a refusal that had already written would be the worst of both",
  );

  const ghostDelete = await notes.deleteNote("zznotecheck-no-such-note");
  ok(
    "  and a note that never existed is refused in the same words",
    !ghostDelete.ok && !foreignDelete.ok && ghostDelete.error === foreignDelete.error,
    "otherwise the error message is a way to find out whose notes exist",
  );

  section("EVERYONE needs notes.broadcast, on the way in and on the way back");

  actAs(teammate);
  const bornPublic = await notes.createNote({ body: `${PREFIX} an announcement nobody approved`, visibility: "EVERYONE" });
  ok("Creating a broadcast without the permission is refused", !bornPublic.ok, bornPublic.ok ? "it was created" : bornPublic.error);

  const quietNote = await writeNote(teammate, { body: "quiet for now", visibility: "PRIVATE" });
  actAs(teammate);
  const promoted = await notes.updateNote({ id: quietNote, body: `${PREFIX} quiet for now`, visibility: "EVERYONE" });
  ok(
    "  and so is editing one into a broadcast afterwards",
    !promoted.ok,
    "without this half, the permission guards nothing: write it private, then edit it public",
  );
  const quietAfter = await db.stickyNote.findUnique({ where: { id: quietNote }, select: { visibility: true } });
  ok("  leaving it private", quietAfter?.visibility === "PRIVATE", quietAfter?.visibility ?? "the note vanished");

  ok(
    "  while somebody who holds the permission may",
    await sees(outsider, broadcast),
    "the manager's broadcast, which reached a different department",
  );

  section("What the board is allowed to offer");

  const teammateBoard = await boardOf(teammate);
  const own = teammateBoard.find((note) => note.id === quietNote);
  const borrowed = teammateBoard.find((note) => note.id === managerTeamNote);

  ok("Your own note comes back editable", own?.canEdit === true, own ? `canEdit ${own.canEdit}` : "not on the board");
  ok(
    "  somebody else's does not",
    borrowed?.canEdit === false,
    borrowed ? `canEdit ${borrowed.canEdit}` : "not on the board",
  );
  ok("  and still names who wrote it", borrowed?.ownerName === manager.name, borrowed?.ownerName ?? "no owner name");

  section("Reminders");

  // Delivered through syncSystemNotifications — the same sweep that raises overdue tasks and
  // breached SLAs. That is the point: a second reminder system is two things to distrust.
  const reminders = async (of: Actor) => {
    await notify.syncSystemNotifications(of.id);
    return db.notification.findMany({
      where: { userId: of.id, type: "NOTE_REMINDER" },
      select: { id: true, message: true, dedupeKey: true },
    });
  };

  actAs(teammate);
  const past = new Date(Date.now() - 60_000).toISOString();
  const due = await notes.createNote({
    body: `${PREFIX} ring the auditor`,
    title: `${PREFIX} Auditor`,
    remindAt: past,
  });
  ok("A note with a reminder saves", due.ok, due.ok ? "" : due.error);
  const dueId = due.ok ? due.data.id : "";

  const first = await reminders(teammate);
  ok("  the reminder is delivered", first.length === 1, `${first.length} raised`);
  ok("  naming the note", first[0]?.message === `${PREFIX} Auditor`, first[0]?.message ?? "no message");

  const second = await reminders(teammate);
  ok(
    "  and running the sweep again does not raise it twice",
    second.length === 1,
    "the sweep runs on every notification fetch, so this is the difference between a reminder and a stream of them",
  );

  ok(
    "  it reaches nobody else, even the manager",
    (await reminders(manager)).length === 0,
    "a reminder belongs to whoever set it — a shared note is not a shared alarm",
  );

  // Moving the reminder has to re-arm it. The dedupe key carries the timestamp for this reason.
  const movedTo = new Date(Date.now() - 30_000).toISOString();
  await notes.updateNote({ id: dueId, title: `${PREFIX} Auditor`, body: `${PREFIX} ring the auditor`, remindAt: movedTo });
  const afterMove = await reminders(teammate);
  ok("  moving the reminder arms it again", afterMove.length === 2, `${afterMove.length} raised`);

  // And an unrelated edit must not cancel it — the full-replace footgun, checked rather than
  // trusted to the caller remembering.
  await notes.updateNote({ id: dueId, title: `${PREFIX} Auditor`, body: `${PREFIX} ring the auditor twice`, remindAt: movedTo });
  const stillSet = await db.stickyNote.findUnique({ where: { id: dueId }, select: { remindAt: true } });
  ok("  editing the text leaves the reminder alone", stillSet?.remindAt !== null, String(stillSet?.remindAt ?? "cleared"));

  // Clearing it is an explicit empty value.
  await notes.updateNote({ id: dueId, title: `${PREFIX} Auditor`, body: `${PREFIX} ring the auditor twice`, remindAt: "" });
  const cleared = await db.stickyNote.findUnique({ where: { id: dueId }, select: { remindAt: true } });
  ok("  and clearing it removes it", cleared?.remindAt === null, String(cleared?.remindAt ?? "null"));

  // Archiving is how somebody says they are done, so it must silence the reminder too.
  const archivedNote = await notes.createNote({ body: `${PREFIX} archived reminder`, remindAt: past });
  const archivedId = archivedNote.ok ? archivedNote.data.id : "";
  await notes.setNoteArchived(archivedId, true);
  const afterArchive = await reminders(teammate);
  ok(
    "  an archived note stops reminding",
    !afterArchive.some((n) => n.dedupeKey?.includes(archivedId)),
    "clearing a note off the board is also how somebody says they are finished with it",
  );

  // A reminder still in the future must stay quiet.
  const laterNote = await notes.createNote({
    body: `${PREFIX} next week`,
    remindAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
  });
  const laterId = laterNote.ok ? laterNote.data.id : "";
  const afterFuture = await reminders(teammate);
  ok(
    "  a future reminder stays quiet",
    !afterFuture.some((n) => n.dedupeKey?.includes(laterId)),
    "otherwise every reminder fires the moment it is set",
  );
  const board = await boardOf(teammate);
  ok(
    "  and the board marks due and not-yet-due apart",
    board.find((n) => n.id === laterId)?.remindDue === false,
    "the card reads this rather than the clock — a client that reads the clock during render is what the compiler refuses",
  );

  section("The dashboard widget reads the same rule");

  // The widget is a second surface onto the same notes, and a second surface is where a
  // visibility rule usually gets quietly re-derived. Driving the real action proves it did not.
  actAs(manager);
  const managerWidget = (await dashboard.getDashboardSummary()).notes;
  actAs(outsider);
  const outsiderWidget = (await dashboard.getDashboardSummary()).notes;

  const onWidget = (widget: typeof managerWidget, id: string) => !!widget?.items.some((n) => n.id === id);

  ok("The widget is populated", (managerWidget?.total ?? 0) > 0, `${managerWidget?.total ?? 0} notes on the manager's board`);
  ok(
    "  a private note reaches nobody else's widget",
    !onWidget(outsiderWidget, quietNote),
    "the teammate's private note, on somebody from another department's home screen",
  );
  ok(
    "  a broadcast does",
    onWidget(outsiderWidget, broadcast),
    "so the absence above is the rule working, not the widget being empty",
  );
  ok(
    "  and it never shows more than it has",
    (managerWidget?.items.length ?? 0) <= 4 && (managerWidget?.items.length ?? 0) <= (managerWidget?.total ?? 0),
    `${managerWidget?.items.length ?? 0} of ${managerWidget?.total ?? 0} shown`,
  );
  ok(
    "  marking somebody else's note as not yours",
    managerWidget?.items.every((n) => (n.ownerName === manager.name) === n.mine) ?? false,
    "the card hides the author on your own notes, so `mine` has to be right",
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nSticky note visibility — the real actions, a real database, a throwaway cast.\n");

  await requireASuperAdminElsewhere();
  await cleanup();
  const cast = await buildCast();
  try {
    await run(cast);
  } finally {
    actor = null;
    // Reported rather than thrown: a teardown that fails should not swallow the results of the run
    // it was tearing down, and leftover ZZNoteCheck rows are themselves worth failing over.
    try {
      await cleanup();
    } catch (err) {
      ok("The fixture removes itself again", false, err instanceof Error ? err.message : String(err));
    }
  }

  console.log(failures === 0 ? "\nAll sticky note checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
