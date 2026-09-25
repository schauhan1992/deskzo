/**
 * Who can open which stored password, and what the owner finds out about it.
 *
 * This module holds the keys to the company's own estate — the registrar, the hosting panel, the
 * tax portal. Every way it can fail is silent:
 *
 *   - an entitlement checked in the wrong order logs an owner reading their own password as an
 *     admin override, and notifies them about themselves until they stop reading notifications;
 *   - a share that has expired but is still matched hands a departed contractor a live password;
 *   - a department share matched on the wrong column shares with everybody or nobody;
 *   - and a secret selected into a list is in the HTML of a page with a padlock drawn on it.
 *
 * None of those throw. So this builds a small organisation, stores real secrets in it, and asks the
 * real actions what each person can open.
 *
 *   npm run check:vault
 *
 * The session substitution is the one `check-notes` documents. Everything deciding access — the
 * entitlement resolver, the permission resolver, bcrypt, the encryption — is the real code.
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against
 * a database with real data in it.
 */
import Module from "node:module";
import bcrypt from "bcryptjs";
import type { Role } from "@/lib/roles";
import { db } from "../src/lib/db";
import { digestSecret, encryptSecret, decryptSecret } from "../src/lib/crypto";
import {
  ARCHIVE_RETENTION_DAYS,
  EXPIRY_NOTICE_WINDOW_DAYS,
  HANDOVER_ROTATION_DAYS,
  daysLeftInArchive,
  entitlementFor,
  expiryNoticeBucket,
  reuseCounts,
  rotationState,
  shouldTellOwner,
} from "../src/lib/vault/policy";
import { purgeExpiredArchive } from "../src/lib/vault/archive";
import {
  DEFAULT_PASSWORD_OPTIONS,
  MAX_LENGTH,
  MIN_LENGTH,
  generatePassword,
  poolSize,
  strengthOf,
} from "../src/lib/vault/password";

const PREFIX = "ZZVault";
const EMAIL = "zzvault.";
const PASSWORD = "correct-horse-battery-staple";

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

const vault = load("../src/actions/vault") as typeof import("../src/actions/vault");

