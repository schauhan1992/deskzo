"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";

/**
 * Setting and clearing a profile photo.
 *
 * Smaller cap than branding's 256KB, deliberately: a logo is uploaded once by one person, while
 * this is one image per employee rendered at 28 pixels in a header. 96KB is generous for that and
 * keeps the table from becoming the largest thing in the database by accident.
 */
const MAX_BYTES = 96 * 1024;

/**
 * No SVG, unlike branding.
 *
 * An SVG is a document that can carry script, and this one is uploaded by any employee and then
 * rendered on everybody else's screen — which is the shape of a stored cross-site scripting bug.
 * Branding can afford SVG because only a settings administrator can set it. A profile photo is a
 * photo; raster formats lose nothing here.
 */
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function refuse(err: unknown): ActionResult<never> {
  if (err instanceof AuthzError) return { ok: false, error: err.message };
  throw err;
}

/**
 * Whose photo the caller may change.
 *
 * Your own, always — it is your face. Somebody else's needs `users.manage`, because an admin
 * setting a colleague's photo to something unpleasant is a thing that happens in offices, and it
 * should at least be a permission and an audit row rather than a free action.
 */
async function mayEdit(targetUserId: string) {
  const session = await requireUser();
  if (targetUserId === session.id) return { actorId: session.id, allowed: true, self: true };
  const allowed = await can(session.id, "users.manage");
  return { actorId: session.id, allowed, self: false };
}

export async function setProfilePhoto(dataUrl: string, userId?: string): Promise<ActionResult<null>> {
  const targetId = userId ?? (await requireUser()).id;
  const { actorId, allowed, self } = await mayEdit(targetId);
  if (!allowed) return { ok: false, error: "You can't change somebody else's profile photo." };

  if (!self) {
    try {
      const actor = await actorContext(actorId);
      const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, isSuperAdmin: true } });
      if (!target) return { ok: false, error: "That user no longer exists." };
      assertMayActOnTarget(actor, target);
    } catch (err) {
      return refuse(err);
    }
  }

  const match = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return { ok: false, error: "That doesn't look like an image file." };

  const [, mimeType, base64] = match;
  if (!ALLOWED_TYPES.includes(mimeType!)) {
    return { ok: false, error: "Use a PNG, JPEG, WebP or GIF. SVG isn't accepted for profile photos." };
  }

  const byteSize = Math.floor((base64!.length * 3) / 4);
  if (byteSize > MAX_BYTES) {
    return {
      ok: false,
      error: `That image is ${Math.round(byteSize / 1024)}KB — keep it under ${MAX_BYTES / 1024}KB. Cropping it square first usually does it.`,
    };
  }

  const now = new Date();
  await db.$transaction([
    db.userPhoto.upsert({
      where: { userId: targetId },
      create: { userId: targetId, dataUrl, mimeType: mimeType!, byteSize },
      update: { dataUrl, mimeType: mimeType!, byteSize },
    }),
    // Written in the same transaction as the bytes: the column is what tells a list a photo exists
    // and what busts the browser cache, so the two drifting apart shows people a stale face or no
    // face at all.
    db.user.update({ where: { id: targetId }, data: { photoUpdatedAt: now } }),
  ]);

  if (!self) {
    const target = await db.user.findUnique({ where: { id: targetId }, select: { name: true } });
    await recordAudit({
      userId: actorId,
      action: "UPDATE",
      entityType: "User",
      entityId: targetId,
      entityLabel: `Set the profile photo for ${target?.name ?? targetId}`,
    });
  }

  revalidatePath("/profile");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

export async function removeProfilePhoto(userId?: string): Promise<ActionResult<null>> {
  const targetId = userId ?? (await requireUser()).id;
  const { actorId, allowed, self } = await mayEdit(targetId);
  if (!allowed) return { ok: false, error: "You can't change somebody else's profile photo." };

  await db.$transaction([
    db.userPhoto.deleteMany({ where: { userId: targetId } }),
    db.user.update({ where: { id: targetId }, data: { photoUpdatedAt: null } }),
  ]);

  if (!self) {
    const target = await db.user.findUnique({ where: { id: targetId }, select: { name: true } });
    await recordAudit({
      userId: actorId,
      action: "DELETE",
      entityType: "User",
      entityId: targetId,
      entityLabel: `Removed the profile photo for ${target?.name ?? targetId}`,
    });
  }

  revalidatePath("/profile");
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
