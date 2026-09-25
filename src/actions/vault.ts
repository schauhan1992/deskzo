"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import type { CredentialTagKind, VaultAccessLevel, VaultField, VaultOwnership } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { decryptSecret, digestSecret, encryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { purgeExpiredArchive } from "@/lib/vault/archive";
import {
  ARCHIVE_RETENTION_DAYS,
  EXPIRY_NOTICE_WINDOW_DAYS,
  daysLeftInArchive,
  daysUntilExpiry,
  entitlementFor,
  isExpiringSoon,
  reuseCounts,
  rotationState,
  shouldTellOwner,
  visibleCredentialsWhere,
} from "@/lib/vault/policy";
import type { ActionResult } from "@/actions/company";

/**
 * The company's own logins — registrars, hosting panels, partner portals, tax accounts.
 *
 * ## The rule the whole file exists to keep
 *
 * `secretCipher` and `recoveryKeyCipher` are read by exactly one function, `revealSecret`, and it
 * costs the caller their own password every time. No list, no detail query, no export selects
 * them. A secret that reaches the browser in a masked field has already left the building — the
 * mask is HTML and the value is in the response.
 *
 * ## Admins can read everything, and the owner is told every time
 *
 * That combination was a deliberate choice. Full admin visibility without notification is a vault
 * whose real security ceiling is "trust every admin, forever, silently". Telling the owner does not
 * prevent the access — nothing could, short of removing the override — but it converts it into
 * something reviewable, which is the difference between a vault and a filing cabinet.
 *
 * The admin route is checked *last* in `entitlementFor`, so it is only ever recorded when nothing
 * else entitled them. An admin opening a credential shared with them is a share, not an override,
 * and the owner is not told twice.
 */

async function viewer(userId: string) {
  const [row, isAdmin] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { departmentId: true } }),
    hasEffectivePermission(userId, "vault.viewAll"),
  ]);
  return { id: userId, departmentId: row?.departmentId ?? null, isAdmin };
}

export type VaultRow = {
  id: string;
  loginName: string;
  category: string | null;
  accessType: string | null;
  username: string | null;
  email: string | null;
  loginUrl: string | null;
  phone: string | null;
  remarks: string | null;
  hasRecoveryKey: boolean;
  billingExpiry: Date | null;
  daysToExpiry: number | null;
  passwordChangedAt: Date | null;
  rotateAfterDays: number | null;
  rotation: ReturnType<typeof rotationState>;
  /** How many other records this person can see hold the same password. */
  reusedOn: number;
  owner: { id: string; name: string; photoUpdatedAt: Date | null };
  /** Ours, or held on a client's behalf. */
  ownership: VaultOwnership;
  /** Which client, where one was named. */
  company: { id: string; name: string } | null;
  mine: boolean;
  canManage: boolean;
  /**
   * Deliberately narrower than `canManage`, and computed here rather than guessed at in the
   * component: a shared co-owner rotating a password is routine, a shared co-owner destroying the
   * only copy of it is not. The button and `deleteCredential` have to agree about who may, and the
   * only way to guarantee that is to decide it once.
   */
  canDelete: boolean;
  /** Only ever `ADMIN` on somebody else's record — shown so nobody uses the override unawares. */
  via: string;
  /**
   * Who it is shared with. A person carries their id and photo stamp so the list can show faces
   * rather than a comma-separated sentence; a department carries neither, because it is not one
   * person and pretending otherwise with an avatar would be a lie about who can open this.
   */
  shares: {
    id: string;
    name: string;
    kind: "user" | "department";
    userId: string | null;
    photoUpdatedAt: Date | null;
    level: VaultAccessLevel;
    expiresAt: Date | null;
  }[];
  /** The five most recent openings. The full trail is its own query — see `credentialTrail`. */
  lastOpened: { userId: string; userName: string; photoUpdatedAt: Date | null; at: Date; via: string }[];
  /** Every opening ever recorded, so the card can say so without fetching them all. */
  openedCount: number;
  /** This viewer’s own pin. Nobody else can see it. */
  pinned: boolean;
  /** Within the expiry window, which floats it above everything else for everybody. */
  expiringSoon: boolean;
};

/**
 * Everything this person may see.
 *
 * One query, composing `visibleCredentialsWhere`. Entitlement is then resolved per row from the
 * shares that came back with it, rather than by asking the database again — the list and the
 * reveal must agree about who is entitled to what, and the only way to guarantee that is for both
 * to call `entitlementFor`.
 */
