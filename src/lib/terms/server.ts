import { cache } from "react";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/custom-fields/server";
import { DEFAULT_WORDING, resolveWording, type Wording } from "@/lib/terms/dictionary";

/**
 * The workspace's own words (Settings → Wording), once per request — the dashboard layout reads them
 * for the menu and hands them to the browser (WordingProvider); a page asking again gets the same read.
 * The app's words for a workspace still waiting for the migration (20261017100000_terminology), and
 * for any read that fails: a word is never worth a page that won't open.
 */
export const getWording = cache(async (): Promise<Wording> => {
  try {
    const row = await db.terminologySettings.findUnique({ where: { id: "global" }, select: { overrides: true } });
    return resolveWording(row?.overrides);
  } catch (err) {
    if (!notMigratedYet(err)) console.error("the workspace's wording could not be read", err);
    return DEFAULT_WORDING;
  }
});
