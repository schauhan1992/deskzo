"use server";

import { revalidatePath } from "next/cache";
import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { buildDocumentNumber, defaultNumberSetting, startingSerial } from "@/lib/document-numbering";
import { documentNumberSettingSchema } from "@/lib/validation/trade-document";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { ActionResult } from "@/actions/company";

/**
 * A type's number format. Until someone changes it, the built-in default applies — with its serial
 * seeded past anything already issued, so enabling numbering on a system with history doesn't
 * immediately propose a number that's taken.
 */
export async function getNumberSetting(docType: TradeDocumentType) {
  await requireUser();
  const row = await db.documentNumberSetting.findUnique({ where: { docType } });
  if (row) return { mode: row.mode, prefix: row.prefix, nextNumber: row.nextNumber, padding: row.padding };

  const existing = await db.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
  return { ...defaultNumberSetting(docType), nextNumber: startingSerial(existing.map((d) => d.docNumber)) };
}

export async function listNumberSettings() {
  await requireUser();
  const rows = await db.documentNumberSetting.findMany();
  const byType = new Map(rows.map((r) => [r.docType, r]));
  return (Object.keys(tradeDocumentLabels) as TradeDocumentType[]).map((docType) => {
    const row = byType.get(docType);
    return {
      docType,
      ...(row
        ? { mode: row.mode, prefix: row.prefix, nextNumber: row.nextNumber, padding: row.padding }
        : defaultNumberSetting(docType)),
    };
  });
}

/**
 * What the next auto-generated number would be, without taking it. Used to fill the form's number
 * field — the serial is only consumed when the document is actually created, so opening a form and
 * abandoning it doesn't burn a number.
 */
export async function previewNextNumber(docType: TradeDocumentType) {
  await requireUser();
  const setting = await getNumberSetting(docType);
  if (setting.mode === "MANUAL") return "";
  return buildDocumentNumber(setting.prefix, setting.nextNumber, setting.padding, new Date());
}

export async function saveNumberSetting(input: unknown): Promise<ActionResult<{ docType: TradeDocumentType }>> {
  const user = await requireUser();
  /**
   * Numbering is an organisation-wide setting.
   *
   * Changing a prefix or rewinding a serial rewrites how every future document is identified — and
   * a GST serial that goes backwards is a filing problem, not a preference. It was reachable by any
   * signed-in session.
   */
  if (!(await can(user.id, "settings.manage"))) {
    return { ok: false, error: "Only an admin can change document numbering." };
  }
  const parsed = documentNumberSettingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { docType, mode, prefix, nextNumber, padding } = parsed.data;

  // Refuse to rewind onto numbers already in use — the collision would only surface at save time,
  // after someone has filled in a whole document.
  if (mode === "AUTO") {
    const candidate = buildDocumentNumber(prefix ?? "", nextNumber, padding, new Date());
    const clash = await db.tradeDocument.findUnique({ where: { docNumber: candidate }, select: { id: true } });
    if (clash) {
      return { ok: false, error: `${candidate} already exists — pick a higher next number.` };
    }
  }

  const fields = { mode, prefix: prefix ?? "", nextNumber, padding };
  await db.documentNumberSetting.upsert({
    where: { docType },
    create: { docType, ...fields },
    update: fields,
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentNumberSetting",
    entityId: docType,
    entityLabel: `${tradeDocumentLabels[docType]} numbering → ${mode === "AUTO" ? `${prefix}${nextNumber}` : "manual"}`,
  });

  revalidatePath("/settings/organisation");
  return { ok: true, data: { docType } };
}
