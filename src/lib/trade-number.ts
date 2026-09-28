/**
 * Allocating a document number.
 *
 * Deliberately not a `"use server"` module: it takes the caller's transaction — the one that creates
 * the document — so a number is allocated with whatever is being created rather than in a separate
 * one that could commit while the document fails and burn the number. Exporting it as an action
 * would also publish "burn a document number" as an endpoint anybody could call.
 *
 * Lives here rather than beside `createTradeDocument` because a delivery challan needs the same
 * series, and two implementations of a statutory numbering sequence is one too many.
 *
 * ## Which series
 *
 * A type's `DocumentNumberSetting.scope` decides whose series a number comes from (spec §6.2):
 * `COMPANY` — the setting row itself, exactly as before branches; `REGISTRATION` — one
 * `DocumentSeries` per GSTIN (a branch without one counts in its own branch series); `BRANCH` — one
 * per branch. The branch is the document's, or the head office when none is given. It is read through
 * the caller's `tx`, never through `src/lib/branches/identity.ts`, whose helpers use another
 * connection and may write — inside a transaction that can deadlock where Postgres cannot see it.
 */
import type { DocumentNumberMode, DocumentSeriesScope, Prisma, TradeDocumentType } from "@prisma/client";
import {
  buildDocumentNumber,
  defaultNumberSetting,
  derivedSeriesPrefix,
  expandPrefix,
  startingSerial,
  type PrefixContext,
} from "@/lib/document-numbering";
import { financialYearOf } from "@/lib/gst-engine";
import { branchLabel } from "@/lib/branches/format";

type Tx = Prisma.TransactionClient;

/** Where a number is counted: the company's setting row, or one owner's `DocumentSeries` row. */
export type SeriesRef =
  | { kind: "setting"; docType: TradeDocumentType }
  | { kind: "series"; docType: TradeDocumentType; ownerKey: string; gstRegistrationId: string | null; branchId: string | null };

/** The branch fields routing needs. */
export type SeriesBranch = {
  id: string;
  name: string;
  code: string;
  isHeadOffice: boolean;
  gstRegistration: { id: string; code: string; gstin: string } | null;
};

const BRANCH_SELECT = {
  id: true,
  name: true,
  code: true,
  isHeadOffice: true,
  gstRegistration: { select: { id: true, code: true, gstin: true } },
} as const;

/** The branch a number is for: the one named, else (none, or unknown) the head office; null when there is none yet. */
async function branchFor(tx: Tx, branchId: string | null | undefined): Promise<SeriesBranch | null> {
  if (branchId) {
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: BRANCH_SELECT });
    if (branch) return branch;
  }
  return tx.branch.findFirst({ where: { isHeadOffice: true }, select: BRANCH_SELECT });
}

/** What `{GST}` and `{BR}` print for numbers allocated at this branch. */
function contextOf(branch: SeriesBranch | null): PrefixContext {
  return { branchCode: branch?.code ?? null, registrationCode: branch?.gstRegistration?.code ?? null };
}

/**
 * The series a branch's numbers count in under a non-company scope — pure, so the numbering
 * settings screen names owners and keys exactly as allocation does.
 *
 * `ownerScope` is the kind of owner it turned out to be: under `REGISTRATION` a branch with no
 * registration counts in its own branch series, and its new series is derived as a branch's (`{BR}/…`)
 * — `{GST}` would print nothing for it.
 */
export function seriesOwner(
  scope: "REGISTRATION" | "BRANCH",
  branch: SeriesBranch,
  docType: TradeDocumentType,
): { ref: Extract<SeriesRef, { kind: "series" }>; ownerScope: "REGISTRATION" | "BRANCH"; ownerLabel: string } {
  const registration = scope === "REGISTRATION" ? branch.gstRegistration : null;
  if (registration) {
    return {
      ref: { kind: "series", docType, ownerKey: registration.id, gstRegistrationId: registration.id, branchId: null },
      ownerScope: "REGISTRATION",
      ownerLabel: `${registration.code} — GSTIN ${registration.gstin}`,
    };
  }
  return {
    ref: { kind: "series", docType, ownerKey: branch.id, gstRegistrationId: null, branchId: branch.id },
    ownerScope: "BRANCH",
    ownerLabel: branchLabel(branch),
  };
}

type Resolved = {
  setting: { mode: DocumentNumberMode; scope: DocumentSeriesScope; prefix: string; nextNumber: number; padding: number } | null;
  branch: SeriesBranch | null;
  /** Null: the company series — COMPANY scope, or no head office yet to route to. */
  owner: ReturnType<typeof seriesOwner> | null;
};

