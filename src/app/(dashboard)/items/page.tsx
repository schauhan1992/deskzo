import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { listItems } from "@/actions/item";
import { listItemCategories } from "@/actions/item-category";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { listBrands } from "@/actions/brand";
import { itemTypeValues } from "@/lib/validation/item";
import { PAGE_SIZES, resolvePage, resolvePageSize } from "@/lib/pagination";
import { OptionParamFilter } from "@/components/ui/option-param-filter";
import { Pagination } from "@/components/ui/pagination";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ExportItemsButton } from "@/components/items/export-items-button";
import { ImportItemsDialog } from "@/components/items/import-items-dialog";
import { ItemsTable } from "@/components/items/items-table";
import { requireUser } from "@/lib/session";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { CustomFieldFilters } from "@/components/custom-fields/custom-field-filters";
import type { ItemType } from "@prisma/client";

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; brandId?: string; category?: string; q?: string; page?: string; pageSize?: string; hsn?: string } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const params = await searchParams;
  const type = (itemTypeValues as readonly string[]).includes(params.type ?? "") ? (params.type as ItemType) : undefined;
  const customFilters = parseCustomFilters(params);
  // Carried by the search form and the type chips, which rebuild the query from the page's own parameters.
  const fieldParams = customFilterParams(params);
  const [result, brands, categories, subscriptions] = await Promise.all([
    listItems({
      type,
      brandId: params.brandId,
      category: params.category,
      search: params.q,
      page: resolvePage(params.page),
      pageSize: resolvePageSize(params.pageSize),
      customFilters,
      // In India, every code against the GST directory: the banner's count, and "?hsn=fix" for the list.
      checkHsn: true,
      hsnToFix: params.hsn === "fix",
    }),
    listBrands(),
    listItemCategories(),
    // Subscriptions are offered only where Renewals is (Deskzo Subscriptions, or One).
    moduleAvailableForTenant("renewals"),
  ]);
  const user = await requireUser();
  // The workspace's own fields: the ones marked "a column in the list" (this table has no column
  // picker), and the filter panel.
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("ITEM", user.id, result.items.map((i) => i.id), { listedOnly: true }),
    customFilterSetup("ITEM", user.id, customFilters),
  ]);

  // The workspace's own word for an item (Settings → Wording).
  const wording = await getWording();

  const typeFilters: { label: string; value?: ItemType }[] = [
    { label: "All" },
    { label: "Goods", value: "GOOD" },
    { label: "Services", value: "SERVICE" },
    ...(subscriptions || params.type === "SUBSCRIPTION" ? [{ label: "Subscriptions", value: "SUBSCRIPTION" as const }] : []),
  ];

  // Changing a filter has to drop the page number, or filtering while on page 3 lands on an
  // out-of-range page for the new result set.
  function filterQuery(overrides: Record<string, string | undefined>) {
    const next = {
      ...fieldParams,
      type: params.type,
      q: params.q,
      brandId: params.brandId,
      category: params.category,
      pageSize: params.pageSize,
      hsn: params.hsn,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">{slot(wording, "Items & Inventory", "item", "{many} & Inventory")}</h1>
          <p className="mt-1 text-sm text-muted">
            {result.total} {slot(wording, "item(s) in the catalog", "item", "{one:lower}(s) in the catalog")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/items/brands">
            <Button variant="ghost">Brands &amp; families</Button>
          </Link>
          <Link href="/items/categories">
            <Button variant="ghost">Categories</Button>
          </Link>
          <ImportItemsDialog />
          <ExportItemsButton />
          <Link href="/items/new">
            <Button>{slot(wording, "New item", "item", "New {one:lower}")}</Button>
          </Link>
        </div>
      </div>

      <form className="mt-4 flex items-center gap-3">
        {/* Kept out of the browser’s autofill, for the reason set out in SearchParamInput. */}
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          aria-label={slot(wording, "Search items", "item", "Search {many:lower}")}
          placeholder="Search name, SKU, or ITM-000123…"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          className="h-9 w-72 rounded-md border border-line-strong px-3 text-sm"
        />
        {params.type && <input type="hidden" name="type" value={params.type} />}
        {params.brandId && <input type="hidden" name="brandId" value={params.brandId} />}
        {params.category && <input type="hidden" name="category" value={params.category} />}
        {params.pageSize && <input type="hidden" name="pageSize" value={params.pageSize} />}
        {params.hsn && <input type="hidden" name="hsn" value={params.hsn} />}
        {Object.entries(fieldParams).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <OptionParamFilter
          paramName="brandId"
          label="Brand"
          listLabel="Brands"
          options={brands.map((b) => ({ id: b.id, name: b.name }))}
          placeholder="All brands — type to search"
        />
        <OptionParamFilter
          paramName="category"
          label="Category"
          listLabel="Categories"
          options={categories.map((c) => ({ id: c.name, name: c.name }))}
          placeholder="All categories — type to search"
        />
        <CustomFieldFilters setup={fieldFilters} />
      </div>

      <div className="mt-4 flex gap-2">
        {typeFilters.map((f) => (
          <Link
            key={f.label}
            href={{ pathname: "/items", query: filterQuery({ type: f.value, page: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              params.type === f.value || (!params.type && !f.value)
                ? "bg-brand text-brand-contrast"
                : "bg-surface text-muted border border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {/* Items whose HSN/SAC is missing, the wrong kind, or not a code the GST portal lists — every
          invoice line for them carries it, and the GST return groups by it. */}
      {(result.hsnToFix > 0 || params.hsn === "fix") && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-text" role="status">
          <span>
            {params.hsn === "fix"
              ? `Showing the ${result.hsnToFix} item${result.hsnToFix === 1 ? "" : "s"} whose HSN/SAC needs fixing — missing, the wrong kind, or not in the GST portal's directory.`
              : `${result.hsnToFix} item${result.hsnToFix === 1 ? " needs its" : "s need their"} HSN/SAC fixed — missing, the wrong kind, or not in the GST portal's directory.`}
          </span>
          <Link
            href={{ pathname: "/items", query: filterQuery({ hsn: params.hsn === "fix" ? undefined : "fix", page: undefined }) }}
            className="font-medium text-brand hover:underline"
          >
            {params.hsn === "fix" ? slot(wording, "Show every item", "item", "Show every {one:lower}") : "Show them"}
          </Link>
        </div>
      )}

      <div className="mt-6">
        <ItemsTable
          items={result.items}
          brands={brands}
          customColumns={customColumns}
          hsnProblems={result.hsnProblems}
          categories={categories}
          subscriptions={subscriptions}
        />
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          totalPages={result.totalPages}
          pageSizes={PAGE_SIZES}
        />
      </div>
    </div>
  );
}
