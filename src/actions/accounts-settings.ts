"use server";

import { revalidatePath } from "next/cache";
import type { CostingMethod, InventoryAccounting } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { toPaise } from "@/lib/accounts/money";
import { accountsSettings, type AccountsSettings } from "@/lib/accounts/settings";
import { ACCOUNTS_SERIES, cleanPrefix, formatAccountsNumber, isSeriesKey, prefixFor } from "@/lib/accounts/numbering";
import { financialYearOf } from "@/lib/gst-engine";
import { pair, postInventoryEntry } from "@/lib/inventory/posting";
import { StockError } from "@/lib/inventory/engine";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Finance → Accounts settings (owner, 22 Oct 2026): how stock is accounted for and costed, what moves it on
 * its own, who has to approve what, and how vouchers are numbered. `accounts.configure` — nobody's by default,
 * and an administrator's to give.
 *
 * Two changes are guarded because they would change figures already in the books:
 *   · the costing method, only while nothing is on hand — a FIFO layer and an average are different
 *     answers for the same unit, and switching under stock would revalue it silently;
 *   · periodic → perpetual inventory posts what is on hand onto the balance sheet in the same transaction
 *     (Dr Stock in Hand, Cr Opening Balance Equity), so the Stock in Hand account starts equal to the stock
 *     ledger. The way back isn't offered: from then on the ledger carries stock's value, and dropping it would
 *     leave a balance nothing keeps current.
 */

async function gate() {
  const user = await requireModuleUser("items");
  return { user, configure: await hasEffectivePermission(user.id, "accounts.configure") };
}

export type AccountsSettingsView = AccountsSettings & {
  migrated: boolean;
  ledger: boolean;
  onHand: { quantity: number; value: number };
  warehouses: { id: string; code: string; name: string; isDefault: boolean }[];
  series: { key: string; label: string; prefix: string; defaultPrefix: string; next: string }[];
};

export async function getAccountsSettings(): Promise<AccountsSettingsView | null> {
  const g = await gate();
  if (!g.configure) return null;
  const settings = await accountsSettings();
  const ledger = await isModuleEnabled("accounting");
  if (!settings.migrated) {
    return { ...settings, ledger, onHand: { quantity: 0, value: 0 }, warehouses: [], series: [] };
  }
  try {
    const fy = financialYearOf(new Date(`${(await workspaceClock()).today()}T00:00:00.000Z`));
    const [onHand, warehouses, counters] = await Promise.all([
      db.stockBalance.aggregate({ _sum: { quantity: true, value: true } }),
      db.warehouse.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, code: true, name: true, isDefault: true } }),
      db.accountsCounter.findMany({ where: { financialYear: fy }, select: { series: true, lastNumber: true } }),
    ]);
    const series = Object.entries(ACCOUNTS_SERIES).map(([key, def]) => {
      const prefix = isSeriesKey(key) ? prefixFor(key, settings.seriesPrefixes) : def.prefix;
      const last = counters.find((c) => c.series === key)?.lastNumber ?? 0;
      return { key, label: def.label, prefix, defaultPrefix: def.prefix, next: formatAccountsNumber(prefix, fy, last + 1) };
    });
    return {
      ...settings,
      ledger,
      onHand: { quantity: Number(onHand._sum.quantity ?? 0), value: Number(onHand._sum.value ?? 0) },
      warehouses,
      series,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ...settings, migrated: false, ledger, onHand: { quantity: 0, value: 0 }, warehouses: [], series: [] };
    throw err;
  }
}

