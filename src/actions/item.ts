"use server";

import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { Prisma, type ItemType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { desanitizeCsvCell, sanitizeCsvCell, csvFilename } from "@/lib/csv";
import {
  createItemSchema,
  updateItemSchema,
  adjustStockSchema,
  importItemRowSchema,
  bulkUpdateItemsSchema,
} from "@/lib/validation/item";
import { parseSeqQuery, formatItemId } from "@/lib/order-id";
import { DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import { recordAudit } from "@/lib/audit";
import { changedLabel, customFieldsForCreate, customSearchWhere, fieldsFor, saveCustomFields, valuesFor } from "@/lib/custom-fields/server";
import { customSheetFor, exportCells } from "@/lib/custom-fields/sheets";
import { hasEffectivePermission } from "@/actions/permission";
import { canonicalColumn, cleanName, nameKey } from "@/lib/items/catalogue-import";
import type { ActionResult } from "@/actions/company";

const FIXED_DIRECTION: Partial<Record<string, 1 | -1>> = {
  RECEIVED: 1,
  RETURNED: 1,
  SOLD: -1,
  DAMAGED: -1,
};

async function requireItemsModule(): Promise<string | null> {
  const enabled = await isModuleEnabled("items");
  return enabled ? null : "The Items & Inventory module is disabled.";
}

/**
 * A product family belongs to one brand, so an item can't claim a family from a different brand —
 * the form chains its two pickers, but the action is where that actually has to hold.
 */
async function validateBrandFamily(brandId?: string, productFamilyId?: string): Promise<string | null> {
  if (!productFamilyId) return null;
  if (!brandId) return "Pick the brand this product family belongs to.";
  const family = await db.productFamily.findUnique({ where: { id: productFamilyId }, select: { brandId: true } });
  if (!family) return "That product family no longer exists.";
  if (family.brandId !== brandId) return "That product family belongs to a different brand.";
  return null;
}

export async function createItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { openingStock, billingCycle, ...rest } = parsed.data;
  // Only goods can track inventory — the "track inventory" field is hidden (not cleared) in the
  // form for other types, so the server is the authoritative place this gets enforced.
  const trackInventory = rest.type === "GOOD" && rest.trackInventory;
  const familyError = await validateBrandFamily(rest.brandId, rest.productFamilyId);
  if (familyError) {
    return { ok: false, error: familyError };
  }
  const custom = await customFieldsForCreate("ITEM", user.id, parsed.data.customFields);
  if (!custom.ok) return { ok: false, error: custom.error };
  // The revenue pattern is Revenue & Close's: without it the field isn't on the form, and is ignored.
  const revenueCapture = await isModuleEnabled("revenue_close");

  try {
    const item = await db.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: {
          name: rest.name.trim(),
          sku: rest.sku.trim(),
          type: rest.type,
          category: rest.category || null,
          hsnCode: rest.hsnCode || null,
          vendor: rest.vendor || null,
          brandId: rest.brandId || null,
          productFamilyId: rest.productFamilyId || null,
          unit: rest.unit || null,
          billingCycle: billingCycle || null,
          costPrice: rest.costPrice ?? null,
          sellingPrice: rest.sellingPrice,
          taxRatePercent: rest.taxRatePercent ?? null,
          description: rest.description || null,
          trackInventory,
          reorderLevel: trackInventory ? (rest.reorderLevel ?? null) : null,
          active: rest.active,
          createdById: user.id,
          stockQuantity: trackInventory && openingStock ? openingStock : 0,
          revenuePattern: revenueCapture ? rest.revenuePattern || null : null,
          ...custom.data,
        },
      });

      if (trackInventory && openingStock) {
        await tx.stockMovement.create({
          data: {
            itemId: created.id,
            type: "RECEIVED",
            quantityChange: openingStock,
            reason: "Opening stock",
            createdByUserId: user.id,
          },
        });
      }

      return created;
    });

    revalidatePath("/items");
    return { ok: true, data: { id: item.id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "An item with this SKU already exists." };
    }
    throw err;
  }
}

