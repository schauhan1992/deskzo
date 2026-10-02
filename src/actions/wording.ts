"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { OrderStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { getWording } from "@/lib/terms/server";
import {
  DEFAULT_TERMS,
  ORDER_STATUS_DEFAULTS,
  ORDER_STATUSES,
  TERM_KEYS,
  WORD_LIMIT,
  checkWord,
  type TermKey,
  type Wording,
  type WordingOverrides,
} from "@/lib/terms/dictionary";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Wording (owner, 2 Oct 2026): the workspace's own words for the app's nouns and its own
 * names for an order's statuses (src/lib/terms). `settings.manage`, like the branding it sits beside —
 * it is how the app reads to everybody in the workspace.
 *
 * Only what differs from the app's word is stored, so a word set back to the app's is the app's again
 * and renders exactly as it always did.
 */

async function manager() {
  const user = await requireUser();
  return (await can(user.id, "settings.manage")) ? user : null;
}

/** The workspace's words as the settings screen edits them. */
export async function wordingForManage(): Promise<Wording | null> {
  if (!(await manager())) return null;
  return getWording();
}

const word = z.string().trim().max(WORD_LIMIT, `Keep each word to ${WORD_LIMIT} characters.`);
const wordingSchema = z.object({
  terms: z.record(z.string(), z.object({ one: word, many: word, a: z.enum(["a", "an"]) })),
  orderStatus: z.record(z.string(), word),
});

/** Saves every word on the screen; what matches the app's word is not stored. */
export async function saveWording(input: unknown): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change the workspace's wording." };
  const parsed = wordingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the words." };

  const overrides: Required<WordingOverrides> = { terms: {}, orderStatus: {} };
  const changed: string[] = [];
  for (const key of TERM_KEYS) {
    const t = parsed.data.terms[key];
    if (!t) continue;
    const name = DEFAULT_TERMS[key].one.toLowerCase();
    const problem = checkWord(`the word for a ${name}`, t.one) ?? checkWord(`the word for ${DEFAULT_TERMS[key].many.toLowerCase()}`, t.many);
    if (problem) return { ok: false, error: problem };
    const d = DEFAULT_TERMS[key];
    if (t.one === d.one && t.many === d.many && t.a === d.a) continue;
    overrides.terms[key as TermKey] = { one: t.one, many: t.many, a: t.a };
    changed.push(`${d.one} → ${t.one}`);
  }
  for (const status of ORDER_STATUSES) {
    const label = parsed.data.orderStatus[status];
    if (label === undefined) continue;
    const problem = checkWord(`the name for ${ORDER_STATUS_DEFAULTS[status].toLowerCase()}`, label);
    if (problem) return { ok: false, error: problem };
    if (label === ORDER_STATUS_DEFAULTS[status]) continue;
    overrides.orderStatus[status as OrderStatus] = label;
    changed.push(`${ORDER_STATUS_DEFAULTS[status]} → ${label}`);
  }

  await db.terminologySettings.upsert({
    where: { id: "global" },
    create: { id: "global", overrides, updatedById: user.id },
    update: { overrides, updatedById: user.id },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TerminologySettings",
    entityId: "global",
    entityLabel: changed.length ? `Wording — ${changed.join(", ")}` : "Wording — back to the app's own words",
  });
  // Every page's menu reads it.
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
