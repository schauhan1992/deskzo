"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { ApiKeyRefused, createApiKey } from "@/lib/api/keys";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Developers & API (owner, 17 Oct 2026): keys for the public API (src/lib/api), made by
 * whoever holds "Make API keys" and acting as them. Each person sees and revokes their own; whoever
 * looks after security ("Change the security and DLP policy") sees every key in the workspace and may
 * revoke any. Never while viewing as somebody: a key made then would act as them.
 */

export type ApiKeyRow = {
  id: string;
  name: string;
  keyId: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  owner: { id: string; name: string };
  mine: boolean;
};

const EXPIRY_DAYS = [30, 90, 180, 365] as const;

async function maker() {
  const user = await requireUser();
  return (await can(user.id, "api.manage")) ? user : null;
}

/**
 * Who may look after keys: their makers, their own; and whoever manages security, everybody's — whether or not they
 * make keys themselves, so an admin can always see and revoke a key that shouldn't be there (security review, 23 Oct 2026).
 */
async function keeper(): Promise<{ user: Awaited<ReturnType<typeof requireUser>>; everyone: boolean } | null> {
  const user = await requireUser();
  const [makes, everyone] = await Promise.all([can(user.id, "api.manage"), can(user.id, "security.manage")]);
  return makes || everyone ? { user, everyone } : null;
}

export async function listApiKeys(): Promise<{ keys: ApiKeyRow[]; everyone: boolean } | null> {
  const keeping = await keeper();
  if (!keeping) return null;
  const { user, everyone } = keeping;
  const rows = await db.apiKey.findMany({
    where: everyone ? {} : { userId: user.id },
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    take: 200,
    select: { id: true, name: true, keyId: true, scopes: true, createdAt: true, lastUsedAt: true, lastUsedIp: true, useCount: true, expiresAt: true, revokedAt: true, user: { select: { id: true, name: true } } },
  });
  return {
    everyone,
    keys: rows.map(({ user: owner, ...k }) => ({
      ...k,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      owner,
      mine: owner.id === user.id,
    })),
  };
}

/** A new key acting as the person making it — its token shown this once, never again. */
export async function makeApiKey(input: { name: string; scopes: string[]; expiresInDays: number | null }): Promise<ActionResult<{ token: string; keyId: string }>> {
  const user = await maker();
  if (!user) return { ok: false, error: "You can't make API keys." };
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const days = input?.expiresInDays === null || input?.expiresInDays === undefined ? null : Number(input.expiresInDays);
  if (days !== null && !(EXPIRY_DAYS as readonly number[]).includes(days)) return { ok: false, error: "Choose when the key expires from the list." };
  try {
    const made = await createApiKey(user.id, { name: String(input?.name ?? ""), scopes: Array.isArray(input?.scopes) ? input.scopes.map(String) : [], expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000) });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "ApiKey", entityId: made.id, entityLabel: `API key “${String(input.name).trim()}” (${made.keyId})` });
    revalidatePath("/settings/developers");
    return { ok: true, data: { token: made.token, keyId: made.keyId } };
  } catch (err) {
    if (err instanceof ApiKeyRefused) return { ok: false, error: err.message };
    throw err;
  }
}

/** A key stopped at once — the maker's own, or any, for whoever looks after security. Never deleted: its record stays. */
export async function revokeApiKey(id: string): Promise<ActionResult<null>> {
  const keeping = await keeper();
  if (!keeping) return { ok: false, error: "You can't manage API keys." };
  const { user, everyone } = keeping;
  const key = await db.apiKey.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true, keyId: true, userId: true, revokedAt: true } });
  if (!key || (key.userId !== user.id && !everyone)) return { ok: false, error: "That key isn't there any more." };
  if (!key.revokedAt) {
    await db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date(), revokedById: user.id } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ApiKey", entityId: key.id, entityLabel: `API key “${key.name}” (${key.keyId}) revoked` });
  }
  revalidatePath("/settings/developers");
  return { ok: true, data: null };
}
