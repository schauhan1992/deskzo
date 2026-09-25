"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { visibleProjectsWhere } from "@/lib/projects/visibility";
import type { ActionResult } from "@/actions/company";

/**
 * Credentials a customer has handed us, or that we hold on their behalf.
 *
 * ## Three separate protections, because one is not enough
 *
 *   1. **Encrypted at rest.** AES-256-GCM via `encryptSecret`, under the workspace's data key. This is
 *      the same mechanism the e-invoice credentials use.
 *   2. **The viewer's own password.** Revealing requires re-entering it. A walk-up on an unlocked
 *      laptop, or a stolen session cookie, is then not enough to harvest a customer's passwords.
 *   3. **Every reveal is recorded and the project manager is told.** The record is a row, not just
 *      an audit line, so the credential screen itself can answer "who has seen this" — which is the
 *      question actually asked when deciding what to rotate after somebody leaves.
 *
 * ## What none of this protects against
 *
 * Somebody with access to the running server has the platform key, and therefore has every secret in
 * this table. That is worth being plain about: this defeats a database dump, a stolen backup and a
 * curious colleague. It is not a vault, and a customer's bank or registrar credentials still belong
 * in one.
 *
 * ## The rule the whole file exists to keep
 *
 * `secretCipher` is never selected by anything except `revealCredential`. Not in the list, not in
 * the detail page, not in an export. A secret that is on the page in a masked field has already
 * left the building — the mask is HTML, and the value is in the response.
 */

async function credentialAccess(projectId: string, userId: string) {
  const [viewAll, mayUse, mayManage] = await Promise.all([
    hasEffectivePermission(userId, "projects.viewAll"),
    hasEffectivePermission(userId, "projects.credentials"),
    hasEffectivePermission(userId, "projects.manage"),
  ]);

  // Seeing the project is a precondition, not a substitute: being a stakeholder does not by itself
  // entitle somebody to the customer's passwords.
  const project = await db.project.findFirst({
    where: { AND: [{ id: projectId }, visibleProjectsWhere(userId, viewAll)] },
    select: { id: true, code: true, name: true, managerId: true },
  });

  return { project, mayUse, mayManage };
}

export type CredentialSummary = {
  id: string;
  label: string;
  username: string | null;
  url: string | null;
  note: string | null;
  expiresAt: Date | null;
  rotatedAt: Date | null;
  createdAt: Date;
  /** Who has opened it, most recent first — the rotation question, answered in place. */
  reveals: { userName: string; at: Date }[];
};

/**
 * The credentials on a project, without any of the secrets.
 *
 * Note what is absent from the select. That absence is the feature.
 */
export async function listCredentials(projectId: string): Promise<ActionResult<CredentialSummary[]>> {
  const user = await requireUser();
  const { project, mayUse } = await credentialAccess(projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!mayUse) return { ok: false, error: "You can't see stored credentials." };

  const rows = await db.projectCredential.findMany({
    where: { projectId },
    orderBy: { label: "asc" },
    select: {
      id: true,
      label: true,
      username: true,
      url: true,
      note: true,
      expiresAt: true,
      rotatedAt: true,
      createdAt: true,
      reveals: {
        orderBy: { at: "desc" },
        take: 5,
        select: { at: true, user: { select: { name: true } } },
      },
    },
  });

  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      label: r.label,
      username: r.username,
      url: r.url,
      note: r.note,
      expiresAt: r.expiresAt,
      rotatedAt: r.rotatedAt,
      createdAt: r.createdAt,
      reveals: r.reveals.map((v) => ({ userName: v.user.name, at: v.at })),
    })),
  };
}

