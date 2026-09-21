"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getPageLayoutDefinition, resolveLayout } from "@/lib/page-layouts";
import type { ActionResult } from "@/actions/company";

/**
 * Reading and writing where somebody has dragged the cards on a page.
 *
 * No permission check beyond being signed in, deliberately: a layout is a preference about your own
 * screen, not access to anything. What each card *contains* is gated where that card gets its data,
 * which is the only place it can be gated correctly — a person who may not see the cash balance has
 * no cash card to arrange.
 */

export async function getPageLayout(pageKey: string): Promise<string[]> {
  const user = await requireUser();
  if (!getPageLayoutDefinition(pageKey)) return [];

  const row = await db.pageLayout.findUnique({
    where: { user_page: { userId: user.id, pageKey } },
    select: { widgets: true },
  });
  return resolveLayout(pageKey, row?.widgets);
}

export async function setPageLayout(pageKey: string, widgets: string[]): Promise<ActionResult<null>> {
  const user = await requireUser();

  const def = getPageLayoutDefinition(pageKey);
  if (!def) return { ok: false, error: "Unknown page." };

  // Filtered through the registry rather than stored as sent, exactly as the table column
  // preferences are: a key that no longer exists would otherwise sit in the row forever, and a
  // hand-made request could fill the array with anything at all.
  const known = new Set(def.widgets.map((w) => w.key));
  const clean = widgets.filter((k) => known.has(k));

  await db.pageLayout.upsert({
    where: { user_page: { userId: user.id, pageKey } },
    update: { widgets: clean },
    create: { userId: user.id, pageKey, widgets: clean },
  });

  return { ok: true, data: null };
}

/** Deletes the row, which is what returns somebody to the order the page ships with. */
export async function resetPageLayout(pageKey: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  await db.pageLayout.deleteMany({ where: { userId: user.id, pageKey } });
  return { ok: true, data: null };
}
