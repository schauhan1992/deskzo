"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type DepreciationMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { ensureChartOfAccounts, postAssetDisposalToLedger, postDepreciationToLedger } from "@/lib/ledger/journal";
import { bookValue, endOfMonth, monthlyCharge, startOfMonth } from "@/lib/ledger/depreciation";
import { calendarDateOf, istMidnight } from "@/lib/india-time";
import type { ActionResult } from "@/actions/company";

/**
 * The fixed asset register, and the depreciation run that works off it.
 *
 * The register exists because the journal can tell you accumulated depreciation but not which
 * laptop it belongs to, when it was bought, or who has it — and those are the questions people
 * actually ask. The ledger holds the money; this holds the things.
 */

async function requireAssets() {
  const user = await requireModuleUser("accounting");
  return { user, allowed: await hasEffectivePermission(user.id, "payments.manage") };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export async function listAssets(filters?: { status?: "ACTIVE" | "DISPOSED" | "ALL" }) {
  const { allowed } = await requireAssets();
  if (!allowed) return [];

  const status = filters?.status ?? "ACTIVE";
  const rows = await db.fixedAsset.findMany({
    where: status === "ALL" ? {} : status === "DISPOSED" ? { disposedOn: { not: null } } : { disposedOn: null },
    orderBy: [{ disposedOn: "asc" }, { purchasedOn: "desc" }],
    include: {
      assetAccount: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, name: true } },
      custodian: { select: { id: true, name: true } },
      vendorCompany: { select: { id: true, name: true } },
      charges: { select: { amount: true, toDate: true } },
    },
  });

  return toPlain(
    rows.map((a) => {
      const accumulated = a.charges.reduce((t, c) => t + Number(c.amount), 0);
      return {
        ...a,
        accumulated,
        bookValue: bookValue({ cost: Number(a.cost), accumulated }),
        lastChargedTo: a.charges.length
          ? a.charges.reduce((latest, c) => (c.toDate > latest ? c.toDate : latest), a.charges[0].toDate)
          : null,
      };
    }),
  );
}

export async function getAsset(id: string) {
  const { allowed } = await requireAssets();
  if (!allowed) return null;
  const asset = await db.fixedAsset.findUnique({
    where: { id },
    include: {
      assetAccount: { select: { id: true, code: true, name: true } },
      accumulatedAccount: { select: { id: true, code: true, name: true } },
      department: { select: { id: true, name: true } },
      custodian: { select: { id: true, name: true } },
      vendorCompany: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      charges: {
        orderBy: { toDate: "desc" },
        include: { entry: { select: { id: true, entryNumber: true } } },
      },
      disposalEntry: { select: { id: true, entryNumber: true } },
    },
  });
  if (!asset) return null;

  const accumulated = asset.charges.reduce((t, c) => t + Number(c.amount), 0);
  return toPlain({ ...asset, accumulated, bookValue: bookValue({ cost: Number(asset.cost), accumulated }) });
}

export async function saveAsset(input: {
  id?: string;
  tag: string;
  name: string;
  description?: string;
  purchasedOn: string;
  cost: number;
  salvageValue?: number;
  usefulLifeYears: number;
  method: DepreciationMethod;
  ratePercent?: number;
  assetAccountId: string;
  departmentId?: string;
  custodianUserId?: string;
  vendorCompanyId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireAssets();
  if (!allowed) return { ok: false, error: "You can't manage the asset register." };

  const tag = input.tag.trim().toUpperCase();
  const name = input.name.trim();
  if (!tag) return { ok: false, error: "Give it a tag — it's what's stuck on the laptop." };
  if (!name) return { ok: false, error: "Name the asset." };
  if (input.cost <= 0) return { ok: false, error: "What did it cost?" };
  if ((input.salvageValue ?? 0) >= input.cost) {
    return { ok: false, error: "The salvage value has to be less than what it cost, or there's nothing to write off." };
  }
  if (input.method === "WRITTEN_DOWN_VALUE" && !(input.ratePercent && input.ratePercent > 0)) {
    return { ok: false, error: "The written-down-value method needs a rate — 40% for computers, 15% for most plant." };
  }
  if (input.method === "STRAIGHT_LINE" && input.usefulLifeYears <= 0) {
    return { ok: false, error: "Straight line needs a useful life in years." };
  }

  const clash = await db.fixedAsset.findFirst({
    where: { tag, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { name: true },
  });
  if (clash) return { ok: false, error: `Tag ${tag} is already on ${clash.name}.` };

  const data = {
    tag,
    name,
    description: input.description?.trim() || null,
    purchasedOn: new Date(`${input.purchasedOn}T00:00:00.000Z`),
    cost: new Prisma.Decimal(input.cost),
    salvageValue: new Prisma.Decimal(input.salvageValue ?? 0),
    usefulLifeYears: input.usefulLifeYears,
    method: input.method,
    ratePercent: input.ratePercent ? new Prisma.Decimal(input.ratePercent) : null,
    assetAccountId: input.assetAccountId,
    departmentId: input.departmentId || null,
    custodianUserId: input.custodianUserId || null,
    vendorCompanyId: input.vendorCompanyId || null,
  };

  if (input.id) {
    const charged = await db.depreciationCharge.count({ where: { assetId: input.id } });
    // Changing the cost or the method after it has been depreciated would make every charge already
    // posted wrong, and there is no honest way to fix that silently.
    if (charged > 0) {
      const existing = await db.fixedAsset.findUnique({
        where: { id: input.id },
        select: { cost: true, method: true, usefulLifeYears: true, ratePercent: true, purchasedOn: true },
      });
      const changedBasis =
        existing &&
        (Number(existing.cost) !== input.cost ||
          existing.method !== input.method ||
          existing.usefulLifeYears !== input.usefulLifeYears ||
          Number(existing.ratePercent ?? 0) !== (input.ratePercent ?? 0) ||
          existing.purchasedOn.toISOString().slice(0, 10) !== input.purchasedOn);
      if (changedBasis) {
        return {
          ok: false,
          error: `${charged} month(s) of depreciation have already been charged on this asset. Cost, method, life and purchase date are fixed now — reverse the charges first if they were genuinely wrong.`,
        };
      }
    }
  }

  const row = input.id
    ? await db.fixedAsset.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.fixedAsset.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "FixedAsset",
    entityId: row.id,
    entityLabel: `${tag} ${name}`,
  });
  revalidatePath("/accounting/assets");
  return { ok: true, data: row };
}

