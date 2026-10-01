import { withDependencies } from "@/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import { BASE_MODULES, PRODUCTS, productByKey, productsOfModule } from "@/lib/products";

/**
 * Which plans go together on one workspace, now that each product is sold on its own
 * (src/lib/products.ts). Pure and client-safe: checkout refuses in these words
 * (src/lib/billing/checkout.ts), the billing page's plan picker says them before anybody is sent to
 * pay, and staff giving plans by hand meet the product rules (src/lib/platform/plans.ts).
 *
 *   · At least one edition: Deskzo One, a plan of a product, or an edition of its own.
 *   · An edition of its own (no product — one made before products, or by hand) comes alone among
 *     editions, as every edition did.
 *   · Deskzo One already holds every product: no other edition with it.
 *   · One plan for each product.
 *   · What an add-on or a bundle brings has what it needs from the editions chosen — or from Deskzo
 *     One — never through the add-on alone: entitlements add a module's `requires` by themselves
 *     (src/lib/entitlements.ts `withDependencies`), so Revenue & Close bought without Books would
 *     quietly bring the whole of accounting with it. A module the add-on lists itself counts as
 *     brought on purpose.
 *   · Nothing bought twice: an add-on or a bundle whose modules the editions already hold is refused
 *     as already included — Revenue & Close comes with Deskzo One (owner decision, 1 Oct 2026).
 */

export type ChoiceKind = "EDITION" | "BUNDLE" | "ADDON" | "INTERNAL";

/** A plan as these rules read it. `modules` may be `["all"]` — the offer's way of writing every module. */
export type ChoicePlan = { key: string; name: string; kind: ChoiceKind; productKey: string | null; allModules?: boolean; modules: readonly string[] };

/** The suite's name, from the one place names are written. */
export const SUITE_NAME = productByKey("one")?.name ?? PRODUCTS[0]!.name;

/** "A", "A or B", "A, B or C". */
function listOf(items: string[], word: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;
}

/** What the rules refuse with, word for word — checkout, the picker and the console show the same. */
export const CHOICE_REFUSALS = {
  noEdition: `Choose a plan first — ${SUITE_NAME}, or one for each product you want — and any add-ons with it.`,
  editionAlone: (name: string) => `${name} is a plan of its own — choose it alone, with any add-ons.`,
  suiteAlone: `${SUITE_NAME} already includes every product — choose it on its own, with any add-ons.`,
  onePerProduct: (product: string, names: string[]) => `Choose one plan for each product — ${listOf(names, "and")} are both ${product}.`,
  needs: (name: string, needed: string) => `${name} needs ${needed}.`,
  included: (name: string, by: string) => `${name} is already included in ${by} — there's nothing to add.`,
  addOnTo: (name: string, products: string) => `${name} is an add-on to ${products}, and included in ${SUITE_NAME}.`,
} as const;

const isEdition = (p: ChoicePlan) => p.kind === "EDITION";
const everything = (p: ChoicePlan) => !!p.allModules || p.modules.includes("all");

/** Always there, whatever is bought: the core and the every-plan modules. */
const ALWAYS = MODULE_REGISTRY.filter((m) => m.core || m.inEveryPlan).map((m) => m.key);

/**
 * The product rules alone — one plan for each product, Deskzo One with no other — which hold for
 * plans given by hand too. Null when they are kept.
 */
export function productRefusal(plans: readonly ChoicePlan[]): string | null {
  const editions = plans.filter((p) => isEdition(p) && p.productKey);
  if (editions.some((p) => p.productKey === "one") && editions.length > 1) {
    const suites = editions.filter((p) => p.productKey === "one");
    if (suites.length > 1) return CHOICE_REFUSALS.onePerProduct(SUITE_NAME, suites.map((p) => p.name));
    return CHOICE_REFUSALS.suiteAlone;
  }
  for (const product of PRODUCTS) {
    const same = editions.filter((p) => p.productKey === product.key);
    if (same.length > 1) return CHOICE_REFUSALS.onePerProduct(product.name, same.map((p) => p.name));
  }
  return null;
}

