"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type AssetKind, type AssetMovementType, type AssetOwnership, type AssetStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { awayFromSite, canMove, checkOwnership, mayBeCapitalised, statusAfter } from "@/lib/assets/lifecycle";
import type { ActionResult } from "@/actions/company";

/**
 * The IT asset register — the operational one.
 *
 * Not to be confused with `src/actions/asset.ts`, which is the *financial* register: what something
 * cost and what it is worth now. This is the other half — serial numbers, who is holding it, where
 * it physically is, and whether anybody will pay to fix it.
 *
 * The rule that runs through everything here: an asset belonging to a client is something we look
 * after, never something we own. See `mayBeCapitalised` in src/lib/assets/lifecycle.ts.
 */

async function access() {
  const user = await requireUser();
  const [manage, viewAll] = await Promise.all([
    hasEffectivePermission(user.id, "assets.manage"),
    hasEffectivePermission(user.id, "assets.viewAll"),
  ]);
  return { user, manage, viewAll: viewAll || manage };
}

const assetSelect = {
  id: true,
  assetTag: true,
  serialNumber: true,
  name: true,
  kind: true,
  status: true,
  ownership: true,
  make: true,
  model: true,
  purchasedOn: true,
  purchaseCost: true,
  warrantyEndsOn: true,
  amcEndsOn: true,
  seats: true,
  retiredOn: true,
  createdAt: true,
  item: { select: { id: true, name: true } },
  ownerCompany: { select: { id: true, name: true } },
  siteCompany: { select: { id: true, name: true } },
  location: { select: { id: true, label: true, city: true } },
  custodian: { select: { id: true, name: true } },
  holder: { select: { id: true, name: true } },
  fixedAsset: { select: { id: true, tag: true } },
  amc: { select: { id: true, endDate: true } },
} satisfies Prisma.AssetSelect;

export type AssetFilters = {
  search?: string;
  ownership?: string;
  status?: string;
  kind?: string;
  companyId?: string;
  custodianUserId?: string;
  /** "mine" narrows to what the signed-in person is holding. */
  scope?: string;
};

