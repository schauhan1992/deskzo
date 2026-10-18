import { LIVE_STATUSES } from "@/lib/platform/entitlements";
import { controlDb } from "@/lib/platform/control-db";
import { PlanRefused, checkPlanInput, savePlan, type PlanInput } from "@/lib/platform/plans";
import { ADD_ONS, BASE_MODULES, PRODUCTS, productPlanKey, type AddOnKey, type ProductKey } from "@/lib/products";
import { NO_LIMITS, PLAN_LIMITS } from "@/lib/automate/limits";

/**
 * The products (src/lib/products.ts) as plans in the control plane — `npm run platform:plans --
 * products`. Owner decision, 1 Oct 2026: each product is sold on its own, and Deskzo One is all of
 * them; a workspace may hold several products, one plan each (src/lib/billing/plan-choice.ts).
 *
 *   deskzo-one           an edition of every module, product "one" — new workspaces' default, so
 *                        they trial everything
 *   deskzo-<product>     an edition for each other product: the basics every product comes with
 *                        (`BASE_MODULES`) and the product's own modules
 *   addon-revenue-close  Revenue & Close, India only (its module is), bought with Books or One
 *   addon-ai-copilot     copilot tokens a month for each unit (1,000,000 to start with)
 *   addon-more-people    one seat for each unit
 *   addon-automate-plus  Automate Plus: Deskzo Automate's limits raised (src/lib/automate/limits.ts)
 *
 * Names and descriptions come from products.ts. Books is sold in India only, as accounting is
 * (src/lib/modules.ts `countries`); everything else everywhere, where a product's India-only module
 * (payroll, in People) drops out abroad by itself. No prices: staff add them in the console, and a
 * plan without one is not on sale. The gateways are never called from here.
 *
 * Running it again is safe. The catalogue owns what a plan *is* — its kind, its product, and its
 * modules (every module, for Deskzo One) — and writes those whenever they differ from products.ts.
 * Everything else belongs to staff once the plan exists: its name and description, where it is sold,
 * seats, copilot tokens, custom domains, order, whether it is on sale, whether it is the default, its
 * prices. Those are written only when the plan is made. A run that finds every plan as the catalogue
 * has it writes nothing at all. Taking a module off a plan that workspaces are on would take it from
 * them, so that waits for `allowRemovals`; an internal plan with one of these keys is left alone.
 *
 * Automate's limits (Phase 7) are staff's too, with one exception: a plan made before they existed has
 * all four empty, and the catalogue fills them in once — an empty limit on an edition means none.
 */

/** Plan keys are identifiers — invitations and scripts name them — so they never follow a rename of the brand (src/lib/products.ts). */
export { productPlanKey };

export const ADD_ON_PLAN_KEYS: Record<AddOnKey, string> = {
  revenue_close: "addon-revenue-close",
  copilot: "addon-ai-copilot",
  seats: "addon-more-people",
  automate_plus: "addon-automate-plus",
};

/** Copilot tokens a month for each unit of the AI Copilot add-on, until staff say otherwise. */
export const COPILOT_TOKENS_PER_UNIT = 1_000_000;

/** A product's own trial, or why a signup can't start on it: not sold where the business is (with where it is), or not offered alone. */
export type ProductTrial = { ok: true; planKey: string } | { ok: false; reason: "country"; soldIn: string[] } | { ok: false; reason: "unavailable" };

/**
 * The plan a signup for one product starts its free trial on (owner, 11 Oct 2026: a product's page
 * starts a trial of that product alone) — the catalogue's own edition of it, `deskzo-<product>`, while it
 * is offered and sold in the business's country. Nothing else under that key: an internal plan staff
 * gave the key to (the catalogue leaves those alone) would be a workspace free for ever, and another
 * product's edition the wrong product. No price is needed, as for the default plan's trial.
 */
export async function productTrialPlan(product: ProductKey, country: string): Promise<ProductTrial> {
  const plan = await controlDb().plan.findUnique({ where: { key: productPlanKey(product) }, select: { key: true, kind: true, productKey: true, active: true, countries: true } });
  if (!plan || !plan.active || plan.kind !== "EDITION" || plan.productKey !== product) return { ok: false, reason: "unavailable" };
  if (plan.countries.length && !plan.countries.includes(country)) return { ok: false, reason: "country", soldIn: plan.countries };
  return { ok: true, planKey: plan.key };
}

