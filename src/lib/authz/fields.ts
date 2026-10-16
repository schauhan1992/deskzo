import { cache } from "react";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { resolveUserPermissions } from "@/lib/authz/resolve";
import { definitionsFor } from "@/lib/custom-fields/server";
import {
  closedPolicy,
  customFieldKey,
  customFieldKind,
  normalisePolicy,
  openPolicy,
  presentValue,
  SENSITIVE_FIELDS,
  visibility,
  type FieldContext,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type FieldVisibility,
  type SensitiveField,
} from "@/lib/authz/field-policy";

/**
 * Field access, resolved for one person — the server half of src/lib/authz/field-policy.ts, which
 * says what the four answers mean and the order they are decided in.
 *
 * Read once per request (React `cache`), as permissions and record levels are; outside a request (a
 * script, a check suite) nothing is memoised, so a change is seen by the next question. A workspace
 * whose database hasn't got the policy tables yet reads as having none stored — every field open.
 */

export type FieldSource =
  | { via: "superAdmin" }
  | { via: "inactive" }
  | { via: "userPolicy"; reason: string | null; expiresAt: Date | null }
  | { via: "rolePolicy"; role: string }
  | { via: "default" };

export type ResolvedField = { field: SensitiveField; policy: FieldPolicy; source: FieldSource };

export type ResolvedFieldPolicies = {
  userId: string;
  /** Field key → its policy and where it came from, for every field the entity has. */
  fields: Map<string, ResolvedField>;
  /** Whether anything is masked or restricted anywhere — false is the common case, and the fast path. */
  narrowed: boolean;
};

/** The sensitive fields of one record type: the built-in ones, then its live custom fields. */
export async function sensitiveFieldsOf(entity: FieldEntity): Promise<SensitiveField[]> {
  const builtIn = SENSITIVE_FIELDS.filter((f) => f.entity === entity);
  if (entity !== "leads") return builtIn;
  const defs = await definitionsFor("LEAD");
  const custom: SensitiveField[] = defs
    .filter((d) => !d.archived)
    .map((d) => ({
      entity,
      key: customFieldKey(d.key),
      label: d.label,
      description: d.restricted ? "A restricted custom field — also needs “See restricted fields”." : "A custom field on leads.",
      kind: customFieldKind(d.type),
    }));
  return [...builtIn, ...custom];
}

type StoredPolicy = { field: string; view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null };

async function storedPolicies(userId: string, role: string, entity: FieldEntity) {
  try {
    const [personal, forRole] = await Promise.all([
      db.userFieldPolicy.findMany({
        where: { userId, entity, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true, reason: true, expiresAt: true },
      }),
      db.roleFieldPolicy.findMany({
        where: { role, entity },
        select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true },
      }),
    ]);
    return { personal, forRole };
  } catch (err) {
    if (notMigratedYet(err)) return { personal: [], forRole: [] };
    throw err;
  }
}

const resolveEntity = cache(async (userId: string, entity: FieldEntity): Promise<ResolvedFieldPolicies> => {
  const fields = new Map<string, ResolvedField>();
  const [list, resolved] = await Promise.all([sensitiveFieldsOf(entity), resolveUserPermissions(userId)]);

  const everything = (policy: (kind: FieldKind) => FieldPolicy, source: FieldSource) => {
    for (const field of list) fields.set(field.key, { field, policy: policy(field.kind), source });
  };

  // Rules 1 and 2, from the same facts the permission resolver used — including that the Automation
  // account and a switched-off role reach nothing.
  if (resolved.isSuperAdmin) {
    everything(openPolicy, { via: "superAdmin" });
    return { userId, fields, narrowed: false };
  }
  if (!resolved.active || !resolved.role) {
    everything(closedPolicy, { via: "inactive" });
    return { userId, fields, narrowed: true };
  }

  const { personal, forRole } = await storedPolicies(userId, resolved.role, entity);
  const mine = new Map(personal.map((r) => [r.field, r]));
  const roles = new Map<string, StoredPolicy>(forRole.map((r) => [r.field, r]));
  let narrowed = false;
  for (const field of list) {
    const own = mine.get(field.key);
    const fromRole = roles.get(field.key);
    const entry: ResolvedField = own
      ? { field, policy: normalisePolicy(field.kind, own), source: { via: "userPolicy", reason: own.reason, expiresAt: own.expiresAt } }
      : fromRole
        ? { field, policy: normalisePolicy(field.kind, fromRole), source: { via: "rolePolicy", role: resolved.role } }
        : { field, policy: openPolicy(field.kind), source: { via: "default" } };
    if (!entry.policy.view || entry.policy.maskInList || entry.policy.maskInDetail) narrowed = true;
    fields.set(field.key, entry);
  }
  return { userId, fields, narrowed };
});

/** Every field of one record type for one person, with where each answer came from. */
export async function resolveFieldPolicies(userId: string, entity: FieldEntity = "leads"): Promise<ResolvedFieldPolicies> {
  return resolveEntity(userId, entity);
}

/** One field's policy for one person — open for a field the entity doesn't have. */
export async function fieldPolicy(userId: string, entity: FieldEntity, field: string): Promise<FieldPolicy> {
  const resolved = await resolveEntity(userId, entity);
  return resolved.fields.get(field)?.policy ?? openPolicy("text");
}

/**
 * What one person may see of a lead's fields, in one context — the masker every lead read path runs
 * its values through before they leave the server.
 *
 * `present(field, value)` returns the value as this person sees it there: as it is, masked, or the
 * word "Restricted". A field the registry doesn't know is passed through, so a read path can't fail
 * open by asking about a field that was renamed — every known field is listed in SENSITIVE_FIELDS.
 */
export type FieldMasker = {
  /** False when nothing is masked or restricted for this person here — the values go out as they are. */
  active: boolean;
  context: FieldContext;
  present(field: string, value: string | null | undefined): string | null;
  visibility(field: string): FieldVisibility;
  policy(field: string): FieldPolicy | null;
};

export async function leadMasker(userId: string, context: FieldContext): Promise<FieldMasker> {
  const resolved = await resolveEntity(userId, "leads");
  const policy = (field: string) => resolved.fields.get(field)?.policy ?? null;
  const active = resolved.narrowed && [...resolved.fields.values()].some((f) => visibility(f.policy, context) !== "clear");
  return {
    active,
    context,
    policy,
    visibility: (field) => {
      const p = policy(field);
      return p ? visibility(p, context) : "clear";
    },
    present: (field, value) => {
      if (!active) return value ?? null;
      const p = policy(field);
      return p ? presentValue(value, p, context) : (value ?? null);
    },
  };
}

/**
 * A lead's custom field values with the person's field access applied: a restricted field is left out
 * altogether, a masked one masked. `values` is already trimmed to the fields they may see at all
 * (`fields.seeRestricted`); this narrows it further, never widens it.
 */
export function maskCustomValues<V extends Record<string, unknown>>(masker: FieldMasker, values: V): V {
  if (!masker.active) return values;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = customFieldKey(key);
    const seen = masker.visibility(field);
    if (seen === "restricted") continue;
    if (seen === "masked") {
      if (Array.isArray(value)) out[key] = value.map((v) => masker.present(field, typeof v === "string" ? v : String(v)));
      else if (value === null || value === undefined || value === "") out[key] = value;
      else out[key] = masker.present(field, typeof value === "string" ? value : String(value));
      continue;
    }
    out[key] = value;
  }
  return out as V;
}