export async function updateItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, billingCycle, ...rest } = parsed.data;
  // Only goods can track inventory — see the matching note in createItem.
  const trackInventory = rest.type === "GOOD" && rest.trackInventory;
  const familyError = await validateBrandFamily(rest.brandId, rest.productFamilyId);
  if (familyError) {
    return { ok: false, error: familyError };
  }
  // Written only where Revenue & Close is available; otherwise the stored pattern is left as it is.
  const revenueCapture = await isModuleEnabled("revenue_close");

  try {
    await db.item.update({
      where: { id },
      data: {
        name: rest.name.trim(),
        sku: rest.sku.trim(),
        type: rest.type,
        category: rest.category || null,
        hsnCode: rest.hsnCode || null,
        vendor: rest.vendor || null,
        brandId: rest.brandId || null,
        productFamilyId: rest.productFamilyId || null,
        unit: rest.unit || null,
        billingCycle: billingCycle || null,
        costPrice: rest.costPrice ?? null,
        sellingPrice: rest.sellingPrice,
        taxRatePercent: rest.taxRatePercent ?? null,
        description: rest.description || null,
        trackInventory,
        reorderLevel: rest.reorderLevel ?? null,
        active: rest.active,
        ...(revenueCapture ? { revenuePattern: rest.revenuePattern || null } : {}),
      },
    });

    revalidatePath("/items");
    revalidatePath(`/items/${id}`);
    return { ok: true, data: { id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "An item with this SKU already exists." };
    }
    throw err;
  }
}

/**
 * The item's own fields (src/lib/custom-fields), from the "More details" card on its page — bound to
 * the item there. Whoever may edit the item may change them, as `updateItem` decides it.
 */
export async function updateItemCustomFields(itemId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };
  const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true, name: true } });
  if (!item) return { ok: false, error: "That item no longer exists." };
  const saved = await saveCustomFields("ITEM", item.id, user.id, input);
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Item", entityId: item.id, entityLabel: `${item.name}${changedLabel(saved.changed)}` });
    revalidatePath("/items");
    revalidatePath(`/items/${item.id}`);
  }
  return { ok: true, data: null };
}

export async function adjustStock(input: unknown): Promise<ActionResult<{ stockQuantity: number }>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };
  const parsed = adjustStockSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { itemId, type, direction, quantity, reason } = parsed.data;

  const item = await db.item.findUnique({ where: { id: itemId } });
  if (!item) {
    return { ok: false, error: "Item not found." };
  }
  if (!item.trackInventory) {
    return { ok: false, error: "This item doesn't track inventory." };
  }

  const sign = type === "ADJUSTMENT" ? (direction === "OUT" ? -1 : 1) : (FIXED_DIRECTION[type] ?? 1);
  const quantityChange = sign * quantity;
  const nextQuantity = item.stockQuantity + quantityChange;

  if (nextQuantity < 0) {
    return { ok: false, error: `Not enough stock — only ${item.stockQuantity} on hand.` };
  }

  await db.$transaction(async (tx) => {
    await tx.stockMovement.create({
      data: { itemId, type, quantityChange, reason: reason || null, createdByUserId: user.id },
    });
    await tx.item.update({ where: { id: itemId }, data: { stockQuantity: nextQuantity } });
  });

  revalidatePath(`/items/${itemId}`);
  revalidatePath("/items");
  return { ok: true, data: { stockQuantity: nextQuantity } };
}

export async function listItems(params?: {
  type?: ItemType;
  brandId?: string;
  search?: string;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const user = await requireModuleUser("items");

  const seq = params?.search ? parseSeqQuery(params.search) : null;
  // The workspace's own fields this person may see, searched too (src/lib/custom-fields/server.ts).
  const customBranches = await customSearchWhere("ITEM", user.id, params?.search);
  const where = {
    ...(params?.type ? { type: params.type } : {}),
    ...(params?.brandId ? { brandId: params.brandId } : {}),
    ...(params?.activeOnly ? { active: true } : {}),
    ...(params?.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" as const } },
            { sku: { contains: params.search, mode: "insensitive" as const } },
            // "ITM-000012" or plain "12" finds that catalog number.
            ...(seq !== null ? [{ itemSeq: seq }] : []),
            ...(customBranches as Prisma.ItemWhereInput[]),
          ],
        }
      : {}),
  };

  const pageSize = params?.pageSize ?? DEFAULT_PAGE_SIZE;
  const total = await db.item.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp rather than return an empty page when a filter shrinks the result set under the
  // page number still sitting in the URL.
  const page = Math.min(Math.max(params?.page ?? 1, 1), totalPages);

  const items = await db.item.findMany({
    where,
    orderBy: { itemSeq: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: {
      brand: { select: { id: true, name: true } },
      productFamily: { select: { id: true, name: true } },
    },
  });

  return { items: toPlain(items), total, page, pageSize, totalPages };
}

