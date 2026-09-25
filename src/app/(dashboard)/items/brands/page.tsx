import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { listBrandsPaged } from "@/actions/brand";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { BrandsManager } from "@/components/items/brands-manager";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

/**
 * The catalogue's brands and their product families.
 *
 * Here rather than on Settings → Lists, where it used to be one card among four: a reseller's
 * catalogue runs to a thousand brands, which is a list to be searched and paged through by whoever
 * keeps the catalogue — work that belongs with the items it describes, not with configuration.
 *
 * Everybody who uses items can read it; changing it is `catalog.manage`, as it always was.
 */
export default async function BrandsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const q = params.q?.trim() || undefined;
  const [result, canManage] = await Promise.all([listBrandsPaged({ q, page, pageSize }), viewerHas("catalog.manage")]);

  return (
    <div>
      <Link href="/items" className="text-sm text-muted hover:text-text">
        ← Items &amp; Inventory
      </Link>
      <div className="mt-1">
        <h1 className="text-xl font-semibold text-text">Brands &amp; product families</h1>
        <p className="mt-1 text-sm text-muted">
          {result.total} brand(s) · {result.families} product family(ies)
          {q ? ` matching “${q}”` : ""}
        </p>
      </div>
      <p className="mt-3 max-w-3xl text-sm text-muted">
        Who makes the products you sell, and the lines within each brand — Microsoft &rarr; Microsoft 365, Autodesk
        &rarr; AutoCAD. Items pick a brand and then one of its families. Importing items adds any brand or family the
        file names that isn&apos;t here yet{canManage ? "" : " (for someone who manages the catalogue)"}.
      </p>

      <div className="mt-4">
        <SearchParamInput paramName="q" placeholder="Search brands or product families…" className="w-80" />
      </div>

      <Card className="mt-4">
        <CardContent>
          <BrandsManager brands={result.rows} canManage={canManage} />
        </CardContent>
      </Card>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
        label="brands"
      />
    </div>
  );
}
