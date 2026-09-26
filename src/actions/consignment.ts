"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ConsignmentReason, type ConsignmentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { canMove, consignmentReasonLabels, ewayBillRequired, isSupply, paperworkFor } from "@/lib/assets/lifecycle";
import { intraStateThreshold } from "@/lib/eway/settings";
import { nextDocumentNumber } from "@/lib/trade-number";
import { financialYearOf, stateCodeFromGstin, stateCodeFromName } from "@/lib/gst-engine";
import { getOrganisation } from "@/lib/organisation";
import type { ActionResult } from "@/actions/company";

/**
 * Moving kit about.
 *
 * A consignment is a batch of assets travelling together to one place, because that is the unit
 * logistics actually happens in: fifteen laptops to one office go in one van, under one docket, on
 * one e-way bill. The question people ask is "where is the delivery", not "where is laptop eleven".
 *
 * The rule that shapes the module: only a sale is a supply. Everything else — repairs, deployments,
 * transfers between our own offices — moves on a delivery challan, because raising an invoice for a
 * laptop going out for repair would book revenue that does not exist and charge GST nobody owes.
 */

async function access() {
  const user = await requireModuleUser("it_assets");
  return { user, manage: await hasEffectivePermission(user.id, "assets.manage") };
}

const consignmentSelect = {
  id: true,
  consignmentNumber: true,
  reason: true,
  status: true,
  fromLabel: true,
  toAddress: true,
  courier: true,
  transporter: { select: { id: true, name: true, gstin: true } },
  docketNumber: true,
  lrNumber: true,
  vehicleNumber: true,
  dispatchedOn: true,
  expectedOn: true,
  deliveredOn: true,
  receivedBy: true,
  declaredValue: true,
  interstate: true,
  ewayBillNumber: true,
  ewayBillValidUntil: true,
  notes: true,
  createdAt: true,
  toCompany: { select: { id: true, name: true } },
  toLocation: { select: { id: true, label: true, city: true, state: true } },
  toContact: { select: { id: true, name: true, phone: true } },
  document: { select: { id: true, docNumber: true, docType: true } },
  createdBy: { select: { name: true } },
  _count: { select: { movements: true } },
} satisfies Prisma.ConsignmentSelect;

export async function listConsignments(filters?: { status?: string; companyId?: string }) {
  const { manage } = await access();
  if (!manage) return [];
  return toPlain(
    await db.consignment.findMany({
      where: {
        ...(filters?.status ? { status: filters.status as ConsignmentStatus } : {}),
        ...(filters?.companyId ? { toCompanyId: filters.companyId } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
      select: consignmentSelect,
    }),
  );
}

export async function getConsignment(id: string) {
  const { manage } = await access();
  if (!manage) return null;
  const row = await db.consignment.findUnique({
    where: { id },
    select: {
      ...consignmentSelect,
      movements: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          occurredAt: true,
          asset: {
            select: {
              id: true, assetTag: true, name: true, serialNumber: true, status: true,
              kind: true, purchaseCost: true,
            },
          },
        },
      },
    },
  });
  if (!row) return null;

  const eway = ewayBillRequired(
    {
      declaredValue: row.declaredValue ? Number(row.declaredValue) : null,
      interstate: row.interstate,
      reason: row.reason,
    },
    // The state's own floor, if one is set. Without it this screen contradicted the e-way list.
    { intraStateThreshold: await intraStateThreshold() },
  );

  return toPlain({ ...row, eway, paperwork: paperworkFor(row.reason) });
}

/**
 * The consignment number.
 *
 * Financial-year scoped like every other document number here, so a reference read out over the
 * phone is unambiguous about which year it belongs to.
 */
