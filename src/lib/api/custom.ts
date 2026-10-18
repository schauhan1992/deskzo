import type { CustomFieldEntityKey } from "@/lib/custom-fields/rules";
import { fieldsFor, unsearchableByPolicy, valuesOf } from "@/lib/custom-fields/server";

/**
 * The workspace's own fields on records the API returns: only those the key's person sees — the
 * restricted ones only with "See restricted fields", and on leads only those their field access
 * shows them in the clear on a list, so a masked value is never handed out whole.
 */
export async function customFieldsOut(entity: CustomFieldEntityKey, userId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!ids.length) return out;
  const [fields, masked, values] = await Promise.all([fieldsFor(entity, userId), unsearchableByPolicy(entity, userId), valuesOf(entity, ids)]);
  const keys = fields.visible.map((d) => d.key).filter((k) => !masked.has(k));
  for (const id of ids) {
    const stored = values.get(id) ?? {};
    out.set(id, Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, (stored as Record<string, unknown>)[k]])));
  }
  return out;
}
