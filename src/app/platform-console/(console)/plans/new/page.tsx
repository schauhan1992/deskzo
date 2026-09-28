import type { Metadata } from "next";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { PlanEditor } from "@/components/console/plans/plan-editor";
import { one } from "@/lib/console-shared/params";
import { SELLERS, capsFor } from "@/lib/console-shared/roles";
import { planDetail, plansList, type PlanDetail } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";
import { moduleCatalogue } from "@/lib/platform/plans";

export const metadata: Metadata = { title: "New plan" };

/** A key for the copy that no plan has yet: "crm-starter-copy", then "crm-starter-copy-2"… — within the 50 a key may have. */
function freeKey(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const key = `${base.slice(0, 50 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(key)) return key;
  }
  return "";
}

/**
 * A new plan (spec §3.10) — blank, or a copy of another (`?from=key`). A copy takes everything but
 * the prices, which are made at the gateway and belong to the plan they were made for, and it is
 * never the default: there is one default, and copying it should not quietly move it. Sellers only;
 * an internal plan is copied by the owner.
 */
export default async function ConsoleNewPlanPage({ searchParams }: PageProps<"/platform-console/plans/new">) {
  const staff = await consoleStaff(SELLERS);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const from = one(sp, "from", 100)?.toLowerCase();
  const [plans, source] = await Promise.all([plansList(), from ? planDetail(from) : Promise.resolve(null)]);
  const catalogue = moduleCatalogue();
  const takenKeys = plans.map((p) => p.key);

  const copyable = source && (source.kind !== "INTERNAL" || caps.editInternalPlans) ? source : null;
  const initial: PlanDetail | null = copyable
    ? {
        ...copyable,
        key: freeKey(copyable.key, new Set(takenKeys)),
        name: `${copyable.name} (copy)`.slice(0, 80),
        isDefault: false,
        active: true,
        prices: [],
        workspaces: 0,
        sample: [],
      }
    : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Plans", href: "/plans" }, { label: copyable ? `Copy of ${copyable.name}` : "New plan" }]}
        title={copyable ? `Copy of ${copyable.name}` : "New plan"}
        subtitle={
          copyable
            ? "Everything but its prices is copied. Prices are made at the gateway, so they are added once the copy exists."
            : "What a workspace on it may use, where it is sold and how many people it includes. Prices come next, once it exists."
        }
      />
      {from && !copyable && (
        <Banner tone="info" title={source ? "Internal plans are copied by an owner." : `There is no plan “${from}” to copy.`} className="mb-6">
          This starts from a blank plan instead.
        </Banner>
      )}
      <PlanEditor initial={initial} catalogue={catalogue} owner={caps.editInternalPlans} mode={copyable ? "duplicate" : "create"} readOnly={false} takenKeys={takenKeys} />
    </>
  );
}