async function nextConsignmentNumber(tx: Prisma.TransactionClient, date: Date) {
  const prefix = `CON/${financialYearOf(date)}/`;
  const last = await tx.consignment.findFirst({
    where: { consignmentNumber: { startsWith: prefix } },
    orderBy: { consignmentNumber: "desc" },
    select: { consignmentNumber: true },
  });
  const serial = last ? Number(last.consignmentNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(serial).padStart(4, "0")}`;
}

export async function createConsignment(input: {
  reason: ConsignmentReason;
  assetIds: string[];
  toCompanyId?: string;
  toLocationId?: string;
  toContactId?: string;
  toAddress?: string;
  fromLabel?: string;
  courier?: string;
  transporterId?: string;
  expectedOn?: string;
  interstate?: boolean;
  declaredValue?: number;
  documentId?: string;
  notes?: string;
}): Promise<ActionResult<{ id: string; consignmentNumber: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't dispatch assets." };
  if (input.assetIds.length === 0) return { ok: false, error: "Nothing to send — pick at least one asset." };

  const assets = await db.asset.findMany({
    where: { id: { in: input.assetIds } },
    select: {
      id: true, assetTag: true, name: true, status: true, kind: true, purchaseCost: true,
      // Where each one is being collected from, captured now rather than on dispatch — by then the
      // asset row has already been updated and the origin is gone.
      siteCompanyId: true, locationId: true, custodianUserId: true,
    },
  });
  if (assets.length !== input.assetIds.length) {
    return { ok: false, error: "One of those assets no longer exists." };
  }

  // A licence does not travel in a van.
  const intangible = assets.filter((a) => a.kind === "SOFTWARE_LICENCE");
  if (intangible.length > 0) {
    return { ok: false, error: `${intangible[0].assetTag} is a software licence — there's nothing to physically send.` };
  }

  const blocked = assets
    .map((a) => ({ asset: a, check: canMove(a.status, "DISPATCHED") }))
    .filter((r) => !r.check.ok);
  if (blocked.length > 0) {
    const first = blocked[0];
    return { ok: false, error: `${first.asset.assetTag}: ${(first.check as { reason: string }).reason}` };
  }

  // Defaults to what the assets cost, because the e-way bill threshold is about the value of the
  // goods moving — and somebody dispatching fifteen laptops should not have to add them up.
  const declaredValue = input.declaredValue ?? (assets.reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0) || null);

  const created = await db.$transaction(async (tx) => {
    const consignment = await tx.consignment.create({
      data: {
        consignmentNumber: await nextConsignmentNumber(tx, new Date()),
        reason: input.reason,
        toCompanyId: input.toCompanyId || null,
        toLocationId: input.toLocationId || null,
        toContactId: input.toContactId || null,
        toAddress: input.toAddress?.trim() || null,
        fromLabel: input.fromLabel?.trim() || null,
        /**
         * Both, and they are not the same thing. `transporterId` is who is carrying it and is what
         * the e-way bill needs; `courier` is the free-text field that predates the transporter
         * table and still holds what was typed on every consignment raised before it existed.
         */
        transporterId: input.transporterId || null,
        courier: input.courier?.trim() || null,
        expectedOn: input.expectedOn ? new Date(`${input.expectedOn}T00:00:00.000Z`) : null,
        interstate: input.interstate ?? false,
        declaredValue: declaredValue ? new Prisma.Decimal(declaredValue) : null,
        documentId: input.documentId || null,
        notes: input.notes?.trim() || null,
        createdById: user.id,
      },
      select: { id: true, consignmentNumber: true },
    });

    // The assets are attached now but nothing has moved yet — the movement is written on dispatch,
    // because a consignment sitting in draft is a plan, not an event.
    await tx.asset.updateMany({
      where: { id: { in: input.assetIds } },
      data: { notes: undefined },
    });

    return consignment;
  });

  // Held on the draft so the contents survive without pretending a movement happened.
  //
  // Each one records where it was picked up. A movement with only a destination reads "dispatched
  // to the service centre" and leaves nobody able to answer whose site it left — which is the half
  // of the journey the customer asks about, and the half a delivery challan has to state.
  await db.assetMovement.createMany({
    data: assets.map((a) => ({
      assetId: a.id,
      type: "DISPATCHED" as const,
      occurredAt: new Date(),
      consignmentId: created.id,
      fromCompanyId: a.siteCompanyId,
      fromLocationId: a.locationId,
      fromUserId: a.custodianUserId,
      note: "Added to this consignment — not yet dispatched",
      recordedById: user.id,
    })),
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Consignment",
    entityId: created.id,
    entityLabel: `${created.consignmentNumber} — ${assets.length} asset(s)`,
  });
  revalidatePath("/logistics");
  return { ok: true, data: created };
}

/**
 * Sends it.
 *
 * Refuses without an e-way bill where one is required, because the consequence falls on the driver
 * at a checkpoint rather than on whoever pressed the button — goods detained, penalty payable, and
 * nobody on site able to fix it.
 */
