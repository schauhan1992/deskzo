import { CompanyStage, CompanySource } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/validation/company";
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

  const owner = await optionalUserRef("Account manager", r.text("Account manager"));
  if ("error" in owner) return { error: owner.error };

  return {
    value: {
      name,
      normalizedName: normalizeCompanyName(name),
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

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;

    const existing = await db.company.findUnique({
      where: { normalizedName: c.normalizedName },
      include: { owner: { select: { name: true } }, industry: { select: { name: true } } },
    });

    if (!existing) {
      return createRow(line, c.normalizedName, c.name, {
        Name: c.name,
        Stage: c.stage,
        Source: c.source,
        Industry: c.industryName,
        Website: c.website,
        "Account manager": c.ownerName,
      });
    }

    return updateRow(line, c.normalizedName, c.name, [
      diff("Name", existing.name, c.name),
      c.stage ? diff("Stage", existing.stage, c.stage) : null,
      c.source ? diff("Source", existing.source, c.source) : null,
      c.industryName ? diff("Industry", existing.industry?.name, c.industryName) : null,
      c.website ? diff("Website", existing.website, c.website) : null,
      c.ownerName ? diff("Account manager", existing.owner?.name, c.ownerName) : null,
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

    const data = {
      name: c.name,
      ...(c.stage ? { stage: c.stage } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.website ? { website: c.website } : {}),
      ...(industry ? { industryId: industry.id } : {}),
      ...(c.ownerUserId ? { ownerUserId: c.ownerUserId } : {}),
    };

    await db.company.upsert({
      where: { normalizedName: c.normalizedName },
      update: data,
      create: {
        ...data,
        normalizedName: c.normalizedName,
        relationshipType: RELATIONSHIP[ctx.area as keyof typeof RELATIONSHIP] ?? "CLIENT",
        createdById: ctx.actorUserId,
        // Falling back to the importer when the file names nobody. Better than null: an unowned
        // account is invisible to everybody under the scoping rules.
        ownerUserId: c.ownerUserId ?? ctx.actorUserId,
      },
    });
  },
};