async function resolve(tx: Tx, docType: TradeDocumentType, branchId: string | null | undefined): Promise<Resolved> {
  const setting = await tx.documentNumberSetting.findUnique({
    where: { docType },
    select: { mode: true, scope: true, prefix: true, nextNumber: true, padding: true },
  });
  const branch = await branchFor(tx, branchId);
  const scope = setting?.scope ?? "COMPANY";
  // No branch at all (a workspace with no head office yet): the company series — never a refusal here.
  const owner = scope !== "COMPANY" && branch ? seriesOwner(scope, branch, docType) : null;
  return { setting, branch, owner };
}

/**
 * The series a document of this type raised at this branch would take its number from, and that
 * series' next number — without taking it or creating anything. For previews, and for telling
 * whether a draft moved to another branch changes series.
 *
 * `scope` is the type's configured scope; `ref` is where this branch's numbers actually come from
 * (the company series when there is no head office yet to route to).
 */
export async function seriesFor(
  tx: Tx,
  docType: TradeDocumentType,
  branchId: string | null,
): Promise<{
  ref: SeriesRef;
  mode: "AUTO" | "MANUAL";
  scope: DocumentSeriesScope;
  prefix: string;
  nextNumber: number;
  padding: number;
  ctx: PrefixContext;
  ownerLabel: string | null;
}> {
  const { setting, branch, owner } = await resolve(tx, docType, branchId);
  const ctx = contextOf(branch);
  const template = setting ?? (await defaultSettingFor(tx, docType));
  const mode = template.mode;
  const scope = setting?.scope ?? "COMPANY";

  if (!owner) {
    const { prefix, nextNumber, padding } = template;
    return { ref: { kind: "setting", docType }, mode, scope, prefix, nextNumber, padding, ctx, ownerLabel: null };
  }
  const row = await tx.documentSeries.findUnique({
    where: { docType_ownerKey: { docType, ownerKey: owner.ref.ownerKey } },
    select: { prefix: true, nextNumber: true, padding: true },
  });
  return {
    ref: owner.ref,
    mode,
    scope,
    prefix: row?.prefix ?? derivedSeriesPrefix(template.prefix, owner.ownerScope),
    nextNumber: row?.nextNumber ?? 1,
    padding: row?.padding ?? template.padding,
    ctx,
    ownerLabel: owner.ownerLabel,
  };
}

/** The setting a type would be given at its first use — the default format, its serial past anything in use. */
async function defaultSettingFor(tx: Tx, docType: TradeDocumentType) {
  const existing = await tx.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
  return { ...defaultNumberSetting(docType), nextNumber: startingSerial(existing.map((d) => d.docNumber)) };
}

/**
 * Takes the next number of the series this branch's documents of this type count in. `branchId`
 * null or left out is the head office. Never refuses: a number that breaks GST's 16-character rule
 * is the e-invoice validation's to say, not a reason to stop invoicing.
 */