export async function saveCredential(input: {
  id?: string;
  projectId: string;
  label: string;
  username?: string;
  url?: string;
  note?: string;
  /** Left blank on an edit to keep the stored secret rather than blanking it. */
  secret?: string;
  expiresAt?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  /**
   * On an edit, the row's own project decides who may write it — not the one the caller sent.
   *
   * The check ran against `input.projectId` and the write ran against `input.id`, so a stakeholder
   * on project A could pass A's id alongside a credential id belonging to project B and overwrite
   * another customer's stored password. The two must name the same project.
   */
  const existing = input.id
    ? await db.projectCredential.findUnique({ where: { id: input.id }, select: { id: true, projectId: true } })
    : null;
  if (input.id && !existing) return { ok: false, error: "That credential no longer exists." };

  const owningProjectId = existing?.projectId ?? input.projectId;
  const { project, mayManage } = await credentialAccess(owningProjectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!mayManage) return { ok: false, error: "You can't store credentials." };

  const label = input.label.trim();
  if (!label) return { ok: false, error: "Give it a name, so somebody can tell what it opens." };

  const secret = input.secret?.trim();
  if (!input.id && !secret) return { ok: false, error: "Enter the password or key to store." };

  const common = {
    label,
    username: input.username?.trim() || null,
    url: input.url?.trim() || null,
    note: input.note?.trim() || null,
    expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T00:00:00.000Z`) : null,
    // A new secret is a rotation, and dating it is what makes "last changed in 2023" visible.
    ...(secret ? { secretCipher: await encryptSecret(secret), rotatedAt: new Date() } : {}),
  };

  const saved = input.id
    ? await db.projectCredential.update({ where: { id: input.id }, data: common, select: { id: true } })
    : await db.projectCredential.create({
        data: { ...common, secretCipher: await encryptSecret(secret!), projectId: input.projectId, createdById: user.id },
        select: { id: true },
      });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "ProjectCredential",
    entityId: saved.id,
    entityLabel: `${label} on ${project.code}${secret && input.id ? " (secret changed)" : ""}`,
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, data: saved };
}

/**
 * Show somebody a stored secret.
 *
 * The only path that reads `secretCipher`, and it costs the caller their password every time.
 * Deliberately not cached or remembered for a session: the friction is the point, and a "don't ask
 * again for an hour" is exactly the hole this is meant to close.
 */
export async function revealCredential(
  credentialId: string,
  password: string,
): Promise<ActionResult<{ secret: string }>> {
  const user = await requireUser();

  const credential = await db.projectCredential.findUnique({
    where: { id: credentialId },
    select: { id: true, label: true, projectId: true, secretCipher: true },
  });
  if (!credential) return { ok: false, error: "That credential no longer exists." };

  const { project, mayUse } = await credentialAccess(credential.projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!mayUse) return { ok: false, error: "You can't see stored credentials." };

  const account = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!account?.passwordHash) return { ok: false, error: "This account has no password set." };
  if (!password || !(await bcrypt.compare(password, account.passwordHash))) {
    // A failed attempt is recorded too. Somebody guessing at a colleague's password in front of a
    // credential store is the exact thing this is here to make visible.
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "ProjectCredential",
      entityId: credential.id,
      entityLabel: `Failed reveal of ${credential.label} on ${project.code} — wrong password`,
    });
    return { ok: false, error: "That password isn't right." };
  }

  let secret: string;
  try {
    secret = await decryptSecret(credential.secretCipher);
  } catch {
    // A key that has changed since the secret was stored. Saying so is more useful than a crash,
    // because the fix is to re-enter it rather than to debug anything.
    return { ok: false, error: "This secret can't be decrypted — the workspace's keys have changed since it was stored. Re-enter it." };
  }

  await db.credentialReveal.create({ data: { credentialId: credential.id, userId: user.id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ProjectCredential",
    entityId: credential.id,
    entityLabel: `Revealed ${credential.label} on ${project.code}`,
  });

  // The manager hears about everybody except themselves. Telling somebody about their own action
  // trains them to ignore the notification, which is the one outcome that makes this useless.
  if (project.managerId && project.managerId !== user.id) {
    await notifyUser({
      userId: project.managerId,
      type: "PROJECT_CREDENTIAL_VIEWED",
      title: `${user.name} opened a credential on ${project.code}`,
      message: `${credential.label} — ${project.name}`,
      link: `/projects/${project.id}`,
    });
  }

  revalidatePath(`/projects/${credential.projectId}`);
  return { ok: true, data: { secret } };
}

export async function deleteCredential(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const credential = await db.projectCredential.findUnique({
    where: { id },
    select: { id: true, label: true, projectId: true },
  });
  if (!credential) return { ok: false, error: "That credential no longer exists." };

  const { project, mayManage } = await credentialAccess(credential.projectId, user.id);
  if (!project) return { ok: false, error: "That project doesn't exist, or you're not on it." };
  if (!mayManage) return { ok: false, error: "You can't remove credentials." };

  await db.projectCredential.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "ProjectCredential",
    entityId: id,
    entityLabel: `${credential.label} on ${project.code}`,
  });

  revalidatePath(`/projects/${credential.projectId}`);
  return { ok: true, data: null };
}