/**
 * Why an add-on or a bundle cannot come with these editions, or null: a module it brings needs one
 * the editions do not have. Names the products that have it, and Deskzo One.
 */
export function needsRefusal(extra: ChoicePlan, chosen: readonly ChoicePlan[]): string | null {
  const list = neededGroups(extra, chosen);
  if (!list) return null;
  const needed = list.length === 1 ? `${list[0]} or ${SUITE_NAME}` : `${listOf(list, "and")}, or ${SUITE_NAME}`;
  return CHOICE_REFUSALS.needs(extra.name, needed);
}

/**
 * What an add-on or a bundle lacks among these editions, as the products that would supply each
 * missing module ("Deskzo Books") — or the module itself where no product has it. Null when nothing.
 */
function neededGroups(extra: ChoicePlan, chosen: readonly ChoicePlan[]): string[] | null {
  if (isEdition(extra) || extra.kind === "INTERNAL" || everything(extra)) return null;
  const editions = chosen.filter(isEdition);
  if (editions.some(everything)) return null;
  const have = withDependencies([...ALWAYS, ...editions.flatMap((p) => p.modules)]);
  const own = new Set(extra.modules);
  const missing = [...withDependencies(extra.modules)].filter((key) => !own.has(key) && !have.has(key));
  if (!missing.length) return null;
  const groups = new Set<string>();
  for (const key of missing) {
    const products = productsOfModule(key).map((p) => p.name);
    groups.add(products.length ? listOf(products, "or") : (getModuleDefinition(key)?.label ?? key));
  }
  return [...groups];
}

/**
 * Why an add-on or a bundle would be bought twice, or null: the editions chosen already hold every
 * module it brings — Deskzo One holds them all. An add-on that brings an allowance rather than a
 * module (AI Copilot, More people) is never "included".
 */
export function includedRefusal(extra: ChoicePlan, chosen: readonly ChoicePlan[]): string | null {
  if (isEdition(extra) || extra.kind === "INTERNAL" || everything(extra) || !extra.modules.length) return null;
  const editions = chosen.filter(isEdition);
  const suite = editions.find(everything);
  if (suite) return CHOICE_REFUSALS.included(extra.name, suite.name);
  const have = new Set([...ALWAYS, ...editions.flatMap((p) => p.modules)]);
  if (!extra.modules.every((m) => have.has(m))) return null;
  const by = editions.filter((p) => p.modules.some((m) => extra.modules.includes(m))).map((p) => p.name);
  return CHOICE_REFUSALS.included(extra.name, listOf(by.length ? by : editions.map((p) => p.name), "and"));
}

/**
 * What the pricing page says of an add-on or a bundle before anybody chooses: the products it is an
 * add-on to, and that Deskzo One already includes it — "Revenue & Close is an add-on to Deskzo Books,
 * and included in Deskzo One." Null when any product will do (AI Copilot, More people).
 */
export function needsOfExtra(extra: ChoicePlan): string | null {
  const list = neededGroups(extra, [{ key: "", name: "", kind: "EDITION", productKey: null, modules: BASE_MODULES }]);
  if (!list) return null;
  return CHOICE_REFUSALS.addOnTo(extra.name, listOf(list, "and"));
}

/**
 * Everything a purchase must keep, in this order: an edition; an edition of its own alone; Deskzo One
 * alone; one plan for each product; each add-on's and bundle's needs met. Null when it may be bought.
 */
export function choiceRefusal(plans: readonly ChoicePlan[]): string | null {
  const editions = plans.filter(isEdition);
  if (!editions.length) return CHOICE_REFUSALS.noEdition;
  const ownEdition = editions.find((p) => !p.productKey);
  if (ownEdition && editions.length > 1) return CHOICE_REFUSALS.editionAlone(ownEdition.name);
  const products = productRefusal(plans);
  if (products) return products;
  for (const extra of plans) {
    const twice = includedRefusal(extra, plans);
    if (twice) return twice;
    const needs = needsRefusal(extra, plans);
    if (needs) return needs;
  }
  return null;
}
