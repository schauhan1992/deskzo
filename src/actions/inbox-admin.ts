"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/actions/company";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { inboxSettings } from "@/lib/inbox/server";
import { INBOX_LIMITS, channelSettings, checkChannelSettings, type InboxKind } from "@/lib/inbox/settings";

/**
 * Settings › Customer inbox (src/app/(dashboard)/settings/inbox): the website bubbles and WhatsApp
 * numbers conversations come in on, what each one's bot says, and the workspace's WhatsApp credentials
 * and webhook. "Change the workspace's settings", like the rest of Settings; every change is in the
 * audit trail, and no secret is ever handed back to the page.
 */

const NOT_ALLOWED = "You can't change the workspace's settings.";

async function settingsUser(): Promise<{ id: string } | string> {
  const user = await requireModuleUser("inbox");
  const refused = await refuseWhileViewingAs();
  if (refused) return refused;
  if (!(await can(user.id, "settings.manage"))) return NOT_ALLOWED;
  return user;
}

function refresh() {
  revalidatePath("/settings/inbox");
  revalidatePath("/inbox");
}

export type ChannelInput = {
  id?: string | null;
  kind: InboxKind;
  name: string;
  settings: unknown;
  phoneNumberId?: string | null;
  displayPhone?: string | null;
  ownerUserId?: string | null;
};

/** A website bubble or a WhatsApp number, new or changed. */
export async function saveInboxChannel(input: ChannelInput): Promise<ActionResult<{ id: string }>> {
  const user = await settingsUser();
  if (typeof user === "string") return { ok: false, error: user };
  const kind = input?.kind === "WHATSAPP" ? "WHATSAPP" : input?.kind === "WEB" ? "WEB" : null;
  if (!kind) return { ok: false, error: "Choose a website or a WhatsApp number." };
  const name = String(input?.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > INBOX_LIMITS.channelName) return { ok: false, error: `Name it, in under ${INBOX_LIMITS.channelName} characters.` };
  const checked = checkChannelSettings(input?.settings, kind);
  if (!checked.ok) return { ok: false, error: checked.error };

  const existing = input?.id ? await db.inboxChannel.findUnique({ where: { id: String(input.id) } }) : null;
  if (input?.id && (!existing || existing.kind !== kind)) return { ok: false, error: "That channel isn't there any more." };

  let whatsapp: { phoneNumberId: string; displayPhone: string | null; ownerUserId: string | null } | null = null;
  if (kind === "WHATSAPP") {
    const phoneNumberId = String(input?.phoneNumberId ?? "").trim();
    if (!/^\d{6,30}$/.test(phoneNumberId)) return { ok: false, error: "Give the phone number ID from Meta (WhatsApp › API setup) — digits only." };
    const clash = await db.inboxChannel.findFirst({ where: { phoneNumberId, ...(existing ? { id: { not: existing.id } } : {}) }, select: { name: true } });
    if (clash) return { ok: false, error: `That number is already in the inbox, as “${clash.name}”.` };
    const ownerUserId = input?.ownerUserId ? String(input.ownerUserId) : null;
    if (ownerUserId) {
      const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { active: true } });
      if (!owner?.active || !(await can(ownerUserId, "inbox.view"))) return { ok: false, error: "A rep's own number needs somebody who may answer customer conversations." };
    }
    whatsapp = { phoneNumberId, displayPhone: String(input?.displayPhone ?? "").trim().slice(0, 30) || null, ownerUserId };
  }

  // Deskzo AI's answers are charged as whoever switched them on: kept while they stay on, never taken from the form.
  const settings = checked.settings;
  if (settings.bot.ai.on) {
    const before = existing ? channelSettings(existing.settings, kind) : null;
    settings.bot.ai.chargedTo = before?.bot.ai.on && before.bot.ai.chargedTo ? before.bot.ai.chargedTo : user.id;
  } else {
    settings.bot.ai.chargedTo = null;
  }
  const data = { name, settings: settings as object, ...(whatsapp ?? {}) };
  const row = existing
    ? await db.inboxChannel.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.inboxChannel.create({ data: { ...data, kind, createdById: user.id, ...(kind === "WEB" ? { publicKey: randomBytes(12).toString("base64url") } : {}) }, select: { id: true } });
  await recordAudit({ userId: user.id, action: existing ? "UPDATE" : "CREATE", entityType: "InboxChannel", entityId: row.id, entityLabel: `Customer inbox: ${name}` });
  refresh();
  return { ok: true, data: { id: row.id } };
}

