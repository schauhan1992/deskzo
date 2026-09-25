"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { digestSecret } from "@/lib/crypto";
import { newCredentials } from "@/lib/lead-capture/credentials";
import type { ActionResult } from "@/actions/company";

/**
 * API keys for the lead capture endpoint — one per website or form.
 *
 * The secret exists in exactly one place after `createCaptureKey` returns: the screen of the person
 * who made it. Only its digest is stored, so there is no "show secret" — a lost secret means
 * revoking the key and making another, which is also the right thing to do with a leaked one.
 */

async function requireAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

export async function listCaptureKeys() {
  if (!(await requireAdmin())) return [];
  const keys = await db.leadCaptureKey.findMany({
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      keyId: true,
      sourceLabel: true,
      active: true,
      lastUsedAt: true,
      useCount: true,
      createdAt: true,
      revokedAt: true,
      createdById: true,
      _count: { select: { leads: true } },
    },
  });
  const creators = await db.user.findMany({
    where: { id: { in: keys.map((k) => k.createdById).filter((v): v is string => !!v) } },
    select: { id: true, name: true },
  });
  return keys.map((k) => ({
    ...k,
    leads: k._count.leads,
    createdBy: creators.find((c) => c.id === k.createdById)?.name ?? null,
  }));
}

const createSchema = z.object({
  name: z.string().trim().min(2, "Name the website or form this key is for").max(80),
  sourceLabel: z.string().trim().max(120).optional().or(z.literal("")),
});

export async function createCaptureKey(input: unknown): Promise<ActionResult<{ keyId: string; secret: string }>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage API keys." };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { keyId, secret } = newCredentials();
  const key = await db.leadCaptureKey.create({
    data: {
      name: parsed.data.name,
      sourceLabel: parsed.data.sourceLabel || null,
      keyId,
      secretDigest: digestSecret(secret),
      createdById: user.id,
    },
    select: { id: true },
  });
  // The key's name, never its secret.
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "LeadCaptureKey", entityId: key.id, entityLabel: `API key “${parsed.data.name}”` });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: { keyId, secret } };
}

export async function revokeCaptureKey(id: string): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage API keys." };
  const key = await db.leadCaptureKey.findUnique({ where: { id }, select: { name: true, revokedAt: true } });
  if (!key) return { ok: false, error: "That key no longer exists." };
  if (key.revokedAt) return { ok: true, data: null };

  await db.leadCaptureKey.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadCaptureKey", entityId: id, entityLabel: `API key “${key.name}” revoked` });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: null };
}