/**
 * What a list row needs, and nothing more.
 *
 * Named once because the page is assembled from two queries and they must select identically —
 * two drifting copies would produce rows whose shape depended on whether they were pinned.
 * `secretCipher` and `recoveryKeyCipher`s value are absent by construction: only the presence of a
 * recovery key is read, and the password is not selected at all.
 */
const VAULT_SELECT = {
  id: true, loginName: true, username: true, email: true, loginUrl: true, phone: true,
  remarks: true, billingExpiry: true, passwordChangedAt: true, rotateAfterDays: true,
  ownerId: true, secretDigest: true,
  ownership: true,
  company: { select: { id: true, name: true } },
  recoveryKeyCipher: true,
  category: { select: { name: true } },
  accessType: { select: { name: true } },
  owner: { select: { id: true, name: true, photoUpdatedAt: true } },
  shares: {
    select: {
      id: true, userId: true, departmentId: true, level: true, expiresAt: true,
      user: { select: { id: true, name: true, photoUpdatedAt: true } },
      department: { select: { name: true } },
    },
  },
  reveals: {
    orderBy: { at: "desc" as const },
    take: 5,
    select: { at: true, via: true, user: { select: { id: true, name: true, photoUpdatedAt: true } } },
  },
  _count: { select: { reveals: true } },
} satisfies Prisma.VaultCredentialSelect;

export type VaultPage = {
  rows: VaultRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** How many of the total are pinned, so the page can say why they are at the top. */
  pinnedCount: number;
  /** And how many are there because their billing is about to lapse. */
  expiringCount: number;
};