/** Switches a channel off — its bubble disappears, its number stops coming in — or back on. */
export async function setInboxChannelActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const user = await settingsUser();
  if (typeof user === "string") return { ok: false, error: user };
  const row = await db.inboxChannel.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!row) return { ok: false, error: "That channel isn't there any more." };
  await db.inboxChannel.update({ where: { id: row.id }, data: { active: active === true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InboxChannel", entityId: row.id, entityLabel: `Customer inbox: ${row.name} ${active ? "switched on" : "switched off"}` });
  refresh();
  return { ok: true, data: null };
}

/** Removes a channel nobody has written on yet. One with conversations is switched off instead, so none is lost. */
export async function deleteInboxChannel(id: string): Promise<ActionResult<null>> {
  const user = await settingsUser();
  if (typeof user === "string") return { ok: false, error: user };
  const row = await db.inboxChannel.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true, _count: { select: { conversations: true } } } });
  if (!row) return { ok: false, error: "That channel isn't there any more." };
  if (row._count.conversations > 0) return { ok: false, error: "It has conversations, so switch it off instead — they stay in the inbox." };
  await db.inboxChannel.delete({ where: { id: row.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "InboxChannel", entityId: row.id, entityLabel: `Customer inbox: ${row.name}` });
  refresh();
  return { ok: true, data: null };
}

/**
 * The workspace's WhatsApp for the inbox: the access token and the Meta app's secret (each kept only
 * when given — a blank keeps what's there, `clear` removes it) and the language templates go in.
 */
export async function saveInboxWhatsApp(input: { accessToken?: string; appSecret?: string; language?: string; clear?: ("accessToken" | "appSecret")[] }): Promise<ActionResult<null>> {
  const user = await settingsUser();
  if (typeof user === "string") return { ok: false, error: user };
  const token = String(input?.accessToken ?? "").trim();
  const secret = String(input?.appSecret ?? "").trim();
  const language = String(input?.language ?? "").trim();
  if (token && (token.length < 20 || token.length > 1000 || /\s/.test(token))) return { ok: false, error: "That doesn't look like a Meta access token." };
  if (secret && !/^[0-9a-f]{16,128}$/i.test(secret)) return { ok: false, error: "The app secret is letters a–f and digits, from the Meta app's Basic settings." };
  if (language && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) return { ok: false, error: "Give the template language as Meta does: en, en_GB, hi…" };
  await inboxSettings();
  const clear = Array.isArray(input?.clear) ? input.clear : [];
  await db.inboxSettings.update({
    where: { id: "global" },
    data: {
      updatedById: user.id,
      ...(language ? { whatsappLanguage: language } : {}),
      ...(token ? { whatsappTokenCipher: await encryptSecret(token) } : clear.includes("accessToken") ? { whatsappTokenCipher: null } : {}),
      ...(secret ? { whatsappAppSecretCipher: await encryptSecret(secret) } : clear.includes("appSecret") ? { whatsappAppSecretCipher: null } : {}),
    },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InboxSettings", entityId: "global", entityLabel: "Customer inbox: WhatsApp credentials" });
  refresh();
  return { ok: true, data: null };
}

/** A new verify token for Meta's webhook check — the old one stops matching at once. */
export async function newInboxVerifyToken(): Promise<ActionResult<{ token: string }>> {
  const user = await settingsUser();
  if (typeof user === "string") return { ok: false, error: user };
  await inboxSettings();
  const token = randomBytes(18).toString("base64url");
  await db.inboxSettings.update({ where: { id: "global" }, data: { whatsappVerifyToken: token, updatedById: user.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InboxSettings", entityId: "global", entityLabel: "Customer inbox: new webhook verify token" });
  refresh();
  return { ok: true, data: { token } };
}
