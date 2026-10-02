import Link from "next/link";
import { listItems } from "@/actions/item";
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
  searchParams: Promise<{ type?: string; brandId?: string; q?: string; page?: string; pageSize?: string } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const params = await searchParams;
  const type = itemTypeValues.includes(params.type as ItemType) ? (params.type as ItemType) : undefined;
  const customFilters = parseCustomFilters(params);
  // Carried by the search form and the type chips, which rebuild the query from the page's own parameters.
  const fieldParams = customFilterParams(params);
  const [result, brands] = await Promise.all([
    listItems({
      type,
      brandId: params.brandId,
      search: params.q,
      page: resolvePage(params.page),
      pageSize: resolvePageSize(params.pageSize),
      customFilters,
    }),
    listBrands(),
  ]);
  const user = await requireUser();
  // The workspace's own fields: the ones marked "a column in the list" (this table has no column
  // picker), and the filter panel.
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("ITEM", user.id, result.items.map((i) => i.id), { listedOnly: true }),
    customFilterSetup("ITEM", user.id, customFilters),
  ]);

  const typeFilters: { label: string; value?: ItemType }[] = [
    { label: "All" },
    { label: "Goods", value: "GOOD" },
    { label: "Services", value: "SERVICE" },
    { label: "Subscriptions", value: "SUBSCRIPTION" },
    { label: "Perpetual", value: "PERPETUAL" },
  ];

  // Changing a filter has to drop the page number, or filtering while on page 3 lands on an
  // out-of-range page for the new result set.
  function filterQuery(overrides: Record<string, string | undefined>) {
    const next = {
      ...fieldParams,
      type: params.type,
      q: params.q,
      brandId: params.brandId,
      pageSize: params.pageSize,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Items & Inventory</h1>
          <p className="mt-1 text-sm text-muted">{result.total} item(s) in the catalog</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/items/brands">
            <Button variant="ghost">Brands &amp; families</Button>
          </Link>
          <ImportItemsDialog />
          <ExportItemsButton />
          <Link href="/items/new">
            <Button>New item</Button>
          </Link>
        </div>
      </div>

      <form className="mt-4 flex items-center gap-3">
        {/* Kept out of the browser’s autofill, for the reason set out in SearchParamInput. */}
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          aria-label="Search items"
          placeholder="Search name, SKU, or ITM-000123…"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          className="h-9 w-72 rounded-md border border-line-strong px-3 text-sm"
        />
        {params.type && <input type="hidden" name="type" value={params.type} />}
        {params.brandId && <input type="hidden" name="brandId" value={params.brandId} />}
        {params.pageSize && <input type="hidden" name="pageSize" value={params.pageSize} />}
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

      <div className="mt-6">
        <ItemsTable items={result.items} brands={brands} customColumns={customColumns} />
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
