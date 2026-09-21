import { AssetKind, AssetOwnership, AssetStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { checkOwnership } from "@/lib/assets/lifecycle";
import { findCompany, optionalUserRef, type CompanyRef, type UserRef } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * The IT asset register, as a spreadsheet — which is how a customer's estate usually arrives.
 *
 * ## What a row is matched on
 *
 * The serial number first, the asset tag second. The serial is the manufacturer's: it is the one
 * identifier that survives the device changing hands, changing owner and changing system. The tag is
 * ours, it is a label somebody stuck on the case, and it gets peeled off and reissued. Where the
 * serial finds nothing the tag is tried, because our own register usually holds the tag while the
 * customer's spreadsheet is what supplies the serial for the first time — treating that row as a new
 * asset would collide with the tag already on it, and the correct outcome is that the machine we
 * have finally learns its serial.
 *
 * A row carrying a serial we have never seen and no tag is refused, not given a derived one. A tag
 * means "this string is printed on that machine"; inventing one asserts something untrue about a
 * physical object, and it collides on the day somebody issues the same number for real. A failed row
 * is cheap to fix now; a duplicate tag is expensive to unpick later.
 *
 * ## What a new asset must say for itself
 *
 * Kind and Ownership are required on a create even though both columns have a database default,
 * because both defaults are answers rather than absences. Blank Kind makes a room full of monitors
 * into laptops. Blank Ownership makes a customer's machine ours — and ownership is the field the
 * whole module turns on, since it decides whether the thing may reach our balance sheet at all.
 * Status is left to default: IN_STOCK means "we have it and nobody is using it", which is honestly
 * what an unstated status means.
 *
 * Tags and serials are upper-cased on the way in, the same normalisation `saveAsset` applies, so a
 * file typed in lower case updates the machine we already have instead of creating a second one.
 */

const COLUMNS = [
  "Asset tag",
  "Serial number",
  "Name",
  "Kind",
  "Status",
  "Ownership",
  "Owner company",
  "Site company",
  "Custodian",
  "Make",
  "Model",
  "Specification",
  "Vendor",
  "Purchased on",
  "Purchase cost",
  "Warranty ends",
  "AMC ends",
  "Seats",
  "Notes",
];

/** The shared lookups have the required company and the optional person, but not this one. */
async function optionalCompanyRef(column: string, value: string): Promise<Resolved<CompanyRef | null>> {
  if (!value.trim()) return { value: null };
  const company = await findCompany(value);
  if (!company) {
    return { error: `No company named "${value}" (${column}). Import the company first, or correct the spelling.` };
  }
  return { value: company };
}

function findExisting(where: Prisma.AssetWhereUniqueInput) {
  return db.asset.findUnique({
    where,
    include: {
      ownerCompany: { select: { name: true } },
      siteCompany: { select: { name: true } },
      // id and email as well as the name, because `custodianRef` below has to recognise the person
      // already holding this machine by whichever of the two the file names them with.
      custodian: { select: { id: true, name: true, email: true, active: true } },
      vendorCompany: { select: { name: true } },
    },
  });
}

type ExistingAsset = NonNullable<Awaited<ReturnType<typeof findExisting>>>;

/**
 * The person holding it.
 *
 * `optionalUserRef` matches active accounts only, which is right when somebody is being *given* an
 * asset: custody handed to a leaver is custody nobody has. But a custodian who has since left is the
 * ordinary case in an estate — a departed employee still holding a laptop is exactly what an audit
 * is looking for — and the export writes their name. Read back through the active-only lookup, the
 * row we exported becomes an error, so the file this module produces cannot be handed back to it.
 *
 * The name already recorded against *this* asset is therefore accepted whether or not the account is
 * still active. Nothing else is: naming a departed employee on a machine they do not hold still
 * fails, so the leniency is exactly the width of the round trip and no wider.
 */
async function custodianRef(value: string, existing: ExistingAsset | null): Promise<Resolved<UserRef | null>> {
  const wanted = value.trim();
  const held = existing?.custodian;
  if (wanted && held && (held.name.toLowerCase() === wanted.toLowerCase() || held.email === wanted.toLowerCase())) {
    return { value: held };
  }
  return optionalUserRef("Custodian", value);
}

/**
 * Money, at the scale the column really stores.
 *
 * `purchaseCost` is `Decimal(14, 2)`, so a cell reading 72500.555 is written as 72500.56. Compared
 * against the unrounded cell that is a difference, and it is a difference the same file reports on
 * every future run — the import never converges and the preview keeps promising a change that has
 * already happened. Rounding here means plan() shows the number apply() will actually write.
 */
function money(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Undefined everywhere means the cell was blank, which leaves that field as it is. */
type ResolvedAsset = {
  existing: ExistingAsset | null;
  assetTag?: string;
  serialNumber?: string;
  name?: string;
  kind?: AssetKind;
  status?: AssetStatus;
  ownership?: AssetOwnership;
  ownerCompanyId?: string;
  ownerCompanyName?: string;
  siteCompanyId?: string;
  siteCompanyName?: string;
  custodianUserId?: string;
  custodianName?: string;
  vendorCompanyId?: string;
  vendorCompanyName?: string;
  make?: string;
  model?: string;
  specification?: string;
  purchasedOn?: Date;
  purchaseCost?: number;
  warrantyEndsOn?: Date;
  amcEndsOn?: Date;
  seats?: number;
  notes?: string;
};

/** A stored date and an imported one compared as the day they are, which is all a @db.Date holds. */
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * Whether this row would leave the asset in a state the register does not allow.
 *
 * The rules themselves come from `checkOwnership`, so a spreadsheet cannot reach a state the asset's
 * own screen refuses — most importantly that a client's machine may not carry a fixed-asset record,
 * because capitalising it would put somebody else's property on our balance sheet.
 *
 * Only a contradiction *this row creates* is refused. One already sitting in the record stays the
 * record's problem: blocking the row would stop somebody using the same file to correct a custodian,
 * and an empty cell cannot clear the offending field anyway. The messages are written against the
 * columns rather than reused verbatim, because "clear the owner" is advice a spreadsheet cannot act
 * on — a blank cell here means "leave it alone".
 */
function ownershipProblem(c: ResolvedAsset): string | null {
  const e = c.existing;
  const after = {
    ownership: c.ownership ?? e?.ownership ?? AssetOwnership.INTERNAL,
    ownerCompanyId: c.ownerCompanyId ?? e?.ownerCompanyId ?? null,
    siteCompanyId: c.siteCompanyId ?? e?.siteCompanyId ?? null,
    fixedAssetId: e?.fixedAssetId ?? null,
  };

  const problems = checkOwnership(after);
  if (problems.length === 0) return null;

  const already = new Set(e ? checkOwnership(e).map((p) => p.field) : []);
  const fresh = problems.find((p) => !already.has(p.field));
  if (!fresh) return null;

  if (fresh.field === "ownerCompanyId") {
    return after.ownership === AssetOwnership.CLIENT_OWNED
      ? "Ownership is CLIENT_OWNED, so Owner company has to say whose asset it is."
      : `Owner company names a company while Ownership is ${after.ownership}. Something that is ours cannot also be owned by a customer — set Ownership to CLIENT_OWNED, or clear the owner on the asset's own screen, since a blank cell here leaves the field alone rather than clearing it.`;
  }
  if (fresh.field === "siteCompanyId") {
    return "Ownership is DEPLOYED, which means it is sitting at somebody's site — Site company has to say whose.";
  }
  return "This asset carries a fixed-asset record, so it cannot be marked CLIENT_OWNED: capitalising a client's machine would put their property on our balance sheet. Unlink the financial record first.";
}

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedAsset>> {
  const r = new RowReader(row);

  const assetTag = r.text("Asset tag").toUpperCase() || undefined;
  const serialNumber = r.text("Serial number").toUpperCase() || undefined;
  const name = r.text("Name") || undefined;
  const kind = r.enum("Kind", AssetKind);
  const status = r.enum("Status", AssetStatus);
  const ownership = r.enum("Ownership", AssetOwnership);
  const purchasedOn = r.date("Purchased on");
  const warrantyEndsOn = r.date("Warranty ends");
  const amcEndsOn = r.date("AMC ends");
  const purchaseCost = money(r.number("Purchase cost"));
  const seats = r.number("Seats");
  if (r.error) return { error: r.error };

  if (!assetTag && !serialNumber) {
    return { error: "Give the row an Asset tag or a Serial number — with neither there is nothing to match it on." };
  }
  if (seats !== undefined && !Number.isInteger(seats)) {
    return { error: `Seats "${r.text("Seats")}" has to be a whole number of licences.` };
  }

  const bySerial = serialNumber ? await findExisting({ serialNumber }) : null;
  const byTag = assetTag ? await findExisting({ assetTag }) : null;
  if (bySerial && byTag && bySerial.id !== byTag.id) {
    return {
      error: `Serial number ${serialNumber} is on ${bySerial.assetTag} (${bySerial.name}) but Asset tag ${assetTag} is on a different machine (${byTag.name}). Correct whichever of the two is wrong.`,
    };
  }
  const existing = bySerial ?? byTag;

  if (!existing) {
    if (!assetTag) {
      return {
        error: `Serial number ${serialNumber} isn't in the register, so this row would add an asset — and a new asset needs an Asset tag. Tags are ours to issue and are printed on the machine, so one is not invented here.`,
      };
    }
    if (!name) return { error: "Name is required for a new asset — what is it?" };
    if (!kind) {
      return { error: `Kind is required for a new asset: ${Object.keys(AssetKind).join(", ")}. Left blank it would become a laptop.` };
    }
    if (!ownership) {
      return {
        error: `Ownership is required for a new asset: ${Object.keys(AssetOwnership).join(", ")}. It decides whether the thing may ever reach our balance sheet, so it is never assumed.`,
      };
    }
  }

  const ownerCompany = await optionalCompanyRef("Owner company", r.text("Owner company"));
  if ("error" in ownerCompany) return { error: ownerCompany.error };
  const siteCompany = await optionalCompanyRef("Site company", r.text("Site company"));
  if ("error" in siteCompany) return { error: siteCompany.error };
  const vendorCompany = await optionalCompanyRef("Vendor", r.text("Vendor"));
  if ("error" in vendorCompany) return { error: vendorCompany.error };
  const custodian = await custodianRef(r.text("Custodian"), existing);
  if ("error" in custodian) return { error: custodian.error };

  const value: ResolvedAsset = {
    existing,
    assetTag,
    serialNumber,
    name,
    kind,
    status,
    ownership,
    ownerCompanyId: ownerCompany.value?.id,
    ownerCompanyName: ownerCompany.value?.name,
    siteCompanyId: siteCompany.value?.id,
    siteCompanyName: siteCompany.value?.name,
    custodianUserId: custodian.value?.id,
    custodianName: custodian.value?.name,
    vendorCompanyId: vendorCompany.value?.id,
    vendorCompanyName: vendorCompany.value?.name,
    make: r.text("Make") || undefined,
    model: r.text("Model") || undefined,
    specification: r.text("Specification") || undefined,
    purchasedOn,
    purchaseCost,
    warrantyEndsOn,
    amcEndsOn,
    seats,
    notes: r.text("Notes") || undefined,
  };

  const problem = ownershipProblem(value);
  if (problem) return { error: problem };

  return { value };
}

export const assetsImporter: Importer = {
  templateColumns: COLUMNS,

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) {
      return errorRow(line, row["Asset tag"] || row["Serial number"] || row.Name || "", resolved.error);
    }
    const c = resolved.value;
    const key = c.existing?.assetTag ?? c.assetTag ?? "";
    const label = c.name ?? c.existing?.name ?? key;

    if (!c.existing) {
      return createRow(line, key, label, {
        "Asset tag": c.assetTag,
        "Serial number": c.serialNumber,
        Name: c.name,
        Kind: c.kind,
        Status: c.status,
        Ownership: c.ownership,
        "Owner company": c.ownerCompanyName,
        "Site company": c.siteCompanyName,
        Custodian: c.custodianName,
        Make: c.make,
        Model: c.model,
        Specification: c.specification,
        Vendor: c.vendorCompanyName,
        "Purchased on": c.purchasedOn,
        "Purchase cost": c.purchaseCost,
        "Warranty ends": c.warrantyEndsOn,
        "AMC ends": c.amcEndsOn,
        Seats: c.seats,
        Notes: c.notes,
      });
    }

    const e = c.existing;
    return updateRow(line, key, label, [
      c.assetTag !== undefined ? diff("Asset tag", e.assetTag, c.assetTag) : null,
      c.serialNumber !== undefined ? diff("Serial number", e.serialNumber, c.serialNumber) : null,
      c.name !== undefined ? diff("Name", e.name, c.name) : null,
      c.kind !== undefined ? diff("Kind", e.kind, c.kind) : null,
      c.status !== undefined ? diff("Status", e.status, c.status) : null,
      c.ownership !== undefined ? diff("Ownership", e.ownership, c.ownership) : null,
      c.ownerCompanyName !== undefined ? diff("Owner company", e.ownerCompany?.name, c.ownerCompanyName) : null,
      c.siteCompanyName !== undefined ? diff("Site company", e.siteCompany?.name, c.siteCompanyName) : null,
      c.custodianName !== undefined ? diff("Custodian", e.custodian?.name, c.custodianName) : null,
      c.make !== undefined ? diff("Make", e.make, c.make) : null,
      c.model !== undefined ? diff("Model", e.model, c.model) : null,
      c.specification !== undefined ? diff("Specification", e.specification, c.specification) : null,
      c.vendorCompanyName !== undefined ? diff("Vendor", e.vendorCompany?.name, c.vendorCompanyName) : null,
      c.purchasedOn !== undefined ? diff("Purchased on", day(e.purchasedOn), day(c.purchasedOn)) : null,
      c.purchaseCost !== undefined
        ? diff("Purchase cost", e.purchaseCost === null ? null : Number(e.purchaseCost), c.purchaseCost)
        : null,
      c.warrantyEndsOn !== undefined ? diff("Warranty ends", day(e.warrantyEndsOn), day(c.warrantyEndsOn)) : null,
      c.amcEndsOn !== undefined ? diff("AMC ends", day(e.amcEndsOn), day(c.amcEndsOn)) : null,
      c.seats !== undefined ? diff("Seats", e.seats, c.seats) : null,
      c.notes !== undefined ? diff("Notes", e.notes, c.notes) : null,
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;

    const data = {
      ...(c.assetTag !== undefined ? { assetTag: c.assetTag } : {}),
      ...(c.serialNumber !== undefined ? { serialNumber: c.serialNumber } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.ownership !== undefined ? { ownership: c.ownership } : {}),
      ...(c.ownerCompanyId !== undefined ? { ownerCompanyId: c.ownerCompanyId } : {}),
      ...(c.siteCompanyId !== undefined ? { siteCompanyId: c.siteCompanyId } : {}),
      ...(c.custodianUserId !== undefined ? { custodianUserId: c.custodianUserId } : {}),
      ...(c.vendorCompanyId !== undefined ? { vendorCompanyId: c.vendorCompanyId } : {}),
      ...(c.make !== undefined ? { make: c.make } : {}),
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.specification !== undefined ? { specification: c.specification } : {}),
      ...(c.purchasedOn !== undefined ? { purchasedOn: c.purchasedOn } : {}),
      ...(c.purchaseCost !== undefined ? { purchaseCost: c.purchaseCost } : {}),
      ...(c.warrantyEndsOn !== undefined ? { warrantyEndsOn: c.warrantyEndsOn } : {}),
      ...(c.amcEndsOn !== undefined ? { amcEndsOn: c.amcEndsOn } : {}),
      ...(c.seats !== undefined ? { seats: c.seats } : {}),
      ...(c.notes !== undefined ? { notes: c.notes } : {}),
    };

    if (c.existing) {
      await db.asset.update({ where: { id: c.existing.id }, data });
      return;
    }

    const created = await db.asset.create({
      data: { ...data, assetTag: c.assetTag!, name: c.name!, createdById: ctx.actorUserId },
      select: { id: true },
    });

    // The same first event `saveAsset` writes when somebody adds an asset by hand. Without it an
    // imported estate has no beginning, and "where has this been" starts mid-sentence — which is
    // the question the movement log exists to answer.
    await db.assetMovement.create({
      data: {
        assetId: created.id,
        type: "RECEIVED",
        occurredAt: c.purchasedOn ?? new Date(),
        toCompanyId: c.siteCompanyId ?? null,
        note: "Added by import",
        recordedById: ctx.actorUserId,
      },
    });
  },
};
