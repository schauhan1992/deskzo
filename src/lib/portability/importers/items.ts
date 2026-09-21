import { BillingCycle, ItemType } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * The catalog — everything we sell, whether it ships in a box, is billed by the hour or renews.
 *
 * Matched on the Key where the file carries one, then on SKU, and only then on name. SKU comes second
 * rather than last because the realistic import source here is a distributor's price list, and a
 * price list carries the supplier's part number, never our ITM- number. Name is the last resort: it
 * is not unique in the schema, so a row that matches two items is refused rather than applied to
 * whichever came back first — repricing the wrong laptop is not an error anybody notices in time.
 *
 * Brand and Family arrive as plain names, and a family belongs to a brand ("Pro" exists under more
 * than one). Where a row names a Family but leaves Brand empty, the brand already on the item is used
 * rather than the row being refused, so that an exported file always reads back; failing that, a row
 * naming the family the item is already in is left alone rather than refused, since an item may carry
 * a family with no brand of its own. Only when the family is genuinely new and no brand can be found
 * is the row an error: inventing the parent brand is how a catalog grows two of everything.
 *
 * Moving an item to a different brand without saying what happens to its family clears the family,
 * because a family belonging to the brand the item just left is the state `validateBrandFamily()`
 * refuses on the item's own screen and bulk edit clears for the same reason. The preview says so.
 */

