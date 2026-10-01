import Link from "next/link";
import { ArrowRight, Boxes, CopyPlus, Globe, Pencil, Sparkles, Star, Users } from "lucide-react";
import { StatusPill } from "@/components/console/kit/status";
import { formatMoney } from "@/lib/billing/money";
import { compactNumber, plural } from "@/lib/console-shared/format";
import { gatewayLabel, intervalLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { CatalogueModuleView, PlanKindKey } from "@/lib/console-shared/types";
import type { PlanListRow } from "@/lib/platform/console-data";
import type { PlanInput } from "@/lib/platform/plans";
import { PRODUCTS, productByKey } from "@/lib/products";
import { cn } from "@/lib/utils";
import { PlanCardActions } from "./plan-card-actions";

/**
 * The plan catalogue as cards, grouped by kind — what each plan includes, which product it sells,
 * where it is sold, what it costs and who is on it, readable at a glance before anybody opens one.
 * Editions are in product order (src/lib/products.ts: Deskzo One first), editions of no product last.
 * Server-safe: the only interactive piece is the retire / offer-again button, a client island per card.
 *
 * The helpers below are shared with the compare matrix, so a price reads the same in both views.
 */

export const KIND_ORDER: readonly PlanKindKey[] = ["EDITION", "BUNDLE", "ADDON", "INTERNAL"];

export const KIND_GROUPS: Record<PlanKindKey, { title: string; description: string }> = {
  EDITION: { title: "Editions", description: "What a workspace buys: a product, or every product, with the people included — one plan for each product." },
  BUNDLE: { title: "Bundles", description: "Several modules sold together, on top of an edition." },
  ADDON: { title: "Add-ons", description: "One more thing: a module, more people, more copilot." },
  INTERNAL: { title: "Internal", description: "Never sold: the installation's own workspace and staff test workspaces." },
};

type PriceLike = { amount: number; currency: string; interval: "MONTH" | "YEAR"; perSeat: boolean };

/** "₹1,499.00 / month per person" — in the price's own currency, never converted. */
export function priceLine(p: PriceLike): string {
  return `${formatMoney(p.amount, p.currency)} / ${intervalLabel(p.interval)}${p.perSeat ? " per person" : ""}`;
}

/** "5 users per unit" — a plan's seats are for each unit of quantity a workspace takes. */
export function seatsText(seats: number | null): string {
  if (seats === null) return "No user limit";
  return `${plural(seats, "user")} per unit`;
}

/** Null is no limit and 0 is none — the difference between "unlimited" and "not included". */
export function copilotText(tokens: number | null): string {
  if (tokens === null) return "Unlimited copilot";
  if (tokens === 0) return "No copilot";
  return `${compactNumber(tokens)} copilot tokens a month`;
}

/** The product a plan sells, by name — or what it is without one. */
export function productText(plan: { kind: PlanKindKey; productKey: string | null }): string {
  const product = productByKey(plan.productKey);
  if (product) return product.key === "one" ? `${product.name} — every product` : product.name;
  return plan.kind === "EDITION" ? "No product — an edition of its own" : "No product";
}

/** Where a plan stands among the products: Deskzo One first, then products.ts's order, then none. */
export const productRank = (productKey: string | null) => {
  const i = PRODUCTS.findIndex((p) => p.key === productKey);
  return i < 0 ? PRODUCTS.length : i;
};

export function soldInText(countries: readonly string[]): string {
  return countries.length ? `Sold in: ${countries.join(", ")}` : "Sold everywhere";
}

/** The plan as the save takes it — so retiring it from a card saves exactly what is there, with only `active` changed. */
export function planInputOf(plan: PlanListRow): PlanInput {
  return {
    key: plan.key,
    name: plan.name,
    kind: plan.kind,
    description: plan.description,
    allModules: plan.allModules,
    modules: plan.modules,
    countries: plan.countries,
    seats: plan.seats,
    copilotTokens: plan.copilotTokens,
    customDomains: plan.customDomains,
    productKey: plan.productKey,
    isDefault: plan.isDefault,
    active: plan.active,
    sortOrder: plan.sortOrder,
  };
}

/** How many module chips a card shows before "+N more". */
const CHIPS = 6;

const EYEBROW = "text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase";
const CARD_ACTION = "inline-flex h-7 items-center gap-1 rounded-base px-2 text-xs font-medium text-muted hover:bg-surface-sunken hover:text-text";

export function PlanCards({ plans, catalogue, caps }: { plans: PlanListRow[]; catalogue: CatalogueModuleView[]; caps: Caps }) {
  const labels = new Map(catalogue.map((m) => [m.key, m.label]));
  const order = new Map(catalogue.map((m, i) => [m.key, i]));
  // Editions in product order; the rest as listed. A stable sort keeps the list's own order within a product.
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    plans: plans.filter((p) => p.kind === kind).sort((a, b) => (kind === "EDITION" ? productRank(a.productKey) - productRank(b.productKey) : 0)),
  })).filter((g) => g.plans.length > 0);

  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.kind} className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-sm font-semibold text-text">{KIND_GROUPS[group.kind].title}</h2>
            <span className="text-xs text-subtle tabular-nums">{group.plans.length}</span>
            <p className="w-full text-xs text-muted sm:w-auto">{KIND_GROUPS[group.kind].description}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {group.plans.map((plan) => (
              <PlanCard key={plan.id} plan={plan} labels={labels} order={order} caps={caps} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PlanCard({ plan, labels, order, caps }: { plan: PlanListRow; labels: Map<string, string>; order: Map<string, number>; caps: Caps }) {
  const internal = plan.kind === "INTERNAL";
  // Sellers change plans; an internal one only the owner (spec §2.3) — nobody else sees the controls.
  const editable = caps.sell && (!internal || caps.editInternalPlans);
  const modules = [...plan.modules].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  const shown = modules.slice(0, CHIPS);
  const more = modules.length - shown.length;
  const live = plan.prices.filter((p) => p.active);
  const href = `/plans/${encodeURIComponent(plan.key)}`;

  return (
    <article className={cn("flex min-w-0 flex-col rounded-xl border bg-surface shadow-sm", plan.active ? "border-line" : "border-dashed border-line-strong")}>
      <div className="px-5 pt-4">
        <h3 className="text-[15px] leading-snug font-semibold break-words">
          <Link href={href} className={cn("rounded-base hover:text-brand", plan.active ? "text-text" : "text-muted")}>
            {plan.name}
          </Link>
        </h3>
        <p className="mt-0.5 font-mono text-xs break-all text-muted">{plan.key}</p>
        {(plan.isDefault || !plan.active || internal) && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {plan.isDefault && (
              <StatusPill tone="brand" icon={<Star className="h-3 w-3" />}>
                Default for new workspaces
              </StatusPill>
            )}
            {!plan.active && <StatusPill tone="neutral">Retired</StatusPill>}
            {internal && <StatusPill tone="warning">Internal</StatusPill>}
          </div>
        )}
        {plan.description && <p className="mt-2.5 line-clamp-3 text-sm text-muted">{plan.description}</p>}
      </div>

      <div className="flex-1 space-y-4 px-5 pt-4 pb-4">
        <div>
          <p className={EYEBROW}>Modules</p>
          {plan.allModules ? (
            <p className="mt-1.5 text-sm text-text">Every module, including ones added later</p>
          ) : modules.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted">Only the basics every workspace has</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {shown.map((key) => (
                <li key={key} className="rounded-md border border-line bg-surface-sunken px-1.5 py-0.5 text-xs text-text">
                  {labels.get(key) ?? key}
                </li>
              ))}
              {more > 0 && (
                <li className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted">
                  <Link href={href} className="hover:text-brand">
                    +{more} more
                  </Link>
                </li>
              )}
            </ul>
          )}
        </div>

        <ul className="space-y-1 text-xs text-muted">
          {plan.kind === "EDITION" && (
            <li className={cn("flex items-center gap-2", plan.productKey ? "font-medium text-text" : "")}>
              <Boxes aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
              {productText(plan)}
            </li>
          )}
          <li className="flex items-center gap-2">
            <Users aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
            {seatsText(plan.seats)}
          </li>
          <li className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
            {copilotText(plan.copilotTokens)}
          </li>
          <li className="flex items-center gap-2">
            <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
            {soldInText(plan.countries)}
          </li>
        </ul>

        <div>
          <p className={EYEBROW}>Prices</p>
          {internal ? (
            <p className="mt-1.5 text-sm text-muted">Never sold</p>
          ) : live.length === 0 ? (
            <p className="mt-1.5 text-sm text-warning">Not on sale — no price yet</p>
          ) : (
            <ul className="mt-1.5 space-y-0.5">
              {live.map((price) => (
                <li key={price.id} className="text-sm text-text tabular-nums">
                  {priceLine(price)}
                  <span className="text-muted"> · {gatewayLabel(price.gateway)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line px-5 py-2.5">
        {plan.workspaces > 0 ? (
          <Link href={`/workspaces?plan=${encodeURIComponent(plan.key)}`} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
            On {plural(plan.workspaces, "workspace")}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span className="text-xs text-subtle">No workspaces yet</span>
        )}
        {editable && (
          <div className="-mr-2 flex flex-wrap items-center gap-0.5">
            <Link href={href} className={CARD_ACTION}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit
            </Link>
            <Link href={`/plans/new?from=${encodeURIComponent(plan.key)}`} className={CARD_ACTION}>
              <CopyPlus aria-hidden="true" className="h-3.5 w-3.5" />
              Duplicate
            </Link>
            <PlanCardActions plan={planInputOf(plan)} active={plan.active} />
          </div>
        )}
      </div>
    </article>
  );
}
