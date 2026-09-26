import { ADMIN_ROLE, type Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { roleKeys } from "@/lib/authz/role-registry";
import { can } from "@/lib/authz/resolve";
import {
  actorContext,
  assertMayActOnTarget,
  assertNotSelf,
  assertSuperAdminRemains,
  AuthzError,
} from "@/lib/authz/guards";
import { wouldCreateCycle } from "@/lib/org-chart";
import { findDepartment, optionalUserRef, upsertDepartment } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type FieldChange,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";
import { seatProblem } from "@/lib/seats";

/**
 * User accounts, their roles, and the reporting line everything else is scoped against.
 *
 * Every other importer risks bad data. This one risks an attacker. A spreadsheet that sets `role` is
 * a privilege-escalation path, and a spreadsheet that sets a password is an account takeover, so this
 * module is written around what it refuses rather than around what it writes. Each refusal below
 * closes a specific way in.
 *
 * The rule the whole file is an application of: **import may not do what the user screen cannot.**
 * It is a second door into the same house and it gets the same lock. Wherever the two differ, the
 * difference is the vulnerability — so every field written here is checked against the action in
 * src/actions/user.ts that writes it, and a field no action writes at all is not written here either.
 *
 * ## Super admin is read, never written
 *
 * The column exists because the export carries it — whoever is editing the file should be able to
 * see who holds the tier — but on the way back in, a cell that disagrees with the stored value is an
 * error row. Not ignored: ignored is worse. Somebody would type `yes`, watch the import succeed, and
 * believe the grant landed, or type `no` and believe it was revoked. Super admin is granted one
 * person at a time on their own screen, where it is a deliberate act with a face attached to it, and
 * `isSuperAdmin` never appears in a payload here under any circumstance.
 *
 * ## The sign-in address is matching information, never a write
 *
 * `Email` finds the account a row is about, and on an account that already exists that is *all* it
 * does — an address that differs from the stored one is an error row, and `email` never appears in an
 * update payload.
 *
 * This is not fussiness about data quality, it is the same escalation as the role column wearing a
 * different hat. Sign-in resolves an identity to an account by address and by nothing else: the
 * credentials provider looks up `db.user.findUnique({ where: { email } })`, and the single sign-on
 * callback in src/lib/auth.ts does exactly the same with the address Entra asserts. So rewriting an
 * account's address re-points that account at whoever controls the new one — sign in through SSO and
 * you are them.
 *
 * `users.manage` is deliberately *not* the super-admin-only key; `users.assignRole` is. That split
 * exists so somebody can be trusted with onboarding and leavers without being trusted to move people
 * between roles. A writable Email column hands that person every role anyway: pick any admin who is
 * not a super admin, move their address to one you own, sign in. Nothing in the application offers
 * this — `updateUserAssignment` writes role, department and manager; `setUserActive` writes active;
 * no action anywhere writes `email` on an account that already exists — so allowing it from a file
 * would be import inventing a capability, which is the one thing it must never do.
 *
 * ## No password, ever
 *
 * There is no password column and nothing writes `passwordHash` on an existing account. A created one
 * gets a placeholder that is not a bcrypt hash and — the part that matters — is not 60 characters,
 * which is the length `bcrypt.compare` demands before it will even attempt a comparison. It returns
 * false without hashing anything, so nothing that can be typed into the login form matches. The
 * account exists, appears in the org chart and can be given work; it cannot be signed into until an
 * admin issues credentials through `createUser` in src/actions/user.ts, which is also where
 * `mustChangePassword` comes from. A bulk file that could set passwords is a bulk file that can mint
 * accounts somebody else already knows the password to.
 *
 * ## No role an admin could not grant by hand
 *
 * The authority checks are the ones the user screen uses, not a second set invented here:
 * `users.manage` for any row that changes something, `users.assignRole` when the role actually moves
 * or when the row would create an ADMIN, `assertMayActOnTarget` so an ordinary admin cannot rewrite a
 * super admin, and `assertNotSelf` so nobody promotes or deactivates themselves.
 *
 * `assertGrantWithinOwnAuthority` is deliberately not used: it answers "may this actor hand out this
 * permission key", which is a different question from "may this actor move somebody between roles".
 * `can(actor, "users.assignRole")` is the question the user actions ask, so it is the one asked here.
 *
 * These run against the signed-in user, which both phases have: `previewImport` and `commitImport`
 * pass `user.id` into `plan()` and `apply()` (src/actions/data-import.ts), and `plan()` documents the
 * actor as required precisely so the preview can refuse a row the person is not allowed to commit. An
 * actor that is somehow missing is therefore a caller that was never wired up, and an unanswerable
 * "who is doing this" is a refusal rather than a pass — the checks are not skipped, the row is.
 *
 * ## Authority gates changes, not rows
 *
 * A row that restates what is already stored writes nothing, so it needs no permission to write
 * nothing: it is a skip. Checking otherwise would mean an ordinary admin could not hand back a file
 * they had just exported — every super admin's unchanged row would come back refused — and a refusal
 * for a row that was never going to do anything trains people to ignore refusals. So the changes are
 * worked out first and the target-scoped guards run only when there are some.
 *
 * ## The last super admin stays
 *
 * `assertSuperAdminRemains` runs twice, on purpose. Once while resolving — read-only, so the preview
 * refuses the row and says why, rather than the writer throwing halfway through a file. Then again
 * inside the transaction that writes, because that guard's whole value is that the check and the
 * write cannot be separated by another request doing the same thing. And a super admin's role cannot
 * be moved off ADMIN from here at all: the invariant behind it is a CHECK constraint, so the
 * alternative to refusing is a database error nobody can read.
 *
 * ## Reporting loops
 *
 * A cycle in `managerId` is not a data-quality problem, it is an outage. `getDownlineUserIds` runs on
 * the authenticated path of every render, and the screen that would repair the bad row is itself
 * behind it, so a file that closes a loop takes the application down with no way back in through the
 * application. `wouldCreateCycle` is checked before the value is ever proposed.
 */

/**
 * Not a hash. Chosen for its length as much as its content: `bcrypt.compare` returns false for any
 * stored value that is not exactly 60 characters, without hashing anything, so this can never match.
 */
const NO_PASSWORD = "no-password-set-by-import";

async function loadUser(where: { userSeq: number } | { email: string }) {
  return db.user.findUnique({
    where,
    select: {
      id: true,
      userSeq: true,
      name: true,
      email: true,
      role: true,
      isSuperAdmin: true,
      active: true,
      department: { select: { name: true } },
      manager: { select: { name: true } },
    },
  });
}

type ExistingUser = NonNullable<Awaited<ReturnType<typeof loadUser>>>;

/**
 * Fields a row may carry for an account that is already here. Absent means "leave it alone".
 *
 * `email` is not among them, and that is the enforcement of the rule above rather than a note about
 * it: there is no field to put an address in, so no code path can write one.
 */
type Edits = {
  name?: string;
  role?: Role;
  active?: boolean;
  departmentName?: string;
  /** The department as it already exists; absent means applying will have to create it. */
  departmentId?: string;
  managerId?: string;
  managerName?: string;
};

type ResolvedUser =
  | ({ existing: null; name: string; email: string; role: Role } & Omit<Edits, "name" | "role">)
  /** `changes` is worked out once, so the preview and the authority checks read the same list. */
  | ({ existing: ExistingUser; changes: FieldChange[] } & Edits);

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<ResolvedUser>> {
  const r = new RowReader(row);
  const name = r.text("Name");
  const email = r.text("Email").toLowerCase();
  /**
   * The accepted set is read from the database, not from a compiled enum.
   *
   * `r.enum` wants a map of allowed values, which used to be the Prisma `Role` enum object. Roles
   * are rows now, so an import naming a role somebody created last week has to be accepted — and
   * one naming a role that does not exist still has to be refused, which is the same check against
   * a different source.
   */
  const allowedRoles = Object.fromEntries((await roleKeys()).map((k) => [k, k]));
  const role = r.enum("Role", allowedRoles);
  const superAdminCell = r.boolean("Super admin");
  const active = r.boolean("Active");
  if (r.error) return { error: r.error };

  // ── Which account the row is about ───────────────────────────────────────────────────────────
  const keyCell = r.text("Key");
  const seq = seqFromKey("USR", keyCell);
  if (keyCell && seq === null) {
    return { error: `Key "${keyCell}" isn't a user key. It looks like USR-000123 — or leave the cell empty to match on email.` };
  }
  if (seq === null && !email) {
    return { error: "Email is required. It is how a row finds the account it describes, and how a new one is created." };
  }

  // Not `findUser` from lookups: that excludes deactivated accounts, which is right for naming
  // somebody else but wrong for the subject of the row — a leaver's row would silently become a
  // second account on the same address.
  const existing = seq !== null ? await loadUser({ userSeq: seq }) : await loadUser({ email });
  if (seq !== null && !existing) {
    return { error: `No user with key ${keyOf("USR", seq)}. Remove the Key cell to create a new account.` };
  }

  // ── The address, which only ever matches ──────────────────────────────────────────────────────
  // Reachable only on a key-matched row: matching *by* address means the two are equal already.
  if (existing && email && email !== existing.email) {
    const clash = await loadUser({ email });
    if (clash) {
      return {
        error: `Email ${email} already belongs to ${clash.name} (${keyOf("USR", clash.userSeq)}). Two accounts can't share an address.`,
      };
    }
    return {
      error: `${existing.name} signs in as ${existing.email}, and an import won't move that to ${email}. The address *is* the account as far as signing in is concerned — single sign-on hands back an address and gets this account — so moving it would hand this account to whoever owns the new one. Leave the Email cell as it was exported, or empty.`,
    };
  }

  // ── Super admin: stated in the file, decided elsewhere ────────────────────────────────────────
  const storedSuperAdmin = existing?.isSuperAdmin ?? false;
  if (superAdminCell !== undefined && superAdminCell !== storedSuperAdmin) {
    return {
      error: `Super admin is granted deliberately on the user's own screen, never through a bulk file. Set "Super admin" to ${storedSuperAdmin ? "yes" : "no"} to match the account as it stands, or leave the cell empty.`,
    };
  }

  // Whether the row switches a live account off, as opposed to restating that it is already off.
  const deactivates = existing ? existing.active && active === false : false;

  // ── A super admin's account, from a file ──────────────────────────────────────────────────────
  if (existing?.isSuperAdmin) {
    if (role !== undefined && role !== ADMIN_ROLE) {
      return {
        error: `${existing.name} is a super admin, and a super admin is always ADMIN. Remove super admin on their own screen before changing the role.`,
      };
    }
    if (deactivates) {
      try {
        // Read-only here — the same guard runs again inside the write's transaction, where it also
        // locks. This copy exists so the preview can refuse the row rather than the writer throwing.
        await assertSuperAdminRemains(db, existing.id);
      } catch (err) {
        if (err instanceof AuthzError) return { error: err.message };
        throw err;
      }
    }
  }

  // ── The reporting line ────────────────────────────────────────────────────────────────────────
  const manager = await optionalUserRef("Manager", r.text("Manager"));
  if ("error" in manager) return { error: manager.error };
  if (existing && manager.value && (await wouldCreateCycle(existing.id, manager.value.id))) {
    return {
      error: `${manager.value.name} can't be ${existing.name}'s manager: ${manager.value.name} already reports up through them, and a loop in the reporting line takes every scoped view down with it.`,
    };
  }

  // Looked up, never created — creating a department belongs to apply(), so a preview somebody
  // abandons leaves the picklist as it found it.
  const departmentName = r.text("Department") || undefined;
  const department = departmentName ? await findDepartment(departmentName) : null;

  const edits: Edits = {
    name: name || undefined,
    role,
    active,
    departmentName,
    departmentId: department?.id,
    managerId: manager.value?.id,
    managerName: manager.value?.name,
  };

  // ── What this row would actually change ───────────────────────────────────────────────────────
  // One list, used by the preview and by the authority checks below. Every entry is a field `apply`
  // writes, and every field `apply` writes has an entry — the two halves cannot drift apart into a
  // preview that describes a write nobody makes, or a write nobody was shown.
  const changes: FieldChange[] = existing
    ? ([
        edits.name ? diff("Name", existing.name, edits.name) : null,
        edits.role ? diff("Role", existing.role, edits.role) : null,
        edits.active !== undefined ? diff("Active", existing.active, edits.active) : null,
        edits.departmentName ? diff("Department", existing.department?.name, edits.departmentName) : null,
        edits.managerName ? diff("Manager", existing.manager?.name, edits.managerName) : null,
      ].filter((c): c is FieldChange => c !== null))
    : [];

  // ── Authority ─────────────────────────────────────────────────────────────────────────────────
  // Both phases know the actor (see the header), so an empty one is a caller that was never wired
  // up. Refuse: the alternative is a path where nothing is checked at all.
  if (!ctx.actorUserId) {
    return { error: "This import can't tell who is running it, so it can't check what you're allowed to change." };
  }

  // `users.assignRole` guards a role that is actually moving, and the creation of an ADMIN, exactly
  // as createUser and updateUserAssignment do. A role cell that restates what is already stored is
  // not a grant and does not need the key, which is what lets an exported file be handed back.
  const grantsRole = existing ? role !== undefined && role !== existing.role : role === ADMIN_ROLE;
  // A row that writes nothing needs no authority to write it; it is a skip.
  const writes = !existing || changes.length > 0;

  try {
    const actor = await actorContext(ctx.actorUserId);
    if (writes && !(await can(actor.id, "users.manage"))) {
      return { error: "You can't create or edit users." };
    }
    if (grantsRole && !(await can(actor.id, "users.assignRole"))) {
      return {
        error: existing
          ? `Only a super admin can change somebody's role, and this row moves ${existing.name} to ${role}.`
          : `Only a super admin can create an ${role} account.`,
      };
    }
    if (existing && writes) {
      assertMayActOnTarget(actor, existing);
      if (grantsRole) assertNotSelf(actor.id, existing.id, "role");
      if (deactivates) assertNotSelf(actor.id, existing.id, "active status");
    }
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message };
    throw err;
  }

  // What a new account cannot be created without. Checked last so the row reports a refusal it could
  // not have known about — an authority or a lookup failure — ahead of a blank cell.
  if (!existing) {
    if (!name) return { error: "Name is required for a new account." };
    if (!role) return { error: "Role is required for a new account — there is no default to fall back on." };
    return { value: { ...edits, existing: null, name, email, role } };
  }
  return { value: { ...edits, existing, changes } };
}