export async function listVault(filters?: {
  q?: string;
  categoryId?: string;
  ownerId?: string;
  ownership?: VaultOwnership;
  companyId?: string;
  mineOnly?: boolean;
  page?: number;
  pageSize?: number;
}): Promise<ActionResult<VaultPage>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.use"))) {
    return { ok: false, error: "You don't have access to the credential vault." };
  }
  const me = await viewer(user.id);
  const now = new Date();

  const where: Prisma.VaultCredentialWhereInput = {
    AND: [
      filters?.mineOnly ? { ownerId: user.id } : visibleCredentialsWhere(me.id, me.departmentId, me.isAdmin),
      ...(filters?.categoryId ? [{ categoryId: filters.categoryId }] : []),
      ...(filters?.ownerId ? [{ ownerId: filters.ownerId }] : []),
      ...(filters?.ownership ? [{ ownership: filters.ownership }] : []),
      ...(filters?.companyId ? [{ companyId: filters.companyId }] : []),
      /**
       * Everything visible on the card, not only the four columns the record is keyed on.
       *
       * It used to search the login name, username, address and URL alone. Somebody typing a
       * colleague’s name, or "hosting", or the phone number the code goes to — all of which are
       * printed on the card in front of them — got nothing back and reasonably concluded the box
       * was broken. A search that does not look where the reader is looking is indistinguishable
       * from one that does not work.
       */
      ...(filters?.q
        ? [
            {
              OR: [
                { loginName: { contains: filters.q, mode: "insensitive" as const } },
                { username: { contains: filters.q, mode: "insensitive" as const } },
                { email: { contains: filters.q, mode: "insensitive" as const } },
                { loginUrl: { contains: filters.q, mode: "insensitive" as const } },
                { phone: { contains: filters.q, mode: "insensitive" as const } },
                { remarks: { contains: filters.q, mode: "insensitive" as const } },
                { category: { name: { contains: filters.q, mode: "insensitive" as const } } },
                { accessType: { name: { contains: filters.q, mode: "insensitive" as const } } },
                { owner: { name: { contains: filters.q, mode: "insensitive" as const } } },
                { owner: { email: { contains: filters.q, mode: "insensitive" as const } } },
                { company: { name: { contains: filters.q, mode: "insensitive" as const } } },
              ],
            },
          ]
        : []),
    ],
  };

  // Clamped against nonsense, not against taste: zero or a negative would page forever, and a
  // caller asking for two rows has a reason. The ceiling is what stops a crafted query asking for
  // every record at once.
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters?.pageSize ?? 25) || 25));
  const page = Math.max(1, Math.floor(filters?.page ?? 1));
  const skip = (page - 1) * pageSize;

  /**
   * Three blocks, paged as one list.
   *
   * Expiring first — for everybody, because a subscription about to lapse is the company's
   * problem and not a matter of taste. Then this person's pins. Then the rest, alphabetically.
   *
   * Two things this shape is defending against, both of which were live bugs:
   *
   * Ordering by a relation count — which is all Prisma can express — counts *everybody's* pins,
   * so a record three colleagues pinned would float to the top of a list belonging to somebody
   * who had pinned nothing. A pin is one person's shortlist.
   *
   * And sorting a page after fetching it floats rows to the top of whatever page they landed on,
   * which leaves an expiring credential stranded on page four — the one place nobody looks. So
   * the window is taken across the blocks in order, spilling from one into the next.
   */
  const expiryCutoff = new Date(now.getTime() + EXPIRY_NOTICE_WINDOW_DAYS * 86400000);
  const expiring: Prisma.VaultCredentialWhereInput = { billingExpiry: { not: null, lte: expiryCutoff } };

  const pinnedIds = (
    await db.vaultPin.findMany({ where: { userId: me.id }, select: { credentialId: true } })
  ).map((row) => row.credentialId);

  /**
   * Each block excludes the ones above it, so nothing appears twice. An expiring record that is
   * also pinned belongs in the expiring block, and must not come back in the pinned one — a row
   * counted twice is a page that overlaps the next.
   */
  const blocks: { where: Prisma.VaultCredentialWhereInput; orderBy: Prisma.VaultCredentialOrderByWithRelationInput }[] = [
    { where: { AND: [where, expiring] }, orderBy: { billingExpiry: "asc" } },
    {
      where: { AND: [where, { NOT: expiring }, { id: { in: pinnedIds } }] },
      orderBy: { loginName: "asc" },
    },
    {
      where: { AND: [where, { NOT: expiring }, { id: { notIn: pinnedIds } }] },
      orderBy: { loginName: "asc" },
    },
  ];

  const counts = await Promise.all(blocks.map((b) => db.vaultCredential.count({ where: b.where })));
  const total = counts.reduce((sum, n) => sum + n, 0);

  const rows: Prisma.VaultCredentialGetPayload<{ select: typeof VAULT_SELECT }>[] = [];
  let remaining = pageSize;
  let cursor = skip;

  for (const [i, block] of blocks.entries()) {
    if (remaining === 0) break;
    const size = counts[i]!;
    if (cursor >= size) {
      // This whole block sits before the window. Step over it, carrying the offset on.
      cursor -= size;
      continue;
    }
    const take = Math.min(remaining, size - cursor);
    rows.push(
      ...(await db.vaultCredential.findMany({
        where: block.where,
        orderBy: block.orderBy,
        skip: cursor,
        take,
        select: VAULT_SELECT,
      })),
    );
    remaining -= take;
    cursor = 0;
  }

  const pinnedOnPage = new Set(pinnedIds);
  const expiringCount = counts[0]!;
  const pinnedCount = counts[1]!;
  const reuse = reuseCounts(rows.map((r) => ({ id: r.id, secretDigest: r.secretDigest })));

  return {
    ok: true,
    data: toPlain({
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      pinnedCount,
      expiringCount,
      rows: rows.map((r) => {
        const ent = entitlementFor({ ownerId: r.ownerId, shares: r.shares }, me, now);
        return {
          id: r.id,
          loginName: r.loginName,
          category: r.category?.name ?? null,
          accessType: r.accessType?.name ?? null,
          username: r.username,
          email: r.email,
          loginUrl: r.loginUrl,
          phone: r.phone,
          remarks: r.remarks,
          hasRecoveryKey: r.recoveryKeyCipher !== null,
          billingExpiry: r.billingExpiry,
          daysToExpiry: daysUntilExpiry(r.billingExpiry, now),
          passwordChangedAt: r.passwordChangedAt,
          rotateAfterDays: r.rotateAfterDays,
          rotation: rotationState(r, now),
          reusedOn: reuse.get(r.id) ?? 0,
          owner: r.owner,
          ownership: r.ownership,
          company: r.company,
          mine: r.ownerId === me.id,
          canManage: ent?.level === "MANAGE",
          canDelete: r.ownerId === me.id || me.isAdmin,
          via: ent?.via ?? "NONE",
          shares: r.shares.map((s) => ({
            id: s.id,
            name: s.user?.name ?? s.department?.name ?? "Unknown",
            kind: (s.userId ? "user" : "department") as "user" | "department",
            userId: s.user?.id ?? null,
            photoUpdatedAt: s.user?.photoUpdatedAt ?? null,
            level: s.level,
            expiresAt: s.expiresAt,
          })),
          lastOpened: r.reveals.map((v) => ({
            userId: v.user.id,
            userName: v.user.name,
            photoUpdatedAt: v.user.photoUpdatedAt,
            at: v.at,
            via: v.via,
          })),
          openedCount: r._count.reveals,
          pinned: pinnedOnPage.has(r.id),
          expiringSoon: isExpiringSoon(r.billingExpiry, now),
        };
      }),
    }),
  };
}