export async function listAssets(filters?: AssetFilters) {
  const { user, viewAll } = await access();

  // Without the view-all permission somebody sees exactly what they are holding, which is the
  // useful default for everybody else — "what have I got, and when does it go back".
  const mine = !viewAll || filters?.scope === "mine";

  return toPlain(
    await db.asset.findMany({
      where: {
        ...(mine ? { custodianUserId: user.id } : {}),
        ...(filters?.ownership ? { ownership: filters.ownership as AssetOwnership } : {}),
        ...(filters?.status ? { status: filters.status as AssetStatus } : {}),
        ...(filters?.kind ? { kind: filters.kind as AssetKind } : {}),
        ...(filters?.custodianUserId ? { custodianUserId: filters.custodianUserId } : {}),
        ...(filters?.companyId
          ? { OR: [{ ownerCompanyId: filters.companyId }, { siteCompanyId: filters.companyId }] }
          : {}),
        ...(filters?.search
          ? {
              OR: [
                { assetTag: { contains: filters.search, mode: "insensitive" as const } },
                { serialNumber: { contains: filters.search, mode: "insensitive" as const } },
                { name: { contains: filters.search, mode: "insensitive" as const } },
                { make: { contains: filters.search, mode: "insensitive" as const } },
                { model: { contains: filters.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ status: "asc" }, { assetTag: "asc" }],
      take: 500,
      select: assetSelect,
    }),
  );
}

export async function getAsset(id: string) {
  const { user, manage, viewAll } = await access();
  const asset = await db.asset.findUnique({
    where: { id },
    select: {
      ...assetSelect,
      specification: true,
      notes: true,
      retiredReason: true,
      licenceKey: true,
      vendorCompany: { select: { id: true, name: true } },
      order: { select: { id: true, quantity: true, item: { select: { name: true } } } },
      amc: { select: { id: true, startDate: true, endDate: true, item: { select: { name: true } } } },
      createdBy: { select: { name: true } },
      movements: {
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true, type: true, occurredAt: true, note: true, fromLabel: true, toLabel: true,
          acknowledgedAt: true,
          fromCompany: { select: { id: true, name: true } },
          toCompany: { select: { id: true, name: true } },
          fromUser: { select: { id: true, name: true } },
          toUser: { select: { id: true, name: true } },
          toContact: { select: { id: true, name: true } },
          recordedBy: { select: { name: true } },
          consignment: { select: { id: true, consignmentNumber: true } },
        },
      },
      tickets: {
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, ticketSeq: true, title: true, status: true, createdAt: true },
      },
    },
  });
  if (!asset) return null;
  if (!viewAll && asset.custodian?.id !== user.id) return null;

  // A licence key is an entitlement somebody paid for, not a public field.
  return toPlain({ ...asset, licenceKey: manage ? asset.licenceKey : null });
}

export async function saveAsset(input: {
  id?: string;
  assetTag: string;
  serialNumber?: string;
  name: string;
  kind: AssetKind;
  ownership: AssetOwnership;
  ownerCompanyId?: string;
  siteCompanyId?: string;
  locationId?: string;
  itemId?: string;
  make?: string;
  model?: string;
  specification?: string;
  vendorCompanyId?: string;
  companyProductId?: string;
  amcProductId?: string;
  fixedAssetId?: string;
  purchasedOn?: string;
  purchaseCost?: number;
  warrantyEndsOn?: string;
  amcEndsOn?: string;
  licenceKey?: string;
  seats?: number;
  notes?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't change the asset register." };

  const assetTag = input.assetTag.trim().toUpperCase();
  const serialNumber = input.serialNumber?.trim().toUpperCase() || null;
  if (!assetTag) return { ok: false, error: "Give it a tag — it's what's stuck on the machine." };
  if (!input.name.trim()) return { ok: false, error: "What is it?" };

  // The ownership rules, checked before anything is written. All of them at once, so a form shows
  // every problem rather than one per attempt.
  const problems = checkOwnership({
    ownership: input.ownership,
    ownerCompanyId: input.ownerCompanyId || null,
    fixedAssetId: input.fixedAssetId || null,
    siteCompanyId: input.siteCompanyId || null,
  });
  if (problems.length > 0) return { ok: false, error: problems[0].message };

  const clashes = await db.asset.findMany({
    where: {
      OR: [{ assetTag }, ...(serialNumber ? [{ serialNumber }] : [])],
      ...(input.id ? { id: { not: input.id } } : {}),
    },
    select: { assetTag: true, serialNumber: true, name: true },
  });
  if (clashes.length > 0) {
    const clash = clashes[0];
    return {
      ok: false,
      error:
        clash.assetTag === assetTag
          ? `Tag ${assetTag} is already on ${clash.name}.`
          : `Serial ${serialNumber} is already recorded against ${clash.name}. Two machines sharing one is always a mistake.`,
    };
  }

  const date = (v?: string) => (v ? new Date(`${v}T00:00:00.000Z`) : null);
  const data = {
    assetTag,
    serialNumber,
    name: input.name.trim(),
    kind: input.kind,
    ownership: input.ownership,
    ownerCompanyId: input.ownership === "CLIENT_OWNED" ? (input.ownerCompanyId ?? null) : null,
    siteCompanyId: input.siteCompanyId || null,
    locationId: input.locationId || null,
    itemId: input.itemId || null,
    make: input.make?.trim() || null,
    model: input.model?.trim() || null,
    specification: input.specification?.trim() || null,
    vendorCompanyId: input.vendorCompanyId || null,
    companyProductId: input.companyProductId || null,
    amcProductId: input.amcProductId || null,
    // Belt and braces: the check above already refuses this, and the field is cleared here too so
    // no path can leave a client's machine carrying a financial record.
    fixedAssetId: mayBeCapitalised(input.ownership) ? (input.fixedAssetId || null) : null,
    purchasedOn: date(input.purchasedOn),
    purchaseCost: input.purchaseCost ? new Prisma.Decimal(input.purchaseCost) : null,
    warrantyEndsOn: date(input.warrantyEndsOn),
    amcEndsOn: date(input.amcEndsOn),
    licenceKey: input.licenceKey?.trim() || null,
    seats: input.seats ?? null,
    notes: input.notes?.trim() || null,
  };

  const row = input.id
    ? await db.asset.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.asset.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  if (!input.id) {
    // Everything starts by arriving somewhere. Recording it means the history has a beginning
    // rather than an asset that simply appears in stock one day.
    await db.assetMovement.create({
      data: {
        assetId: row.id,
        type: "RECEIVED",
        occurredAt: data.purchasedOn ?? new Date(),
        toCompanyId: data.siteCompanyId,
        toLocationId: data.locationId,
        note: "Added to the register",
        recordedById: user.id,
      },
    });
  }

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Asset",
    entityId: row.id,
    entityLabel: `${assetTag} ${data.name}`,
  });
  revalidatePath("/assets");
  return { ok: true, data: row };
}

// ─── Custody ──────────────────────────────────────────────────────────────────

/**
 * Hands an asset to somebody, or takes it back.
 *
 * Writes the movement and the asset's new state in one transaction, so the register can never say
 * an asset is assigned while its history says it was returned.
 */
export async function moveAsset(input: {
  assetId: string;
  type: AssetMovementType;
  occurredAt?: string;
  toUserId?: string;
  toCompanyId?: string;
  toLocationId?: string;
  toContactId?: string;
  toLabel?: string;
  ticketId?: string;
  visitId?: string;
  note?: string;
}): Promise<ActionResult<{ status: AssetStatus }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: "You can't move assets." };

  const asset = await db.asset.findUnique({
    where: { id: input.assetId },
    select: {
      id: true, assetTag: true, name: true, status: true, ownership: true,
      custodianUserId: true, siteCompanyId: true, locationId: true,
    },
  });
  if (!asset) return { ok: false, error: "That asset no longer exists." };

  const allowed = canMove(asset.status, input.type);
  if (!allowed.ok) return { ok: false, error: allowed.reason };

  const occurredAt = input.occurredAt ? new Date(`${input.occurredAt}T00:00:00.000Z`) : new Date();
  const status = statusAfter(input.type);

  await db.$transaction(async (tx) => {
    await tx.assetMovement.create({
      data: {
        assetId: asset.id,
        type: input.type,
        occurredAt,
        fromUserId: asset.custodianUserId,
        fromCompanyId: asset.siteCompanyId,
        fromLocationId: asset.locationId,
        toUserId: input.toUserId || null,
        toCompanyId: input.toCompanyId || null,
        toLocationId: input.toLocationId || null,
        toContactId: input.toContactId || null,
        toLabel: input.toLabel?.trim() || null,
        ticketId: input.ticketId || null,
        visitId: input.visitId || null,
        note: input.note?.trim() || null,
        recordedById: user.id,
      },
    });

    await tx.asset.update({
      where: { id: asset.id },
      data: {
        status,
        // Where it is now follows from where it went. A movement that names nobody — scrapped,
        // returned to stock — clears the holder rather than leaving a stale name on the record.
        custodianUserId: input.toUserId ?? (status === "ASSIGNED" ? asset.custodianUserId : null),
        holderContactId: input.toContactId ?? null,
        siteCompanyId: input.toCompanyId ?? (status === "IN_STOCK" ? null : asset.siteCompanyId),
        locationId: input.toLocationId ?? (status === "IN_STOCK" ? null : asset.locationId),
        ...(input.type === "SCRAPPED"
          ? { retiredOn: occurredAt, retiredReason: input.note?.trim() || "Scrapped" }
          : {}),
      },
    });
  });

  if (input.toUserId && input.type === "ASSIGNED") {
    await notifyUser({
      userId: input.toUserId,
      type: "TASK_ASSIGNED",
      title: `${asset.name} is now yours`,
      message: `Asset ${asset.assetTag}. It stays on your record until it's returned.`,
      link: `/assets/${asset.id}`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Asset",
    entityId: asset.id,
    entityLabel: `${asset.assetTag} — ${input.type.toLowerCase().replaceAll("_", " ")}`,
  });
  revalidatePath("/assets");
  revalidatePath(`/assets/${asset.id}`);
  return { ok: true, data: { status } };
}