/**
 * Apply one or more field changes to a set of items at once. Only the fields actually passed are
 * touched, so "assign a brand" doesn't quietly blank out everything else.
 */
export async function bulkUpdateItems(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };

  const parsed = bulkUpdateItemsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { itemIds, brandId, productFamilyId, type, category, active } = parsed.data;

  // "clear" is how the form asks for null, since an empty select value means "leave alone".
  const nextBrandId = brandId === "clear" ? null : brandId || undefined;
  const nextFamilyId = productFamilyId === "clear" ? null : productFamilyId || undefined;

  if (nextFamilyId) {
    const familyError = await validateBrandFamily(nextBrandId ?? undefined, nextFamilyId);
    if (familyError) return { ok: false, error: familyError };
  }
  // Moving items to a different brand would orphan their family on the old one.
  const clearFamilyWithBrand = nextBrandId !== undefined && !nextFamilyId;

  const data = {
    ...(brandId ? { brandId: nextBrandId } : {}),
    ...(nextFamilyId ? { productFamilyId: nextFamilyId } : {}),
    ...(clearFamilyWithBrand ? { productFamilyId: null } : {}),
    ...(productFamilyId === "clear" ? { productFamilyId: null } : {}),
    ...(type ? { type } : {}),
    ...(category ? { category: category === "clear" ? null : category } : {}),
    ...(active ? { active: active === "true" } : {}),
  };

  if (Object.keys(data).length === 0) {
    return { ok: false, error: "Pick at least one change to apply." };
  }

  const result = await db.item.updateMany({ where: { id: { in: itemIds } }, data });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Item",
    entityId: itemIds[0],
    entityLabel: `Bulk update of ${result.count} item(s)`,
  });

  revalidatePath("/items", "layout");
  return { ok: true, data: { count: result.count } };
}

/** What an item picker needs — the order form prices and taxes the line from these. */
const ITEM_OPTION_SELECT = {
  id: true,
  name: true,
  sku: true,
  type: true,
  unit: true,
  sellingPrice: true,
  taxRatePercent: true,
} as const;

/**
 * Every active item, for the item pickers. `take` stops at that many rows, for a picker that searches
 * the server for the rest (`searchItemOptions`) — ask for one more than you show, and the extra row
 * says the list is incomplete.
 */
export async function listItemOptions(params?: { take?: number }) {
  await requireModuleUser("items");
  const take = params?.take;
  return toPlain(
    await db.item.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      // A positive whole number or no limit: whatever else a caller sends is ignored, not queried with.
      ...(typeof take === "number" && Number.isInteger(take) && take > 0 ? { take } : {}),
      select: ITEM_OPTION_SELECT,
    }),
  );
}

/** How many items one search answers with — the picker says so when the cap bites. */
const ITEM_SEARCH_LIMIT = 20;

/**
 * Active items whose name or SKU contains what was typed, for the order form's product picker once the
 * catalogue is too long to send to the browser whole. Two characters at least, the first twenty by
 * name — the same fields `listItemOptions` gives, and the brand the item belongs to.
 */
export async function searchItemOptions(query: string) {
  await requireModuleUser("items");
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  return toPlain(
    await db.item.findMany({
      where: {
        active: true,
        OR: [{ name: { contains: typed, mode: "insensitive" } }, { sku: { contains: typed, mode: "insensitive" } }],
      },
      orderBy: { name: "asc" },
      take: ITEM_SEARCH_LIMIT,
      select: { ...ITEM_OPTION_SELECT, brandId: true },
    }),
  );
}

export async function getItem(id: string) {
  await requireModuleUser("items");
  const item = await db.item.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      productFamily: { select: { id: true, name: true } },
      stockMovements: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { createdBy: { select: { id: true, name: true } } },
      },
    },
  });
  return item ? toPlain(item) : null;
}

/**
 * The custom-field labels the items CSV would read as one of its own columns ("Price" is the selling
 * price there) — their columns are headed "… (custom)" instead, in the export and the import alike.
 */
async function csvBuiltIns(userId: string): Promise<string[]> {
  const { visible } = await fieldsFor("ITEM", userId);
  return visible.map((d) => d.label).filter((label) => canonicalColumn(label) !== label.trim());
}