export type TrailEntry = {
  id: string;
  userId: string;
  userName: string;
  photoUpdatedAt: Date | null;
  at: Date;
  via: string;
  field: string;
};

/** Capped, because a record opened daily for three years is a scroll, not an answer. */
const TRAIL_LIMIT = 200;

/**
 * Who has opened this, and when.
 *
 * The reveal log is the vault's whole accountability story: an admin override cannot be prevented,
 * only recorded, and a record nobody can read is not a record. So the trail is visible to everyone
 * entitled to the credential — the owner most of all — rather than to admins alone.
 *
 * Entitlement is resolved here from the row's own shares rather than taken on trust from the id in
 * the request. Knowing a credential's id must never be the same as being allowed to see who has
 * been reading it: that list names colleagues and their habits, and it leaks something even when
 * the secret does not.
 *
 * Reading the trail is not itself a reveal. No secret is decrypted, so nothing is logged and the
 * owner is not notified — otherwise checking who opened your password would notify you that you
 * had checked.
 */
export async function credentialTrail(id: string): Promise<ActionResult<TrailEntry[]>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.use"))) {
    return { ok: false, error: "You don't have access to the credential vault." };
  }

  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: null },
    select: {
      ownerId: true,
      shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } },
    },
  });
  // The same refusal for a record that does not exist and one they may not see, so the id cannot
  // be probed to find out which.
  if (!credential) return { ok: false, error: "That credential isn't available to you." };

  const me = await viewer(user.id);
  if (!entitlementFor(credential, me, new Date())) {
    return { ok: false, error: "That credential isn't available to you." };
  }

  const reveals = await db.vaultReveal.findMany({
    where: { credentialId: id },
    orderBy: { at: "desc" },
    take: TRAIL_LIMIT,
    select: {
      id: true,
      at: true,
      via: true,
      field: true,
      user: { select: { id: true, name: true, photoUpdatedAt: true } },
    },
  });

  return {
    ok: true,
    data: toPlain(
      reveals.map((r) => ({
        id: r.id,
        userId: r.user.id,
        userName: r.user.name,
        photoUpdatedAt: r.user.photoUpdatedAt,
        at: r.at,
        via: r.via,
        field: r.field,
      })),
    ),
  };
}

