import { COUNTRY_FEATURES, MODULE_REGISTRY, getModuleDefinition, type CountryFeature, type ModuleDefinition } from "@/lib/modules";

/**
 * What a workspace may use: the rules, in one place, for the control plane that works them out
 * (src/lib/platform/entitlements.ts) and the workspace that obeys them (src/lib/modules-access.ts).
 *
 * The answer is kept on the workspace's own control-plane row and travels with it through the
 * registry, so asking "is this module in the plan" never costs a query.
 */
export type Entitlements = {
  v: 1;
  /** Every module there is, including ones added after this was worked out. */
  all: boolean;
  /** Module keys, dependencies included. Core modules and the every-plan ones are implied. */
  modules: string[];
  /** People who may hold an active account. Null: no limit. */
  seats: number | null;
  /**
   * Deskzo AI credits a month, across everybody (src/lib/ai/credits.ts). Null: no limit; 0: none. Counted
   * copilot tokens until 17 Oct 2026, when AI moved to credits; the name is older.
   */
  copilotTokens: number | null;
  /**
   * Addresses of its own it may add (src/lib/platform/domains.ts) — every one it has, waiting,
   * live or stopped, counts. Null: no limit; 0: none.
   */
  customDomains: number | null;
  /**
   * Deskzo Automate's limits (src/lib/automate/limits.ts): active workflows, steps a month across
   * everybody, days of run history, connector level — each null for no limit. Absent: worked out before
   * they existed — no limit until worked out again.
   */
  automation?: { workflows: number | null; steps: number | null; historyDays: number | null; connectors: number | null };
  /** The plans it came from, by key — for showing, never for deciding. */
  plans: string[];
  /** Its seats are a free trial's (console › Settings): it pays for nothing yet. Absent: they are not. */
  trial?: boolean;
  /**
   * Worked out since AI moved to credits, so `copilotTokens` counts credits. Absent: an answer from before,
   * whose number counted tokens — src/lib/ai/credits.ts works it out again before relying on it.
   */
  inCredits?: true;
};

/** A workspace from the environment — the installation as it was before workspaces — has everything. */
export const UNRESTRICTED: Entitlements = { v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] };

/**
 * A workspace whose entitlements were never worked out: the core, its first owner, and nothing else.
 * Failing closed — a plan nobody wrote down is not a plan of everything.
 */
export const CORE_ONLY: Entitlements = { v: 1, all: false, modules: [], seats: 1, copilotTokens: 0, customDomains: 0, automation: { workflows: 0, steps: 0, historyDays: 7, connectors: 0 }, plans: [] };

const limit = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * Read back from the control plane; anything malformed is the core only. An answer worked out before
 * custom domains existed has no `customDomains`: none, until it is worked out again.
 */
export function parseEntitlements(json: unknown): Entitlements {
  if (!json || typeof json !== "object") return CORE_ONLY;
  const e = json as Record<string, unknown>;
  const seats = limit(e.seats);
  const copilotTokens = limit(e.copilotTokens);
  const customDomains = e.customDomains === undefined ? 0 : limit(e.customDomains);
  if (e.v !== 1 || typeof e.all !== "boolean" || !Array.isArray(e.modules) || seats === undefined || copilotTokens === undefined || customDomains === undefined) return CORE_ONLY;
  return {
    v: 1,
    all: e.all,
    modules: e.modules.filter((m): m is string => typeof m === "string"),
    seats,
    copilotTokens,
    customDomains,
    ...automationOf(e.automation),
    plans: Array.isArray(e.plans) ? e.plans.filter((p): p is string => typeof p === "string") : [],
    ...(e.trial === true ? { trial: true } : {}),
    ...(e.inCredits === true ? { inCredits: true as const } : {}),
  };
}

/** Automate's limits as cached, kept only when whole: one unreadable reads as never worked out (no limit). */
function automationOf(raw: unknown): { automation?: NonNullable<Entitlements["automation"]> } {
  if (!raw || typeof raw !== "object") return {};
  const a = raw as Record<string, unknown>;
  const [workflows, steps, historyDays, connectors] = [limit(a.workflows), limit(a.steps), limit(a.historyDays), limit(a.connectors)];
  if (workflows === undefined || steps === undefined || historyDays === undefined || connectors === undefined) return {};
  return { automation: { workflows, steps, historyDays, connectors } };
}

/** Whether a module is sold in this country at all. */
export function soldIn(def: Pick<ModuleDefinition, "countries">, country: string): boolean {
  return !def.countries || def.countries.includes(country);
}

/**
 * Leads were part of the core until 14 Oct 2026, when they became a module sold with Deskzo Pipeline, CRM
 * and One. A plan saved before then doesn't list them. Until `platform:plans -- products` saves it again,
 * a plan holding the contact library — which only CRM and Pipeline sell — has leads too, so nobody paying
 * for a CRM loses their pipeline between the deploy and that run. Harmless after it: those plans list leads.
 */
const LEADS_CARRIED_BY = "contacts_library";

/** Whether this workspace's plan includes the module. Unknown keys are never included. */
export function moduleEntitled(entitlements: Entitlements, country: string, key: string): boolean {
  const def = getModuleDefinition(key);
  if (!def) return false;
  if (def.core) return true;
  if (!soldIn(def, country)) return false;
  if (key === "leads" && entitlements.modules.includes(LEADS_CARRIED_BY)) return true;
  return entitlements.all || !!def.inEveryPlan || entitlements.modules.includes(key);
}

/** Every module this workspace's plan includes, core and every-plan ones among them. */
export function entitledModuleKeys(entitlements: Entitlements, country: string): string[] {
  return MODULE_REGISTRY.filter((m) => moduleEntitled(entitlements, country, m.key)).map((m) => m.key);
}

/** A country-bound part of a module — the e-invoice and e-way bill systems are India's. */
export function featureAvailable(country: string, feature: CountryFeature): boolean {
  return (COUNTRY_FEATURES[feature] as readonly string[]).includes(country);
}

/** The modules and everything they need, transitively. */
export function withDependencies(keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const add = (key: string) => {
    if (out.has(key)) return;
    out.add(key);
    for (const dep of getModuleDefinition(key)?.requires ?? []) add(dep);
  };
  for (const key of keys) add(key);
  return out;
}

/** The modules that need this one, transitively — what taking it away takes with it. */
export function dependentsOf(key: string): Set<string> {
  const out = new Set<string>();
  const visit = (target: string) => {
    for (const m of MODULE_REGISTRY) {
      if (m.requires?.includes(target) && !out.has(m.key)) {
        out.add(m.key);
        visit(m.key);
      }
    }
  };
  visit(key);
  return out;
}