export async function nextDocumentNumber(
  tx: Tx,
  docType: TradeDocumentType,
  issueDate: Date,
  branchId?: string | null,
): Promise<string> {
  const existingRow = await tx.documentNumberSetting.findUnique({ where: { docType } });
  if (!existingRow) {
    // First use on a system that may already have documents — start past whatever is in use.
    const existing = await tx.tradeDocument.findMany({ where: { docType }, select: { docNumber: true } });
    await tx.documentNumberSetting.create({
      data: {
        docType,
        ...defaultNumberSetting(docType),
        nextNumber: startingSerial(existing.map((d) => d.docNumber)),
      },
    });
  }
  const { setting: template, branch, owner } = await resolve(tx, docType, branchId);

  let prefix: string;
  let serial: number;
  let padding: number;
  if (!owner || !template) {
    const setting = await tx.documentNumberSetting.update({
      where: { docType },
      data: { nextNumber: { increment: 1 } },
      select: { prefix: true, nextNumber: true, padding: true },
    });
    /**
     * The number being issued is the one the row held *before* the increment.
     *
     * `update` returns the row after it, and reading that skipped the very number the settings screen
     * advertises as next: set the series to 1000 and the first invoice came out as 1001. Incrementing
     * unconditionally and stepping back one issues the advertised number in both cases — a row just
     * created at S goes to S+1 and issues S; an existing row at N goes to N+1 and issues N.
     */
    serial = setting.nextNumber - 1;
    prefix = setting.prefix;
    padding = setting.padding;
  } else {
    const { ref } = owner;
    const where = { docType_ownerKey: { docType, ownerKey: ref.ownerKey } };
    // An owner's first number creates its series from the type's template, starting at 1.
    await tx.documentSeries.upsert({
      where,
      update: {},
      create: {
        docType,
        ownerKey: ref.ownerKey,
        gstRegistrationId: ref.gstRegistrationId,
        branchId: ref.branchId,
        prefix: derivedSeriesPrefix(template.prefix, owner.ownerScope),
        nextNumber: 1,
        padding: template.padding,
      },
      select: { id: true },
    });
    // The same idiom as the company series, and the same row lock serialising two people creating at once.
    const series = await tx.documentSeries.update({
      where,
      data: { nextNumber: { increment: 1 } },
      select: { prefix: true, nextNumber: true, padding: true },
    });
    serial = series.nextNumber - 1;
    prefix = series.prefix;
    padding = series.padding;
  }

  // The company's per-year tally, unchanged whatever the scope (spec §6.7): read by nothing, and its
  // unique (docType, financialYear) is what the previous build upserts on.
  const financialYear = financialYearOf(issueDate);
  await tx.documentCounter.upsert({
    where: { docType_financialYear: { docType, financialYear } },
    create: { docType, financialYear, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return buildDocumentNumber(prefix, serial, padding, issueDate, contextOf(branch));
}

/** The serial of `docNumber` when it is `expandedPrefix` followed by digits only, else null. */
function serialAfter(expandedPrefix: string, docNumber: string): number | null {
  if (!docNumber.startsWith(expandedPrefix)) return null;
  const rest = docNumber.slice(expandedPrefix.length);
  if (!/^\d+$/.test(rest)) return null;
  const value = Number(rest);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Bumps the serial past a number typed in by hand, so auto-generation doesn't collide with it.
 *
 * Company scope keeps its old rule — any trailing digits at or past the next number advance it — so
 * nothing changes for a company that never switches scope. A per-registration or per-branch series
 * advances only for a number that is its own shape (its prefix, expanded for `issueDate`, then digits):
 * "MH/INV/2627/0042" typed at a Karnataka branch says nothing about the Karnataka series. A series
 * that does not exist yet is created already past the typed number.
 *
 * `issueDate` expands `{FY}`/`{FY2}` in that comparison; it defaults to today.
 */
export async function advanceSerialPast(
  tx: Tx,
  docType: TradeDocumentType,
  docNumber: string,
  branchId?: string | null,
  issueDate: Date = new Date(),
): Promise<void> {
  const { setting, branch, owner } = await resolve(tx, docType, branchId);
  if (!setting) return;

  if (!owner) {
    const trailing = /(\d+)\s*$/.exec(docNumber);
    if (!trailing) return;
    const used = Number(trailing[1]);
    if (Number.isFinite(used) && used >= setting.nextNumber) {
      await tx.documentNumberSetting.update({ where: { docType }, data: { nextNumber: used + 1 } });
    }
    return;
  }

  const { ref } = owner;
  const where = { docType_ownerKey: { docType, ownerKey: ref.ownerKey } };
  const row = await tx.documentSeries.findUnique({ where, select: { prefix: true, nextNumber: true } });
  const prefix = row?.prefix ?? derivedSeriesPrefix(setting.prefix, owner.ownerScope);
  const used = serialAfter(expandPrefix(prefix, issueDate, contextOf(branch)), docNumber);
  if (used === null || used >= 2_147_483_647) return;
  if (!row) {
    await tx.documentSeries.create({
      data: { docType, ownerKey: ref.ownerKey, gstRegistrationId: ref.gstRegistrationId, branchId: ref.branchId, prefix, nextNumber: used + 1, padding: setting.padding },
    });
  } else if (used >= row.nextNumber) {
    await tx.documentSeries.update({ where, data: { nextNumber: used + 1 } });
  }
}

/**
 * Whether `docNumber` looks like one this branch's series generated for `issueDate`: its prefix,
 * expanded, followed by digits only. A draft moved to a branch with a different series is renumbered
 * only when this is true — a number somebody typed is theirs to keep.
 */
export async function isAutoNumberOf(
  tx: Tx,
  docType: TradeDocumentType,
  branchId: string | null,
  docNumber: string,
  issueDate: Date,
): Promise<boolean> {
  const series = await seriesFor(tx, docType, branchId);
  return serialAfter(expandPrefix(series.prefix, issueDate, series.ctx), docNumber) !== null;
}
