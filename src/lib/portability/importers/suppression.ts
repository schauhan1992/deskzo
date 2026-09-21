import { SuppressionReason, SuppressionScope } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * The list of addresses, domains, contacts and companies nobody may be marketed to.
 *
 * ## This import is additive, and that is deliberate
 *
 * Everywhere else in the portability layer a record missing from the file means "no change". Here it
 * would mean somebody starts receiving mail again — and the consequence of that is a regulator or a
 * blocklist, not a wrong phone number. So a suppression absent from the file is never removed, and
 * an existing one is never weakened: a reason may be hardened, never softened. "Weakened" is judged
 * on both axes that matter rather than on one strength scale — see `weakening` below — because a
 * reason can block more mail while still making the row deletable, and deleting it is the step that
 * puts somebody back on a list. Taking somebody off this list stays a deliberate act on the
 * suppression page, one row at a time, with a person's name against it. An expiry is freely
 * editable, because a cooling-off period is exactly what that field is for.
 *
 * ## Matched on scope plus the normalised value
 *
 * `src/lib/marketing/pipeline.ts` matches a stored suppression by comparing its `value` against a
 * lowercased address, a lowercased domain, or a record id. Anything stored in another casing is a
 * suppression that does not suppress: it sits in the list looking like protection while the mail
 * goes out. So the value is lowercased here exactly as `addSuppression` lowercases it, and the match
 * is the `scope + value` unique.
 *
 * Because the match is the value itself, an existing row is almost always a skip — only Reason and
 * Expires can change. `Added` is the date somebody unsubscribed or bounced, which is worth carrying
 * in when a list is migrated from another system, so it is honoured on create and never on update:
 * rewriting it would move the evidence of when they asked us to stop.
 */

type ResolvedSuppression = {
  scope: SuppressionScope;
  value: string;
  reason?: SuppressionReason;
  addedAt?: Date;
  expiresAt?: Date;
  existing: { id: string; reason: SuppressionReason; expiresAt: Date | null } | null;
};

/**
 * The two that block a transactional message too, not only marketing. `suppressionReasons` in
 * src/lib/marketing/suppression.ts raises these for every message class; the other two are gated on
 * `marketing`.
 */
const BLOCKS_EVERYTHING: SuppressionReason[] = [SuppressionReason.HARD_BOUNCE, SuppressionReason.COMPLAINT];

/**
 * The two `removeSuppression` refuses to delete. They record the recipient's own decision, and
 * reversing that from an admin screen is not ours to do — so an import must not be able to turn one
 * into a row that *can* be deleted.
 */
const IRREVERSIBLE: SuppressionReason[] = [SuppressionReason.UNSUBSCRIBED, SuppressionReason.COMPLAINT];

/**
 * Why rewriting `from` to `to` would weaken the record, or null if it would not.
 *
 * Two independent things can be lost here, and a spreadsheet may take away neither: how much the row
 * blocks, and whether anybody can delete it afterwards. Ranking the four reasons on a single
 * strength scale gets the second one wrong — UNSUBSCRIBED → HARD_BOUNCE blocks strictly more mail,
 * yet it converts a row `removeSuppression` will not delete into one it will, so a file could
 * launder a customer's opt-out into a suppression somebody then removes by hand. Both axes are
 * checked, and losing either is refused.
 */
function weakening(from: SuppressionReason, to: SuppressionReason): string | null {
  if (BLOCKS_EVERYTHING.includes(from) && !BLOCKS_EVERYTHING.includes(to)) {
    return `${to} only stops marketing, so transactional mail to an address recorded as ${from} would start going out again`;
  }
  if (IRREVERSIBLE.includes(from) && !IRREVERSIBLE.includes(to)) {
    return `the suppression screen refuses to delete a ${from} row and will delete a ${to} one, so this would make their decision reversible by hand`;
  }
  return null;
}

/** Compared by the day, because a stored timestamp and a date cell are never equal to the second. */
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * What a value has to look like for the send path to ever find it.
 *
 * Checked only when a row would create a suppression. A row already in the list is a fact, however
 * odd it looks, and refusing to read back something we ourselves exported would turn a re-import
 * into a wall of errors over rows that need no action at all.
 */
