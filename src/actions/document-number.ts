"use server";

import { revalidatePath } from "next/cache";
import type { DocumentNumberMode, DocumentSeriesScope, TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import {
  buildDocumentNumber,
  defaultNumberSetting,
  derivedSeriesPrefix,
  expandPrefix,
  gstNumberProblem,
  numberFormatWarning,
  numberScopeLabels,
  startingSerial,
  type PrefixContext,
} from "@/lib/document-numbering";
import { seriesFor, seriesOwner, type SeriesBranch } from "@/lib/trade-number";
import { ensureHeadOffice } from "@/lib/branches/identity";
import { branchLabel } from "@/lib/branches/format";
import { documentNumberSettingSchema } from "@/lib/validation/trade-document";
import { documentSeriesSchema, numberingScopeSchema } from "@/lib/validation/branch";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import type { ActionResult } from "@/actions/company";

/**
 * Document numbering settings: the company series of each type (the `DocumentNumberSetting` row), and
 * under a per-registration or per-branch scope each owner's own series (spec §6).
 *
 * Which series a branch's numbers come from is `src/lib/trade-number.ts`'s to decide; everything here
 * reads it through the same functions (`seriesFor`, `seriesOwner`), so the screen shows exactly what
 * allocation will do. Formats are checked against GST's 16-character rule (§6.5) only in AUTO mode — a
 * manually numbered type never builds a number from them.
 */

/** One owner's series of a type, as the numbering screen shows it. */
export type SeriesView = {
  ownerKey: string;
  ownerKind: "REGISTRATION" | "BRANCH";
  ownerLabel: string;
  gstRegistrationId: string | null;
  branchId: string | null;
  /** False: nothing is numbered here yet, and the values are the ones it will be created with. */
  exists: boolean;
  prefix: string;
  nextNumber: number;
  padding: number;
  example: string;
  problem: string | null;
  warning: string | null;
  isHeadOffice: boolean;
};

export type NumberSettingView = {
  docType: TradeDocumentType;
  mode: DocumentNumberMode;
  scope: DocumentSeriesScope;
  prefix: string;
  nextNumber: number;
  padding: number;
  example: string;
  problem: string | null;
  warning: string | null;
  /** Under a per-registration or per-branch scope, the series of every active branch; empty for COMPANY. */
  series: SeriesView[];
};

/** The series a document raised at one branch takes its number from — what the form's numbering dialog edits. */
export type NumberSettingForForm = {
  mode: DocumentNumberMode;
  scope: DocumentSeriesScope;
  prefix: string;
  nextNumber: number;
  padding: number;
  seriesId: string | null;
  ownerKey: string | null;
  ownerLabel: string | null;
  /** What {GST} and {BR} expand to for this series, so the form's dialog can preview a prefix exactly. */
  ctx: PrefixContext;
  /** Whose series it is, when it isn't the company's. */
  ownerKind: "REGISTRATION" | "BRANCH" | null;
};

type Owner = ReturnType<typeof seriesOwner> & { ctx: PrefixContext; isHeadOffice: boolean };

/** Thrown inside a transaction to roll it back and say why. */
class Refusal extends Error {}

/** What `{GST}` and `{BR}` print for numbers raised at this branch — as allocation expands them. */
function contextOf(branch: SeriesBranch | null | undefined): PrefixContext {
  return { branchCode: branch?.code ?? null, registrationCode: branch?.gstRegistration?.code ?? null };
}

/** Active branches, as routing reads them, head office first. */
async function activeSeriesBranches(): Promise<SeriesBranch[]> {
  const rows = await db.branch.findMany({
    where: { active: true },
    select: { id: true, name: true, code: true, isHeadOffice: true, gstRegistration: { select: { id: true, code: true, gstin: true } } },
  });
  return rows.sort((a, b) => Number(b.isHeadOffice) - Number(a.isHeadOffice) || a.name.localeCompare(b.name));
}

/**
 * The series a type's numbers are counted in under this scope, one per owner, decided as allocation
 * decides it (`seriesOwner`). A registration several branches share is one owner; its `{BR}` prints the
 * first of them — the head office when it is one, since the branches come head office first.
 */
function ownersOf(scope: "REGISTRATION" | "BRANCH", branches: SeriesBranch[], docType: TradeDocumentType): Owner[] {
  const owners = new Map<string, Owner>();
  for (const branch of branches) {
    const owner = seriesOwner(scope, branch, docType);
    if (owners.has(owner.ref.ownerKey)) continue;
    owners.set(owner.ref.ownerKey, { ...owner, ctx: contextOf(branch), isHeadOffice: branch.isHeadOffice });
  }
  return [...owners.values()];
}

/** A stored series with what its owner prints — for series whose owner may no longer be active. */
const SERIES_OWNER_INCLUDE = {
  gstRegistration: { select: { id: true, code: true, gstin: true } },
  branch: { select: { name: true, code: true, isHeadOffice: true, gstRegistration: { select: { code: true } } } },
} as const;

type StoredSeries = {
  gstRegistrationId: string | null;
  gstRegistration: { id: string; code: string; gstin: string } | null;
  branch: { name: string; code: string; isHeadOffice: boolean; gstRegistration: { code: string } | null } | null;
};

function storedSeriesContext(row: StoredSeries, branches: SeriesBranch[]): PrefixContext {
  if (row.branch) return { branchCode: row.branch.code, registrationCode: row.branch.gstRegistration?.code ?? null };
  const first = branches.find((b) => b.gstRegistration?.id === row.gstRegistrationId);
  return { branchCode: first?.code ?? null, registrationCode: row.gstRegistration?.code ?? null };
}

function storedSeriesLabel(row: StoredSeries): string {
  if (row.gstRegistration) return `${row.gstRegistration.code} — GSTIN ${row.gstRegistration.gstin}`;
  return row.branch ? branchLabel(row.branch) : "another series";
}

/** A format's next number for today, and what GST's 16-character rule says about it. */
function describe(docType: TradeDocumentType, prefix: string, nextNumber: number, padding: number, ctx: PrefixContext, now: Date) {
  const example = buildDocumentNumber(prefix, nextNumber, padding, now, ctx);
  return { example, problem: gstNumberProblem(docType, example), warning: numberFormatWarning(docType, prefix, nextNumber, padding, ctx) };
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Every type's numbering, with its series. Until someone changes a type, the built-in default applies —
 * its serial seeded past anything already issued, so enabling numbering on a system with history
 * doesn't immediately propose a number that's taken.
 */
export async function listNumberSettings(): Promise<NumberSettingView[]> {
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  // A fresh workspace's series are its head office's; make sure there is one to name.
  await ensureHeadOffice();
  const [rows, stored, branches] = await Promise.all([
    db.documentNumberSetting.findMany(),
    db.documentSeries.findMany({ select: { docType: true, ownerKey: true, prefix: true, nextNumber: true, padding: true } }),
    activeSeriesBranches(),
  ]);
  const types = Object.keys(tradeDocumentLabels) as TradeDocumentType[];
  const byType = new Map(rows.map((r) => [r.docType, r]));
  const missing = types.filter((t) => !byType.has(t));
  const used = missing.length
    ? await db.tradeDocument.findMany({ where: { docType: { in: missing } }, select: { docType: true, docNumber: true } })
    : [];
  const storedByKey = new Map(stored.map((r) => [`${r.docType}:${r.ownerKey}`, r]));
  const headOfficeCtx = contextOf(branches.find((b) => b.isHeadOffice));
  const now = new Date();

  return types.map((docType) => {
    const row = byType.get(docType);
    const setting = row
      ? { mode: row.mode, scope: row.scope, prefix: row.prefix, nextNumber: row.nextNumber, padding: row.padding }
      : {
          ...defaultNumberSetting(docType),
          scope: "COMPANY" as DocumentSeriesScope,
          nextNumber: startingSerial(used.filter((d) => d.docType === docType).map((d) => d.docNumber)),
        };
    const scope = setting.scope;
    const series: SeriesView[] =
      scope === "COMPANY"
        ? []
        : ownersOf(scope, branches, docType).map((owner) => {
            const own = storedByKey.get(`${docType}:${owner.ref.ownerKey}`);
            const prefix = own?.prefix ?? derivedSeriesPrefix(setting.prefix, owner.ownerScope);
            const nextNumber = own?.nextNumber ?? 1;
            const padding = own?.padding ?? setting.padding;
            return {
              ownerKey: owner.ref.ownerKey,
              ownerKind: owner.ownerScope,
              ownerLabel: owner.ownerLabel,
              gstRegistrationId: owner.ref.gstRegistrationId,
              branchId: owner.ref.branchId,
              exists: Boolean(own),
              prefix,
              nextNumber,
              padding,
              ...describe(docType, prefix, nextNumber, padding, owner.ctx, now),
              isHeadOffice: owner.isHeadOffice,
            };
          });
    return { docType, ...setting, ...describe(docType, setting.prefix, setting.nextNumber, setting.padding, headOfficeCtx, now), series };
  });
}

/**
 * The format a document of this type raised at this branch takes its number from: the company series,
 * or under another scope that branch's series (or the default it will start with). Null or unknown
 * `branchId` is the head office.
 */
export async function getNumberSetting(docType: TradeDocumentType, branchId?: string | null): Promise<NumberSettingForForm> {
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  // Read-only: seriesFor creates nothing.
  return await db.$transaction(async (tx) => {
    const series = await seriesFor(tx, docType, branchId ?? null);
    const ref = series.ref.kind === "series" ? series.ref : null;
    const row = ref
      ? await tx.documentSeries.findUnique({ where: { docType_ownerKey: { docType, ownerKey: ref.ownerKey } }, select: { id: true } })
      : null;
    return {
      mode: series.mode,
      scope: series.scope,
      prefix: series.prefix,
      nextNumber: series.nextNumber,
      padding: series.padding,
      seriesId: row?.id ?? null,
      ownerKey: ref?.ownerKey ?? null,
      ownerLabel: series.ownerLabel,
      ctx: series.ctx,
      ownerKind: ref ? (ref.gstRegistrationId ? "REGISTRATION" : "BRANCH") : null,
    };
  });
}

/**
 * What the next auto-generated number would be at this branch, without taking it. Used to fill the
 * form's number field — the serial is only consumed when the document is actually created, so opening
 * a form and abandoning it doesn't burn a number.
 */
export async function previewNextNumber(docType: TradeDocumentType, branchId?: string | null): Promise<string> {
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  const series = await db.$transaction(async (tx) => await seriesFor(tx, docType, branchId ?? null));
  if (series.mode === "MANUAL") return "";
  return buildDocumentNumber(series.prefix, series.nextNumber, series.padding, new Date(), series.ctx);
}

/**
 * A type's mode and company format. Under a per-registration or per-branch scope the format is the
 * template new series start from, and the form's dialog changes only the mode: an input with no
 * `prefix`, `nextNumber` or `padding` writes just `mode`.
 */
export async function saveNumberSetting(input: unknown): Promise<ActionResult<{ docType: TradeDocumentType; warning?: string }>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
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
  const { docType, mode, nextNumber, padding } = parsed.data;
  const prefix = parsed.data.prefix ?? "";
  const label = tradeDocumentLabels[docType];

  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (raw.prefix === undefined && raw.nextNumber === undefined && raw.padding === undefined) {
    const current = await db.documentNumberSetting.findUnique({ where: { docType }, select: { docType: true } });
    if (current) {
      await db.documentNumberSetting.update({ where: { docType }, data: { mode } });
    } else {
      const existing = await db.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
      await db.documentNumberSetting.create({
        data: { docType, ...defaultNumberSetting(docType), nextNumber: startingSerial(existing.map((d) => d.docNumber)), mode },
      });
    }
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "DocumentNumberSetting",
      entityId: docType,
      entityLabel: `${label} numbering → ${mode === "AUTO" ? "automatic" : "manual"}`,
    });
    revalidatePath("/settings/numbering");
    return { ok: true, data: { docType } };
  }

  let warning: string | null = null;
  if (mode === "AUTO") {
    const [setting, branches] = await Promise.all([
      db.documentNumberSetting.findUnique({ where: { docType }, select: { scope: true } }),
      activeSeriesBranches(),
    ]);
    const scope = setting?.scope ?? "COMPANY";
    const now = new Date();
    if (scope === "COMPANY") {
      const ctx = contextOf(branches.find((b) => b.isHeadOffice));
      const candidate = buildDocumentNumber(prefix, nextNumber, padding, now, ctx);
      const problem = gstNumberProblem(docType, candidate);
      if (problem) return { ok: false, error: `The next number would be ${candidate}. ${problem}` };
      // Refuse to rewind onto numbers already in use — the collision would only surface at save time,
      // after someone has filled in a whole document.
      const clash = await db.tradeDocument.findUnique({ where: { docNumber: candidate }, select: { id: true } });
      if (clash) {
        return { ok: false, error: `${candidate} already exists — pick a higher next number.` };
      }
      warning = numberFormatWarning(docType, prefix, nextNumber, padding, ctx);
    } else {
      // The template only shapes the series not created yet: each starts at 1 with the derived prefix.
      const created = new Set((await db.documentSeries.findMany({ where: { docType }, select: { ownerKey: true } })).map((r) => r.ownerKey));
      for (const owner of ownersOf(scope, branches, docType)) {
        if (created.has(owner.ref.ownerKey)) continue;
        const derived = derivedSeriesPrefix(prefix, owner.ownerScope);
        const first = buildDocumentNumber(derived, 1, padding, now, owner.ctx);
        const problem = gstNumberProblem(docType, first);
        if (problem) return { ok: false, error: `${owner.ownerLabel} would start at ${first}. ${problem}` };
        warning ??= numberFormatWarning(docType, derived, 1, padding, owner.ctx);
      }
    }
  }

  const fields = { mode, prefix, nextNumber, padding };
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
    entityLabel: `${label} numbering → ${mode === "AUTO" ? `${prefix}${nextNumber}` : "manual"}`,
  });

  revalidatePath("/settings/numbering");
  return { ok: true, data: warning ? { docType, warning } : { docType } };
}