export async function saveCredential(input: {
  id?: string;
  loginName: string;
  categoryId?: string;
  accessTypeId?: string;
  username?: string;
  email?: string;
  loginUrl?: string;
  phone?: string;
  /** Blank on an edit keeps the stored secret rather than blanking it. */
  secret?: string;
  recoveryKey?: string;
  remarks?: string;
  billingExpiry?: string;
  rotateAfterDays?: number | null;
  ownership?: VaultOwnership;
  /** Which client, when it is theirs. Ignored — and cleared — when the record is ours. */
  companyId?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.use"))) {
    return { ok: false, error: "You don't have access to the credential vault." };
  }
  const loginName = input.loginName.trim();
  if (!loginName) return { ok: false, error: "Give it a name, so somebody can tell what it opens." };

  const me = await viewer(user.id);
  const now = new Date();

  const ownership: VaultOwnership = input.ownership ?? "OURS";

  const common = {
    loginName,
    ownership,
    /**
     * Cleared when the record is ours.
     *
     * Somebody flipping a client's login back to "ours" and leaving the company attached would
     * leave a record that reads as ours on the card and still turns up under that client's filter
     * — and the filter is the thing anybody would trust when asked what a departing customer
     * still has access to.
     */
    companyId: ownership === "CLIENT" ? input.companyId || null : null,
    categoryId: input.categoryId || null,
    accessTypeId: input.accessTypeId || null,
    username: input.username?.trim() || null,
    email: input.email?.trim() || null,
    loginUrl: input.loginUrl?.trim() || null,
    phone: input.phone?.trim() || null,
    remarks: input.remarks?.trim() || null,
    billingExpiry: input.billingExpiry ? new Date(`${input.billingExpiry}T00:00:00.000Z`) : null,
    rotateAfterDays: input.rotateAfterDays ?? null,
  };

  const secret = input.secret?.trim();
  const recovery = input.recoveryKey?.trim();

  if (!input.id) {
    if (!secret) return { ok: false, error: "Enter the password to store." };
    const created = await db.vaultCredential.create({
      data: {
        ...common,
        secretCipher: await encryptSecret(secret),
        secretDigest: await digestSecret(secret),
        recoveryKeyCipher: recovery ? await encryptSecret(recovery) : null,
        passwordChangedAt: now,
        ownerId: user.id,
        createdById: user.id,
      },
      select: { id: true },
    });
    await recordAudit({
      userId: user.id, action: "CREATE", entityType: "VaultCredential",
      entityId: created.id, entityLabel: loginName,
    });
    revalidatePath("/vault");
    return { ok: true, data: created };
  }

  const existing = await db.vaultCredential.findFirst({
    where: { id: input.id, archivedAt: null },
    select: { id: true, ownerId: true, loginName: true, shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } } },
  });
  if (!existing) return { ok: false, error: "That record no longer exists." };

  const ent = entitlementFor(existing, me, now);
  if (ent?.level !== "MANAGE") return { ok: false, error: "You can open this, but not change it." };

  await db.vaultCredential.update({
    where: { id: input.id },
    data: {
      ...common,
      // A new secret is a rotation, and dating it is what makes "last changed" mean anything.
      ...(secret ? { secretCipher: await encryptSecret(secret), secretDigest: await digestSecret(secret), passwordChangedAt: now } : {}),
      ...(recovery ? { recoveryKeyCipher: await encryptSecret(recovery) } : {}),
    },
  });

  await recordAudit({
    userId: user.id, action: "UPDATE", entityType: "VaultCredential",
    entityId: input.id, entityLabel: `${loginName}${secret ? " (password changed)" : ""}`,
  });
  // The owner hears about somebody else rotating their record, because the next person to use the
  // old password will otherwise just find it broken.
  if (secret && existing.ownerId !== user.id) {
    await notifyUser({
      userId: existing.ownerId,
      type: "VAULT_CREDENTIAL_OPENED",
      title: `${user.name} changed the password on ${loginName}`,
      link: "/vault",
    });
  }
  revalidatePath("/vault");
  return { ok: true, data: { id: input.id } };
}

/**
 * Show somebody a stored secret.
 *
 * The only function in the application that reads these two columns. Requires the viewer's own
 * password every time — deliberately not remembered for a session, because a "don't ask again for
 * an hour" is exactly the hole this closes.
 */
export async function revealSecret(
  id: string,
  password: string,
  field: VaultField = "PASSWORD",
): Promise<ActionResult<{ secret: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.use"))) {
    return { ok: false, error: "You don't have access to the credential vault." };
  }

  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: null },
    select: {
      id: true, loginName: true, ownerId: true, secretCipher: true, recoveryKeyCipher: true,
      shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } },
    },
  });
  if (!credential) return { ok: false, error: "That record no longer exists." };

  const me = await viewer(user.id);
  const ent = entitlementFor(credential, me, new Date());
  // The same answer for "not entitled" as for "does not exist" would be better, but the record was
  // already found by id — somebody probing ids learns nothing they did not supply.
  if (!ent) return { ok: false, error: "That record isn't shared with you." };

  const account = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!account?.passwordHash) return { ok: false, error: "This account has no password set." };
  if (!password || !(await bcrypt.compare(password, account.passwordHash))) {
    await recordAudit({
      userId: user.id, action: "UPDATE", entityType: "VaultCredential", entityId: credential.id,
      entityLabel: `Failed open of ${credential.loginName} — wrong password`,
    });
    return { ok: false, error: "That password isn't right." };
  }

  const cipher = field === "RECOVERY_KEY" ? credential.recoveryKeyCipher : credential.secretCipher;
  if (!cipher) return { ok: false, error: "No recovery key is stored on this record." };

  let secret: string;
  try {
    secret = await decryptSecret(cipher);
  } catch {
    return { ok: false, error: "This can't be decrypted — the workspace's keys have changed since it was stored. Re-enter it." };
  }

  await db.vaultReveal.create({ data: { credentialId: credential.id, userId: user.id, via: ent.via, field } });
  await recordAudit({
    userId: user.id, action: "UPDATE", entityType: "VaultCredential", entityId: credential.id,
    entityLabel: `Opened ${field === "RECOVERY_KEY" ? "recovery key" : "password"} for ${credential.loginName} (${ent.via.toLowerCase()})`,
  });

  if (shouldTellOwner(ent.via)) {
    await notifyUser({
      userId: credential.ownerId,
      type: "VAULT_CREDENTIAL_OPENED",
      title: `${user.name} opened ${credential.loginName}`,
      message:
        ent.via === "ADMIN"
          ? "Using their admin override — they aren't shared on this record."
          : `${field === "RECOVERY_KEY" ? "Recovery key" : "Password"}, via ${ent.via.toLowerCase()} access.`,
      link: "/vault",
    });
  }

  revalidatePath("/vault");
  return { ok: true, data: { secret } };
}