export const usersImporter: Importer = {
  templateColumns: ["Key", "Name", "Email", "Role", "Super admin", "Active", "Department", "Manager"],

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Name || row.Email || "", resolved.error);
    const u = resolved.value;

    if (u.existing === null) {
      return createRow(line, u.email, u.name, {
        Name: u.name,
        Email: u.email,
        Role: u.role,
        Active: u.active,
        Department: u.departmentName,
        Manager: u.managerName,
      });
    }

    // Neither "Super admin" nor "Email" can appear in this list, because neither can appear in the
    // payload. A row that disagreed with the stored value on either never reached here.
    return updateRow(line, keyOf("USR", u.existing.userSeq), u.name ?? u.existing.name, u.changes);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const u = resolved.value;

    // The one write the planner could not do for itself. Departments are a picklist rather than a
    // record anybody owns, so a name the file introduces is created here.
    const departmentId = u.departmentName
      ? (u.departmentId ?? (await upsertDepartment(u.departmentName))?.id)
      : undefined;

    // A new active account, or one switched back on, takes a seat — the row fails when none is free.
    const takesSeat = u.existing === null ? u.active !== false : u.active === true && !u.existing.active;
    if (takesSeat) {
      const seats = await seatProblem();
      if (seats) throw new Error(seats);
    }

    const assignments = {
      ...(u.active !== undefined ? { active: u.active } : {}),
      ...(departmentId ? { departmentId } : {}),
      ...(u.managerId ? { managerId: u.managerId } : {}),
    };

    if (u.existing === null) {
      await db.user.create({
        data: {
          name: u.name,
          email: u.email,
          role: u.role,
          ...assignments,
          // Unusable by construction, and flagged so the first real password has to be changed —
          // the same state createUser leaves an account in, minus the temporary password nobody
          // should be typing into a spreadsheet.
          passwordHash: NO_PASSWORD,
          mustChangePassword: true,
        },
      });
      return;
    }

    const target = u.existing;
    const data = {
      ...(u.name ? { name: u.name } : {}),
      ...(u.role ? { role: u.role } : {}),
      ...assignments,
    };

    await db.$transaction(async (tx) => {
      // Checked again, and this time under a lock: between the preview and here, the other super
      // admin this row was relying on may have been switched off by the row above it.
      if (target.isSuperAdmin && target.active && u.active === false) {
        await assertSuperAdminRemains(tx, target.id);
      }
      await tx.user.update({ where: { id: target.id }, data });
    });
  },
};
