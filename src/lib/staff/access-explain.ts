import type { AccessLevel } from "@prisma/client";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { accessModule, actionRowsOf, moduleStanding, type ActionRowSpec, type ModuleStanding } from "@/lib/staff/access-modules";

/**
 * What a set of answers — the permissions somebody (or a role) holds and the level they reach each
 * record at — means for one module's Actions table and its Permission preview, in words. Pure, so the
 * screens can say it about the role as it is being edited, before anything is saved.
 */

export type AccessFacts = {
  holds: (key: string) => boolean;
  level: (record: AccessRecord, action: AccessAction) => AccessLevel;
};

/** Whether a row of the Actions table is allowed: its permission, or any reach at all. */
export function rowAllowed(row: ActionRowSpec, facts: AccessFacts): boolean {
  if (row.kind === "key") return facts.holds(row.key);
  if (row.viewKey && !facts.holds(row.viewKey)) return false;
  return facts.level(row.record, row.action) !== "NONE";
}

const SCOPE_WORDS: Record<AccessLevel, string> = {
  NONE: "none",
  OWN: "their own",
  TEAM: "their team's",
  BRANCH: "their branch's",
  ALL: "all",
  FOLLOW: "as the account allows",
};

export function moduleStandingOf(moduleKey: string, facts: AccessFacts): ModuleStanding {
  const m = accessModule(moduleKey);
  if (!m) return "none";
  return moduleStanding(m, facts.holds, (record) => facts.level(record, "view") !== "NONE");
}

/**
 * The access explanation under the Permission preview: what may be done in the module, how far, and
 * what is restricted — "Can view leads (their team's) and edit leads (their own). Delete leads and
 * Export CRM data are restricted."
 */
export function explainModule(
  moduleKey: string,
  records: { key: AccessRecord; label: string; actions: AccessAction[] }[],
  facts: AccessFacts,
): { allowed: string[]; restricted: string[]; sentence: string } {
  const rows = actionRowsOf(moduleKey, records);
  const allowed: string[] = [];
  const restricted: string[] = [];
  for (const row of rows) {
    if (rowAllowed(row, facts)) {
      allowed.push(row.kind === "record" ? `${lower(row.label)} (${SCOPE_WORDS[facts.level(row.record, row.action)]})` : lower(row.label));
    } else {
      restricted.push(row.label);
    }
  }
  const name = accessModule(moduleKey)?.label ?? "this module";
  let sentence: string;
  if (allowed.length === 0) sentence = `No access to ${name}: every action is restricted.`;
  else {
    sentence = `Can ${list(allowed)}.`;
    if (restricted.length === 0) sentence += ` Nothing in ${name} is restricted.`;
    else if (restricted.length <= 4) sentence += ` ${list(restricted)} ${restricted.length === 1 ? "is" : "are"} restricted.`;
    else sentence += ` ${restricted.length} other actions are restricted.`;
  }
  return { allowed, restricted, sentence };
}

function lower(label: string): string {
  // "View leads" → "view leads", but an acronym stays as it is ("CRM data").
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length > 6) return `${items.slice(0, 5).join(", ")} and ${items.length - 5} more`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