async function unusableValue(scope: SuppressionScope, value: string): Promise<string | null> {
  if (scope === SuppressionScope.EMAIL && !value.includes("@")) {
    return `Value "${value}" isn't an email address. An EMAIL suppression is matched against a whole address; for everybody at a domain use the DOMAIN scope.`;
  }
  if (scope === SuppressionScope.DOMAIN && value.includes("@")) {
    return `Value "${value}" is an address, not a domain (Value). A DOMAIN suppression is matched against the part after the @, so write "example.com".`;
  }
  if (scope === SuppressionScope.CONTACT) {
    const hit = await db.contact.findUnique({ where: { id: value }, select: { id: true } });
    if (!hit) return `No contact has the id "${value}" (Value). A CONTACT suppression holds a contact's id — to suppress an address, use the EMAIL scope.`;
  }
  if (scope === SuppressionScope.COMPANY) {
    const hit = await db.company.findUnique({ where: { id: value }, select: { id: true } });
    if (!hit) return `No company has the id "${value}" (Value). A COMPANY suppression holds a company's id rather than its name.`;
  }
  return null;
}

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedSuppression>> {
  const r = new RowReader(row);
  const scope = r.enum("Scope", SuppressionScope);
  const reason = r.enum("Reason", SuppressionReason);
  const addedAt = r.date("Added");
  const expiresAt = r.date("Expires");
  if (r.error) return { error: r.error };
  if (!scope) return { error: `Scope is required — one of ${Object.keys(SuppressionScope).join(", ")}.` };

  const value = r.text("Value").toLowerCase();
  if (!value) return { error: "Value is required." };

  const existing = await db.suppression.findUnique({
    where: { scope_value: { scope, value } },
    select: { id: true, reason: true, expiresAt: true },
  });

  if (!existing) {
    if (!reason) {
      return { error: `Reason is required on a new suppression — one of ${Object.keys(SuppressionReason).join(", ")}.` };
    }
    const unusable = await unusableValue(scope, value);
    if (unusable) return { error: unusable };
  } else if (reason && reason !== existing.reason) {
    const weaker = weakening(existing.reason, reason);
    if (weaker) {
      return {
        error: `${value} is recorded as ${existing.reason} and an import can't rewrite that to ${reason}: ${weaker}. If the stored reason is genuinely wrong, change it on the suppression list.`,
      };
    }
  }

  return { value: { scope, value, reason, addedAt, expiresAt, existing } };
}

export const suppressionImporter: Importer = {
  templateColumns: ["Scope", "Value", "Reason", "Added", "Expires"],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, `${row.Scope ?? ""} ${row.Value ?? ""}`.trim(), resolved.error);
    const s = resolved.value;
    const key = `${s.scope}:${s.value}`;
    const label = `${s.scope.toLowerCase()} ${s.value}`;

    if (!s.existing) {
      return createRow(line, key, label, {
        Scope: s.scope,
        Value: s.value,
        Reason: s.reason,
        Added: s.addedAt,
        Expires: s.expiresAt,
      });
    }

    return updateRow(line, key, label, [
      s.reason ? diff("Reason", s.existing.reason, s.reason) : null,
      s.expiresAt ? diff("Expires", dayOf(s.existing.expiresAt), dayOf(s.expiresAt)) : null,
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const s = resolved.value;

    if (s.existing) {
      await db.suppression.update({
        where: { id: s.existing.id },
        data: {
          ...(s.reason ? { reason: s.reason } : {}),
          ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
        },
      });
      return;
    }

    await db.suppression.create({
      data: {
        scope: s.scope,
        value: s.value,
        // resolve() refuses a create without one, so this is only ever undefined on an update.
        reason: s.reason!,
        ...(s.addedAt ? { createdAt: s.addedAt } : {}),
        ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
        createdById: ctx.actorUserId || null,
      },
    });
  },
};
