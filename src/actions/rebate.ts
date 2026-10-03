"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { formatOrderId } from "@/lib/order-id";
import { calendarDay } from "@/lib/orders/handoff-rules";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { saveOrderRebateSchema } from "@/lib/validation/order";
import { rebateProgrammeSchema, writeOffRebateSchema } from "@/lib/validation/rebate";
import { matchingProgrammes, REBATE_BASIS_LABELS, type DealRegStatusKey } from "@/lib/rebates/rules";
import { ORDER_REBATE_SELECT, rebateSummary, resolveRebateInput } from "@/lib/rebates/server";
import type { ActionResult } from "@/actions/company";

/**
 * Backend rebates (owner, 1 Oct 2026): the standing programmes that suggest them, each order's
 * expected rebates, writing one off, and the report of what is due.
 *
 * Every rebate figure is behind `rebates.view` — the owner's line between a sales manager, who sees
 * them, and a sales executive, who doesn't — and changing the programmes or writing a rebate off is
 * `rebates.manage`. An order's rebate is entered by anybody who sees rebates and can see the order.
 * Rebates never reach targets or incentives (src/lib/targets/measure.ts counts front margin only).
 */

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const DONE_STATUSES = ["CANCELLED", "REJECTED"] as const;

async function rebateUser(level: "view" | "manage") {
  const user = await requireModuleUser("orders");
  const ok = await hasEffectivePermission(user.id, level === "view" ? "rebates.view" : "rebates.manage");
  return ok ? user : null;
}

/** An order the caller may see, by the account scope, with what its rebates are worked out from. */
async function scopedOrder(userId: string, orderId: string) {
  return db.companyProduct.findFirst({
    where: { id: orderId, ...(await viaCompanyScope(userId)) },
    select: { ...ORDER_REBATE_SELECT, orderSeq: true, orderStatus: true, companyId: true },
  });
}

// ─── Programmes ──────────────────────────────────────────────────────────────────────────────────

export async function listRebateProgrammes() {
  const user = await rebateUser("view");
  if (!user) return null;
  const programmes = await db.rebateProgramme.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      brand: { select: { id: true, name: true } },
      vendor: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
      _count: { select: { rebates: true } },
    },
  });
  return toPlain({ programmes, canManage: await hasEffectivePermission(user.id, "rebates.manage") });
}

export async function saveRebateProgramme(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await rebateUser("manage");
  if (!user) return { ok: false, error: "You can't change the rebate programmes." };
  const parsed = rebateProgrammeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  if (data.brandId && !(await db.brand.findUnique({ where: { id: data.brandId }, select: { id: true } }))) {
    return { ok: false, error: "That brand no longer exists." };
  }
  if (data.vendorId) {
    const vendor = await db.company.findUnique({ where: { id: data.vendorId }, select: { relationshipType: true } });
    if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) return { ok: false, error: "Pick a distributor from your vendors." };
  }
  const row = {
    name: data.name,
    brandId: data.brandId || null,
    vendorId: data.vendorId || null,
    basis: data.basis,
    rate: new Prisma.Decimal(data.rate),
    needsDealRegistration: data.needsDealRegistration,
    payer: data.payer,
    settlement: data.settlement,
    validFrom: data.validFrom ? calendarDay(data.validFrom) : null,
    validTo: data.validTo ? calendarDay(data.validTo) : null,
    active: data.active,
    notes: data.notes || null,
    updatedById: user.id,
  };
  let id: string;
  if (data.id) {
    const existing = await db.rebateProgramme.findUnique({ where: { id: data.id }, select: { id: true } });
    if (!existing) return { ok: false, error: "That programme no longer exists." };
    id = (await db.rebateProgramme.update({ where: { id: data.id }, data: row, select: { id: true } })).id;
  } else {
    id = (await db.rebateProgramme.create({ data: row, select: { id: true } })).id;
  }
  await recordAudit({
    userId: user.id,
    action: data.id ? "UPDATE" : "CREATE",
    entityType: "RebateProgramme",
    entityId: id,
    entityLabel: `${data.name} — ${data.rate}% (${REBATE_BASIS_LABELS[data.basis].toLowerCase()})${data.active ? "" : ", off"}`,
  });
  revalidatePath("/settings/rebate-programmes");
  return { ok: true, data: { id } };
}