/**
 * The plan a signup starts on, the first that applies: the one its invitation names (made for this
 * customer); the trial of the product the visitor chose on its page; the one a partner's referral names;
 * and otherwise none — the default plan (`planForNewWorkspace`). What the visitor clicked comes before a
 * partner's choice, which is the partner's default for people who chose nothing; the partner is
 * credited with the workspace either way (src/lib/partners/attribution.ts).
 */
export function signupPlanKey(choice: { invitePlan: string | null; productPlan: string | null; referralPlan: string | null }): string | null {
  return choice.invitePlan ?? choice.productPlan ?? choice.referralPlan ?? null;
}


/** A plan as the catalogue makes it: every field given. */
export type CataloguePlan = Required<Omit<PlanInput, "customDomains">>;

/** The plans the catalogue makes, in the order they are listed for sale. */
export function productCatalogue(): CataloguePlan[] {
  const editions = PRODUCTS.map((product, i): CataloguePlan => {
    const suite = product.key === "one";
    return {
      key: productPlanKey(product.key),
      name: product.name,
      kind: "EDITION",
      description: product.tagline,
      productKey: product.key,
      allModules: suite,
      modules: suite ? [] : [...new Set([...BASE_MODULES, ...product.modules])],
      // Sold only where products.ts says (Books and People: India).
      countries: [...(product.soldOnlyIn ?? [])],
      // No limit on people until staff price the plans; the copilot is bought as an add-on.
      seats: null,
      copilotTokens: 0,
      automation: { ...(suite ? PLAN_LIMITS.one : PLAN_LIMITS.edition) },
      isDefault: suite,
      active: true,
      sortOrder: i * 10,
    };
  });
  const addOn = (key: AddOnKey) => ADD_ONS.find((a) => a.key === key)!;
  const extras: CataloguePlan[] = [
    {
      key: ADD_ON_PLAN_KEYS.revenue_close,
      name: addOn("revenue_close").name,
      kind: "ADDON",
      description: addOn("revenue_close").tagline,
      productKey: null,
      allModules: false,
      modules: [...addOn("revenue_close").modules],
      countries: ["IN"],
      seats: null,
      copilotTokens: null,
      automation: { ...NO_LIMITS },
      isDefault: false,
      active: true,
      sortOrder: 200,
    },
    {
      key: ADD_ON_PLAN_KEYS.copilot,
      name: addOn("copilot").name,
      kind: "ADDON",
      description: addOn("copilot").tagline,
      productKey: null,
      allModules: false,
      modules: [],
      countries: [],
      seats: null,
      copilotTokens: COPILOT_TOKENS_PER_UNIT,
      automation: { ...NO_LIMITS },
      isDefault: false,
      active: true,
      sortOrder: 210,
    },
    {
      key: ADD_ON_PLAN_KEYS.automate_plus,
      name: addOn("automate_plus").name,
      kind: "ADDON",
      description: addOn("automate_plus").tagline,
      productKey: null,
      allModules: false,
      modules: [],
      countries: [],
      seats: null,
      copilotTokens: null,
      automation: { ...PLAN_LIMITS.plus },
      isDefault: false,
      active: true,
      sortOrder: 215,
    },
    {
      key: ADD_ON_PLAN_KEYS.seats,
      name: addOn("seats").name,
      kind: "ADDON",
      description: addOn("seats").tagline,
      productKey: null,
      allModules: false,
      modules: [],
      countries: [],
      seats: 1,
      copilotTokens: null,
      automation: { ...NO_LIMITS },
      isDefault: false,
      active: true,
      sortOrder: 220,
    },
  ];
  return [...editions, ...extras];
}

/** What a run did, or would do (`dryRun`), to one plan. */
export type CatalogueLine = {
  key: string;
  outcome: "created" | "updated" | "unchanged" | "left alone" | "refused";
  /** What changed, or would: "modules +x −y", "product crm"… */
  changes: string[];
  note?: string;
};

/**
 * Creates the catalogue's plans that are missing and brings the fields it owns up to date on the
 * others (see the top of this file). `dryRun`: says what it would do, and writes nothing.
 */
