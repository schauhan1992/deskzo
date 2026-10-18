import type { Entitlements } from "@/lib/entitlements";

/**
 * Deskzo Automate's plan limits (Phase 7; owner, 17 Oct 2026: the plan's limits as proposed, connectors
 * by plan). Pure — the numbers, and what they mean for one workspace.
 *
 *   · Active workflows, steps a month (actions that ran and did something, never a test), days of run
 *     history, and how far into the outside world its workflows may reach.
 *   · They come from its plans (src/lib/platform/entitlements.ts) — an edition's per person, pooled — or
 *     a staff override. A workspace whose entitlements were worked out before Phase 7 has none written:
 *     no limit, until they are worked out again.
 */

/**
 * Which outside connectors a workflow may use; each level includes the ones before it. `upTo`: a
 * plan at this level, as read; `comesWith`: where the level's own connectors are sold.
 */
export const CONNECTOR_LEVELS = [
  { level: 0, label: "Webhooks", upTo: "Webhooks only", comesWith: "Webhooks come with every plan." },
  {
    level: 1,
    label: "Saved API connections, Slack and Teams",
    upTo: "Webhooks, saved API connections, Slack and Teams",
    comesWith: "Saved API connections, Slack and Teams come with every product's plan.",
  },
  { level: 2, label: "Google Sheets", upTo: "Everything but WhatsApp", comesWith: "Google Sheets comes with Deskzo One, or the Automate Plus add-on." },
  { level: 3, label: "WhatsApp", upTo: "Every connector", comesWith: "WhatsApp comes with the Automate Plus add-on." },
] as const;
export const ALL_CONNECTORS = 3;

export type AutomationLimits = {
  /** Workflows switched on at once. Null: no limit. */
  workflows: number | null;
  /** Steps a month, across everybody. Null: no limit. */
  steps: number | null;
  /** Days a finished run's history is kept. Null: for good. */
  historyDays: number | null;
  /** The highest connector level its workflows may use (`CONNECTOR_LEVELS`). Null: all. */
  connectors: number | null;
};

/** What each kind of plan gives, as the catalogue makes them (src/lib/platform/product-plans.ts). Steps are per person on a plan sold per person. */
export const PLAN_LIMITS = {
  /** Any product's edition. */
  edition: { workflows: 20, steps: 1_000, historyDays: 30, connectors: 1 },
  /** Deskzo One. */
  one: { workflows: 100, steps: 3_000, historyDays: 90, connectors: 2 },
  /** The Automate Plus add-on, for each one bought: added to the plans it is bought with. */
  plus: { workflows: 100, steps: 50_000, historyDays: 365, connectors: 3 },
  /** The free trial, whatever plan it trials. */
  trial: { workflows: 5, steps: 1_000, historyDays: 7, connectors: 0 },
} as const satisfies Record<string, AutomationLimits>;

export const NO_LIMITS: AutomationLimits = { workflows: null, steps: null, historyDays: null, connectors: null };

/** A workspace's limits, from its entitlements — none written (worked out before Phase 7): no limit. */
export function automationLimits(entitlements: Pick<Entitlements, "automation">): AutomationLimits {
  return entitlements.automation ?? NO_LIMITS;
}

/** The connector level an action needs, as configured: a webhook call to an address is level 0; a saved API, Slack or Teams 1; Google Sheets 2; WhatsApp 3. */
export function connectorLevelOf(action: string, input: Record<string, unknown> | null | undefined): number {
  switch (action) {
    case "http.request":
      return input?.connectionId ? 1 : 0;
    case "slack.post":
    case "teams.post":
      return 1;
    case "sheets.append":
      return 2;
    case "whatsapp.send":
      return 3;
    default:
      return -1;
  }
}

/** A plan's connector level, as read. Null: every connector. */
export const connectorLevelText = (level: number | null): string => (level === null ? "Every connector" : (CONNECTOR_LEVELS[level]?.upTo ?? `Level ${level}`));

/** Why the plan doesn't allow this connector, or null when it does. */
export function connectorRefusal(level: number, limits: AutomationLimits): string | null {
  if (level < 0 || limits.connectors === null || level <= limits.connectors) return null;
  return `Not on this workspace's plan. ${CONNECTOR_LEVELS[level]!.comesWith}`;
}

/** Whether a count has passed a share of its limit — the 80% and 100% warnings. */
export function share(used: number, limit: number | null): number | null {
  return limit === null || limit <= 0 ? (limit === 0 ? 1 : null) : used / limit;
}
