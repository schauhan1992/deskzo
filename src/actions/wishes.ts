"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { markWishesSeen, sendWish, wishesFor, type WishOccasion, type WishSent } from "@/lib/hr/wishes";
import type { ActionResult } from "@/actions/company";

/**
 * Wishes on a colleague's birthday or work anniversary (src/lib/hr/wishes.ts). They ride on the HR
 * module, as the occasions do: no employee records, no birthdays, nothing to wish.
 */

/** Wishes the person whose occasion this is. Once: a second click answers "already". */
export async function sendWishAction(occasionKey: string): Promise<ActionResult<WishSent>> {
  const user = await requireModuleUser("hr");
  // A wish signed with somebody else's name is exactly what "View as" must never send.
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (typeof occasionKey !== "string" || occasionKey.length > 200) return { ok: false, error: "Unknown occasion." };
  return sendWish(user.id, occasionKey);
}

/** The signed-in person's own occasions today and their wishes — what the corner card polls. */
export async function myWishesToday(): Promise<WishOccasion[]> {
  const user = await requireModuleUser("hr");
  return wishesFor(user.id);
}

/**
 * The card was closed: these occasions' wishes are seen. Not while viewing as somebody, so an admin
 * looking round their account doesn't mark their wishes read before they have seen them.
 */
export async function markWishesSeenAction(occasionKeys: string[]): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  if (await viewAsContext()) return { ok: true, data: null };
  if (!Array.isArray(occasionKeys) || occasionKeys.length > 4) return { ok: false, error: "Unknown occasion." };
  await markWishesSeen(user.id, occasionKeys.filter((k): k is string => typeof k === "string"));
  return { ok: true, data: null };
}
