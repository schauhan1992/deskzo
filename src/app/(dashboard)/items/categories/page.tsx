import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { listItemCategoriesWithCounts } from "@/actions/item-category";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CategoriesManager } from "@/components/items/categories-manager";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The workspace's item categories — what the item form's Category picks from.
 *
 * Beside Brands & families, for the same reason: it is the catalogue's own vocabulary, kept by
 * whoever keeps the catalogue. Everybody who uses items can read it; changing it is `catalog.manage`.
 */
export default async function ItemCategoriesPage() {
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  const [categories, canManage] = await Promise.all([listItemCategoriesWithCounts(), viewerHas("catalog.manage")]);

  return (
    <div>
      <Link href="/items" className="text-sm text-muted hover:text-text">
        ← Items &amp; Inventory
      </Link>
      <div className="mt-1">
        <h1 className="text-xl font-semibold text-text">Item categories</h1>
        <p className="mt-1 text-sm text-muted">{categories.length} categor{categories.length === 1 ? "y" : "ies"}</p>
      </div>
      <p className="mt-3 max-w-3xl text-sm text-muted">
        What kind of goods or service each item is — Laptops, Software licences, AMC, Perpetual licence. Items pick one
        from this list, and the reports group by it. Renaming a category renames it on every item in it; a category with
        items in it can&apos;t be deleted until they&apos;re moved. Importing items adds any category the file names
        that isn&apos;t here yet{canManage ? "" : " (for someone who manages the catalogue)"}.
      </p>

      <Card className="mt-4 max-w-2xl">
        <CardContent>
          <CategoriesManager categories={categories} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  );
}
