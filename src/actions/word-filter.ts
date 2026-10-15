"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { cleanWordList } from "@/lib/word-filter/match";
import type { FilterArea } from "@/lib/word-filter/server";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Word filter (owner, 15 Oct 2026): the words chat and tickets each keep out. Saved per area
 * by whoever may change the workspace's settings; the area's own module has to be on.
 */

const AREA_LABEL: Record<FilterArea, string> = { CHAT: "Chat", TICKETS: "Tickets" };

export async function saveWordFilter(
  area: FilterArea,
  input: { enabled: boolean; usePreset: boolean; words: string[]; allowed: string[] },
): Promise<ActionResult<{ words: string[]; allowed: string[] }>> {
  if (area !== "CHAT" && area !== "TICKETS") return { ok: false, error: "That isn't something the filter covers." };
  // Each area's own module: Chat for chat, the Helpdesk for tickets.
  const user = area === "CHAT" ? await requireModuleUser("chat") : await requireModuleUser("helpdesk");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the workspace's settings." };

  const words = cleanWordList(Array.isArray(input?.words) ? input.words.map(String) : []);
  if (!words.ok) return { ok: false, error: words.error };
  const allowed = cleanWordList(Array.isArray(input?.allowed) ? input.allowed.map(String) : []);
  if (!allowed.ok) return { ok: false, error: allowed.error };
  const data = { enabled: input?.enabled === true, usePreset: input?.usePreset !== false, words: words.words, allowed: allowed.words, updatedById: user.id };
  await db.wordFilter.upsert({ where: { area }, create: { area, ...data }, update: data });
  // What changed, never the words themselves.
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "WordFilter",
    entityId: area,
    entityLabel: `${AREA_LABEL[area]} word filter ${data.enabled ? "on" : "off"} · preset ${data.usePreset ? "on" : "off"} · ${data.words.length} own word(s) · ${data.allowed.length} let through`,
  });
  revalidatePath("/settings/word-filter");
  return { ok: true, data: { words: data.words, allowed: data.allowed } };
}
