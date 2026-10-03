import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem, updateItemCustomFields } from "@/actions/item";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { formatItemId } from "@/lib/order-id";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { db } from "@/lib/db";
import { AdjustStockForm } from "@/components/items/adjust-stock-form";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CustomFieldsCard } from "@/components/custom-fields/custom-fields-card";
import { EditCustomFields } from "@/components/custom-fields/edit-custom-fields";
import { requireUser } from "@/lib/session";
import { displayFields, formSetup, valuesFor } from "@/lib/custom-fields/server";

const TYPE_TONE = { GOOD: "default", SERVICE: "blue", SUBSCRIPTION: "green", PERPETUAL: "amber" } as const;

export default async function ItemDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const enabled = await isModuleEnabled("items");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  const [{ id }, query] = await Promise.all([params, searchParams]);
  /**
   * The sequence resolves to the cuid before the action runs, so `getItem` keeps doing every check
   * it already did — this only translates the reference, it does not bypass anything. A sequence
   * that matches nothing falls through as the original segment and `getItem` answers null, which is
   * the same refusal a bad cuid gets.
   */
  const ref = parseRecordRef(id);
  const resolved =
    ref.kind === "seq"
      ? ((await db.item.findUnique({ where: { itemSeq: ref.seq }, select: { id: true } }))?.id ?? id)
      : ref.id;

  const item = await getItem(resolved);
  if (!item) notFound();
  const clock = await workspaceClock();

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/items", formatItemId(item.itemSeq), query);

  // The workspace's own fields (src/lib/custom-fields) — whoever may open the item may edit them, as
  // with the item itself.
  const user = await requireUser();
  const customValues = await valuesFor("ITEM", item.id);
  const [customShown, customForm] = await Promise.all([displayFields("ITEM", user.id, customValues), formSetup("ITEM", user.id, customValues)]);

  const lowStock =
    item.trackInventory && item.reorderLevel !== null && item.stockQuantity <= item.reorderLevel;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-text">{item.name}</h1>
            <Badge tone={TYPE_TONE[item.type]}>{item.type}</Badge>
            {!item.active && <Badge tone="red">Inactive</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatItemId(item.itemSeq)} · SKU {item.sku}
            {item.brand && ` · ${item.brand.name}`}
            {item.productFamily && ` ${item.productFamily.name}`}
            {item.category && ` · ${item.category}`}
            {item.vendor && ` · ${item.vendor}`}
          </p>
        </div>
        <Link href={`/items/${item.id}/edit`}>
          <Button variant="secondary">Edit</Button>
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-6">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Pricing</CardHeader>
            <CardContent className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-muted">Cost price</div>
                <div className="text-text">{formatCurrency(item.costPrice?.toString())}</div>
              </div>
              <div>
                <div className="text-muted">Selling price</div>
                <div className="text-text">{formatCurrency(item.sellingPrice.toString())}</div>
              </div>
              <div>
                <div className="text-muted">GST rate</div>
                <div className="text-text">
                  {item.taxRatePercent ? `${item.taxRatePercent}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-muted">HSN / SAC</div>
                {/* Said plainly when missing: the GST summary flags every invoice line without one. */}
                <div className={item.hsnCode ? "font-mono text-text" : "text-danger"}>{item.hsnCode ?? "Not set"}</div>
              </div>
              {item.billingCycle && (
                <div>
                  <div className="text-muted">Billing cycle</div>
                  <div className="text-text">{item.billingCycle.replaceAll("_", " ")}</div>
                </div>
              )}
              {item.unit && (
                <div>
                  <div className="text-muted">Unit</div>
                  <div className="text-text">{item.unit}</div>
                </div>
              )}
            </CardContent>
            {item.description && (
              <CardContent className="border-t border-line text-sm text-text">
                {item.description}
              </CardContent>
            )}
          </Card>

          {item.trackInventory && (
            <Card>
              <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
                <span>Stock movements</span>
                {lowStock && <Badge tone="amber">Low stock</Badge>}
              </CardHeader>
              <CardContent className="space-y-4">
                <AdjustStockForm itemId={item.id} />
                <div className="border-t border-line pt-3">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="py-1.5">Date</th>
                        <th className="py-1.5">Type</th>
                        <th className="py-1.5">Change</th>
                        <th className="py-1.5">Reason</th>
                        <th className="py-1.5">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.stockMovements.map((m) => (
                        <tr key={m.id} className="border-t border-line">
                          <td className="py-1.5 text-muted">{clock.date(m.createdAt)}</td>
                          <td className="py-1.5 text-muted">{m.type}</td>
                          <td className={`py-1.5 font-medium ${m.quantityChange >= 0 ? "text-success" : "text-danger"}`}>
                            {m.quantityChange >= 0 ? `+${m.quantityChange}` : m.quantityChange}
                          </td>
                          <td className="py-1.5 text-muted">{m.reason ?? "—"}</td>
                          <td className="py-1.5 text-muted">{m.createdBy.name}</td>
                        </tr>
                      ))}
                      {item.stockMovements.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-4 text-center text-subtle">
                            No stock movements yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <CustomFieldsCard
            groups={customShown}
            action={
              <EditCustomFields
                title={`More details — ${item.name}`}
                fields={customForm.fields}
                initial={customForm.values}
                people={customForm.people}
                save={updateItemCustomFields.bind(null, item.id)}
              />
            }
          />

          {item.trackInventory && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Stock on hand</CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold text-text">{item.stockQuantity}</div>
                {item.reorderLevel !== null && (
                  <p className="mt-1 text-sm text-muted">Reorder level: {item.reorderLevel}</p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="text-sm font-medium text-text">Details</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">Added by</span>
                <span className="text-text">{item.createdBy.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Added on</span>
                <span className="text-text">{clock.date(item.createdAt)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