type ResolvedItem = {
  /** Undefined throughout means the cell was blank: leave whatever is there alone. */
  name?: string;
  sku?: string;
  type?: ItemType;
  brandName?: string;
  familyName?: string;
  billingCycle?: BillingCycle;
  unit?: string;
  price?: number;
  taxRatePercent?: number;
  /** The item moves to another brand and says nothing about its family, so the family goes. */
  clearFamily?: boolean;
  existingId?: string;
  existingSeq?: number;
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedItem>> {
  const r = new RowReader(row);
  const name = r.text("Name");
  const sku = r.text("SKU");

  const type = r.enum("Type", ItemType);
  const billingCycle = r.enum("Billing cycle", BillingCycle);
  const price = r.number("Price");
  const taxRatePercent = r.number("Tax %");
  if (r.error) return { error: r.error };

  const lookup = {
    id: true,
    itemSeq: true,
    sku: true,
    brand: { select: { name: true } },
    productFamily: { select: { name: true, brand: { select: { name: true } } } },
  } as const;

  // A Key cell that is not a key at all is a typo, not an instruction to match on something else.
  // Falling through would quietly match by SKU — or create a second item — under a key the person
  // believed named an existing one.
  const keyCell = r.text("Key");
  const seq = seqFromKey("ITM", keyCell);
  if (keyCell && seq === null) {
    return { error: `Key "${keyCell}" isn't an item key. Use ITM-000001, or leave the cell empty to match on SKU.` };
  }

  let existing: {
    id: string;
    itemSeq: number;
    sku: string;
    brand: { name: string } | null;
    productFamily: { name: string; brand: { name: string } } | null;
  } | null = null;
  if (seq !== null) {
    existing = await db.item.findUnique({ where: { itemSeq: seq }, select: lookup });
    if (!existing) {
      return { error: `No item with key ${keyOf("ITM", seq)}. Remove the Key cell to create a new item.` };
    }
  } else if (sku) {
    existing = await db.item.findUnique({ where: { sku }, select: lookup });
  } else if (name) {
    const matches = await db.item.findMany({
      where: { name: { equals: name, mode: "insensitive" } },
      select: lookup,
      take: 2,
    });
    if (matches.length > 1) {
      return { error: `More than one item is named "${name}". Add its SKU or its Key so the row says which one.` };
    }
    existing = matches[0] ?? null;
  } else {
    return { error: "Name is required — a row needs a Key, a SKU or a Name to say which item it is." };
  }

  // Moving a SKU onto an item that already answers to a different one collides with the unique
  // constraint. Caught here so it reads as a row somebody can fix, not a database error mid-import.
  if (existing && sku && existing.sku !== sku) {
    const clash = await db.item.findUnique({ where: { sku }, select: { itemSeq: true, name: true } });
    if (clash) {
      return { error: `SKU "${sku}" already belongs to ${keyOf("ITM", clash.itemSeq)} (${clash.name}).` };
    }
  }

  const brandCell = r.text("Brand");
  const familyCell = r.text("Family");
  const brandName = brandCell || existing?.brand?.name || undefined;
  const currentFamily = existing?.productFamily ?? null;

  // A row naming the family the item is already in needs no brand to say which family that is — and
  // an item can have a family while its own brandId is null, so the exported form of one would
  // otherwise be unreadable back.
  const familyAlreadySet =
    !!familyCell &&
    !!currentFamily &&
    sameText(currentFamily.name, familyCell) &&
    (!brandName || sameText(currentFamily.brand.name, brandName));

  let familyName: string | undefined;
  let clearFamily = false;
  if (familyCell && !familyAlreadySet) {
    if (!brandName) {
      return { error: `Family "${familyCell}" also needs a Brand — a product family belongs to one, and the same line name exists under several brands.` };
    }
    familyName = familyCell;
  } else if (!familyCell && currentFamily && brandName && !sameText(currentFamily.brand.name, brandName)) {
    clearFamily = true;
  }

  if (!existing) {
    if (!name) return { error: "Name is required to create an item." };
    if (!sku) return { error: `SKU is required to create "${name}". It is what the next price list will be matched on.` };
    if (!type) return { error: `Type is required to create "${name}". One of: ${Object.keys(ItemType).join(", ")}.` };
    if (price === undefined) return { error: `Price is required to create "${name}".` };
  }

  return {
    value: {
      name: name || undefined,
      sku: sku || undefined,
      type,
      brandName,
      familyName,
      billingCycle,
      unit: r.text("Unit") || undefined,
      price,
      taxRatePercent,
      clearFamily,
      existingId: existing?.id,
      existingSeq: existing?.itemSeq,
    },
  };
}

export const itemsImporter: Importer = {
  templateColumns: ["Key", "Name", "SKU", "Type", "Brand", "Family", "Billing cycle", "Unit", "Price", "Tax %"],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name || row.SKU || "", resolved.error);
    const i = resolved.value;

    if (!i.existingId) {
      return createRow(line, i.sku!, i.name!, {
        Name: i.name,
        SKU: i.sku,
        Type: i.type,
        Brand: i.brandName,
        Family: i.familyName,
        "Billing cycle": i.billingCycle,
        Unit: i.unit,
        Price: i.price,
        "Tax %": i.taxRatePercent,
      });
    }

    const existing = await db.item.findUniqueOrThrow({
      where: { id: i.existingId },
      include: { brand: { select: { name: true } }, productFamily: { select: { name: true } } },
    });

    return updateRow(line, keyOf("ITM", i.existingSeq!), i.name ?? existing.name, [
      i.name ? diff("Name", existing.name, i.name) : null,
      i.sku ? diff("SKU", existing.sku, i.sku) : null,
      i.type ? diff("Type", existing.type, i.type) : null,
      i.brandName ? diff("Brand", existing.brand?.name, i.brandName) : null,
      i.familyName ? diff("Family", existing.productFamily?.name, i.familyName) : null,
      i.clearFamily ? diff("Family", existing.productFamily?.name, "") : null,
      i.billingCycle ? diff("Billing cycle", existing.billingCycle, i.billingCycle) : null,
      i.unit ? diff("Unit", existing.unit, i.unit) : null,
      // Through Number on both sides: a Decimal and the number read out of the cell are the same
      // price, and comparing their text would report 68000.00 → 68000 as an edit on every run.
      i.price !== undefined ? diff("Price", Number(existing.sellingPrice), i.price) : null,
      i.taxRatePercent !== undefined
        ? diff("Tax %", existing.taxRatePercent === null ? null : Number(existing.taxRatePercent), i.taxRatePercent)
        : null,
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const i = resolved.value;

    // The two writes the planner could not make for itself: a brand and a line the file names but the
    // catalog has never carried. Done here rather than in resolve() so that planning stays read-only.
    const brand = i.brandName
      ? await db.brand.upsert({ where: { name: i.brandName }, update: {}, create: { name: i.brandName } })
      : null;
    const family =
      brand && i.familyName
        ? await db.productFamily.upsert({
            where: { brandId_name: { brandId: brand.id, name: i.familyName } },
            update: {},
            create: { brandId: brand.id, name: i.familyName },
          })
        : null;

    const data = {
      ...(i.name ? { name: i.name } : {}),
      ...(i.sku ? { sku: i.sku } : {}),
      ...(i.type ? { type: i.type } : {}),
      ...(brand ? { brandId: brand.id } : {}),
      ...(family ? { productFamilyId: family.id } : {}),
      ...(i.clearFamily ? { productFamilyId: null } : {}),
      ...(i.billingCycle ? { billingCycle: i.billingCycle } : {}),
      ...(i.unit ? { unit: i.unit } : {}),
      ...(i.price !== undefined ? { sellingPrice: i.price } : {}),
      ...(i.taxRatePercent !== undefined ? { taxRatePercent: i.taxRatePercent } : {}),
    };

    if (i.existingId) {
      await db.item.update({ where: { id: i.existingId }, data });
    } else {
      // resolve() refuses a create that is missing any of these, so they are present here.
      await db.item.create({
        data: {
          ...data,
          name: i.name!,
          sku: i.sku!,
          type: i.type!,
          sellingPrice: i.price!,
          createdById: ctx.actorUserId,
        },
      });
    }
  },
};
