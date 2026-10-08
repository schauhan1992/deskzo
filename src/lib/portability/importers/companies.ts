import { CompanyStage, CompanySource, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { valuesFor } from "@/lib/custom-fields/server";
import { isVendorRelationshipType, normalizeCompanyName } from "@/lib/validation/company";
import { assignVendorCodes } from "@/lib/companies/vendor-code";
import { optionalUserRef } from "./lookups";
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
 * Companies, and the three other kinds of party that live in the same table.
 *
 * `relationshipType` separates clients, vendors, resellers and commission agents, and it is taken
 * from the area being imported into rather than from a column. Importing a vendor list should
 * produce vendors whatever the file says, and a mistyped Type cell that quietly filed a supplier in
 * the customer pool would be found much later, by somebody wondering why they are being marketed to.
 */

type ResolvedCompany = {
  name: string;
  normalizedName: string;
  stage?: CompanyStage;
  source?: CompanySource;
  industryName?: string;
  website?: string;
  ownerUserId?: string;
  ownerName?: string;
};

const RELATIONSHIP = {
  vendors: "VENDOR",
  resellers: "RESELLER",
  "commission-parties": "COMMISSION_PARTY",
} as const;

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedCompany>> {
  const r = new RowReader(row);
  const name = r.text("Name") || r.text("name");
  if (!name) return { error: "Name is required." };

  const stage = r.enum("Stage", CompanyStage);
  const source = r.enum("Source", CompanySource);
  if (r.error) return { error: r.error };

  // The account manager it has today reads back even if they have since left (`optionalUserRef`).
  const normalizedName = normalizeCompanyName(name);
  const held = await db.company.findUnique({
    where: { normalizedName },
    select: { owner: { select: { id: true, name: true, email: true, active: true } } },
  });
  const owner = await optionalUserRef("Account manager", r.text("Account manager"), false, held?.owner);
  if ("error" in owner) return { error: owner.error };

  return {
    value: {
      name,
      normalizedName,
      stage,
      source,
      industryName: r.text("Industry") || undefined,
      website: r.text("Website") || undefined,
      ownerUserId: owner.value?.id,
      ownerName: owner.value?.name,
    },
  };
}

export const companiesImporter: Importer = {
  templateColumns: ["Name", "Stage", "Source", "Industry", "Website", "Account manager"],
  customEntity: "COMPANY",

  async plan(row, line, ctx) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;

    const existing = await db.company.findUnique({
      where: { normalizedName: c.normalizedName },
      include: { owner: { select: { name: true } }, industry: { select: { name: true } } },
    });
    // The workspace's own fields in this row, checked against what the company holds (sheets.ts).
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor("COMPANY", existing.id) : {}, row) : null;
    if (custom && !custom.ok) return errorRow(line, c.name, custom.error);

    if (!existing) {
      return createRow(line, c.normalizedName, c.name, {
        Name: c.name,
        Stage: c.stage,
        Source: c.source,
        Industry: c.industryName,
        Website: c.website,
        "Account manager": c.ownerName,
        ...(custom?.ok ? Object.fromEntries(custom.changes.map((ch) => [ch.field, ch.to])) : {}),
      });
    }

    return updateRow(line, c.normalizedName, c.name, [
      diff("Name", existing.name, c.name),
      c.stage ? diff("Stage", existing.stage, c.stage) : null,
      c.source ? diff("Source", existing.source, c.source) : null,
      c.industryName ? diff("Industry", existing.industry?.name, c.industryName) : null,
      c.website ? diff("Website", existing.website, c.website) : null,
      c.ownerName ? diff("Account manager", existing.owner?.name, c.ownerName) : null,
      ...(custom?.ok ? custom.changes : []),
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;

    // The one write the planner could not do for itself: an industry the file names but the system
    // has never seen. Created here rather than in resolve() so that planning stays read-only.
    const industry = c.industryName
      ? await db.industry.upsert({ where: { name: c.industryName }, update: {}, create: { name: c.industryName } })
      : null;

    const existing = await db.company.findUnique({ where: { normalizedName: c.normalizedName }, select: { id: true } });
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor("COMPANY", existing.id) : {}, row) : null;
    if (custom && !custom.ok) throw new Error(custom.error);

    const data = {
      name: c.name,
      ...(custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {}),
      ...(c.stage ? { stage: c.stage } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.website ? { website: c.website } : {}),
      ...(industry ? { industryId: industry.id } : {}),
      ...(c.ownerUserId ? { ownerUserId: c.ownerUserId } : {}),
    };

    const relationshipType = RELATIONSHIP[ctx.area as keyof typeof RELATIONSHIP] ?? "CLIENT";
    const saved = await db.company.upsert({
      where: { normalizedName: c.normalizedName },
      update: data,
      select: { id: true },
      create: {
        ...data,
        normalizedName: c.normalizedName,
        relationshipType,
        createdById: ctx.actorUserId,
        // Falling back to the importer when the file names nobody. Better than null: an unowned
        // account is invisible to everybody under the scoping rules.
        ownerUserId: c.ownerUserId ?? ctx.actorUserId,
      },
    });
    // A vendor new to the system is numbered as one created by hand is (src/lib/companies/vendor-code.ts).
    if (!existing && isVendorRelationshipType(relationshipType)) await assignVendorCodes([saved.id]);
  },
};
