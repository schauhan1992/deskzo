import { z } from "zod";
import { HSN_MESSAGE, HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";

/**
 * What an item can be made as: goods, a service, or a service managed as a subscription. A perpetual
 * licence was a fourth type; it is a service in the "Perpetual licence" category now (it never behaved
 * differently), and an old value of it is read as SERVICE — see `PERPETUAL_CATEGORY`.
 */
export const itemTypeValues = ["GOOD", "SERVICE", "SUBSCRIPTION"] as const;

/** Labels for every type a stored item may have, the retired one included. */
export const itemTypeLabels: Record<(typeof itemTypeValues)[number] | "PERPETUAL", string> = {
  GOOD: "Good",
  SERVICE: "Service",
  SUBSCRIPTION: "Subscription",
  PERPETUAL: "Perpetual licence",
};

/** The category a perpetual licence goes in, now that it isn't a type. Every workspace starts with it. */
export const PERPETUAL_CATEGORY = "Perpetual licence";

/** A type as sent: the retired PERPETUAL is a service now; anything else as it is. */
const currentType = (v: unknown) => (v === "PERPETUAL" ? "SERVICE" : v);

/** Only a subscription expires and needs renewing — anything else is sold once. */
export function itemTypeRenews(type: string) {
  return type === "SUBSCRIPTION";
}

/**
 * How long a subscription runs is its order's (start and expiry dates, picked as a term on the order
 * form), not its product's: the same licence is sold monthly, yearly or for three years. Items no
 * longer carry a billing cycle; their old column is left unread.
 */
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
 * Stored without the spaces people copy it with. A code that is present has to be well formed; in an
 * Indian workspace the actions also require one, of the right kind for the item and listed in the GST
 * portal's directory (`hsnIssue`, src/lib/platform/hsn-directory.ts) — elsewhere it means nothing to
 * the tax, so it stays optional.
 */
const hsnField = z.preprocess(
  (v) => normaliseHsn(v),
  z.union([z.literal(""), z.string().regex(HSN_PATTERN, HSN_MESSAGE)]),
);

const itemDetailShape = {
  name: z.string().trim().min(2, "Item name is required"),
  sku: z.string().trim().min(1, "SKU is required"),
  type: z.preprocess(currentType, z.enum(itemTypeValues)),
  /** One of the workspace's categories, by name — the actions check it is on the list. */
  category: z.string().trim().optional().or(z.literal("")),
  hsnCode: hsnField,
  vendor: z.string().trim().optional().or(z.literal("")),
  brandId: z.string().optional().or(z.literal("")),
  productFamilyId: z.string().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
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
  /** The workspace's own fields (src/lib/custom-fields) — checked by the action against its definitions. */
  customFields: z.record(z.string(), z.unknown()).optional(),
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
  /** A category from the list, by name — or "clear" to take it off. */
  category: z.string().trim().optional().or(z.literal("")),
  active: z.enum(["true", "false"]).optional().or(z.literal("")),
  /** One HSN/SAC for every item picked — blank leaves each item's own. */
  hsnCode: hsnField.optional(),
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
  // PERPETUAL is still read, from files made before it was retired: the action makes the row a service
  // in the "Perpetual licence" category.
  type: z.preprocess(csvEnumTrimUpper, z.enum([...itemTypeValues, "PERPETUAL"], {
    message: "Type must be GOOD, SERVICE or SUBSCRIPTION",
  })),
  /** Matched by name against the workspace's categories, case and spacing ignored. Blank clears it. */
  category: z.string().trim().optional().or(z.literal("")),
  /** Matched by name, case and spacing ignored — see `nameKey`. Blank clears it. */
  brand: z.string().trim().optional().or(z.literal("")),
  /** One of the brand's families, matched the same way. Needs a brand. */
  productFamily: z.string().trim().optional().or(z.literal("")),
  hsnCode: hsnField,
  vendor: z.string().trim().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
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