// ─── The depreciation run ─────────────────────────────────────────────────────

/**
 * Whether a charge is for the period ending on `periodEnd`. The charge's `toDate` is a `@db.Date` and
 * reads back as midnight UTC, while `periodEnd` is 12:00 UTC on the same day, so comparing the two
 * instants never matched: every month read as not yet charged, and a second run counted as charging
 * again (the posting itself stayed single — its own lookup compares the date column by day).
 */
function sameDay(date: Date, periodEnd: Date) {
  return calendarDateOf(date).getTime() === calendarDateOf(periodEnd).getTime();
}

/** What a month's run would charge, before anybody commits to it. */
export async function previewDepreciation(params: { month: number; year: number }) {
  const { allowed } = await requireAssets();
  if (!allowed) return [];

  const periodEnd = endOfMonth(params.year, params.month);
  const assets = await db.fixedAsset.findMany({
    where: { purchasedOn: { lte: periodEnd } },
    include: { charges: { select: { amount: true, toDate: true } } },
  });

  return toPlain(
    assets
      .map((a) => {
        const accumulated = a.charges.reduce((t, c) => t + Number(c.amount), 0);
        const already = a.charges.some((c) => sameDay(c.toDate, periodEnd));
        const charge = already
          ? 0
          : monthlyCharge(
              {
                cost: Number(a.cost),
                salvageValue: Number(a.salvageValue),
                usefulLifeYears: a.usefulLifeYears,
                method: a.method,
                ratePercent: a.ratePercent ? Number(a.ratePercent) : null,
                purchasedOn: a.purchasedOn,
                disposedOn: a.disposedOn,
                accumulated,
              },
              periodEnd,
            );
        return {
          id: a.id,
          tag: a.tag,
          name: a.name,
          cost: Number(a.cost),
          accumulated,
          bookValue: bookValue({ cost: Number(a.cost), accumulated }),
          charge,
          already,
          disposed: !!a.disposedOn,
        };
      })
      .filter((a) => a.charge > 0 || a.already),
  );
}

/**
 * Charges a month's depreciation across every asset.
 *
 * Safe to run twice: each charge is unique per asset and period end, so a second run over the same
 * month adds nothing. That matters because the natural way to use this is to press the button and,
 * if unsure whether it worked, press it again.
 */