/** A programme no order uses is deleted; one in use is kept for the record — switch it off instead. */
export async function deleteRebateProgramme(id: string): Promise<ActionResult<null>> {
  const user = await rebateUser("manage");
  if (!user) return { ok: false, error: "You can't change the rebate programmes." };
  const programme = await db.rebateProgramme.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { rebates: true } } } });
  if (!programme) return { ok: false, error: "That programme no longer exists." };
  if (programme._count.rebates > 0) {
    return { ok: false, error: `${programme._count.rebates} order${programme._count.rebates === 1 ? "" : "s"} came from it — switch it off instead, so they keep saying where their rebate came from.` };
  }
  await db.rebateProgramme.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "RebateProgramme", entityId: id, entityLabel: programme.name });
  revalidatePath("/settings/rebate-programmes");
  return { ok: true, data: null };
}

/**
 * The programmes that apply while an order is being punched: for its item's brand, through its
 * distributor, in date today, and — those that need one — with the deal registration approved.
 */
export async function suggestOrderRebates(input: { itemId: string; vendorId?: string | null; dealRegStatus?: string | null }) {
  const user = await rebateUser("view");
  if (!user) return [];
  const item = input.itemId ? await db.item.findUnique({ where: { id: input.itemId }, select: { brandId: true } }) : null;
  const programmes = await db.rebateProgramme.findMany({
    where: { active: true },
    select: {
      id: true, name: true, brandId: true, vendorId: true, basis: true, rate: true, payer: true, settlement: true,
      needsDealRegistration: true, validFrom: true, validTo: true, active: true,
    },
  });
  const status = ["APPLIED", "APPROVED", "REJECTED"].includes(input.dealRegStatus ?? "") ? (input.dealRegStatus as DealRegStatusKey) : null;
  // In date on the workspace's today.
  const today = (await workspaceClock()).today();
  return toPlain(
    matchingProgrammes(programmes, { brandId: item?.brandId ?? null, vendorId: input.vendorId || null, dealRegStatus: status, on: today }).map((p) => ({
      id: p.id,
      name: p.name,
      basis: p.basis,
      rate: Number(p.rate),
      payer: p.payer,
      settlement: p.settlement,
      // A programme through one distributor is paid by that distributor; otherwise by the order's.
      payerCompanyId: p.payer === "DISTRIBUTOR" ? (p.vendorId ?? input.vendorId ?? null) : null,
    })),
  );
}

// ─── An order's rebates ──────────────────────────────────────────────────────────────────────────

/** An order's rebates and margins — expected, received, still to come — or null without `rebates.view`. */
export async function getOrderRebates(orderId: string) {
  const user = await rebateUser("view");
  if (!user) return null;
  const order = await scopedOrder(user.id, orderId);
  if (!order) return null;
  return toPlain({ ...rebateSummary(order), canManage: await hasEffectivePermission(user.id, "rebates.manage") });
}

export async function saveOrderRebate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await rebateUser("view");
  if (!user) return { ok: false, error: "You can't enter a backend rebate." };
  const parsed = saveOrderRebateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { orderId, rebateId, rebate } = parsed.data;
  const order = await scopedOrder(user.id, orderId);
  if (!order) return { ok: false, error: "Order not found." };
  if ((DONE_STATUSES as readonly string[]).includes(order.orderStatus)) return { ok: false, error: "This order isn't going ahead — there's no rebate to expect." };
  const resolved = await resolveRebateInput(rebate);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let id: string;
  if (rebateId) {
    const existing = order.rebates.find((r) => r.id === rebateId);
    if (!existing) return { ok: false, error: "That rebate isn't on this order." };
    id = (await db.orderRebate.update({ where: { id: rebateId }, data: resolved.data, select: { id: true } })).id;
  } else {
    if (order.rebates.length >= 5) return { ok: false, error: "Five rebates on one order at most." };
    id = (await db.orderRebate.create({ data: { ...resolved.data, companyProductId: orderId, createdById: user.id }, select: { id: true } })).id;
  }
  const what = rebate.basis === "AMOUNT" ? rupees(rebate.value) : `${rebate.value}% ${REBATE_BASIS_LABELS[rebate.basis].replace(/^% /, "")}`;
  await recordAudit({
    userId: user.id,
    action: rebateId ? "UPDATE" : "CREATE",
    entityType: "OrderRebate",
    entityId: id,
    entityLabel: `${formatOrderId(order.orderSeq)} — backend rebate ${what}, from the ${rebate.payer === "OEM" ? "OEM" : "distributor"}`,
  });
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/orders/rebates");
  return { ok: true, data: { id } };
}