export async function syncProductPlans(opts: { actor: string; dryRun?: boolean; allowRemovals?: boolean }): Promise<CatalogueLine[]> {
  const control = controlDb();
  const wanted = productCatalogue();
  const rows = await control.plan.findMany({ where: { key: { in: wanted.map((w) => w.key) } }, include: { modules: { select: { moduleKey: true } } } });
  const defaultNow = await control.plan.findFirst({ where: { isDefault: true }, select: { key: true } });
  const lines: CatalogueLine[] = [];

  for (const plan of wanted) {
    const row = rows.find((r) => r.key === plan.key);
    if (!row) {
      const kind = plan.kind === "ADDON" ? "add-on" : plan.kind.toLowerCase();
      const changes = [`${kind}${plan.productKey ? ` of ${plan.productKey}` : ""}`];
      if (plan.allModules) changes.push("every module");
      else if (plan.modules.length) changes.push(`${plan.modules.length} module${plan.modules.length === 1 ? "" : "s"}`);
      if (plan.kind === "ADDON" && plan.copilotTokens) changes.push(`${plan.copilotTokens.toLocaleString("en-IN")} copilot tokens a month a unit`);
      if (plan.kind === "ADDON" && plan.seats) changes.push(`${plan.seats} seat${plan.seats === 1 ? "" : "s"} a unit`);
      if (plan.kind === "ADDON" && plan.automation.steps) changes.push(`${plan.automation.steps.toLocaleString("en-IN")} Automate steps a month a unit`);
      if (plan.countries.length) changes.push(`sold in ${plan.countries.join(", ")}`);
      if (plan.isDefault) changes.push(defaultNow && defaultNow.key !== plan.key ? `the default, in place of ${defaultNow.key}` : "the default");
      lines.push(await apply(plan, { outcome: "created", changes }, opts));
      continue;
    }
    if (row.kind === "INTERNAL") {
      lines.push({ key: plan.key, outcome: "left alone", changes: [], note: "an internal plan has this key" });
      continue;
    }

    const have = row.modules.map((m) => m.moduleKey);
    const added = plan.allModules ? [] : plan.modules.filter((m) => !have.includes(m));
    let removed = plan.allModules ? [] : have.filter((m) => !plan.modules.includes(m));
    let note: string | undefined;
    if (removed.length && !opts.allowRemovals) {
      const workspaces = await control.tenant.count({ where: { subscriptions: { some: { status: { in: [...LIVE_STATUSES] }, items: { some: { planId: row.id } } } } } });
      if (workspaces > 0) {
        note = `kept ${removed.join(", ")}: ${workspaces} workspace${workspaces === 1 ? " is" : "s are"} on it (--allow-removals takes ${removed.length === 1 ? "it" : "them"} off)`;
        removed = [];
      }
    }
    const changes: string[] = [];
    if (row.kind !== plan.kind) changes.push(`kind ${row.kind} → ${plan.kind}`);
    if (row.productKey !== plan.productKey) changes.push(`product ${row.productKey ?? "none"} → ${plan.productKey ?? "none"}`);
    if (row.allModules !== plan.allModules) changes.push(plan.allModules ? "every module" : "a list of modules");
    if (added.length || removed.length) changes.push(`modules${added.length ? ` +${added.join(" +")}` : ""}${removed.length ? ` −${removed.join(" −")}` : ""}`);
    // Made before Automate's limits: filled in once, then staff's.
    const automationUnset = row.automationWorkflows === null && row.automationSteps === null && row.automationHistoryDays === null && row.automationConnectors === null;
    const fillAutomation = automationUnset && Object.values(plan.automation).some((v) => v !== null);
    if (fillAutomation) changes.push("Automate limits");
    if (!changes.length) {
      lines.push({ key: plan.key, outcome: "unchanged", changes, note });
      continue;
    }
    const modules = plan.allModules ? [] : [...have.filter((m) => !removed.includes(m)), ...added];
    // The catalogue's fields, and everything else as staff left it; custom domains left out, so kept.
    const merged: PlanInput = {
      key: row.key,
      name: row.name,
      kind: plan.kind,
      description: row.description,
      productKey: plan.productKey,
      allModules: plan.allModules,
      modules,
      countries: row.countries,
      seats: row.seats,
      copilotTokens: row.copilotTokens,
      ...(fillAutomation ? { automation: plan.automation } : {}),
      isDefault: row.isDefault,
      active: row.active,
      sortOrder: row.sortOrder,
    };
    lines.push(await apply(merged, { outcome: "updated", changes, note }, opts));
  }
  return lines;
}

/**
 * Saves one plan — through `savePlan`, so it is checked, audited and its workspaces worked out
 * again. A dry run only checks it, as the save would.
 */
async function apply(input: PlanInput, line: Omit<CatalogueLine, "key">, opts: { actor: string; dryRun?: boolean }): Promise<CatalogueLine> {
  try {
    if (opts.dryRun) checkPlanInput(input);
    else await savePlan(input, opts.actor);
    return { key: input.key, ...line };
  } catch (err) {
    if (err instanceof PlanRefused) return { key: input.key, outcome: "refused", changes: line.changes, note: err.message };
    throw err;
  }
}
