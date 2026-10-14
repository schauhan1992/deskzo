"use server";

import { requireUser } from "@/lib/session";
import { kindsForItemType, type HsnOption } from "@/lib/hsn";
import { knownHsnCodes, searchHsnDirectory } from "@/lib/platform/hsn-directory";
import { HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";

/**
 * The GST portal's HSN/SAC directory, for the item form and the document lines: a search, and what one
 * code is. Public facts, but asked only from signed-in forms; every input is bounded and every answer
 * capped (src/lib/platform/hsn-directory.ts).
 */

/** Codes matching what was typed — narrowed to goods or services when the item's type decides it. */
export async function searchHsnCodes(query: string, itemType?: string): Promise<HsnOption[]> {
  await requireUser();
  return searchHsnDirectory(String(query ?? ""), itemType ? kindsForItemType(itemType) : undefined);
}

export type HsnDescription =
  | { status: "found"; option: HsnOption }
  /** Well formed, but the portal doesn't list it. */
  | { status: "not-found"; code: string }
  /** Not 4, 6 or 8 digits — nothing to look up. */
  | { status: "invalid" }
  /** No directory to ask: the shape rules are all that apply. */
  | { status: "no-directory" };

/** What a code is, for the line under the field — or why there is nothing to say. */
export async function describeHsnCode(value: string): Promise<HsnDescription> {
  await requireUser();
  const code = normaliseHsn(String(value ?? "").slice(0, 20));
  if (!HSN_PATTERN.test(code)) return { status: "invalid" };
  const known = await knownHsnCodes([code]);
  if (!known.checked) return { status: "no-directory" };
  const option = known.found.get(code);
  return option ? { status: "found", option } : { status: "not-found", code };
}