export async function dispatchConsignment(input: {
  id: string;
  dispatchedOn?: string;
  courier?: string;
  docketNumber?: string;
  lrNumber?: string;
  vehicleNumber?: string;
  ewayBillNumber?: string;
  ewayBillValidUntil?: string;
}): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't dispatch assets." };

  const consignment = await db.consignment.findUnique({
    where: { id: input.id },
    select: {
      id: true, consignmentNumber: true, status: true, reason: true, declaredValue: true,
      interstate: true, ewayBillNumber: true, toCompanyId: true, toLocationId: true,
      movements: { select: { assetId: true } },
    },
  });
  if (!consignment) return { ok: false, error: "That consignment no longer exists." };
  if (consignment.status !== "DRAFT") return { ok: false, error: "It has already gone." };

  const eway = ewayBillRequired(
    {
      declaredValue: consignment.declaredValue ? Number(consignment.declaredValue) : null,
      interstate: consignment.interstate,
      reason: consignment.reason,
    },
    { intraStateThreshold: await intraStateThreshold() },
  );
  const ewayNumber = input.ewayBillNumber?.trim() || consignment.ewayBillNumber;
  if (eway.required && !ewayNumber) {
    return {
      ok: false,
      error: `This needs an e-way bill before it moves. ${eway.reason} Without one the goods can be detained in transit, and the driver can't fix it at the checkpoint.`,
    };
  }

  const dispatchedOn = input.dispatchedOn ? new Date(`${input.dispatchedOn}T00:00:00.000Z`) : new Date();
  const assetIds = consignment.movements.map((m) => m.assetId);

  await db.$transaction(async (tx) => {
    await tx.consignment.update({
      where: { id: consignment.id },
      data: {
        status: "IN_TRANSIT",
        dispatchedOn,
        courier: input.courier?.trim() || undefined,
        docketNumber: input.docketNumber?.trim() || undefined,
        lrNumber: input.lrNumber?.trim() || undefined,
        vehicleNumber: input.vehicleNumber?.trim().toUpperCase() || undefined,
        ewayBillNumber: ewayNumber,
        ewayBillValidUntil: input.ewayBillValidUntil
          ? new Date(`${input.ewayBillValidUntil}T00:00:00.000Z`)
          : undefined,
      },
    });

    await tx.assetMovement.updateMany({
      where: { consignmentId: consignment.id },
      data: { occurredAt: dispatchedOn, note: null },
    });

    await tx.asset.updateMany({
      where: { id: { in: assetIds } },
      data: { status: "IN_TRANSIT" },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Consignment",
    entityId: consignment.id,
    entityLabel: `${consignment.consignmentNumber} dispatched${ewayNumber ? `, e-way bill ${ewayNumber}` : ""}`,
  });
  revalidatePath("/logistics");
  revalidatePath(`/logistics/${consignment.id}`);
  return { ok: true, data: null };
}

/** It arrived. Every asset in it lands where the consignment was going. */
export async function deliverConsignment(input: {
  id: string;
  deliveredOn?: string;
  receivedBy?: string;
  installed?: boolean;
}): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't take delivery." };

  const consignment = await db.consignment.findUnique({
    where: { id: input.id },
    select: {
      id: true, consignmentNumber: true, status: true, reason: true,
      toCompanyId: true, toLocationId: true, toContactId: true,
      movements: { select: { assetId: true } },
    },
  });
  if (!consignment) return { ok: false, error: "That consignment no longer exists." };
  if (consignment.status === "DRAFT") return { ok: false, error: "It hasn't been dispatched yet." };
  if (consignment.status === "DELIVERED") return { ok: false, error: "It has already been delivered." };

  const deliveredOn = input.deliveredOn ? new Date(`${input.deliveredOn}T00:00:00.000Z`) : new Date();
  const assetIds = consignment.movements.map((m) => m.assetId);
  const movementType = input.installed ? "INSTALLED" : "DELIVERED";

  // Coming back from repair means it returns to stock, not to a customer's desk.
  const returning = consignment.reason === "REPAIR_RETURN";

  await db.$transaction(async (tx) => {
    await tx.consignment.update({
      where: { id: consignment.id },
      data: { status: "DELIVERED", deliveredOn, receivedBy: input.receivedBy?.trim() || null },
    });

    for (const assetId of assetIds) {
      await tx.assetMovement.create({
        data: {
          assetId,
          type: returning ? "BACK_FROM_REPAIR" : movementType,
          occurredAt: deliveredOn,
          consignmentId: consignment.id,
          toCompanyId: returning ? null : consignment.toCompanyId,
          toLocationId: returning ? null : consignment.toLocationId,
          toContactId: returning ? null : consignment.toContactId,
          note: input.receivedBy ? `Received by ${input.receivedBy}` : null,
          recordedById: user.id,
        },
      });
    }

    await tx.asset.updateMany({
      where: { id: { in: assetIds } },
      data: returning
        ? { status: "IN_STOCK", siteCompanyId: null, locationId: null }
        : {
            status: input.installed ? "INSTALLED" : "INSTALLED",
            siteCompanyId: consignment.toCompanyId,
            locationId: consignment.toLocationId,
            holderContactId: consignment.toContactId,
          },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Consignment",
    entityId: consignment.id,
    entityLabel: `${consignment.consignmentNumber} delivered${input.receivedBy ? ` to ${input.receivedBy}` : ""}`,
  });
  revalidatePath("/logistics");
  revalidatePath(`/logistics/${consignment.id}`);
  revalidatePath("/assets");
  return { ok: true, data: null };
}

export async function cancelConsignment(id: string, reason: string): Promise<ActionResult<null>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't cancel a consignment." };

  const consignment = await db.consignment.findUnique({
    where: { id },
    select: { id: true, consignmentNumber: true, status: true, movements: { select: { assetId: true, id: true } } },
  });
  if (!consignment) return { ok: false, error: "That consignment no longer exists." };
  if (consignment.status === "DELIVERED") {
    return { ok: false, error: "It has already been delivered — record a return instead." };
  }

  await db.$transaction(async (tx) => {
    await tx.consignment.update({
      where: { id },
      data: { status: "CANCELLED", notes: reason.trim() || null },
    });
    // The assets go back to stock. Their movement rows stay: the history is that they were put on a
    // consignment which was then cancelled, not that nothing happened.
    await tx.asset.updateMany({
      where: { id: { in: consignment.movements.map((m) => m.assetId) } },
      data: { status: "IN_STOCK" },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Consignment",
    entityId: id,
    entityLabel: `${consignment.consignmentNumber} cancelled — ${reason}`,
  });
  revalidatePath("/logistics");
  return { ok: true, data: null };
}

/**
 * Raises the delivery challan that travels with the goods.
 *
 * A challan, not an invoice, whenever no supply is taking place. It carries no tax and never
 * reaches the ledger — the posting engine only recognises invoices, credit notes and bills, which
 * is exactly right, because sending a laptop for repair is not revenue.
 */
export async function raiseDeliveryChallan(consignmentId: string): Promise<ActionResult<{ documentId: string; docNumber: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't raise a challan." };

  const consignment = await db.consignment.findUnique({
    where: { id: consignmentId },
    select: {
      id: true, consignmentNumber: true, reason: true, toCompanyId: true, toLocationId: true,
      toAddress: true, declaredValue: true, documentId: true, notes: true,
      toLocation: { select: { label: true, address: true, city: true, state: true, pincode: true, gstNumber: true } },
      toCompany: { select: { name: true } },
      toContact: { select: { name: true, phone: true } },
      movements: {
        select: {
          asset: {
            select: {
              id: true,
              assetTag: true,
              name: true,
              serialNumber: true,
              purchaseCost: true,
              make: true,
              model: true,
              // The HSN belongs to the catalogue item, and a delivery challan is required to carry
              // it — it is also what an e-way bill raised against this challan needs.
              item: { select: { hsnCode: true } },
            },
          },
        },
      },
    },
  });
  if (!consignment) return { ok: false, error: "That consignment no longer exists." };
  if (consignment.documentId) return { ok: false, error: "A document is already attached to this consignment." };
  if (isSupply(consignment.reason)) {
    return {
      ok: false,
      error: "This is a sale, so it travels on a tax invoice. Raise the invoice and attach it instead.",
    };
  }
  if (!consignment.toCompanyId) return { ok: false, error: "A challan needs somebody to be addressed to." };
  if (consignment.movements.length === 0) return { ok: false, error: "There's nothing on this consignment." };

  // Each asset becomes a line, so the challan lists what actually travelled by serial number — which
  // is the whole point of one at a checkpoint or a goods-inwards desk.
  const assets = consignment.movements.map((m) => m.asset);
  const issueDate = new Date();
  const org = await getOrganisation();
  /**
   * The consignee's own GSTIN first, then the state they are in by name.
   *
   * Either gives the portal the two digits it insists on. Neither being available is worth knowing
   * before the lorry leaves rather than at a checkpoint.
   */
  const deliveryStateCode =
    stateCodeFromGstin(consignment.toLocation?.gstNumber) ?? stateCodeFromName(consignment.toLocation?.state);

  try {
    const created = await db.$transaction(async (tx) => {
      const docNumber = await nextDocumentNumber(tx, "DELIVERY_CHALLAN", issueDate);
      const doc = await tx.tradeDocument.create({
        data: {
          docNumber,
          docType: "DELIVERY_CHALLAN",
          // Goods leaving our premises, so it sits on the sales side — even though nothing is sold.
          direction: "SALES",
          status: "ISSUED",
          // Nobody typed this one; dispatching the consignment produced it.
          origin: "CONSIGNMENT",
          companyId: consignment.toCompanyId!,
          locationId: consignment.toLocationId,
          issueDate,
          createdById: user.id,
          /**
           * Where the goods are actually going, written onto the document.
           *
           * A delivery challan has to state the place of delivery, and an e-way bill raised against
           * one is refused outright without a six-digit pincode and a GST state code. Loading the
           * location and then not writing it down made every challan this produced un-billable —
           * the portal said so in as many words the first time one was tried.
           */
          sellerGstin: org.gstin,
          buyerGstin: consignment.toLocation?.gstNumber ?? null,
          shippingSameAsBilling: true,
          shippingAttention: consignment.toContact?.name ?? consignment.toCompany?.name ?? null,
          shippingLine1: consignment.toLocation?.address ?? consignment.toAddress ?? null,
          shippingCity: consignment.toLocation?.city ?? null,
          shippingState: consignment.toLocation?.state ?? null,
          shippingStateCode: deliveryStateCode,
          shippingPincode: consignment.toLocation?.pincode ?? null,
          shippingPhone: consignment.toContact?.phone ?? null,
          shippingGstin: consignment.toLocation?.gstNumber ?? null,
          placeOfSupplyCode: deliveryStateCode,
          // No tax on any of it. A challan accompanies goods that are not being supplied, so it
          // carries values for identification only — charging GST here would collect tax on a
          // transaction that isn't happening.
          taxableValue: new Prisma.Decimal(0),
          cgstAmount: new Prisma.Decimal(0),
          sgstAmount: new Prisma.Decimal(0),
          igstAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
          notes: `${consignmentReasonLabels[consignment.reason]} — consignment ${consignment.consignmentNumber}. Not a supply; no tax charged.`,
          lines: {
            create: assets.map((a, i) => ({
              name: `${a.assetTag} — ${a.name}`,
              description: [a.make, a.model, a.serialNumber ? `S/N ${a.serialNumber}` : null]
                .filter(Boolean)
                .join(" · ") || null,
              quantity: new Prisma.Decimal(1),
              /**
               * Carried even though nothing is being charged.
               *
               * A delivery challan has to state the HSN of what is moving, and an e-way bill raised
               * against this challan is rejected without one. Its absence was not a simplification —
               * it made every challan this produced non-compliant on its own terms.
               */
              hsnCode: a.item?.hsnCode ?? null,
              // Stated for identification, not charged: the line value is what the thing is worth,
              // and the document total stays nil.
              unitPrice: new Prisma.Decimal(Number(a.purchaseCost ?? 0)),
              taxRatePercent: new Prisma.Decimal(0),
              taxableValue: new Prisma.Decimal(0),
              lineTotal: new Prisma.Decimal(0),
              sortOrder: i,
            })),
          },
        },
        select: { id: true, docNumber: true },
      });

      await tx.consignment.update({ where: { id: consignment.id }, data: { documentId: doc.id } });
      return doc;
    });

    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "TradeDocument",
      entityId: created.id,
      entityLabel: `Delivery challan ${created.docNumber} for ${consignment.consignmentNumber}`,
    });
    revalidatePath(`/logistics/${consignment.id}`);
    return { ok: true, data: { documentId: created.id, docNumber: created.docNumber } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not raise the challan." };
  }
}

/** Assets that could go on a consignment: in stock, physical, not retired. */
export async function dispatchableAssets(search?: string) {
  const { manage } = await access();
  if (!manage) return [];
  return toPlain(
    await db.asset.findMany({
      where: {
        kind: { not: "SOFTWARE_LICENCE" },
        status: { in: ["IN_STOCK", "ASSIGNED", "INSTALLED", "UNDER_REPAIR"] },
        ...(search
          ? {
              OR: [
                { assetTag: { contains: search, mode: "insensitive" as const } },
                { serialNumber: { contains: search, mode: "insensitive" as const } },
                { name: { contains: search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: { assetTag: "asc" },
      take: 200,
      select: {
        id: true, assetTag: true, name: true, serialNumber: true, status: true, kind: true,
        purchaseCost: true, ownership: true,
        siteCompany: { select: { name: true } },
        custodian: { select: { name: true } },
      },
    }),
  );
}
