import type { Prisma } from "@prisma/client";
import { definitionsFor, type StoredDefinition } from "@/lib/custom-fields/server";
import type { CustomFieldValues } from "@/lib/custom-fields/rules";
import { applyOutsideInput, outsideDefs, stillToFill, type OutsideEntity, type SkippedValue } from "@/lib/custom-fields/outside";

/**
 * The server half of src/lib/custom-fields/outside.ts: this workspace's definitions, and what a record
 * made from outside is created with.
 *
 * Nobody is signed in on these paths, so no person and no permission is consulted — the rules in
 * outside.ts allow only what anybody in the workspace could see. A workspace still waiting for the
 * migration has no definitions (`definitionsFor` reads none), so it is never asked to write a value.
 */

export type OutsideFields = {
  /** Spread into the record's `create` data — nothing at all when there is nothing to write. */
  data: { customFields?: Prisma.InputJsonValue };
  values: CustomFieldValues;
  skipped: SkippedValue[];
  /** The required fields still empty, by label (`stillToFill`). */
  missing: string[];
  /** Every definition for the record type, retired ones included. */
  defs: StoredDefinition[];
};

/** What a create writes for these values: nothing when there are none. */
export function createData(values: CustomFieldValues): { customFields?: Prisma.InputJsonValue } {
  return Object.keys(values).length > 0 ? { customFields: values as Prisma.InputJsonValue } : {};
}

/** The values a record made from outside starts with, what was set aside, and what is still to fill in. */
export async function customFieldsFromOutside(entity: OutsideEntity, input: unknown): Promise<OutsideFields> {
  const defs = await definitionsFor(entity);
  const { values, skipped } = applyOutsideInput(defs, input);
  return { data: createData(values), values, skipped, missing: stillToFill(defs, values), defs };
}

/** The definitions of the three record types an enquiry makes, retired ones included. */
export async function outsideDefinitions(): Promise<Record<OutsideEntity, StoredDefinition[]>> {
  const [LEAD, COMPANY, CONTACT] = await Promise.all([definitionsFor("LEAD"), definitionsFor("COMPANY"), definitionsFor("CONTACT")]);
  return { LEAD, COMPANY, CONTACT };
}

/** The fields a website or a form can fill, by record type, in their order. */
export async function fillableFields(): Promise<Record<OutsideEntity, StoredDefinition[]>> {
  const all = await outsideDefinitions();
  return { LEAD: outsideDefs(all.LEAD), COMPANY: outsideDefs(all.COMPANY), CONTACT: outsideDefs(all.CONTACT) };
}