async function makeUser(name: string, role: Role, departmentId?: string) {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL}${name.toLowerCase()}@example.invalid`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role,
      active: true,
      departmentId: departmentId ?? null,
    },
  });
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.vaultCredential.deleteMany({ where: { loginName: { startsWith: PREFIX } } });
  await db.credentialTag.deleteMany({ where: { name: { startsWith: PREFIX } } });
  // The credentials above point at it, so it goes after them.
  await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (ids.length > 0) {
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.department.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  section("Entitlement, resolved without a database");

  const now = new Date();
  const base = { ownerId: "owner", shares: [] as never[] };
  const asOwner = { id: "owner", departmentId: "d1", isAdmin: true };

  ok(
    "Owning it beats being an admin",
    entitlementFor(base, asOwner, now)?.via === "OWNER",
    "otherwise somebody reading their own password is logged as an override and notified about themselves",
  );
  ok(
    "A direct share beats a department one",
    entitlementFor(
      { ownerId: "x", shares: [
        { userId: "u", departmentId: null, level: "VIEW", expiresAt: null },
        { userId: null, departmentId: "d1", level: "MANAGE", expiresAt: null },
      ] },
      { id: "u", departmentId: "d1", isAdmin: false },
      now,
    )?.via === "SHARE",
  );
  ok(
    "  and the most generous department grant wins",
    entitlementFor(
      { ownerId: "x", shares: [
        { userId: null, departmentId: "d1", level: "VIEW", expiresAt: null },
        { userId: null, departmentId: "d1", level: "MANAGE", expiresAt: null },
      ] },
      { id: "u", departmentId: "d1", isAdmin: false },
      now,
    )?.level === "MANAGE",
    "the alternative depends on row order, which is no answer at all",
  );
  ok(
    "An expired share entitles nobody",
    entitlementFor(
      { ownerId: "x", shares: [{ userId: "u", departmentId: null, level: "MANAGE", expiresAt: new Date(now.getTime() - 1000) }] },
      { id: "u", departmentId: null, isAdmin: false },
      now,
    ) === null,
    "this is the one that hands a departed contractor a live password",
  );
  ok(
    "The admin override is last",
    entitlementFor({ ownerId: "x", shares: [] }, { id: "a", departmentId: null, isAdmin: true }, now)?.via === "ADMIN",
  );
  ok(
    "  and a stranger gets nothing",
    entitlementFor({ ownerId: "x", shares: [] }, { id: "s", departmentId: null, isAdmin: false }, now) === null,
  );
  ok("The owner is never told about their own reveal", !shouldTellOwner("OWNER") && shouldTellOwner("ADMIN"));

  ok(
    "A password with no change date reports 'unknown', not 'fine'",
    rotationState({ passwordChangedAt: null, rotateAfterDays: 90 }, now).state === "unknown",
    "never rotated is worth saying out loud",
  );
  ok(
    "  one past its window is overdue",
    rotationState({ passwordChangedAt: new Date(now.getTime() - 120 * 86400000), rotateAfterDays: 90 }, now).state === "overdue",
  );
  ok(
    "  and one inside the fortnight's warning is due",
    rotationState({ passwordChangedAt: new Date(now.getTime() - 80 * 86400000), rotateAfterDays: 90 }, now).state === "due",
  );

  const counts = reuseCounts([
    { id: "a", secretDigest: "X" },
    { id: "b", secretDigest: "X" },
    { id: "c", secretDigest: "Y" },
  ]);
  ok("Reuse counts the others, not itself", counts.get("a") === 1 && counts.get("c") === 0, `a:${counts.get("a")} c:${counts.get("c")}`);

  section("The digest");

  ok("The same password digests the same", digestSecret("hunter2") === digestSecret("hunter2"));
  ok("  a different one does not", digestSecret("hunter2") !== digestSecret("hunter3"));
  ok(
    "  and the digest does not contain the password",
    !digestSecret("hunter2").includes("hunter2"),
    "a bare hash of a password is reversible against a wordlist — this is keyed",
  );
  ok("Encryption round-trips", decryptSecret(encryptSecret("hunter2")) === "hunter2");
  ok("  and the ciphertext is not the plaintext", !encryptSecret("hunter2").includes("hunter2"));

  // ── Cast ──────────────────────────────────────────────────────────────────────────────────────
  const support = await db.department.create({ data: { name: `${PREFIX} Support` } });
  const owner = await makeUser("Owner", "SALES");
  const mate = await makeUser("Mate", "SALES");
  const agent = await makeUser("Agent", "SUPPORT", support.id);
  const stranger = await makeUser("Stranger", "SALES");
  const admin = await makeUser("Admin", "ADMIN");

  actAs(owner);
  const created = await vault.saveCredential({
    loginName: `${PREFIX} GoDaddy`,
    username: "wroffy-admin",
    secret: "registrar-pass",
    recoveryKey: "recovery-abc-123",
    rotateAfterDays: 90,
  });
  ok("A credential is stored", created.ok, created.ok ? "" : created.error);
  if (!created.ok) return;
  const id = created.data.id;

  const raw = await db.vaultCredential.findUniqueOrThrow({
    where: { id },
    select: { secretCipher: true, recoveryKeyCipher: true, passwordChangedAt: true },
  });
  ok("Neither secret is in the database in the clear", !raw.secretCipher.includes("registrar-pass") && !raw.recoveryKeyCipher!.includes("recovery-abc-123"));
  ok("  and storing it dates the change", raw.passwordChangedAt !== null);

  section("What the list does and does not carry");

  const listed = await vault.listVault();
  ok("The owner sees their record", listed.ok && listed.data.rows.some((r) => r.id === id));
  ok(
    "  and the list carries no secret of any kind",
    listed.ok &&
      !JSON.stringify(listed.data.rows).includes("registrar-pass") &&
      !JSON.stringify(listed.data.rows).includes("recovery-abc-123") &&
      !JSON.stringify(listed.data.rows).includes("secretCipher") &&
      !JSON.stringify(listed.data.rows).includes("recoveryKeyCipher"),
    "a masked field is HTML — the value would already be in the response",
  );
  ok(
    "  it says a recovery key exists without shipping it",
    listed.ok && listed.data.rows.find((r) => r.id === id)?.hasRecoveryKey === true,
  );

  actAs(stranger);
  const strangerList = await vault.listVault();
  ok("A stranger sees nothing of it", strangerList.ok && !strangerList.data.rows.some((r) => r.id === id));
  const strangerReveal = await vault.revealSecret(id, PASSWORD);
  ok("  and cannot open it", !strangerReveal.ok, strangerReveal.ok ? "IT OPENED IT" : strangerReveal.error);

  section("Opening one");

  actAs(owner);
  const wrong = await vault.revealSecret(id, "not-the-password");
  ok("A wrong password opens nothing", !wrong.ok, wrong.ok ? "IT OPENED IT" : wrong.error);
  ok(
    "  and the attempt is recorded",
    (await db.auditLog.count({ where: { userId: owner.id, entityLabel: { contains: "Failed open" } } })) === 1,
  );
  ok("  but not as a reveal", (await db.vaultReveal.count({ where: { credentialId: id } })) === 0);

  const opened = await vault.revealSecret(id, PASSWORD);
  ok("The owner opens their own", opened.ok && opened.data.secret === "registrar-pass");
  ok(
    "  logged as OWNER, not as an override",
    (await db.vaultReveal.findFirstOrThrow({ where: { credentialId: id }, orderBy: { at: "desc" } })).via === "OWNER",
  );
  ok(
    "  and they are not notified about themselves",
    (await db.notification.count({ where: { userId: owner.id, type: "VAULT_CREDENTIAL_OPENED" } })) === 0,
  );

  const recovery = await vault.revealSecret(id, PASSWORD, "RECOVERY_KEY");
  ok("The recovery key opens separately", recovery.ok && recovery.data.secret === "recovery-abc-123");
  ok(
    "  and is logged as its own field",
    (await db.vaultReveal.count({ where: { credentialId: id, field: "RECOVERY_KEY" } })) === 1,
    "a recovery key is what somebody uses to take the account away from you",
  );

  section("Sharing");

  const shared = await vault.shareCredential({ credentialId: id, userId: mate.id, level: "VIEW" });
  ok("Sharing with a person works", shared.ok, shared.ok ? "" : shared.error);
  ok("  and they are told", (await db.notification.count({ where: { userId: mate.id, type: "VAULT_SHARED" } })) === 1);

  actAs(mate);
  const mateOpen = await vault.revealSecret(id, PASSWORD);
  ok("They can open it", mateOpen.ok && mateOpen.data.secret === "registrar-pass");
  ok(
    "  the owner is told",
    (await db.notification.count({ where: { userId: owner.id, type: "VAULT_CREDENTIAL_OPENED" } })) === 1,
  );
  const mateEdit = await vault.saveCredential({ id, loginName: `${PREFIX} GoDaddy renamed` });
  ok(
    "  but a VIEW share cannot edit it",
    !mateEdit.ok,
    mateEdit.ok ? "it edited it" : mateEdit.error,
  );
  const mateShare = await vault.shareCredential({ credentialId: id, userId: stranger.id, level: "VIEW" });
  ok("  nor share it onward", !mateShare.ok, mateShare.ok ? "it shared it" : mateShare.error);
  const mateDelete = await vault.deleteCredential(id);
  ok("  nor delete it", !mateDelete.ok, mateDelete.ok ? "it deleted it" : mateDelete.error);

  actAs(owner);
  await vault.shareCredential({ credentialId: id, departmentId: support.id, level: "MANAGE" });
  actAs(agent);
  const agentOpen = await vault.revealSecret(id, PASSWORD);
  ok("A department share reaches its members", agentOpen.ok, agentOpen.ok ? "" : agentOpen.error);
  ok(
    "  logged as DEPARTMENT",
    (await db.vaultReveal.findFirstOrThrow({ where: { credentialId: id, userId: agent.id } })).via === "DEPARTMENT",
  );
  const agentEdit = await vault.saveCredential({ id, loginName: `${PREFIX} GoDaddy` });
  ok("  and a MANAGE department share can edit", agentEdit.ok, agentEdit.ok ? "" : agentEdit.error);

  section("The admin override, and what the owner hears about it");

  actAs(admin);
  await db.userPermission.create({
    data: { userId: admin.id, permission: "vault.viewAll", allowed: true, grantedById: admin.id },
  });
  const adminList = await vault.listVault();
  ok("An admin sees every record", adminList.ok && adminList.data.rows.some((r) => r.id === id));

  const adminOpen = await vault.revealSecret(id, PASSWORD);
  ok("  and can open one nobody shared with them", adminOpen.ok && adminOpen.data.secret === "registrar-pass");
  ok(
    "  recorded as an override rather than as ordinary access",
    (await db.vaultReveal.findFirstOrThrow({ where: { credentialId: id, userId: admin.id } })).via === "ADMIN",
  );
  const told = await db.notification.findFirst({
    where: { userId: owner.id, type: "VAULT_CREDENTIAL_OPENED" },
    orderBy: { createdAt: "desc" },
  });
  ok(
    "  and the owner is told it was an override",
    told?.message?.includes("admin override") === true,
    `${told?.title} — ${told?.message}`,
  );
  ok(
    "The owner can see every open on their record",
    (await db.vaultReveal.count({ where: { credentialId: id } })) === 5,
    "this is the list that answers 'what has to be rotated' after somebody leaves",
  );

  section("Reuse detection");

  actAs(owner);
  await vault.saveCredential({ loginName: `${PREFIX} Hosting`, secret: "registrar-pass" });
  const reused = await vault.listVault();
  ok(
    "The same password on two records is spotted",
    reused.ok && reused.data.rows.find((r) => r.loginName === `${PREFIX} Hosting`)?.reusedOn === 1,
    "one leaked password becoming five compromised accounts is the thing this prevents",
  );

  actAs(stranger);
  const strangerReuse = await vault.listVault();
  ok(
    "  and a stranger is told nothing by it",
    strangerReuse.ok && strangerReuse.data.rows.length === 0,
    "counting across records they cannot see would disclose something about accounts they have no business knowing",
  );

  section("Pinning, and whose list it reorders");

  actAs(owner);
  // Three more, named so alphabetical order is known and a pin visibly breaks it.
  const zulu = await vault.saveCredential({ loginName: `${PREFIX} Zulu`, secret: "zulu-pass" });
  const alpha = await vault.saveCredential({ loginName: `${PREFIX} Alpha`, secret: "alpha-pass" });
  const zuluId = zulu.ok ? zulu.data.id : "";

  const beforePin = await vault.listVault();
  ok(
    "Alphabetical to start with",
    beforePin.ok && beforePin.data.rows[0]?.loginName === `${PREFIX} Alpha`,
    beforePin.ok ? beforePin.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );

  const pinned = await vault.setCredentialPin(zuluId, true);
  ok("A record can be pinned", pinned.ok, pinned.ok ? "" : pinned.error);

  const afterPin = await vault.listVault();
  ok(
    "  and it goes to the top, out of alphabetical order",
    afterPin.ok && afterPin.data.rows[0]?.loginName === `${PREFIX} Zulu`,
    afterPin.ok ? afterPin.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );
  ok("  marked as pinned on the row", afterPin.ok && afterPin.data.rows[0]?.pinned === true);
  ok("  and counted", afterPin.ok && afterPin.data.pinnedCount === 1, afterPin.ok ? afterPin.data.pinnedCount : "");
  ok(
    "  without changing how many records there are",
    beforePin.ok && afterPin.ok && beforePin.data.total === afterPin.data.total,
  );

  /**
   * The mistake this is here to catch.
   *
   * Ordering by the raw relation count — which is what Prisma can express — floats a record to the
   * top of *everybody's* list as soon as one person pins it. A pin is one person's shortlist, and
   * it leaking into a colleague's ordering is both wrong and a small disclosure of who cares about
   * what.
   */
  actAs(mate);
  const mateList = await vault.listVault();
  ok(
    "Somebody else's pin does not reorder my list",
    mateList.ok && mateList.data.rows[0]?.loginName !== `${PREFIX} Zulu`,
    mateList.ok ? mateList.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );
  ok("  and their pin is not shown on my row", mateList.ok && mateList.data.rows.every((r) => !r.pinned));
  ok("  nor counted for me", mateList.ok && mateList.data.pinnedCount === 0);

  actAs(stranger);
  const strangerPin = await vault.setCredentialPin(zuluId, true);
  ok(
    "A record somebody cannot see cannot be pinned",
    !strangerPin.ok,
    strangerPin.ok ? "IT PINNED IT" : strangerPin.error,
  );
  ok(
    "  refused in the same words as one that does not exist",
    !strangerPin.ok &&
      strangerPin.error === ((await vault.setCredentialPin("does-not-exist", true)) as { error: string }).error,
    "or the refusal tells a stranger which ids are real",
  );

  actAs(owner);
  await vault.setCredentialPin(zuluId, true);
  const twice = await vault.listVault();
  ok("Pinning twice is not an error", twice.ok && twice.data.pinnedCount === 1, "a double click is not a mistake");

  const unpinned = await vault.setCredentialPin(zuluId, false);
  const afterUnpin = await vault.listVault();
  ok(
    "Unpinning puts it back where it belongs",
    unpinned.ok && afterUnpin.ok && afterUnpin.data.rows[0]?.loginName === `${PREFIX} Alpha`,
    afterUnpin.ok ? afterUnpin.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );

  section("Paging");

  const all = await vault.listVault({ pageSize: 100 });
  const count = all.ok ? all.data.total : 0;
  ok("Everything fits on one big page", all.ok && all.data.rows.length === count, count);

  const p1 = await vault.listVault({ pageSize: 2, page: 1 });
  const p2 = await vault.listVault({ pageSize: 2, page: 2 });
  ok("A page is the size asked for", p1.ok && p1.data.rows.length === 2, p1.ok ? p1.data.rows.length : "");
  ok(
    "  and the next page is different records",
    p1.ok && p2.ok && !p1.data.rows.some((a) => p2.data.rows.some((b) => b.id === a.id)),
    "an overlap means the window and the ordering disagree",
  );
  ok(
    "  with the page count derived from the total",
    p1.ok && p1.data.totalPages === Math.ceil(count / 2),
    p1.ok ? `${p1.data.totalPages} pages of 2 from ${count}` : "",
  );

  /**
   * The reason the two blocks are paged together in SQL rather than sorted after the fetch.
   *
   * Sorting a page once it has been fetched floats pins to the top of whatever page they landed on,
   * which leaves a pinned record stranded on page four — the one place its owner will not look.
   */
  await vault.setCredentialPin(zuluId, true);
  const pinnedFirstPage = await vault.listVault({ pageSize: 2, page: 1 });
  ok(
    "A pinned record is on page one, wherever it sorted before",
    pinnedFirstPage.ok && pinnedFirstPage.data.rows[0]?.id === zuluId,
    pinnedFirstPage.ok ? pinnedFirstPage.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );
  ok(
    "  and pages still do not overlap",
    (await (async () => {
      const a = await vault.listVault({ pageSize: 2, page: 1 });
      const b = await vault.listVault({ pageSize: 2, page: 2 });
      return a.ok && b.ok && !a.data.rows.some((x) => b.data.rows.some((y) => y.id === x.id));
    })()),
    "the pinned block and the rest are one window, not two",
  );
  await vault.setCredentialPin(zuluId, false);
  void alpha;

  section("Deleting archives rather than destroys");

  actAs(owner);
  const doomed = await vault.saveCredential({ loginName: `${PREFIX} Doomed`, secret: "doomed-pass" });
  const doomedId = doomed.ok ? doomed.data.id : "";
  await vault.shareCredential({ credentialId: doomedId, userId: mate.id, level: "VIEW" });

  const gone = await vault.deleteCredential(doomedId, "Account closed");
  ok("A delete succeeds", gone.ok, gone.ok ? "" : gone.error);

  const afterArchive = await vault.listVault({ pageSize: 100 });
  ok("  and the record leaves the list", afterArchive.ok && !afterArchive.data.rows.some((r) => r.id === doomedId));
  ok(
    "  without being destroyed",
    (await db.vaultCredential.count({ where: { id: doomedId } })) === 1,
    "the plaintext existed nowhere else — a delete that cannot be undone is the wrong default here",
  );

  /**
   * The invariant the whole shape rests on.
   *
   * Archived is not merely hidden from one list. Every way into a credential goes by id, and
   * `findUnique` cannot carry an extra predicate — which is exactly how a deleted record stays
   * readable to anybody who kept the id. Each of these is a separate door.
   */
  const reveal = await vault.revealSecret(doomedId, PASSWORD);
  ok("An archived record cannot be opened", !reveal.ok, reveal.ok ? "IT OPENED IT" : reveal.error);

  const trail = await vault.credentialTrail(doomedId);
  ok("  its trail cannot be read", !trail.ok, trail.ok ? "IT READ THE TRAIL" : trail.error);

  const pinIt = await vault.setCredentialPin(doomedId, true);
  ok("  it cannot be pinned", !pinIt.ok, pinIt.ok ? "IT PINNED IT" : pinIt.error);

  const shareIt = await vault.shareCredential({ credentialId: doomedId, userId: stranger.id, level: "VIEW" });
  ok("  and it cannot be shared onwards", !shareIt.ok, shareIt.ok ? "IT SHARED IT" : shareIt.error);

  const editIt = await vault.saveCredential({ id: doomedId, loginName: `${PREFIX} Doomed renamed` });
  ok(
    "  editing it creates a new record rather than touching the archived one",
    !editIt.ok || editIt.data.id !== doomedId,
    "an edit that reached through the archive would be a delete somebody could undo by accident",
  );

  actAs(admin);
  const adminSees2 = await vault.listVault({ pageSize: 100 });
  ok(
    "Not even an admin finds it in the ordinary list",
    adminSees2.ok && !adminSees2.data.rows.some((r) => r.id === doomedId),
    "the archive is its own screen; a deleted password beside the live ones is the bug this prevents",
  );

  section("The archive, and who may open it");

  actAs(mate);
  const mateArchive = await vault.listArchivedVault();
  ok("Somebody without the admin permission sees no archive", !mateArchive.ok, mateArchive.ok ? "THEY SAW IT" : mateArchive.error);
  const mateRestore = await vault.restoreCredential(doomedId);
  ok("  and cannot restore from it", !mateRestore.ok, mateRestore.ok ? "THEY RESTORED IT" : mateRestore.error);
  const mateDestroy = await vault.destroyArchivedCredential(doomedId);
  ok("  nor empty it", !mateDestroy.ok, mateDestroy.ok ? "THEY DESTROYED IT" : mateDestroy.error);

  actAs(admin);
  const archive = await vault.listArchivedVault();
  const entry = archive.ok ? archive.data.find((r) => r.id === doomedId) : null;
  ok("An admin sees it in the archive", entry !== null && entry !== undefined, archive.ok ? `${archive.data.length} rows` : archive.error);
  ok("  with the reason that was given", entry?.archiveReason === "Account closed", entry?.archiveReason);
  ok("  whose it was", entry?.ownerName === owner.name, entry?.ownerName);
  ok("  and who deleted it", entry?.archivedByName === owner.name, entry?.archivedByName);
  ok(
    "  counting down from the retention period",
    entry !== null && entry !== undefined && entry.daysLeft > ARCHIVE_RETENTION_DAYS - 2 && entry.daysLeft <= ARCHIVE_RETENTION_DAYS,
    `${entry?.daysLeft} of ${ARCHIVE_RETENTION_DAYS}`,
  );

  const restored = await vault.restoreCredential(doomedId);
  ok("An admin can put it back", restored.ok, restored.ok ? "" : restored.error);

  actAs(owner);
  const afterRestore = await vault.listVault({ pageSize: 100 });
  ok("  and it returns to the list", afterRestore.ok && afterRestore.data.rows.some((r) => r.id === doomedId));
  const back = afterRestore.ok ? afterRestore.data.rows.find((r) => r.id === doomedId) : null;
  ok(
    "  to the same owner, with its shares intact",
    back?.owner.id === owner.id && back?.shares.some((sh) => sh.userId === mate.id),
    "a restore that quietly changed who could open it would be a worse surprise than the delete",
  );
  const reopened = await vault.revealSecret(doomedId, PASSWORD);
  ok("  and can be opened again", reopened.ok && reopened.data.secret === "doomed-pass");

  section("The retention clock");

  ok("Sixty days is the retention", ARCHIVE_RETENTION_DAYS === 60, String(ARCHIVE_RETENTION_DAYS));
  ok(
    "A record archived today has the full period",
    daysLeftInArchive(new Date(), new Date()) === ARCHIVE_RETENTION_DAYS,
    String(daysLeftInArchive(new Date(), new Date())),
  );
  ok(
    "  one archived a month ago has half",
    daysLeftInArchive(new Date(Date.now() - 30 * 86400000), new Date()) === ARCHIVE_RETENTION_DAYS - 30,
    String(daysLeftInArchive(new Date(Date.now() - 30 * 86400000), new Date())),
  );
  ok(
    "  and one past its date has run out",
    daysLeftInArchive(new Date(Date.now() - (ARCHIVE_RETENTION_DAYS + 1) * 86400000), new Date()) <= 0,
  );

  /**
   * The sweep, exercised against a record backdated past its retention. Nothing else may be caught
   * by it — a purge that took a live record with it would be the worst bug this module could have.
   */
  actAs(owner);
  const staleSave = await vault.saveCredential({ loginName: `${PREFIX} Stale`, secret: "stale-pass" });
  const staleId = staleSave.ok ? staleSave.data.id : "";
  await vault.deleteCredential(staleId, "Old");
  await db.vaultCredential.update({
    where: { id: staleId },
    data: { archivedAt: new Date(Date.now() - (ARCHIVE_RETENTION_DAYS + 3) * 86400000) },
  });

  const liveBefore = await db.vaultCredential.count({ where: { archivedAt: null, loginName: { startsWith: PREFIX } } });
  const swept = await purgeExpiredArchive();
  ok("The sweep destroys what has run out", swept >= 1, `${swept} destroyed`);
  ok("  and it is gone for good", (await db.vaultCredential.count({ where: { id: staleId } })) === 0);
  const liveAfter = await db.vaultCredential.count({
    where: { archivedAt: null, loginName: { startsWith: PREFIX } },
  });
  ok("  while every live record is untouched", liveAfter === liveBefore, `${liveAfter} of ${liveBefore}`);

  actAs(owner);

  section("Whose account it is");

  const client = await db.company.create({
    data: { name: `${PREFIX} Client Co`, normalizedName: `${PREFIX.toLowerCase()} client co`, createdById: owner.id },
    select: { id: true, name: true },
  });

  actAs(owner);
  const clientCred = await vault.saveCredential({
    loginName: `${PREFIX} Their cPanel`,
    secret: "their-pass",
    ownership: "CLIENT",
    companyId: client.id,
  });
  ok("A credential can be marked as a client's", clientCred.ok, clientCred.ok ? "" : clientCred.error);
  const clientId = clientCred.ok ? clientCred.data.id : "";

  const listed2 = await vault.listVault({ pageSize: 100 });
  const theirs = listed2.ok ? listed2.data.rows.find((r) => r.id === clientId) : null;
  ok("  and says whose", theirs?.ownership === "CLIENT" && theirs?.company?.id === client.id, theirs?.company?.name);

  const onlyClients = await vault.listVault({ ownership: "CLIENT", pageSize: 100 });
  ok(
    "Filtering to clients' returns only theirs",
    onlyClients.ok && onlyClients.data.rows.every((r) => r.ownership === "CLIENT") && onlyClients.data.rows.length > 0,
    onlyClients.ok ? `${onlyClients.data.rows.length} rows` : onlyClients.error,
  );
  const onlyOurs = await vault.listVault({ ownership: "OURS", pageSize: 100 });
  ok(
    "  and filtering to ours excludes them",
    onlyOurs.ok && !onlyOurs.data.rows.some((r) => r.id === clientId),
    onlyOurs.ok ? `${onlyOurs.data.rows.length} rows` : onlyOurs.error,
  );
  ok(
    "  with the two adding up to the whole",
    onlyClients.ok && onlyOurs.ok && listed2.ok &&
      onlyClients.data.total + onlyOurs.data.total === listed2.data.total,
    onlyClients.ok && onlyOurs.ok && listed2.ok
      ? `${onlyClients.data.total} + ${onlyOurs.data.total} = ${listed2.data.total}`
      : "",
  );

  const byClientName = await vault.listVault({ q: "Client Co", pageSize: 100 });
  ok(
    "Searching the client's name finds their credential",
    byClientName.ok && byClientName.data.rows.some((r) => r.id === clientId),
    "the company is printed on the card, so it has to be searchable from it",
  );

  /**
   * The rule that keeps the filter trustworthy.
   *
   * Somebody flipping a client's login back to "ours" and leaving the company attached would leave
   * a record that reads as ours on the card and still answers to that client's filter — and the
   * filter is the thing anybody would rely on when asked what a departing customer still reaches.
   */
  await vault.saveCredential({ id: clientId, loginName: `${PREFIX} Their cPanel`, ownership: "OURS", companyId: client.id });
  const flipped = await vault.listVault({ pageSize: 100 });
  const nowOurs = flipped.ok ? flipped.data.rows.find((r) => r.id === clientId) : null;
  ok("Marking one as ours clears the client with it", nowOurs?.ownership === "OURS" && nowOurs?.company === null, nowOurs?.company?.name ?? "cleared");
  const clientsAfter = await vault.listVault({ ownership: "CLIENT", pageSize: 100 });
  ok(
    "  so it stops answering to that client's filter",
    clientsAfter.ok && !clientsAfter.data.rows.some((r) => r.id === clientId),
  );

  section("Who may delete one");

  actAs(owner);
  const ownerSees = await vault.listVault({ pageSize: 100 });
  ok(
    "The owner may delete their own",
    ownerSees.ok && ownerSees.data.rows.find((r) => r.id === clientId)?.canDelete === true,
  );

  actAs(mate);
  const mateSees = await vault.listVault({ pageSize: 100 });
  const sharedRow = mateSees.ok ? mateSees.data.rows.find((r) => r.id === id) : null;
  ok(
    "Somebody it is shared with may not, however they are entitled",
    sharedRow !== null && sharedRow?.canDelete === false,
    "a shared co-owner rotating a password is routine; destroying the only copy is not",
  );
  const mateCannotDelete = await vault.deleteCredential(id);
  ok("  and the action refuses them too", !mateCannotDelete.ok, mateCannotDelete.ok ? "IT DELETED IT" : mateCannotDelete.error);
  ok(
    "  which is the point of computing it once",
    sharedRow?.canDelete === false && !mateCannotDelete.ok,
    "a button the action would refuse is a button that lies",
  );

  actAs(admin);
  const adminSees = await vault.listVault({ pageSize: 100 });
  ok(
    "An admin may delete somebody else's",
    adminSees.ok && adminSees.data.rows.every((r) => r.canDelete),
    "clearing out a departed colleague's records is the case this exists for",
  );

  const adminDelete = await vault.deleteCredential(clientId);
  ok("  and actually can", adminDelete.ok, adminDelete.ok ? "" : adminDelete.error);
  const afterDelete = await vault.listVault({ pageSize: 100 });
  ok("  with the record gone", afterDelete.ok && !afterDelete.data.rows.some((r) => r.id === clientId));

  actAs(owner);

  section("What the search looks at, and what floats to the top");

  actAs(owner);
  const expiring = await vault.saveCredential({
    loginName: `${PREFIX} Expiring`,
    secret: "expiring-pass",
    remarks: "Renewed through the reseller portal",
    billingExpiry: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
  });
  const expiringId = expiring.ok ? expiring.data.id : "";

  /**
   * The complaint that started this: the box searched four columns and the card showed a dozen.
   * Somebody typing what is printed in front of them got nothing back, which is indistinguishable
   * from a search that does not work.
   */
  const byOwnerName = await vault.listVault({ q: owner.name.split(" ")[1]! });
  ok(
    "Searching an owner's name finds their records",
    byOwnerName.ok && byOwnerName.data.rows.length > 0,
    byOwnerName.ok ? `${byOwnerName.data.rows.length} rows` : byOwnerName.error,
  );

  const byOwnerEmail = await vault.listVault({ q: owner.email.slice(0, 12) });
  ok("  and so does their address", byOwnerEmail.ok && byOwnerEmail.data.rows.length > 0);

  const byRemark = await vault.listVault({ q: "reseller portal" });
  ok(
    "  a remark printed on the card is searchable",
    byRemark.ok && byRemark.data.rows.some((r) => r.id === expiringId),
  );

  const byNothing = await vault.listVault({ q: "zzzz-no-such-thing" });
  ok("  and nonsense still finds nothing", byNothing.ok && byNothing.data.rows.length === 0);

  const byOwnerId = await vault.listVault({ ownerId: owner.id });
  ok(
    "Filtering by owner returns only theirs",
    byOwnerId.ok && byOwnerId.data.rows.every((r) => r.owner.id === owner.id),
    byOwnerId.ok ? `${byOwnerId.data.rows.length} rows` : byOwnerId.error,
  );
  const byOtherOwner = await vault.listVault({ ownerId: stranger.id });
  ok("  and somebody with none gets none", byOtherOwner.ok && byOtherOwner.data.rows.length === 0);

  /**
   * Expiring outranks pinning, and for everybody rather than per person: a subscription about to
   * lapse is the company's problem, not a matter of taste.
   */
  const byExpiry = await vault.listVault();
  ok(
    "A record whose billing is about to lapse comes first",
    byExpiry.ok && byExpiry.data.rows[0]?.id === expiringId,
    byExpiry.ok ? byExpiry.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );
  ok("  flagged as such on the row", byExpiry.ok && byExpiry.data.rows[0]?.expiringSoon === true);
  ok("  and counted", byExpiry.ok && byExpiry.data.expiringCount === 1, byExpiry.ok ? byExpiry.data.expiringCount : "");

  const zuluAgain = await vault.setCredentialPin(zuluId, true);
  const both = await vault.listVault();
  ok(
    "  ahead even of something this person pinned",
    zuluAgain.ok && both.ok && both.data.rows[0]?.id === expiringId && both.data.rows[1]?.id === zuluId,
    both.ok ? both.data.rows.map((r) => r.loginName.replace(PREFIX + " ", "")).join(", ") : "",
  );

  /**
   * A record can be both expiring and pinned, and each block excludes the ones above it. Without
   * that it would be fetched twice and page one would overlap page two.
   */
  await vault.setCredentialPin(expiringId, true);
  const deduped = await vault.listVault({ pageSize: 100 });
  const ids = deduped.ok ? deduped.data.rows.map((r) => r.id) : [];
  ok(
    "Expiring and pinned at once appears once, not twice",
    new Set(ids).size === ids.length,
    `${ids.length} rows, ${new Set(ids).size} distinct`,
  );
  ok(
    "  and the total still matches the rows",
    deduped.ok && deduped.data.total === ids.length,
    deduped.ok ? `${deduped.data.total} vs ${ids.length}` : "",
  );

  const firstPage = await vault.listVault({ pageSize: 2, page: 1 });
  const secondPage = await vault.listVault({ pageSize: 2, page: 2 });
  ok(
    "  and the pages still do not overlap across three blocks",
    firstPage.ok &&
      secondPage.ok &&
      !firstPage.data.rows.some((a) => secondPage.data.rows.some((b) => b.id === a.id)),
    "spilling from one block into the next is where an off-by-one hides",
  );

  await vault.setCredentialPin(expiringId, false);
  await vault.setCredentialPin(zuluId, false);

  section("When a billing expiry is worth mentioning");

  /**
   * The bucket is the whole schedule — there is no "last reminded at" column. It goes into
   * `dedupeKey`, so the same bucket twice writes one notification and a new bucket writes another.
   * These assertions are therefore about the cadence itself, not about a counter somewhere.
   */
  ok("Nothing to say with no expiry recorded", expiryNoticeBucket(null) === null);
  ok("  nor a year out", expiryNoticeBucket(365) === null);
  ok(
    "  nor the day before the window opens",
    expiryNoticeBucket(EXPIRY_NOTICE_WINDOW_DAYS + 1) === null,
    EXPIRY_NOTICE_WINDOW_DAYS + 1,
  );
  ok(
    "The window opens exactly where it says it does",
    expiryNoticeBucket(EXPIRY_NOTICE_WINDOW_DAYS) !== null,
    `${EXPIRY_NOTICE_WINDOW_DAYS} days`,
  );

  // Walk the month down a day at a time and count how often the key changes. Each change is one
  // more notification; anything else is either silence or a daily nag.
  const keys: string[] = [];
  for (let d = EXPIRY_NOTICE_WINDOW_DAYS; d >= 0; d--) {
    const bucket = expiryNoticeBucket(d);
    if (bucket && bucket !== keys[keys.length - 1]) keys.push(bucket);
  }
  ok(
    "Six reminders across the final month, one every five days",
    keys.length === 6,
    `${keys.length} distinct keys over ${EXPIRY_NOTICE_WINDOW_DAYS} days`,
  );
  ok(
    "  and the same day twice is the same reminder",
    expiryNoticeBucket(12) === expiryNoticeBucket(12),
    "or a second run of the sweep would send it again",
  );
  ok(
    "  five days apart is a different one",
    expiryNoticeBucket(12) !== expiryNoticeBucket(7),
    `${expiryNoticeBucket(12)} then ${expiryNoticeBucket(7)}`,
  );
  ok(
    "  and a day apart is not",
    expiryNoticeBucket(12) === expiryNoticeBucket(11),
    "a reminder every day is a notification people turn off",
  );

  ok("A lapsed one says so", expiryNoticeBucket(-1) === "lapsed");
  ok(
    "  and keeps saying the same thing rather than counting upwards",
    expiryNoticeBucket(-1) === expiryNoticeBucket(-90),
    "one notice that stays true beats ninety that say the same thing",
  );

  section("A password inherited from somebody who left");

  const leaverNow = new Date("2026-03-01T00:00:00.000Z");
  const handedOver = {
    passwordChangedAt: null,
    rotateAfterDays: null,
    rotateBy: new Date("2026-03-16T00:00:00.000Z"),
    rotateReason: "The previous owner left.",
  };
  const inherited = rotationState(handedOver, leaverNow);
  ok("It is due even though it has never been rotated here", inherited.state === "due", inherited.state);
  ok("  within a fortnight and a day", inherited.daysUntilDue === HANDOVER_ROTATION_DAYS, inherited.daysUntilDue);
  ok("  and it says why", inherited.reason === "The previous owner left.", inherited.reason);

  /**
   * The case the whole column exists for: without it, a credential nobody has ever rotated through
   * this app reports `unknown`, and the one password that genuinely must change would be the one
   * the screen said nothing about.
   */
  const withoutDeadline = rotationState({ passwordChangedAt: null, rotateAfterDays: null }, leaverNow);
  ok(
    "  which the standing policy alone could never have said",
    withoutDeadline.state === "unknown",
    "a record never rotated here has no opinion of its own",
  );

  const late = rotationState({ ...handedOver, rotateBy: new Date("2026-02-01T00:00:00.000Z") }, leaverNow);
  ok("A missed deadline is overdue, not forgotten", late.state === "overdue", late.daysUntilDue);

  ok(
    "An event deadline outranks the record's own policy",
    rotationState(
      { passwordChangedAt: leaverNow, rotateAfterDays: 365, rotateBy: handedOver.rotateBy, rotateReason: null },
      leaverNow,
    ).state === "due",
    "otherwise a generous rotation policy would bury the fact that somebody walked out with it",
  );

  ok("With no deadline the policy still governs", rotationState({ passwordChangedAt: leaverNow, rotateAfterDays: 90 }, leaverNow).state === "fine");

  section("Generating a password");

  /**
   * A counting source, so what comes out is a fact rather than a coincidence. Every draw is
   * deterministic, which is the only way to assert that the classes, the length and the shuffle
   * behave — a generator tested with real randomness can only ever be spot-checked.
   */
  let tick = 0;
  const counting = (max: number) => tick++ % max;

  const generated = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 24 });
  ok("A generated password is the length asked for", generated.length === 24, generated.length);
  ok("  with a lower-case letter", /[a-z]/.test(generated));
  ok("  an upper-case letter", /[A-Z]/.test(generated));
  ok("  a digit", /[0-9]/.test(generated));
  ok("  and a symbol", /[^a-zA-Z0-9]/.test(generated), generated.replace(/[a-zA-Z0-9]/g, ""));

  ok(
    "Lookalike characters are left out when asked",
    !/[O0oIl1]/.test(generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 64, avoidAmbiguous: true })),
    "O/0 and I/l/1 are what get read back wrong over the phone",
  );
  ok(
    "  and the pool shrinks accordingly",
    poolSize({ ...DEFAULT_PASSWORD_OPTIONS, avoidAmbiguous: true }) <
      poolSize({ ...DEFAULT_PASSWORD_OPTIONS, avoidAmbiguous: false }),
  );

  ok(
    "A class that is turned off never appears",
    !/[^a-z]/.test(
      generatePassword({ length: 40, lower: true, upper: false, digits: false, symbols: false, avoidAmbiguous: false }),
    ),
  );
  ok(
    "Every class turned off still returns something usable",
    generatePassword({ length: 16, lower: false, upper: false, digits: false, symbols: false, avoidAmbiguous: false })
      .length === 16,
    "rather than an empty string somebody saves as their password",
  );

  ok(
    "A length below the floor is raised to it",
    generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 2 }).length === MIN_LENGTH,
    MIN_LENGTH,
  );
  ok(
    "  and one above the ceiling is capped",
    generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 5000 }).length === MAX_LENGTH,
    MAX_LENGTH,
  );

  /**
   * The guaranteed characters are placed first and then shuffled. Without the shuffle the first
   * four positions would always be lower/upper/digit/symbol in that order, which removes most of
   * the benefit of the length that follows.
   */
  tick = 0;
  const ordered = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 16 }, counting);
  ok(
    "The guaranteed characters do not stay at the front",
    !(/^[a-z]/.test(ordered) && /^.[A-Z]/.test(ordered) && /^..[0-9]/.test(ordered)),
    ordered,
  );

  // Two runs off the real CSPRNG. Colliding would mean the source is not what it claims to be.
  const many = new Set(Array.from({ length: 200 }, () => generatePassword()));
  ok("Two hundred generated passwords are two hundred different ones", many.size === 200, many.size);

  section("Saying how strong it is");

  ok("Nothing entered is weak", strengthOf("").label === "weak");
  ok("  and short is weak however clever", strengthOf("aB3$xY7!").label === "weak", strengthOf("aB3$xY7!").note);
  ok(
    "One kind of character is weak at any length",
    strengthOf("abcdefghijklmnopqrstuvwxyzabcdef").label === "weak",
  );
  ok(
    "  as is a handful of characters repeated",
    strengthOf("abababababababababab").label === "weak",
    strengthOf("abababababababababab").note,
  );
  ok("A run like 1234 is marked down", strengthOf("Xk!pQ1234wZmvT#er").label === "fair");
  ok("  and so is a tripled character", strengthOf("Xk!pQwww9ZmvT#er").label === "fair");
  ok("Two classes only is fair", strengthOf("abcpqrxyzmnokjhgf9").label === "fair");

  const strong = strengthOf(generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 24 }));
  ok("A generated password comes out strong", strong.label === "strong", `${strong.bits} bits`);
  ok("  with nothing to say about it", strong.note === null);

  /**
   * The honest limit, asserted rather than left in a comment: the meter measures length and
   * character classes, so a dictionary word dressed up scores well. This is why the generator is
   * one click from the field — the meter is a guide, not a gate.
   */
  ok(
    "The meter cannot see a dictionary word",
    strengthOf("Password123!Password").label !== "weak",
    "measured on classes and length, which is why generating beats choosing",
  );


  console.log(failures === 0 ? "\nAll vault checks passed." : `\n${failures} check(s) FAILED.`);
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