/**
 * One registration's or one branch's series of a type, created the first time it is saved. Refused when
 * its next number breaks GST's rules, is already used, or its prefix prints the same as another series
 * of the type — two series with one prefix would issue the same numbers.
 */
export async function saveDocumentSeries(input: unknown): Promise<ActionResult<{ id: string; warning?: string }>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) {
    return { ok: false, error: "Only an admin can change document numbering." };
  }
  const parsed = documentSeriesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { docType, nextNumber, padding } = parsed.data;
  const prefix = parsed.data.prefix ?? "";
  const gstRegistrationId = parsed.data.gstRegistrationId || null;
  const branchId = parsed.data.branchId || null;
  const ownerKey = (gstRegistrationId ?? branchId)!;

  const [setting, branches, registration, branch, others] = await Promise.all([
    db.documentNumberSetting.findUnique({ where: { docType }, select: { mode: true, scope: true, prefix: true, nextNumber: true } }),
    activeSeriesBranches(),
    gstRegistrationId
      ? db.gstRegistration.findUnique({ where: { id: gstRegistrationId }, select: { id: true, code: true, gstin: true } })
      : Promise.resolve(null),
    branchId
      ? db.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true, code: true, isHeadOffice: true, gstRegistration: { select: { id: true, code: true, gstin: true } } },
        })
      : Promise.resolve(null),
    db.documentSeries.findMany({
      where: { docType, NOT: { ownerKey } },
      select: { ownerKey: true, prefix: true, nextNumber: true, gstRegistrationId: true, ...SERIES_OWNER_INCLUDE },
    }),
  ]);
  if (gstRegistrationId && !registration) return { ok: false, error: "That GST registration no longer exists." };
  if (branchId && !branch) return { ok: false, error: "That branch no longer exists." };

  const headOffice = branches.find((b) => b.isHeadOffice);
  const ctx = registration
    ? storedSeriesContext({ gstRegistrationId: registration.id, gstRegistration: registration, branch: null }, branches)
    : contextOf(branch);
  const ownerLabel = registration ? `${registration.code} — GSTIN ${registration.gstin}` : branchLabel(branch!);
  const now = new Date();
  const candidate = buildDocumentNumber(prefix, nextNumber, padding, now, ctx);

  if ((setting?.mode ?? "AUTO") === "AUTO") {
    const problem = gstNumberProblem(docType, candidate);
    if (problem) return { ok: false, error: `The next number would be ${candidate}. ${problem}` };
    const clash = await db.tradeDocument.findUnique({ where: { docNumber: candidate }, select: { id: true } });
    if (clash) return { ok: false, error: `${candidate} already exists — pick a higher next number.` };
  }

  // Two series may print the same prefix only when one carries on where the other stopped: a series in
  // use never, one left from an earlier scope while this is past every number it issued, and the company
  // series only for the head office, whose series continues it (switching back takes its counter).
  const expanded = expandPrefix(prefix, now, ctx);
  const scope = setting?.scope ?? "COMPANY";
  const inUse = new Set<string>(scope === "COMPANY" ? [] : ownersOf(scope, branches, docType).map((o) => o.ref.ownerKey));
  for (const other of others) {
    const same = expandPrefix(other.prefix, now, storedSeriesContext(other, branches)) === expanded;
    if (same && (inUse.has(other.ownerKey) || nextNumber < other.nextNumber)) {
      return {
        ok: false,
        error: `That prefix prints the same as the series for ${storedSeriesLabel(other)} (${expanded}…) — two series can't share numbers. Add {GST} or {BR}, or change it.`,
      };
    }
  }
  const isHeadOfficeOwner = ownerKey === headOffice?.id || ownerKey === headOffice?.gstRegistration?.id;
  const companyPrefix = setting?.prefix ?? defaultNumberSetting(docType).prefix;
  if (expandPrefix(companyPrefix, now, contextOf(headOffice)) === expanded) {
    const continues = isHeadOfficeOwner && (scope === "COMPANY" || nextNumber >= (setting?.nextNumber ?? 1));
    if (!continues) {
      return { ok: false, error: `That prefix prints the same as the company series (${expanded}…) — two series can't share numbers. Add {GST} or {BR}, or change it.` };
    }
  }

  const saved = await db.documentSeries.upsert({
    where: { docType_ownerKey: { docType, ownerKey } },
    create: { docType, ownerKey, gstRegistrationId, branchId, prefix, nextNumber, padding },
    update: { prefix, nextNumber, padding },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentSeries",
    entityId: saved.id,
    entityLabel: `${tradeDocumentLabels[docType]} numbering for ${ownerLabel} → ${prefix}${nextNumber}`,
  });
  revalidatePath("/settings/numbering");

  const warning = numberFormatWarning(docType, prefix, nextNumber, padding, ctx);
  return { ok: true, data: warning ? { id: saved.id, warning } : { id: saved.id } };
}