export async function exportItemsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };

  const items = await db.item.findMany({
    orderBy: { name: "asc" },
    include: { brand: { select: { name: true } }, productFamily: { select: { name: true } } },
  });
  const rows = items.map((item) => ({
    itemId: formatItemId(item.itemSeq),
    name: sanitizeCsvCell(item.name),
    sku: sanitizeCsvCell(item.sku),
    type: item.type,
    category: sanitizeCsvCell(item.category ?? ""),
    hsnCode: item.hsnCode ?? "",
    vendor: sanitizeCsvCell(item.vendor ?? ""),
    brand: sanitizeCsvCell(item.brand?.name ?? ""),
    productFamily: sanitizeCsvCell(item.productFamily?.name ?? ""),
    unit: sanitizeCsvCell(item.unit ?? ""),
    billingCycle: item.billingCycle ?? "",
    costPrice: item.costPrice?.toString() ?? "",
    sellingPrice: item.sellingPrice.toString(),
    taxRatePercent: item.taxRatePercent?.toString() ?? "",
    description: sanitizeCsvCell(item.description ?? ""),
    trackInventory: item.trackInventory ? "true" : "false",
    stockQuantity: item.stockQuantity.toString(),
    reorderLevel: item.reorderLevel?.toString() ?? "",
    active: item.active ? "true" : "false",
  }));
  // The workspace's own fields this person may see, after the built-in columns — headed by label, as
  // the import reads them back (src/lib/custom-fields/sheets.ts).
  const custom = await exportCells("ITEM", user.id, items.map((item) => item.id), await csvBuiltIns(user.id), { sanitize: sanitizeCsvCell });
  const withCustom = rows.map((row, n) => Object.assign(row, custom(items[n]!.id)));

  const csv = Papa.unparse(withCustom);
  return { ok: true, data: { csv, filename: csvFilename("items-export") } };
}

export type ImportItemsResult = {
  created: number;
  updated: number;
  errors: { row: number; message: string }[];
  /** Brands the file named that were not in the catalogue, and were added to it. */
  brandsCreated: string[];
  /** The same for product families, as "Brand → Family". */
  familiesCreated: string[];
};

type CatalogueBrand = { id: string; name: string; families: Map<string, string> };

/**
 * The catalogue's brands and families, looked up by `nameKey` and added to as the file names new
 * ones — so a brand that appears on two hundred rows is created once, on the first, and "DELL" on
 * row 40 is the "Dell" created on row 3.
 *
 * Only somebody who holds `catalog.manage` adds to it, the same permission the Brands page asks for.
 * Anybody else still gets every row whose brand and family already exist; a row naming one that
 * does not is refused with the name, rather than the item landing without the brand it asked for.
 */
async function catalogueResolver(canCreate: boolean, result: ImportItemsResult) {
  const brands = await db.brand.findMany({
    select: { id: true, name: true, families: { select: { id: true, name: true } } },
  });
  const byName = new Map<string, CatalogueBrand>();
  const byId = new Map<string, CatalogueBrand>();
  for (const b of brands) {
    const entry = { id: b.id, name: b.name, families: new Map(b.families.map((f) => [nameKey(f.name), f.id])) };
    byName.set(nameKey(b.name), entry);
    byId.set(b.id, entry);
  }

  async function brand(name: string): Promise<CatalogueBrand | { error: string }> {
    const found = byName.get(nameKey(name));
    if (found) return found;
    const stored = cleanName(name);
    if (!canCreate) {
      return { error: `Brand "${stored}" isn't in the catalogue — add it under Items & Inventory → Brands, or ask someone who manages the catalogue.` };
    }
    let row: { id: string; name: string } | null = null;
    try {
      row = await db.brand.create({ data: { name: stored }, select: { id: true, name: true } });
      result.brandsCreated.push(stored);
    } catch (err) {
      // Added by somebody else since this import started.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      row = await db.brand.findFirst({ where: { name: { equals: stored, mode: "insensitive" } }, select: { id: true, name: true } });
      if (!row) throw err;
    }
    const entry = { id: row.id, name: row.name, families: new Map<string, string>() };
    byName.set(nameKey(row.name), entry);
    byId.set(row.id, entry);
    return entry;
  }

  async function family(brandId: string, name: string): Promise<{ id: string } | { error: string }> {
    let owner = byId.get(brandId);
    if (!owner) {
      // A brand added since the import began, reached through an existing item.
      const b = await db.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, families: { select: { id: true, name: true } } } });
      if (!b) return { error: "That item's brand no longer exists." };
      owner = { id: b.id, name: b.name, families: new Map(b.families.map((f) => [nameKey(f.name), f.id])) };
      byId.set(b.id, owner);
      byName.set(nameKey(b.name), owner);
    }
    const found = owner.families.get(nameKey(name));
    if (found) return { id: found };
    const stored = cleanName(name);
    if (!canCreate) {
      return { error: `${owner.name} has no product family "${stored}" — add it under Items & Inventory → Brands, or ask someone who manages the catalogue.` };
    }
    let row: { id: string } | null = null;
    try {
      row = await db.productFamily.create({ data: { brandId: owner.id, name: stored }, select: { id: true } });
      result.familiesCreated.push(`${owner.name} → ${stored}`);
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      row = await db.productFamily.findFirst({
        where: { brandId: owner.id, name: { equals: stored, mode: "insensitive" } },
        select: { id: true },
      });
      if (!row) throw err;
    }
    owner.families.set(nameKey(stored), row.id);
    return row;
  }

  return { brand, family };
}