/**
 * Deleting archives. Nothing on this screen destroys a secret outright.
 *
 * A stored password is the one thing here that an accidental delete cannot be undone by asking
 * somebody what it was — the plaintext existed nowhere else, and `secretCipher` is the only copy.
 * So the record is set aside for `ARCHIVE_RETENTION_DAYS` and destroyed after that, which keeps the
 * archive from quietly becoming a second vault nobody looks at or audits.
 *
 * Who may is unchanged and deliberately narrower than managing: the owner, or an admin. A shared
 * co-owner rotating a password is routine; a shared co-owner making it disappear is not.
 */
export async function deleteCredential(id: string, reason?: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: null },
    select: { id: true, loginName: true, ownerId: true, shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } } },
  });
  if (!credential) return { ok: false, error: "That record no longer exists." };

  const me = await viewer(user.id);
  const ent = entitlementFor(credential, me, new Date());
  if (credential.ownerId !== user.id && !me.isAdmin) {
    return { ok: false, error: ent ? "Only the owner can delete this." : "That record isn't shared with you." };
  }

  await db.vaultCredential.update({
    where: { id },
    data: { archivedAt: new Date(), archivedById: user.id, archiveReason: reason?.trim() || null },
  });

  /**
   * Recorded as a delete, not as an edit.
   *
   * Whoever reads the audit trail is asking what happened to the record, and "archived" is an
   * implementation detail of how this system honours a delete. Softening the word in the log would
   * hide the event behind the mechanism.
   */
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "VaultCredential",
    entityId: id,
    entityLabel: credential.loginName,
  });

  // The owner hears about it when somebody else did it. Their password vanishing from a list with
  // no explanation is how people stop trusting the vault.
  if (credential.ownerId !== user.id) {
    await notifyUser({
      userId: credential.ownerId,
      type: "SECURITY_ALERT",
      title: "A stored login of yours was deleted",
      message: `${credential.loginName} — moved to the archive. It can be restored for ${ARCHIVE_RETENTION_DAYS} days.`,
      link: "/vault",
    });
  }

  revalidatePath("/vault");
  return { ok: true, data: null };
}

export type ArchivedRow = {
  id: string;
  loginName: string;
  category: string | null;
  ownerName: string;
  archivedAt: Date;
  archivedByName: string | null;
  archiveReason: string | null;
  /** Negative once the retention period has run out and it is waiting to be swept. */
  daysLeft: number;
};

/**
 * The archive, for the people who can restore from it.
 *
 * Admins only, and gated on `vault.viewAll` rather than on ownership: a deleted record has no live
 * entitlement to check, and the person most likely to need one back is whoever is clearing up after
 * somebody who has left. Nothing here decrypts anything — the archive lists what was deleted, and
 * restoring is what makes it readable again, through the ordinary reveal path.
 */
export async function listArchivedVault(): Promise<ActionResult<ArchivedRow[]>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.viewAll"))) {
    return { ok: false, error: "Only an administrator can see the vault's archive." };
  }

  await purgeExpiredArchive();

  const now = new Date();
  const rows = await db.vaultCredential.findMany({
    where: { archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    select: {
      id: true,
      loginName: true,
      archivedAt: true,
      archiveReason: true,
      category: { select: { name: true } },
      owner: { select: { name: true } },
      archivedBy: { select: { name: true } },
    },
  });

  return {
    ok: true,
    data: toPlain(
      rows.map((r) => ({
        id: r.id,
        loginName: r.loginName,
        category: r.category?.name ?? null,
        ownerName: r.owner.name,
        archivedAt: r.archivedAt!,
        archivedByName: r.archivedBy?.name ?? null,
        archiveReason: r.archiveReason,
        daysLeft: daysLeftInArchive(r.archivedAt!, now),
      })),
    ),
  };
}