/** Removes a rebate entered in error. One something has come in against is written off instead. */
export async function removeOrderRebate(rebateId: string): Promise<ActionResult<null>> {
  const user = await rebateUser("view");
  if (!user) return { ok: false, error: "You can't change backend rebates." };
  const rebate = await db.orderRebate.findUnique({
    where: { id: rebateId },
    select: { id: true, companyProductId: true, _count: { select: { allocations: true } } },
  });
  if (!rebate || !(await scopedOrder(user.id, rebate.companyProductId))) return { ok: false, error: "That rebate no longer exists." };
  if (rebate._count.allocations > 0) {
    return { ok: false, error: "Money has come in against this rebate — write off what's left instead." };
  }
  await db.orderRebate.delete({ where: { id: rebateId } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "OrderRebate", entityId: rebateId, entityLabel: "Backend rebate removed" });
  revalidatePath(`/orders/${rebate.companyProductId}`);
  revalidatePath("/orders/rebates");
  return { ok: true, data: null };
}

/** What is still to come on a rebate stops being due — the distributor or OEM won't pay it. */
export async function writeOffOrderRebate(input: unknown): Promise<ActionResult<null>> {
  const user = await rebateUser("manage");
  if (!user) return { ok: false, error: "You can't write a rebate off." };
  const parsed = writeOffRebateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const rebate = await db.orderRebate.findUnique({ where: { id: parsed.data.rebateId }, select: { id: true, companyProductId: true, writtenOffAt: true } });
  if (!rebate || !(await scopedOrder(user.id, rebate.companyProductId))) return { ok: false, error: "That rebate no longer exists." };
  if (rebate.writtenOffAt) return { ok: false, error: "It's written off already." };
  await db.orderRebate.update({
    where: { id: rebate.id },
    data: { writtenOffAt: new Date(), writtenOffById: user.id, writeOffReason: parsed.data.reason },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrderRebate", entityId: rebate.id, entityLabel: `Backend rebate written off: ${parsed.data.reason}` });
  revalidatePath(`/orders/${rebate.companyProductId}`);
  revalidatePath("/orders/rebates");
  return { ok: true, data: null };
}

/** Takes a write-off back: what is still to come is due again. */
export async function reopenOrderRebate(rebateId: string): Promise<ActionResult<null>> {
  const user = await rebateUser("manage");
  if (!user) return { ok: false, error: "You can't change a written-off rebate." };
  const rebate = await db.orderRebate.findUnique({ where: { id: rebateId }, select: { id: true, companyProductId: true, writtenOffAt: true } });
  if (!rebate || !(await scopedOrder(user.id, rebate.companyProductId))) return { ok: false, error: "That rebate no longer exists." };
  if (!rebate.writtenOffAt) return { ok: false, error: "It isn't written off." };
  await db.orderRebate.update({ where: { id: rebate.id }, data: { writtenOffAt: null, writtenOffById: null, writeOffReason: null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrderRebate", entityId: rebate.id, entityLabel: "Backend rebate due again" });
  revalidatePath(`/orders/${rebate.companyProductId}`);
  revalidatePath("/orders/rebates");
  return { ok: true, data: null };
}

// ─── The report ──────────────────────────────────────────────────────────────────────────────────

/** The financial-year quarter a moment falls in on the workspace's calendar: "Q3 FY26-27" for October 2026. */
function fyQuarter(at: Date, clock: Clock) {
  const { year, month } = clock.parts(at); // month 0 = January
  const fyStart = month >= 3 ? year : year - 1;
  const quarter = Math.floor(((month + 9) % 12) / 3) + 1;
  return { key: `${fyStart}-Q${quarter}`, label: `Q${quarter} FY${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}` };
}

/**
 * What the backend rebates on orders booked between two days (the workspace's calendar days,
 * `yyyy-mm-dd`, both inclusive) come to: each order's expected, received and still to come, and the
 * same totalled by who pays, by the OEM (the item's brand) and by quarter. Cancelled and rejected
 * orders are left out.
 */
export async function rebatesReport(params: { from: string; to: string }) {
  const user = await rebateUser("view");
  if (!user) return null;
  const clock = await workspaceClock();
  // From the first day's midnight up to, not including, the midnight after the last — on the
  // workspace's clock. This was India's, by a fixed offset.
  const from = clock.startOfDay(params.from);
  const before = clock.endOfDay(params.to);
  if (!from || !before) return null;
  const orders = await db.companyProduct.findMany({
    where: {
      ...(await viaCompanyScope(user.id)),
      rebates: { some: {} },
      orderStatus: { notIn: [...DONE_STATUSES] },
      bookedAt: { gte: from, lt: before },
    },
    orderBy: { bookedAt: "desc" },
    select: {
      ...ORDER_REBATE_SELECT,
      orderSeq: true,
      bookedAt: true,
      company: { select: { id: true, name: true } },
      item: { select: { sellingPrice: true, name: true, brand: { select: { id: true, name: true } } } },
    },
  });

  type Total = { key: string; label: string; expected: number; received: number; outstanding: number; orders: number };
  const add = (map: Map<string, Total>, key: string, label: string, r: { expected: number; received: number; outstanding: number }) => {
    const t = map.get(key) ?? { key, label, expected: 0, received: 0, outstanding: 0, orders: 0 };
    t.expected += r.expected;
    t.received += r.received;
    t.outstanding += r.outstanding;
    t.orders += 1;
    map.set(key, t);
  };
  const byPayer = new Map<string, Total>();
  const byBrand = new Map<string, Total>();
  const byQuarter = new Map<string, Total>();
  const rows = orders.map((o) => {
    const summary = rebateSummary(o);
    const quarter = fyQuarter(o.bookedAt ?? new Date(), clock);
    for (const r of summary.rebates) {
      add(byPayer, r.payerCompany?.id ?? `none:${r.payer}`, r.payerCompany?.name ?? (r.payer === "OEM" ? "An OEM — not named" : "A distributor — not named"), r);
    }
    add(byBrand, o.item.brand?.id ?? "none", o.item.brand?.name ?? "No brand", summary.totals);
    add(byQuarter, quarter.key, quarter.label, summary.totals);
    return {
      id: o.id,
      orderRef: formatOrderId(o.orderSeq),
      bookedAt: o.bookedAt,
      company: o.company,
      itemName: o.item.name,
      brandName: o.item.brand?.name ?? null,
      front: summary.front,
      net: summary.net,
      ...summary.totals,
      writtenOff: summary.rebates.some((r) => r.writtenOff),
    };
  });
  const totals = rows.reduce(
    (t, r) => ({ expected: t.expected + r.expected, received: t.received + r.received, outstanding: t.outstanding + r.outstanding }),
    { expected: 0, received: 0, outstanding: 0 },
  );
  const sorted = (m: Map<string, Total>) => [...m.values()].sort((a, b) => b.outstanding - a.outstanding || b.expected - a.expected);
  return toPlain({
    rows,
    totals,
    byPayer: sorted(byPayer),
    byBrand: sorted(byBrand),
    byQuarter: [...byQuarter.values()].sort((a, b) => b.key.localeCompare(a.key)),
  });
}