/**
 * Items from a spreadsheet — every attribute the item form has, brand and product family included.
 *
 * ## Columns
 *
 * Headers are matched loosely (`canonicalColumn`): "Selling Price", "sellingPrice" and "selling_price"
 * are one column, and "HSN/SAC", "Make" and "UOM" are understood. Anything unrecognised is ignored,
 * which is what lets an export — with its item id and stock columns — come straight back in.
 *
 * ## A missing column is not a blank one
 *
 * For brand, product family and HSN/SAC — the columns added after the first template — a column the
 * file does not have leaves those fields as they are on an existing item, while a column present
 * but left blank clears them. Otherwise re-importing an older template, or a sheet of prices only,
 * would strip the brand off every item it touched.
 */
export async function importItems(formData: FormData): Promise<ActionResult<ImportItemsResult>> {
  const user = await requireModuleUser("items");
  const moduleError = await requireItemsModule();
  if (moduleError) return { ok: false, error: moduleError };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file provided." };
  }
  if (file.size > 2 * 1024 * 1024) {
    return { ok: false, error: "File is too large (max 2MB)." };
  }

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: canonicalColumn,
  });

  if (parsed.errors.length > 0) {
    return { ok: false, error: `Could not parse CSV: ${parsed.errors[0].message}` };
  }
  if (parsed.data.length === 0) {
    return { ok: false, error: "The file has no data rows." };
  }

  const columns = new Set(parsed.meta.fields ?? []);
  const hasBrand = columns.has("brand");
  const hasFamily = columns.has("productFamily");
  const hasHsn = columns.has("hsnCode");

  const result: ImportItemsResult = { created: 0, updated: 0, errors: [], brandsCreated: [], familiesCreated: [] };
  const catalogue = await catalogueResolver(await hasEffectivePermission(user.id, "catalog.manage"), result);
  // The workspace's own fields, read from their columns by label. A blank cell leaves a value alone —
  // unlike the built-in columns here — so a file made before a field existed never clears it.
  const customSheet = await customSheetFor("ITEM", user.id, await csvBuiltIns(user.id));

  // Every SKU the file names, in one query rather than one per row.
  const skus = [...new Set(parsed.data.map((r) => String(r.sku ?? "").trim()).filter(Boolean))];
  const known = new Map(
    (
      await db.item.findMany({
        where: { sku: { in: skus } },
        select: { id: true, sku: true, brandId: true, productFamilyId: true },
      })
    ).map((i) => [i.sku, i]),
  );

  for (let i = 0; i < parsed.data.length; i++) {
    const rowNumber = i + 2; // header is row 1
    const validated = importItemRowSchema.safeParse(parsed.data[i]);
    if (!validated.success) {
      result.errors.push({
        row: rowNumber,
        message: validated.error.issues[0]?.message ?? "Invalid row",
      });
      continue;
    }
    const data = validated.data;
    const existing = known.get(data.sku);
    // Only goods can track inventory — see the matching note in createItem.
    const trackInventory = data.type === "GOOD" && data.trackInventory;

    // Brand, then family — each left as it is when the file has no such column.
    let brandId = existing?.brandId ?? null;
    let productFamilyId = existing?.productFamilyId ?? null;
    if (hasFamily && data.productFamily && !(hasBrand ? data.brand : brandId)) {
      result.errors.push({ row: rowNumber, message: `Product family "${data.productFamily}" needs its brand on the same row.` });
      continue;
    }
    if (hasBrand) {
      if (data.brand) {
        const brand = await catalogue.brand(data.brand);
        if ("error" in brand) {
          result.errors.push({ row: rowNumber, message: brand.error });
          continue;
        }
        // A family belongs to one brand, so a new brand drops the old brand's family.
        if (brand.id !== brandId) productFamilyId = null;
        brandId = brand.id;
      } else {
        brandId = null;
        productFamilyId = null;
      }
    }
    if (hasFamily) {
      if (data.productFamily && brandId) {
        const family = await catalogue.family(brandId, data.productFamily);
        if ("error" in family) {
          result.errors.push({ row: rowNumber, message: family.error });
          continue;
        }
        productFamilyId = family.id;
      } else {
        productFamilyId = null;
      }
    }
    const hsnCode = hasHsn ? data.hsnCode || null : undefined;
    // Read back without the formula guard the export put on its text cells (src/lib/csv.ts).
    const cells = Object.fromEntries(Object.entries(parsed.data[i]!).map(([k, v]) => [k, desanitizeCsvCell(String(v ?? ""))]));
    const custom = customSheet ? await customSheet.merge(existing ? await valuesFor("ITEM", existing.id) : {}, cells) : null;
    if (custom && !custom.ok) {
      result.errors.push({ row: rowNumber, message: custom.error });
      continue;
    }
    const customData = custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {};

    try {
      if (existing) {
        // Never touch stock on update — that stays authoritative in the stock ledger,
        // adjusted only via "Record movement" on the item page.
        await db.item.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            type: data.type,
            category: data.category || null,
            hsnCode,
            vendor: data.vendor || null,
            brandId,
            productFamilyId,
            unit: data.unit || null,
            billingCycle: data.billingCycle || null,
            costPrice: data.costPrice ?? null,
            sellingPrice: data.sellingPrice,
            taxRatePercent: data.taxRatePercent ?? null,
            description: data.description || null,
            trackInventory,
            reorderLevel: data.reorderLevel ?? null,
            active: data.active,
            ...customData,
          },
        });
        known.set(data.sku, { ...existing, brandId, productFamilyId });
        result.updated++;
      } else {
        const created = await db.$transaction(async (tx) => {
          const item = await tx.item.create({
            data: {
              name: data.name,
              sku: data.sku,
              type: data.type,
              category: data.category || null,
              hsnCode: hsnCode ?? null,
              vendor: data.vendor || null,
              brandId,
              productFamilyId,
              unit: data.unit || null,
              billingCycle: data.billingCycle || null,
              costPrice: data.costPrice ?? null,
              sellingPrice: data.sellingPrice,
              taxRatePercent: data.taxRatePercent ?? null,
              description: data.description || null,
              trackInventory,
              reorderLevel: trackInventory ? (data.reorderLevel ?? null) : null,
              active: data.active,
              createdById: user.id,
              stockQuantity: trackInventory && data.openingStock ? data.openingStock : 0,
              ...customData,
            },
          });

          if (trackInventory && data.openingStock) {
            await tx.stockMovement.create({
              data: {
                itemId: item.id,
                type: "RECEIVED",
                quantityChange: data.openingStock,
                reason: "Opening stock (import)",
                createdByUserId: user.id,
              },
            });
          }
          return item;
        });
        // A second row for the same SKU further down updates this one, as it would a stored item.
        known.set(data.sku, { id: created.id, sku: data.sku, brandId, productFamilyId });
        result.created++;
      }
    } catch {
      result.errors.push({ row: rowNumber, message: `Could not save SKU "${data.sku}".` });
    }
  }

  if (result.created + result.updated + result.brandsCreated.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Item",
      entityId: "import",
      entityLabel:
        `Imported items — ${result.created} created, ${result.updated} updated` +
        (result.brandsCreated.length ? `, ${result.brandsCreated.length} brand(s) added` : "") +
        (result.familiesCreated.length ? `, ${result.familiesCreated.length} product family(ies) added` : ""),
    });
  }

  revalidatePath("/items", "layout");
  return { ok: true, data: result };
}
