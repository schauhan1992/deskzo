import { z } from "zod";
import { HSN_MESSAGE, HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";

export const itemTypeValues = ["GOOD", "SERVICE", "SUBSCRIPTION", "PERPETUAL"] as const;

export const itemTypeLabels: Record<(typeof itemTypeValues)[number], string> = {
  GOOD: "Good",
  SERVICE: "Service",
  SUBSCRIPTION: "Subscription",
  PERPETUAL: "Perpetual licence",
};

/** Only a subscription expires and needs renewing — a perpetual licence is owned outright. */
export function itemTypeRenews(type: (typeof itemTypeValues)[number]) {
  return type === "SUBSCRIPTION";
}

export const billingCycleValues = ["MONTHLY", "QUARTERLY", "ANNUAL", "ONE_TIME"] as const;

/** How revenue from an item is recognised (Revenue & Close, Ind AS 115). Blank is "automatic". */
export const revenuePatternValues = ["POINT_IN_TIME", "RATABLE"] as const;
export const revenuePatternLabels: Record<(typeof revenuePatternValues)[number], string> = {
  POINT_IN_TIME: "When invoiced",
  RATABLE: "Over the service period",
};
export const stockMovementTypeValues = ["RECEIVED", "SOLD", "ADJUSTMENT", "RETURNED", "DAMAGED"] as const;

const optionalNonNegativeNumber = (opts?: { max?: number }) =>
  z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    opts?.max !== undefined
      ? z.number().nonnegative().max(opts.max).optional()
      : z.number().nonnegative().optional(),
  );

const requiredNonNegativeNumber = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
  z.number().nonnegative("Must be zero or more"),
);

const optionalNonNegativeInt = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
  z.number().int().nonnegative().optional(),
);

/**
 * HSN for goods, SAC for services — the code every invoice line carries and the GST return groups by.
 * Optional here, since a new catalogue is rarely complete, but a code that is present has to be one;
 * the GST summary already flags lines with none. Stored without the spaces people copy it with.
 */
const hsnField = z.preprocess(
  (v) => normaliseHsn(v),
  z.union([z.literal(""), z.string().regex(HSN_PATTERN, HSN_MESSAGE)]),
);

const itemDetailShape = {
  name: z.string().trim().min(2, "Item name is required"),
  sku: z.string().trim().min(1, "SKU is required"),
  type: z.enum(itemTypeValues),
  category: z.string().trim().optional().or(z.literal("")),
  hsnCode: hsnField,
  vendor: z.string().trim().optional().or(z.literal("")),
  brandId: z.string().optional().or(z.literal("")),
  productFamilyId: z.string().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
  billingCycle: z.enum(billingCycleValues).optional().or(z.literal("")),
  costPrice: optionalNonNegativeNumber(),
  sellingPrice: requiredNonNegativeNumber,
  taxRatePercent: optionalNonNegativeNumber({ max: 100 }),
  description: z.string().trim().optional().or(z.literal("")),
  trackInventory: z.boolean().default(false),
  reorderLevel: optionalNonNegativeInt,
  active: z.boolean().default(true),
  /**
   * Blank is "automatic, from the item type" (null): a subscription over its service period, anything
   * else when invoiced. Saved only where Revenue & Close is available; the actions ignore it otherwise.
   */
  revenuePattern: z.enum(revenuePatternValues).optional().or(z.literal("")),
};

export const createItemSchema = z.object({
  ...itemDetailShape,
  openingStock: optionalNonNegativeInt,
});

export const updateItemSchema = z.object({
  id: z.string().min(1),
  ...itemDetailShape,
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

/**
 * Bulk edit. Every field is optional and an empty string means "leave this alone"; the literal
 * "clear" is how the form asks for a field to be emptied, since a blank select can't mean both.
 */
export const bulkUpdateItemsSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item"),
  brandId: z.string().optional().or(z.literal("")),
  productFamilyId: z.string().optional().or(z.literal("")),
  type: z.enum(itemTypeValues).optional().or(z.literal("")),
  category: z.string().trim().optional().or(z.literal("")),
  active: z.enum(["true", "false"]).optional().or(z.literal("")),
});

export type BulkUpdateItemsInput = z.infer<typeof bulkUpdateItemsSchema>;

const csvBoolean = (defaultValue: boolean) =>
  z.preprocess((v) => {
    if (typeof v !== "string" || v.trim() === "") return defaultValue;
    return ["true", "1", "yes", "y"].includes(v.trim().toLowerCase());
  }, z.boolean());

const csvEnumTrimUpper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : v);

const csvOptionalEnumTrimUpper = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const upper = v.trim().toUpperCase();
  return upper === "" ? undefined : upper;
};

export const importItemRowSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  sku: z.string().trim().min(1, "SKU is required"),
  type: z.preprocess(csvEnumTrimUpper, z.enum(itemTypeValues, {
    message: "Type must be GOOD, SERVICE, SUBSCRIPTION, or PERPETUAL",
  })),
  category: z.string().trim().optional().or(z.literal("")),
  /** Matched by name, case and spacing ignored — see `nameKey`. Blank clears it. */
  brand: z.string().trim().optional().or(z.literal("")),
  /** One of the brand's families, matched the same way. Needs a brand. */
  productFamily: z.string().trim().optional().or(z.literal("")),
  hsnCode: hsnField,
  vendor: z.string().trim().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
  billingCycle: z.preprocess(csvOptionalEnumTrimUpper, z.enum(billingCycleValues).optional()),
  costPrice: optionalNonNegativeNumber(),
  sellingPrice: requiredNonNegativeNumber,
  taxRatePercent: optionalNonNegativeNumber({ max: 100 }),
  description: z.string().trim().optional().or(z.literal("")),
  trackInventory: csvBoolean(false),
  reorderLevel: optionalNonNegativeInt,
  openingStock: optionalNonNegativeInt,
  active: csvBoolean(true),
});

export type ImportItemRow = z.infer<typeof importItemRowSchema>;

export const adjustStockSchema = z.object({
  itemId: z.string().min(1),
  type: z.enum(stockMovementTypeValues),
  direction: z.enum(["IN", "OUT"]).optional(),
  quantity: z.preprocess((v) => Number(v), z.number().int().positive("Quantity must be greater than zero")),
  reason: z.string().trim().optional().or(z.literal("")),
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