/**
 * Whose series a type counts in (spec §6.6), in one transaction that updates the setting row first — its
 * row lock queues this type's company-series allocations behind the switch.
 *
 *   · Away from COMPANY: the head office's owner continues the company counter (its series is created
 *     with the company's prefix, next number and padding, or, left from an earlier switch, takes the
 *     higher next number); every other active owner gets its derived series at 1 if it has none.
 *   · Between REGISTRATION and BRANCH: the head office's new series continues its old one the same way.
 *   · Back to COMPANY: the company counter takes the higher of itself and the head office's series, so
 *     the head office never reuses a number. Other series stay, as history.
 *
 * Refused when two series would print the same prefix, or (in AUTO mode) a next number breaks GST's rules.
 */
export async function setNumberingScope(docType: TradeDocumentType, scope: DocumentSeriesScope): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) {
    return { ok: false, error: "Only an admin can change document numbering." };
  }
  const parsed = numberingScopeSchema.safeParse({ docType, scope });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const target = parsed.data.scope;

  // Resolved before the transaction: ensureHeadOffice may write, and must never run inside one.
  await ensureHeadOffice();
  const branches = await activeSeriesBranches();
  const headOffice = branches.find((b) => b.isHeadOffice);
  if (!headOffice) return { ok: false, error: "There is no head office yet — open Settings → Branches & GST registrations first." };
  const headOfficeCtx = contextOf(headOffice);

  let changed: boolean;
  try {
    changed = await db.$transaction(async (tx) => {
      const before = await tx.documentNumberSetting.findUnique({ where: { docType }, select: { scope: true } });
      const from = before?.scope ?? "COMPANY";
      if (from === target) return false;
      if (!before) {
        const existing = await tx.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
        await tx.documentNumberSetting.upsert({
          where: { docType },
          create: { docType, ...defaultNumberSetting(docType), nextNumber: startingSerial(existing.map((d) => d.docNumber)) },
          update: {},
        });
      }
      const setting = await tx.documentNumberSetting.update({
        where: { docType },
        data: { scope: target },
        select: { mode: true, prefix: true, nextNumber: true, padding: true },
      });
      const auto = setting.mode === "AUTO";
      const now = new Date();
      const fromHeadOfficeKey = from === "COMPANY" ? null : seriesOwner(from, headOffice, docType).ref.ownerKey;
      const rows = await tx.documentSeries.findMany({ where: { docType }, include: SERIES_OWNER_INCLUDE });
      const rowByKey = new Map(rows.map((r) => [r.ownerKey, r]));

      if (target === "COMPANY") {
        const headOfficeSeries = fromHeadOfficeKey ? rowByKey.get(fromHeadOfficeKey) : undefined;
        const nextNumber = Math.max(setting.nextNumber, headOfficeSeries?.nextNumber ?? 0);
        if (auto) {
          const next = buildDocumentNumber(setting.prefix, nextNumber, setting.padding, now, headOfficeCtx);
          const problem = gstNumberProblem(docType, next);
          if (problem) throw new Refusal(`The company series would continue at ${next}. ${problem}`);
        }
        if (nextNumber !== setting.nextNumber) await tx.documentNumberSetting.update({ where: { docType }, data: { nextNumber } });
        return true;
      }

      // What the head office was counting in until now: the company series, or its previous series.
      const previous = fromHeadOfficeKey ? rowByKey.get(fromHeadOfficeKey) : undefined;
      const carried = previous ?? { prefix: setting.prefix, nextNumber: setting.nextNumber, padding: setting.padding };
      const planned = ownersOf(target, branches, docType).map((owner) => {
        const row = rowByKey.get(owner.ref.ownerKey);
        if (owner.isHeadOffice) {
          return {
            owner,
            row,
            prefix: row?.prefix ?? carried.prefix,
            nextNumber: Math.max(row?.nextNumber ?? 0, carried.nextNumber),
            padding: row?.padding ?? carried.padding,
          };
        }
        return {
          owner,
          row,
          prefix: row?.prefix ?? derivedSeriesPrefix(setting.prefix, owner.ownerScope),
          nextNumber: row?.nextNumber ?? 1,
          padding: row?.padding ?? setting.padding,
        };
      });

      // No two series in use may print the same prefix. Nor may one print the prefix of a series that
      // stops here (the company's, or one left from an earlier scope) unless it carries on past the
      // numbers that one issued — as the head office's carries on the company counter.
      const live = planned.map((p) => ({
        label: p.owner.ownerLabel,
        expanded: expandPrefix(p.prefix, now, p.owner.ctx),
        nextNumber: p.nextNumber,
        isHeadOffice: p.owner.isHeadOffice,
      }));
      const plannedKeys = new Set(planned.map((p) => p.owner.ref.ownerKey));
      const stopped = [
        { label: "the company series", expanded: expandPrefix(setting.prefix, now, headOfficeCtx), nextNumber: setting.nextNumber, company: true },
        ...rows
          .filter((r) => !plannedKeys.has(r.ownerKey))
          .map((r) => ({
            label: `the earlier series for ${storedSeriesLabel(r)}`,
            expanded: expandPrefix(r.prefix, now, storedSeriesContext(r, branches)),
            nextNumber: r.nextNumber,
            company: false,
          })),
      ];
      for (let i = 0; i < live.length; i++) {
        const a = live[i];
        for (const b of live.slice(i + 1)) {
          if (a.expanded === b.expanded) {
            throw new Refusal(`${capitalised(a.label)} and ${b.label} would both number as ${a.expanded}… — give one of them a different prefix first.`);
          }
        }
        for (const old of stopped) {
          // Only the head office continues the company series: switching back takes its counter, nobody else's.
          const continues = a.nextNumber >= old.nextNumber && (a.isHeadOffice || !old.company);
          if (a.expanded === old.expanded && !continues) {
            throw new Refusal(`${capitalised(a.label)} would number as ${old.expanded}… again, as ${old.label} did — give it a different prefix first.`);
          }
        }
      }
      if (auto) {
        for (const p of planned) {
          const next = buildDocumentNumber(p.prefix, p.nextNumber, p.padding, now, p.owner.ctx);
          const problem = gstNumberProblem(docType, next);
          if (problem) throw new Refusal(`${p.owner.ownerLabel}'s next number would be ${next}. ${problem}`);
        }
      }

      for (const p of planned) {
        if (!p.row) {
          await tx.documentSeries.create({
            data: {
              docType,
              ownerKey: p.owner.ref.ownerKey,
              gstRegistrationId: p.owner.ref.gstRegistrationId,
              branchId: p.owner.ref.branchId,
              prefix: p.prefix,
              nextNumber: p.nextNumber,
              padding: p.padding,
            },
            select: { id: true },
          });
        } else if (p.nextNumber !== p.row.nextNumber) {
          await tx.documentSeries.update({ where: { id: p.row.id }, data: { nextNumber: p.nextNumber }, select: { id: true } });
        }
      }
      return true;
    });
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    // A number allocated at a new owner in the same moment created its series first.
    if ((err as { code?: unknown })?.code === "P2002") return { ok: false, error: "Numbering changed while switching — try again." };
    throw err;
  }
  if (!changed) return { ok: true, data: null };

  const scopeLabel = numberScopeLabels[target];
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "DocumentNumberSetting",
    entityId: docType,
    entityLabel: `${tradeDocumentLabels[docType]} numbering → ${scopeLabel.charAt(0).toLowerCase()}${scopeLabel.slice(1)}`,
  });
  revalidatePath("/settings/numbering");
  return { ok: true, data: null };
}
