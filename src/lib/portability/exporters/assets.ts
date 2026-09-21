import { db } from "@/lib/db";
import type { Exporter, ExportScope } from "./types";

/**
 * The managed estate — every device and licence we look after, whoever owns it.
 *
 * ## Scoping, and why the shared helper is not called
 *
 * `viaOptionalCompany` encodes the rule this needs: a record with no company at all is ours, and
 * dropping it would silently take the whole internal estate out of the file. But it is written for a
 * model that reaches a company through one `company` relation, and an asset reaches two — the
 * customer who owns it and the site it sits at, neither of which is called `company`. So the same
 * rule is spelled out here against those two relations rather than the helper being bent to fit.
 * An asset counts as in scope when either of its companies is one this person manages, because a
 * customer's machine parked at our workshop is still their machine.
 *
 * ## The licence key is deliberately absent
 *
 * `getAsset` already withholds it from anybody without `assets.manage`, and an export has no
 * permission to check against — only who may see which accounts. A licence key is an entitlement
 * somebody paid for, so the one column that would be worth stealing stays out of a file that
 * travels. Seats, which say how much was bought, are here; the key that unlocks it is not.
 *
 * The headings are the import template for this area, in this order. Editing either file means
 * editing both, or the round trip stops holding.
 */

function assetScope(scope: ExportScope) {
  if (scope.ownerUserIds === null) return {};
  const managed = { ownerUserId: { in: scope.ownerUserIds } };
  return {
    OR: [
      // Ours, on nobody's site: internal kit, in scope for anyone who may see the area at all.
      { ownerCompanyId: null, siteCompanyId: null },
      { ownerCompany: managed },
      { siteCompany: managed },
    ],
  };
}

export const assetsExporter: Exporter = async (scope) => {
  const rows = await db.asset.findMany({
    where: assetScope(scope),
    include: {
      ownerCompany: { select: { name: true } },
      siteCompany: { select: { name: true } },
      custodian: { select: { name: true } },
      vendorCompany: { select: { name: true } },
    },
    orderBy: { assetTag: "asc" },
  });

  return rows.map((a) => ({
    "Asset tag": a.assetTag,
    "Serial number": a.serialNumber ?? "",
    Name: a.name,
    Kind: a.kind,
    Status: a.status,
    Ownership: a.ownership,
    "Owner company": a.ownerCompany?.name ?? "",
    "Site company": a.siteCompany?.name ?? "",
    Custodian: a.custodian?.name ?? "",
    Make: a.make ?? "",
    Model: a.model ?? "",
    Specification: a.specification ?? "",
    Vendor: a.vendorCompany?.name ?? "",
    "Purchased on": a.purchasedOn,
    // Zero is a fact — something acquired at no cost — so it is written rather than blanked.
    "Purchase cost": a.purchaseCost === null ? null : Number(a.purchaseCost),
    "Warranty ends": a.warrantyEndsOn,
    "AMC ends": a.amcEndsOn,
    Seats: a.seats,
    Notes: a.notes ?? "",
  }));
};