/** Somebody confirming they actually have it — the step that stops handovers going quiet. */
export async function acknowledgeMovement(movementId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const movement = await db.assetMovement.findUnique({
    where: { id: movementId },
    select: { id: true, toUserId: true, acknowledgedAt: true, asset: { select: { id: true, assetTag: true } } },
  });
  if (!movement) return { ok: false, error: "That movement no longer exists." };
  if (movement.acknowledgedAt) return { ok: false, error: "Already acknowledged." };
  // Only the person it went to can say they have it. Anybody else confirming on their behalf is
  // exactly the acknowledgement that turns out to be worthless.
  if (movement.toUserId !== user.id) {
    return { ok: false, error: "Only the person it was handed to can confirm they have it." };
  }

  await db.assetMovement.update({
    where: { id: movementId },
    data: { acknowledgedAt: new Date(), acknowledgedById: user.id },
  });
  revalidatePath(`/assets/${movement.asset.id}`);
  revalidatePath("/assets/mine");
  return { ok: true, data: null };
}

// ─── What somebody is holding ─────────────────────────────────────────────────

/** Used by the offboarding checklist, and by the person themselves. */
export async function assetsHeldBy(userId: string) {
  const { user, viewAll } = await access();
  if (!viewAll && userId !== user.id) return [];
  return toPlain(
    await db.asset.findMany({
      where: { custodianUserId: userId, status: { notIn: ["RETIRED", "LOST"] } },
      orderBy: { assetTag: "asc" },
      select: {
        ...assetSelect,
        movements: {
          where: { type: "ASSIGNED", toUserId: userId },
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { id: true, occurredAt: true, acknowledgedAt: true },
        },
      },
    }),
  );
}

// ─── The estate view ──────────────────────────────────────────────────────────

/**
 * Whether this company has an estate worth a tab at all.
 *
 * Cheap on purpose: it runs on every company page, and the answer is only used to decide whether to
 * show the tab. A prospect we have never shipped anything to shouldn't carry an empty tab around.
 */