/**
 * Puts one back.
 *
 * It returns to its previous owner with its shares intact, because a restore that silently changed
 * who could open a password would be a worse surprise than the delete was. If the owner has since
 * left, the record comes back on their name and the handover screen is where it is moved on from —
 * one mechanism for reassigning ownership rather than two.
 */
export async function restoreCredential(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.viewAll"))) {
    return { ok: false, error: "Only an administrator can restore from the vault's archive." };
  }

  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: { not: null } },
    select: { id: true, loginName: true, ownerId: true },
  });
  if (!credential) return { ok: false, error: "That record isn't in the archive." };

  await db.vaultCredential.update({
    where: { id },
    data: { archivedAt: null, archivedById: null, archiveReason: null },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "VaultCredential",
    entityId: id,
    entityLabel: `Restored ${credential.loginName}`,
  });

  await notifyUser({
    userId: credential.ownerId,
    type: "SECURITY_ALERT",
    title: "A stored login of yours was restored",
    message: `${credential.loginName} is back in the vault.`,
    link: "/vault",
  });

  revalidatePath("/vault");
  return { ok: true, data: null };
}

/**
 * Destroys one now rather than waiting out the retention.
 *
 * Separate from `deleteCredential` and worded differently everywhere it appears, because they are
 * genuinely different acts: one is reversible for two months and the other is not reversible at
 * all. Collapsing them into a single "delete" with a flag is how somebody ends up doing the second
 * while believing they did the first.
 */
export async function destroyArchivedCredential(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.viewAll"))) {
    return { ok: false, error: "Only an administrator can empty the vault's archive." };
  }

  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: { not: null } },
    select: { id: true, loginName: true },
  });
  if (!credential) return { ok: false, error: "That record isn't in the archive." };

  await db.vaultCredential.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "VaultCredential",
    entityId: id,
    entityLabel: `Destroyed ${credential.loginName}`,
  });

  revalidatePath("/vault");
  return { ok: true, data: null };
}

/**
 * Pin or unpin, for this person only.
 *
 * Entitlement is checked even though a pin discloses nothing: the row it points at is the thing
 * that would be disclosed, and allowing a pin on a record somebody cannot see makes the pin table
 * a way to ask "does this id exist" one call at a time. The refusal is the same either way.
 *
 * Not audited. A pin is a preference about a list, not access to anything, and an audit trail
 * that fills up with them is one nobody reads when it matters.
 */
export async function setCredentialPin(id: string, pinned: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.use"))) {
    return { ok: false, error: "You don't have access to the credential vault." };
  }

  const credential = await db.vaultCredential.findFirst({
    where: { id, archivedAt: null },
    select: {
      ownerId: true,
      shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } },
    },
  });
  if (!credential) return { ok: false, error: "That credential isn't available to you." };

  const me = await viewer(user.id);
  if (!entitlementFor(credential, me, new Date())) {
    return { ok: false, error: "That credential isn't available to you." };
  }

  if (pinned) {
    // Upsert rather than create: pinning something already pinned is a double click, not an error.
    await db.vaultPin.upsert({
      where: { userId_credentialId: { userId: user.id, credentialId: id } },
      create: { userId: user.id, credentialId: id },
      update: {},
    });
  } else {
    await db.vaultPin.deleteMany({ where: { userId: user.id, credentialId: id } });
  }

  revalidatePath("/vault");
  return { ok: true, data: null };
}

// ─── Sharing ────────────────────────────────────────────────────────────────────────────────────

/**
 * Lends a record to somebody, or to a team.
 *
 * Only whoever may manage it — which is the owner, an existing MANAGE share, or an admin. Sharing
 * is the one operation that widens who can read a secret, so the person doing it has to already be
 * trusted with the record rather than merely able to see it.
 */
