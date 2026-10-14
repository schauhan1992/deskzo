"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { isRetentionChoice } from "@/lib/chat/rules";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Chat: the workspace's rules for chat, and the super admin's one way into a chat they
 * aren't in — exporting it, which is recorded (src/app/api/chat/export).
 */

const settingsSchema = z.object({
  attachmentsViewOnly: z.boolean(),
  retentionDays: z.number().int().positive().nullable(),
});

/** Saves the workspace's chat rules. Needs "Change the workspace's settings". */
export async function saveChatSettings(input: z.infer<typeof settingsSchema>): Promise<ActionResult<null>> {
  const user = await requireModuleUser("chat");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the workspace's settings." };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success || !isRetentionChoice(parsed.data.retentionDays)) return { ok: false, error: "Pick one of the options offered." };
  const data = { ...parsed.data, updatedById: user.id };
  await db.chatSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ChatSettings", entityId: "global", entityLabel: "Chat settings" });
  revalidatePath("/settings/chat");
  revalidatePath("/chat");
  return { ok: true, data: null };
}

export type ExportableChat = { id: string; kind: "DIRECT" | "GROUP"; title: string; members: string[]; messageCount: number; lastMessageAt: string | null };

/**
 * The chats the super admin may export, found by a person's or a group's name — names, people and
 * counts only, never a word of what was said. Empty for anybody else.
 */
export async function findChatsToExport(query: string): Promise<ExportableChat[]> {
  const user = await requireModuleUser("chat");
  if (await refuseWhileViewingAs()) return [];
  const me = await db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true } });
  if (!me?.isSuperAdmin) return [];
  const q = query.replace(/\s+/g, " ").trim();
  if (q.length < 2) return [];
  const chats = await db.chat.findMany({
    where: {
      OR: [
        { kind: "GROUP", name: { contains: q, mode: "insensitive" } },
        { members: { some: { user: { name: { contains: q, mode: "insensitive" } } } } },
      ],
      lastMessageAt: { not: null },
    },
    select: {
      id: true,
      kind: true,
      name: true,
      lastMessageAt: true,
      members: { select: { user: { select: { name: true } } }, orderBy: { joinedAt: "asc" } },
      _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 25,
  });
  return chats.map((c) => {
    const members = c.members.map((m) => m.user.name);
    return {
      id: c.id,
      kind: c.kind,
      title: c.kind === "GROUP" ? c.name ?? "Group" : members.join(" and "),
      members,
      messageCount: c._count.messages,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    };
  });
}