export async function runDepreciation(params: { month: number; year: number }): Promise<ActionResult<{ charged: number; total: number; skipped: number }>> {
  const { user, allowed } = await requireAssets();
  if (!allowed) return { ok: false, error: "You can't run depreciation." };

  const periodEnd = endOfMonth(params.year, params.month);
  const periodStart = startOfMonth(params.year, params.month);
  // Over at midnight IST starting the next month. The charge's own date (12:00 UTC on the last day) is
  // 17:30 IST, and treating that as the end let a month be charged while its evening was still to come.
  if (istMidnight(params.year, params.month, 1) > new Date()) {
    return { ok: false, error: "That month isn't over yet." };
  }

  await ensureChartOfAccounts();
  const label = `${MONTHS[params.month - 1]} ${params.year}`;

  const assets = await db.fixedAsset.findMany({
    where: { purchasedOn: { lte: periodEnd } },
    include: { charges: { select: { amount: true, toDate: true } } },
  });

  let charged = 0;
  let total = 0;
  let skipped = 0;

  for (const a of assets) {
    const accumulated = a.charges.reduce((t, c) => t + Number(c.amount), 0);
    if (a.charges.some((c) => sameDay(c.toDate, periodEnd))) {
      skipped += 1;
      continue;
    }
    const amount = monthlyCharge(
      {
        cost: Number(a.cost),
        salvageValue: Number(a.salvageValue),
        usefulLifeYears: a.usefulLifeYears,
        method: a.method,
        ratePercent: a.ratePercent ? Number(a.ratePercent) : null,
        purchasedOn: a.purchasedOn,
        disposedOn: a.disposedOn,
        accumulated,
      },
      periodEnd,
    );
    if (amount <= 0) {
      skipped += 1;
      continue;
    }

    try {
      await db.$transaction((tx) =>
        postDepreciationToLedger(tx, {
          assetId: a.id,
          amount,
          fromDate: periodStart,
          toDate: periodEnd,
          periodLabel: label,
          userId: user.id,
        }),
      );
      charged += 1;
      total = Math.round((total + amount) * 100) / 100;
    } catch (error) {
      // One asset failing must not abandon the rest of the run — the others are still correct, and
      // the failure is visible as an asset with no charge for the month.
      void error;
      skipped += 1;
    }
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "DepreciationCharge",
    entityId: `${params.year}-${params.month}`,
    entityLabel: `Depreciation for ${label}: ${charged} asset(s), ₹${total.toLocaleString("en-IN")}`,
  });
  revalidatePath("/accounting/assets");
  revalidatePath("/accounting/journal");
  return { ok: true, data: { charged, total, skipped } };
}

/** Selling or scrapping — the gain or loss falls out of the figures rather than being typed. */
export async function disposeAsset(input: {
  id: string;
  disposedOn: string;
  proceeds: number;
  note?: string;
}): Promise<ActionResult<{ gainOrLoss: number }>> {
  const { user, allowed } = await requireAssets();
  if (!allowed) return { ok: false, error: "You can't dispose of an asset." };

  const asset = await db.fixedAsset.findUnique({
    where: { id: input.id },
    select: { id: true, tag: true, name: true, cost: true, disposedOn: true, purchasedOn: true, charges: { select: { amount: true } } },
  });
  if (!asset) return { ok: false, error: "That asset no longer exists." };
  if (asset.disposedOn) return { ok: false, error: "That asset has already been disposed of." };

  const disposedOn = new Date(`${input.disposedOn}T00:00:00.000Z`);
  if (Number.isNaN(disposedOn.getTime())) return { ok: false, error: "That isn't a date." };
  if (disposedOn < asset.purchasedOn) return { ok: false, error: "It can't be disposed of before it was bought." };
  if (input.proceeds < 0) return { ok: false, error: "Proceeds can't be negative. Scrapped for nothing is zero." };

  const accumulated = asset.charges.reduce((t, c) => t + Number(c.amount), 0);
  const gainOrLoss = Math.round((input.proceeds - (Number(asset.cost) - accumulated)) * 100) / 100;

  try {
    await ensureChartOfAccounts();
    await db.$transaction(async (tx) => {
      const entry = await postAssetDisposalToLedger(tx, {
        assetId: asset.id,
        proceeds: input.proceeds,
        disposedOn,
        userId: user.id,
      });
      await tx.fixedAsset.update({
        where: { id: asset.id },
        data: {
          disposedOn,
          disposalProceeds: new Prisma.Decimal(input.proceeds),
          disposalNote: input.note?.trim() || null,
          disposalEntryId: entry?.id ?? null,
        },
      });
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not dispose of that asset." };
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "FixedAsset",
    entityId: asset.id,
    entityLabel: `${asset.tag} disposed for ₹${input.proceeds.toLocaleString("en-IN")} — ${gainOrLoss >= 0 ? "gain" : "loss"} ₹${Math.abs(gainOrLoss).toLocaleString("en-IN")}`,
  });
  revalidatePath("/accounting/assets");
  revalidatePath("/accounting/journal");
  return { ok: true, data: { gainOrLoss } };
}

/** The accounts an asset's cost can sit in — the postable ones under Fixed Assets. */
export async function listAssetAccounts() {
  await requireModuleUser("accounting");
  return db.ledgerAccount.findMany({
    where: { type: "ASSET", isGroup: false, active: true, systemKey: null },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
}