export async function shareCredential(input: {
  credentialId: string;
  userId?: string;
  departmentId?: string;
  level: VaultAccessLevel;
  expiresAt?: string;
}): Promise<ActionResult<null>> {
  const user = await requireUser();
  const credential = await db.vaultCredential.findFirst({
    where: { id: input.credentialId, archivedAt: null },
    select: {
      id: true,
      loginName: true,
      ownerId: true,
      shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } },
    },
  });
  if (!credential) return { ok: false, error: "That record no longer exists." };

  const me = await viewer(user.id);
  const ent = entitlementFor(credential, me, new Date());
  if (ent?.level !== "MANAGE") return { ok: false, error: "You can't share this record." };
  if (!input.userId && !input.departmentId) return { ok: false, error: "Choose a person or a department." };
  if (input.userId && input.departmentId) return { ok: false, error: "One or the other, not both." };
  if (input.userId === credential.ownerId) return { ok: false, error: "They already own it." };

  try {
    await db.vaultShare.create({
      data: {
        credentialId: input.credentialId,
        userId: input.userId || null,
        departmentId: input.departmentId || null,
        level: input.level,
        // A share that lapses on its own is access nobody has to remember to take away.
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        sharedById: user.id,
      },
    });
  } catch {
    // The unique index on (credential, person) doing its job. Sharing something twice is not an
    // error worth a stack trace.
    return { ok: false, error: "It's already shared with them." };
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "VaultCredential",
    entityId: credential.id,
    entityLabel: `Shared ${credential.loginName}`,
  });

  // The person it was shared with is told, because a password appearing in their vault with no
  // explanation is not a gift, it is a puzzle.
  if (input.userId) {
    await notifyUser({
      userId: input.userId,
      type: "VAULT_SHARED",
      title: "A stored login was shared with you",
      message: credential.loginName,
      link: "/vault",
    });
  }

  revalidatePath("/vault");
  return { ok: true, data: null };
}

/**
 * Takes a share back.
 *
 * Checked against the credential the share belongs to rather than against the share itself: the
 * question is who may change access to this record, and a share id on its own answers nothing.
 */
export async function unshareCredential(shareId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const share = await db.vaultShare.findUnique({
    where: { id: shareId },
    select: {
      id: true,
      credential: {
        select: {
          id: true,
          loginName: true,
          ownerId: true,
          archivedAt: true,
          shares: { select: { userId: true, departmentId: true, level: true, expiresAt: true } },
        },
      },
    },
  });
  if (!share || share.credential.archivedAt) return { ok: false, error: "That share no longer exists." };

  const me = await viewer(user.id);
  const ent = entitlementFor(share.credential, me, new Date());
  if (ent?.level !== "MANAGE") return { ok: false, error: "You can't change who this is shared with." };

  await db.vaultShare.delete({ where: { id: shareId } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "VaultCredential",
    entityId: share.credential.id,
    entityLabel: `Unshared ${share.credential.loginName}`,
  });

  revalidatePath("/vault");
  return { ok: true, data: null };
}

// ─── Options and tags ───────────────────────────────────────────────────────────────────────────

export async function vaultOptions() {
  await requireUser();
  const [tags, users, departments, companies] = await Promise.all([
    db.credentialTag.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      // The address and the photo stamp, because the picker matches on one and draws the other.
      select: { id: true, name: true, email: true, photoUpdatedAt: true },
    }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    /**
     * Customers, for naming whose login a client credential is.
     * Not every company — a vendor or a competitor is not somebody whose password we would be
     * holding, and a picker of five hundred names is one nobody finds anything in.
     */
    db.company.findMany({
      where: { stage: "CUSTOMER" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return toPlain({
    categories: tags.filter((t) => t.kind === "CATEGORY"),
    accessTypes: tags.filter((t) => t.kind === "ACCESS_TYPE"),
    users,
    departments,
    companies,
  });
}

/** Both lists for the settings screen. Inactive ones included there and nowhere else. */
export async function listCredentialTags(includeInactive = false) {
  await requireUser();
  return toPlain(
    await db.credentialTag.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
  );
}

export async function saveCredentialTag(input: {
  id?: string;
  kind: CredentialTagKind;
  name: string;
  active?: boolean;
  sortOrder?: number;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.manageTags"))) {
    return { ok: false, error: "You can't change the vault's categories." };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give it a name." };

  const data = {
    kind: input.kind,
    name,
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  };

  const row = input.id
    ? await db.credentialTag.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.credentialTag.create({ data, select: { id: true } });

  revalidatePath("/settings");
  revalidatePath("/vault");
  return { ok: true, data: { id: row.id } };
}

export async function deleteCredentialTag(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "vault.manageTags"))) {
    return { ok: false, error: "You can't change the vault's categories." };
  }
  const inUse = await db.vaultCredential.count({ where: { OR: [{ categoryId: id }, { accessTypeId: id }] } });
  if (inUse > 0) return { ok: false, error: `${inUse} record(s) use this. Make it inactive instead.` };
  await db.credentialTag.delete({ where: { id } });
  revalidatePath("/settings");
  return { ok: true, data: null };
}