export type SaveAccountsSettingsInput = {
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

const LABELS: Record<keyof SaveAccountsSettingsInput, string> = {
  inventoryAccounting: "Inventory accounting",
  costingMethod: "Costing method",
  allowNegativeStock: "Negative stock",
  invoiceIssuesStock: "Invoices issue stock",
  billReceivesStock: "Bills receive stock",
  creditNoteReturnsStock: "Credit notes return stock",
  reserveOnOrderApproval: "Reserve stock on order approval",
  voucherApprovalRequired: "Voucher approval",
  adjustmentApprovalRequired: "Adjustment approval",
  quantityDecimals: "Quantity decimals",
  defaultWarehouseId: "Default warehouse",
  seriesPrefixes: "Voucher numbering",
};

export async function saveAccountsSettings(input: SaveAccountsSettingsInput): Promise<ActionResult<{ openingEntry: string | null }>> {
  const g = await gate();
  if (!g.configure) return { ok: false, error: "Accounts settings need “Change Accounts settings”." };
  const current = await accountsSettings();
  if (!current.migrated) return { ok: false, error: "This workspace's database hasn't been brought up to date for Accounts yet." };

  if (input.inventoryAccounting !== "PERIODIC" && input.inventoryAccounting !== "PERPETUAL") return { ok: false, error: "Choose periodic or perpetual inventory." };
  if (input.costingMethod !== "WEIGHTED_AVERAGE" && input.costingMethod !== "FIFO") return { ok: false, error: "Choose weighted average or FIFO." };
  const decimals = Math.floor(Number(input.quantityDecimals));
  if (!(decimals >= 0 && decimals <= 3)) return { ok: false, error: "Quantities keep 0 to 3 decimals." };

  // Prefixes: each one clean, and no two series sharing one — a number has to say which book it's in.
  const prefixes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input.seriesPrefixes ?? {})) {
    if (!isSeriesKey(key) || !raw?.trim()) continue;
    const clean = cleanPrefix(raw);
    if (!clean) return { ok: false, error: `${ACCOUNTS_SERIES[key].label}: a prefix is up to 8 letters, digits or dashes.` };
    if (clean !== ACCOUNTS_SERIES[key].prefix) prefixes[key] = clean;
  }
  const effective = Object.keys(ACCOUNTS_SERIES).map((key) => (isSeriesKey(key) ? prefixFor(key, prefixes) : key));
  const clash = effective.find((p, i) => effective.indexOf(p) !== i);
  if (clash) return { ok: false, error: `Two series would both be numbered ${clash}/… — give each its own prefix.` };

  const toPerpetual = current.inventoryAccounting === "PERIODIC" && input.inventoryAccounting === "PERPETUAL";
  if (current.inventoryAccounting === "PERPETUAL" && input.inventoryAccounting === "PERIODIC") {
    return { ok: false, error: "Perpetual inventory can't be switched back: the ledger now carries stock's value, and periodic would leave it there with nothing keeping it current." };
  }
  if (toPerpetual && !(await isModuleEnabled("accounting"))) {
    return { ok: false, error: "Perpetual inventory posts to the ledger — Accounting has to be on first." };
  }
  if (input.defaultWarehouseId) {
    const wh = await db.warehouse.findUnique({ where: { id: input.defaultWarehouseId }, select: { active: true } });
    if (!wh?.active) return { ok: false, error: "The default warehouse has to be an open one." };
  }
  const today = (await workspaceClock()).today();

  const data = {
    inventoryAccounting: input.inventoryAccounting,
    costingMethod: input.costingMethod,
    allowNegativeStock: !!input.allowNegativeStock,
    invoiceIssuesStock: !!input.invoiceIssuesStock,
    billReceivesStock: !!input.billReceivesStock,
    creditNoteReturnsStock: !!input.creditNoteReturnsStock,
    reserveOnOrderApproval: !!input.reserveOnOrderApproval,
    voucherApprovalRequired: !!input.voucherApprovalRequired,
    adjustmentApprovalRequired: !!input.adjustmentApprovalRequired,
    quantityDecimals: decimals,
    defaultWarehouseId: input.defaultWarehouseId || null,
    seriesPrefixes: prefixes,
    updatedById: g.user.id,
  };

  let openingEntry: string | null = null;
  try {
    openingEntry = await db.$transaction(
      async (tx) => {
        // One change at a time: the costing and the switch below read stock and settings and act on them.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:accounts-settings'))`;
        const row = await tx.accountsSettings.findUnique({ where: { id: "global" }, select: { inventoryAccounting: true, costingMethod: true } });
        const was = { inventoryAccounting: row?.inventoryAccounting ?? "PERIODIC", costingMethod: row?.costingMethod ?? "WEIGHTED_AVERAGE" };
        const onHand = await tx.stockBalance.aggregate({ _sum: { value: true }, _count: { _all: true }, where: { quantity: { not: 0 } } });
        if (was.costingMethod !== data.costingMethod && onHand._count._all > 0) {
          throw new StockError(
            "The costing method can only change while nothing is on hand — switching under stock would revalue it. Close the year's stock out (or count it to nothing), change it, and take the stock back in.",
          );
        }
        await tx.accountsSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
        if (was.inventoryAccounting === "PERIODIC" && data.inventoryAccounting === "PERPETUAL") {
          const paise = toPaise(Number(onHand._sum.value ?? 0));
          const entry = await postInventoryEntry(tx, {
            postingKey: `inventory:perpetual-opening:${today}`,
            date: new Date(`${today}T00:00:00.000Z`),
            narration: "Perpetual inventory switched on: stock on hand brought onto the balance sheet",
            userId: g.user.id,
            lines: pair("INVENTORY", "OPENING_BALANCE_EQUITY", paise),
          });
          return entry?.entryNumber ?? null;
        }
        return null;
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    if (err instanceof StockError) return { ok: false, error: err.message };
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date for Accounts yet." };
    if (err instanceof Error && /period|locked|closed/i.test(err.message)) return { ok: false, error: err.message };
    throw err;
  }

  const changed = (Object.keys(LABELS) as (keyof SaveAccountsSettingsInput)[]).filter((k) =>
    k === "seriesPrefixes" ? JSON.stringify(current.seriesPrefixes) !== JSON.stringify(prefixes) : String(current[k] ?? "") !== String(data[k] ?? ""),
  );
  await recordAudit({
    userId: g.user.id,
    action: "UPDATE",
    entityType: "AccountsSettings",
    entityId: "global",
    entityLabel: `Accounts settings: ${changed.map((k) => LABELS[k]).join(", ") || "saved, nothing changed"}${openingEntry ? ` — opening stock entry ${openingEntry}` : ""}`,
  });
  revalidatePath("/items/settings");
  return { ok: true, data: { openingEntry } };
}