export async function estateCount(companyId: string) {
  const { viewAll } = await access();
  if (!viewAll) return 0;
  const [assets, consignments] = await Promise.all([
    db.asset.count({
      where: {
        status: { not: "RETIRED" },
        OR: [{ ownerCompanyId: companyId }, { siteCompanyId: companyId }],
      },
    }),
    db.consignment.count({ where: { toCompanyId: companyId, status: { not: "CANCELLED" } } }),
  ]);
  return assets + consignments;
}

/**
 * Everything we look after for one company, from that company's side of the relationship.
 *
 * Three lists rather than one, because "whose is it" changes what you are allowed to do with it and
 * who pays when it breaks:
 *
 *  - theirs — their property, on our register only because we manage it. Never our balance sheet.
 *  - ours   — our kit standing at their site. Still ours, still depreciating, and it has to come back.
 *  - away   — ours that *was* at their site and is now on the road or in a repair centre.
 *
 * That last list is the one worth the extra query. `siteCompanyId` follows the machine, so sending
 * one out for repair moves it off the site list — and the customer waiting for it back would find
 * nothing about it on their own page, which is precisely when they ring.
 */
export async function companyEstate(companyId: string) {
  const { viewAll, manage } = await access();
  if (!viewAll) return null;

  const [theirs, ours, movedOut, consignments] = await Promise.all([
    // Ownership doesn't change when a machine moves, so this list holds together even while
    // something is away being fixed.
    db.asset.findMany({
      where: { ownerCompanyId: companyId, status: { not: "RETIRED" } },
      orderBy: [{ status: "asc" }, { assetTag: "asc" }],
      select: assetSelect,
    }),
    db.asset.findMany({
      where: { siteCompanyId: companyId, ownership: { not: "CLIENT_OWNED" }, status: { not: "RETIRED" } },
      orderBy: [{ status: "asc" }, { assetTag: "asc" }],
      select: assetSelect,
    }),
    db.asset.findMany({
      where: {
        status: { in: ["IN_TRANSIT", "UNDER_REPAIR"] },
        movements: { some: { fromCompanyId: companyId } },
      },
      orderBy: { assetTag: "asc" },
      take: 200,
      select: {
        ...assetSelect,
        movements: {
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: {
            id: true,
            type: true,
            occurredAt: true,
            fromCompanyId: true,
            toLabel: true,
            toCompany: { select: { id: true, name: true } },
          },
        },
      },
    }),
    db.consignment.findMany({
      where: { toCompanyId: companyId },
      // The enum runs draft → dispatched → in transit → delivered → cancelled, so this floats
      // whatever is still moving to the top, which is the only part anybody acts on.
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        consignmentNumber: true,
        reason: true,
        status: true,
        courier: true,
        docketNumber: true,
        dispatchedOn: true,
        expectedOn: true,
        deliveredOn: true,
        receivedBy: true,
        declaredValue: true,
        ewayBillNumber: true,
        toLocation: { select: { id: true, label: true, city: true } },
        toContact: { select: { id: true, name: true } },
        document: { select: { id: true, docNumber: true, docType: true } },
        _count: { select: { movements: true } },
      },
    }),
  ]);

  const away = awayFromSite({ candidates: movedOut, companyId, stillHere: [...theirs, ...ours] });

  return toPlain({ theirs, ours, away, consignments, canManage: manage });
}

/** Options for the forms — kept here so a page doesn't reach past the permission check. */
export async function assetFormOptions() {
  const { manage } = await access();
  if (!manage) return { companies: [], people: [], items: [], fixedAssets: [] };

  const [companies, people, items, fixedAssets] = await Promise.all([
    db.company.findMany({ orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.item.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
    // Only financial records nothing else has claimed, so two IT assets can't point at one.
    db.fixedAsset.findMany({
      where: { disposedOn: null, asset: null },
      orderBy: { tag: "asc" },
      select: { id: true, tag: true, name: true },
    }),
  ]);
  return { companies, people, items, fixedAssets };
}

/** Sites for one company, for the location pickers. */
export async function locationsFor(companyId: string) {
  await requireUser();
  return db.companyLocation.findMany({
    where: { companyId },
    orderBy: { label: "asc" },
    select: { id: true, label: true, city: true, state: true },
  });
}

/** AMCs a client has, so an asset can be put under one. */
export async function amcOptionsFor(companyId: string) {
  const { manage } = await access();
  if (!manage) return [];
  return toPlain(
    await db.companyProduct.findMany({
      where: { companyId, endDate: { not: null } },
      orderBy: { endDate: "desc" },
      take: 50,
      select: { id: true, startDate: true, endDate: true, quantity: true, item: { select: { name: true } } },
    }),
  );
}
