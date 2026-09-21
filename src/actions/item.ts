"use server";

import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { Prisma, type ItemType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { sanitizeCsvCell, csvFilename } from "@/lib/csv";
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
  const user = await requireUser();
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

  try {
    const item = await db.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: {
          name: rest.name.trim(),
          sku: rest.sku.trim(),
          type: rest.type,
          category: rest.category || null,
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
  await requireUser();
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

  try {
    await db.item.update({
      where: { id },
      data: {
        name: rest.name.trim(),
        sku: rest.sku.trim(),
        type: rest.type,
        category: rest.category || null,
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

export async function adjustStock(input: unknown): Promise<ActionResult<{ stockQuantity: number }>> {
  const user = await requireUser();
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

  await db.$transaction([
    db.stockMovement.create({
      data: { itemId, type, quantityChange, reason: reason || null, createdByUserId: user.id },
    }),
    db.item.update({ where: { id: itemId }, data: { stockQuantity: nextQuantity } }),
  ]);

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
  await requireUser();

  const seq = params?.search ? parseSeqQuery(params.search) : null;
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
  const user = await requireUser();
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

export async function listItemOptions() {
  await requireUser();
  return toPlain(
    await db.item.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true },
    }),
  );
}

export async function getItem(id: string) {
  await requireUser();
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

export async function exportItemsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  await requireUser();
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

  const csv = Papa.unparse(rows);
  return { ok: true, data: { csv, filename: csvFilename("items-export") } };
}

export type ImportItemsResult = {
  created: number;
  updated: number;
  errors: { row: number; message: string }[];
};

export async function importItems(formData: FormData): Promise<ActionResult<ImportItemsResult>> {
  const user = await requireUser();
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
  });

  if (parsed.errors.length > 0) {
    return { ok: false, error: `Could not parse CSV: ${parsed.errors[0].message}` };
  }
  if (parsed.data.length === 0) {
    return { ok: false, error: "The file has no data rows." };
  }

  const result: ImportItemsResult = { created: 0, updated: 0, errors: [] };

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
    // Only goods can track inventory — see the matching note in createItem.
    const trackInventory = data.type === "GOOD" && data.trackInventory;

    try {
      const existing = await db.item.findUnique({ where: { sku: data.sku } });

      if (existing) {
        // Never touch stock on update — that stays authoritative in the stock ledger,
        // adjusted only via "Record movement" on the item page.
        await db.item.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            type: data.type,
            category: data.category || null,
            vendor: data.vendor || null,
            unit: data.unit || null,
            billingCycle: data.billingCycle || null,
            costPrice: data.costPrice ?? null,
            sellingPrice: data.sellingPrice,
            taxRatePercent: data.taxRatePercent ?? null,
            description: data.description || null,
            trackInventory,
            reorderLevel: data.reorderLevel ?? null,
            active: data.active,
          },
        });
        result.updated++;
      } else {
        await db.$transaction(async (tx) => {
          const created = await tx.item.create({
            data: {
              name: data.name,
              sku: data.sku,
              type: data.type,
              category: data.category || null,
              vendor: data.vendor || null,
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
            },
          });

          if (trackInventory && data.openingStock) {
            await tx.stockMovement.create({
              data: {
                itemId: created.id,
                type: "RECEIVED",
                quantityChange: data.openingStock,
                reason: "Opening stock (import)",
                createdByUserId: user.id,
              },
            });
          }
        });
        result.created++;
      }
    } catch {
      result.errors.push({ row: rowNumber, message: `Could not save SKU "${data.sku}".` });
    }
  }

  revalidatePath("/items");
  return { ok: true, data: result };
}
