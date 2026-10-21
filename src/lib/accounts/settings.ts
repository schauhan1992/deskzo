import type { CostingMethod, InventoryAccounting, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Finance → Accounts settings (owner, 22 Oct 2026): how stock is costed and accounted for, what moves it, and
 * whether vouchers and adjustments need a second person. One row; no row is the defaults, and the defaults
 * are how the books already behaved — periodic inventory, weighted-average cost, no negative stock, and
 * nothing moving stock until the company turns it on — so upgrading changes nobody's figures.
 */

export type AccountsSettings = {
  inventoryAccounting: InventoryAccounting;
  costingMethod: CostingMethod;
  allowNegativeStock: boolean;
  invoiceIssuesStock: boolean;
  billReceivesStock: boolean;
  creditNoteReturnsStock: boolean;
  reserveOnOrderApproval: boolean;
  voucherApprovalRequired: boolean;
  adjustmentApprovalRequired: boolean;
  quantityDecimals: number;
  defaultWarehouseId: string | null;
  seriesPrefixes: Record<string, string>;
};

export const DEFAULT_ACCOUNTS_SETTINGS: AccountsSettings = {
  inventoryAccounting: "PERIODIC",
  costingMethod: "WEIGHTED_AVERAGE",
  allowNegativeStock: false,
  invoiceIssuesStock: false,
  billReceivesStock: false,
  creditNoteReturnsStock: false,
  reserveOnOrderApproval: false,
  voucherApprovalRequired: false,
  adjustmentApprovalRequired: true,
  quantityDecimals: 2,
  defaultWarehouseId: null,
  seriesPrefixes: {},
};

type Client = Pick<Prisma.TransactionClient, "accountsSettings">;

function prefixesOf(json: unknown): Record<string, string> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return Object.fromEntries(
    Object.entries(json as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""),
  );
}

/**
 * The settings as they stand, with `migrated` false where the workspace's database doesn't have Accounts'
 * tables yet — every inventory screen and hook checks it and stands aside until it does.
 */
export async function accountsSettings(client: Client = db): Promise<AccountsSettings & { migrated: boolean }> {
  try {
    const row = await client.accountsSettings.findUnique({ where: { id: "global" } });
    if (!row) return { ...DEFAULT_ACCOUNTS_SETTINGS, migrated: true };
    return {
      inventoryAccounting: row.inventoryAccounting,
      costingMethod: row.costingMethod,
      allowNegativeStock: row.allowNegativeStock,
      invoiceIssuesStock: row.invoiceIssuesStock,
      billReceivesStock: row.billReceivesStock,
      creditNoteReturnsStock: row.creditNoteReturnsStock,
      reserveOnOrderApproval: row.reserveOnOrderApproval,
      voucherApprovalRequired: row.voucherApprovalRequired,
      adjustmentApprovalRequired: row.adjustmentApprovalRequired,
      quantityDecimals: row.quantityDecimals,
      defaultWarehouseId: row.defaultWarehouseId,
      seriesPrefixes: prefixesOf(row.seriesPrefixes),
      migrated: true,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ...DEFAULT_ACCOUNTS_SETTINGS, migrated: false };
    throw err;
  }
}
