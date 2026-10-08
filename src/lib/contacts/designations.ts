import type { ContactDesignation, Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { designationFromTitle } from "@/lib/lead-capture/intake";

/**
 * Contact designations from the workspace's own list (owner, 8 Oct 2026): picked as a contact is saved,
 * or typed and added then and there; renamed, retyped and merged in Settings › Lists.
 *
 * Each designation has a type — one of the eight the fixed list had — and a contact keeps that type in
 * its own `designation`, which is what lead scoring, assignment rules and campaign filters read. So a
 * contact's type always follows its designation's: set together here, and moved together when a
 * designation is retyped or merged.
 *
 * `designationId` is in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts): read by name.
 */

type Client = Prisma.TransactionClient | PrismaClient;

/** The designations a workspace starts with — the seven of the fixed list, each its own type. */
export const STARTER_DESIGNATIONS: { id: string; name: string; kind: ContactDesignation }[] = [
  { id: "des-it-manager", name: "IT Manager", kind: "IT_MANAGER" },
  { id: "des-purchase-manager", name: "Purchase Manager", kind: "PURCHASE_MANAGER" },
  { id: "des-it-head", name: "IT Head", kind: "IT_HEAD" },
  { id: "des-director", name: "Director", kind: "DIRECTOR" },
  { id: "des-ceo", name: "CEO", kind: "CEO" },
  { id: "des-cio", name: "CIO", kind: "CIO" },
  { id: "des-hr", name: "HR", kind: "HR" },
];

/** A name as it is kept: trimmed, single-spaced, at most 80 characters. */
export function cleanDesignationName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The designation of this name, whatever its capitals — or null. */
export function findDesignation(client: Client, name: string) {
  return client.designation.findFirst({ where: { name: { equals: cleanDesignationName(name), mode: "insensitive" } }, select: { id: true, name: true, kind: true } });
}

/**
 * The designation a typed name means: the one already on the list, else a new one, its type guessed
 * from the words ("Network Engineer" → IT manager, "VP Sales" → director, anything else → other) and
 * changeable in Settings. Two people adding the same new name at once both end up with one row.
 */
export async function resolveDesignation(client: Client, name: string): Promise<{ id: string; kind: ContactDesignation }> {
  const clean = cleanDesignationName(name);
  const found = await findDesignation(client, clean);
  if (found) return found;
  try {
    return await client.designation.create({ data: { name: clean, kind: designationFromTitle(clean) }, select: { id: true, kind: true } });
  } catch {
    // The unique index on lower(name): somebody added it a moment ago.
    const again = await findDesignation(client, clean);
    if (again) return again;
    throw new Error(`Couldn't add the designation "${clean}".`);
  }
}

/**
 * What a contact's save writes for its designation. A name sent (even blank) is the list's: blank
 * clears it. Without one — an import, a web form, an older screen — only the type was given, and the
 * starter designation of that type is taken, so the contact still reads as before.
 */
export async function designationData(
  client: Client,
  input: { designationName?: string | null; designation?: ContactDesignation | null },
): Promise<{ designationId: string | null; designation: ContactDesignation } | null> {
  if (input.designationName !== undefined && input.designationName !== null) {
    if (!cleanDesignationName(input.designationName)) return { designationId: null, designation: "OTHER" };
    const d = await resolveDesignation(client, input.designationName);
    return { designationId: d.id, designation: d.kind };
  }
  if (!input.designation) return null;
  const starter = STARTER_DESIGNATIONS.find((s) => s.kind === input.designation);
  const exists = starter ? await client.designation.findUnique({ where: { id: starter.id }, select: { id: true } }) : null;
  return { designationId: exists?.id ?? null, designation: input.designation };
}

/** The list, for a picker: names in order. */
export async function designationNames(): Promise<string[]> {
  try {
    const rows = await db.designation.findMany({ select: { name: true }, orderBy: { name: "asc" } });
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * Each contact's designation name, by contact id — for screens whose rows were read without it.
 * Empty where the column is not there yet: they then show the type.
 */
export async function designationNamesOf(contactIds: string[]): Promise<Record<string, string>> {
  if (contactIds.length === 0) return {};
  try {
    const rows = await db.contact.findMany({
      where: { id: { in: contactIds }, designationId: { not: null } },
      select: { id: true, designationRef: { select: { name: true } } },
    });
    return Object.fromEntries(rows.filter((r) => r.designationRef).map((r) => [r.id, r.designationRef!.name]));
  } catch {
    return {};
  }
}
