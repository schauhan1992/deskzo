import { refDb, referenceConfigured } from "@/lib/platform/reference-db";
import { hsnShapeIssue, type HsnKind, type HsnOption } from "@/lib/hsn";
import { HSN_PATTERN, normaliseHsn } from "@/lib/items/catalogue-import";

/**
 * The GST portal's HSN/SAC directory, in the shared reference database (`hsn_codes`).
 *
 * ## The source
 *
 * The portal publishes the whole directory as one Excel file — Services › User Services › Search HSN
 * Code › "Download HSN Directory in Excel Format", served from
 * https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx. Two sheets: HSN_MSTR (goods, ~22,000 codes at
 * 2, 4, 6 and 8 digits) and SAC_MSTR (services, ~680 codes, all 99…). Codes and descriptions only —
 * no rates, so an item's GST rate stays what the workspace enters.
 *
 * The committed copy is prisma/reference/hsn-sac.xlsx, loaded on seed (`ensureHsnDirectory`); a
 * platform manager can load a newer one from the console's Reference data page. The loader — the only
 * code that writes `hsn_codes` — is prisma/reference/hsn.ts, where the reference-data rule lets it
 * replace the rows (src/lib/reference-data.ts); this file only reads them.
 *
 * ## What it answers
 *
 * Search for the item form (by code prefix or by words of the description), and whether a code is in
 * the directory at all — the check behind "that isn't a real HSN". A workspace whose reference
 * database has no directory yet — not configured, not migrated, not loaded — is never refused for it:
 * the shape and kind rules still hold (src/lib/hsn.ts), and the directory check simply isn't made.
 */

export const HSN_DIRECTORY_KEY = "gst-hsn-sac";
/** The portal's own file, as committed. */
export const HSN_DIRECTORY_FILE = "prisma/reference/hsn-sac.xlsx";

export type HsnDirectoryState = {
  loaded: { codes: number; goods: number; services: number; source: string; loadedAt: string; skipped: number } | null;
};

/** What is loaded, for the console's Reference data page. */
export async function readHsnDirectory(): Promise<HsnDirectoryState> {
  const [dataset, groups] = await Promise.all([
    refDb().referenceDataset.findUnique({ where: { key: HSN_DIRECTORY_KEY } }),
    refDb().hsnCode.groupBy({ by: ["kind"], _count: { _all: true } }),
  ]);
  const goods = groups.find((g) => g.kind === "GOODS")?._count._all ?? 0;
  const services = groups.find((g) => g.kind === "SERVICES")?._count._all ?? 0;
  return {
    loaded:
      dataset && goods + services > 0
        ? { codes: goods + services, goods, services, source: dataset.source, loadedAt: dataset.loadedAt.toISOString(), skipped: dataset.skipped }
        : null,
  };
}

// ─── Asking it ────────────────────────────────────────────────────────────────────────────────────

/**
 * The directory's rows for these codes, or `checked: false` when there is no directory to ask —
 * reference database not configured, not migrated, or nothing loaded. Never throws for those: an
 * installation without the directory still saves items, on the shape rules alone.
 */
export async function knownHsnCodes(codes: string[]): Promise<{ checked: boolean; found: Map<string, HsnOption> }> {
  const found = new Map<string, HsnOption>();
  if (!referenceConfigured()) return { checked: false, found };
  const wanted = [...new Set(codes.filter(Boolean))].slice(0, 5000);
  try {
    const rows = await refDb().hsnCode.findMany({ where: { code: { in: wanted } } });
    for (const r of rows) found.set(r.code, r);
    if (found.size > 0) return { checked: true, found };
    return { checked: (await refDb().hsnCode.findFirst({ select: { code: true } })) !== null, found };
  } catch (error) {
    // A reference database that is down or not yet migrated: say so in the log, and don't refuse.
    console.warn("[hsn] the HSN/SAC directory could not be read; codes are checked for shape only —", error instanceof Error ? error.message : error);
    return { checked: false, found };
  }
}

export const notInDirectory = (code: string) =>
  `${code} isn't in the GST portal's HSN/SAC directory — check the code, or search by description for the right one.`;

/**
 * Everything wrong with an item's code, or null: missing, the wrong shape, the wrong kind for the item,
 * or not a code the portal lists.
 */
export async function hsnIssue(value: unknown, itemType: string | null | undefined): Promise<string | null> {
  const shape = hsnShapeIssue(value, itemType);
  if (shape) return shape;
  const code = normaliseHsn(value);
  const known = await knownHsnCodes([code]);
  return !known.checked || known.found.has(code) ? null : notInDirectory(code);
}

/**
 * What is wrong with the codes on a document's lines, as the refusal a save returns — or null. A code
 * on a line must be 4, 6 or 8 digits and, where there is a directory, one the portal lists. A blank one
 * is the line's own business: the server fills it from the line's product (`checkLineLinks`), and the
 * GST summary flags a line that has none.
 */
export async function lineHsnRefusal(lines: { hsnCode?: string | null }[]): Promise<string | null> {
  const codes = lines.map((l) => normaliseHsn(l.hsnCode ?? ""));
  const malformed = codes.findIndex((c) => c !== "" && !HSN_PATTERN.test(c));
  if (malformed >= 0) return `Line ${malformed + 1}: HSN/SAC must be 4, 6 or 8 digits.`;
  const known = await knownHsnCodes(codes.filter(Boolean));
  if (!known.checked) return null;
  const unknown = codes.findIndex((c) => c !== "" && !known.found.has(c));
  return unknown < 0 ? null : `Line ${unknown + 1}: ${notInDirectory(codes[unknown]!)}`;
}

/**
 * The items whose code needs fixing, each with why: missing, malformed, the wrong kind for the item,
 * or — where there is a directory — not a code the portal lists. One directory query for them all.
 */
export async function hsnProblemsFor(items: { id: string; type: string; hsnCode: string | null }[]): Promise<Map<string, string>> {
  const problems = new Map<string, string>();
  const toLookUp: { id: string; code: string }[] = [];
  for (const item of items) {
    const shape = hsnShapeIssue(item.hsnCode ?? "", item.type);
    if (shape) problems.set(item.id, shape);
    else toLookUp.push({ id: item.id, code: normaliseHsn(item.hsnCode ?? "") });
  }
  const known = await knownHsnCodes(toLookUp.map((t) => t.code));
  if (known.checked) for (const t of toLookUp) if (!known.found.has(t.code)) problems.set(t.id, notInDirectory(t.code));
  return problems;
}

/** Codes a search may offer: the ones an item can carry. A 2-digit chapter classifies nothing on an invoice. */
const OFFERABLE = new Set([4, 6, 8]);
const SEARCH_LIMIT = 30;

/**
 * Codes for the item form's search: digits match the start of a code ("8471" → 8471, 847130,
 * 84713010…); words must each appear in the description or its heading ("data processing portable").
 * `kinds` narrows to goods or services when the item type decides it.
 */
export async function searchHsnDirectory(query: string, kinds?: HsnKind[]): Promise<HsnOption[]> {
  if (!referenceConfigured()) return [];
  const text = String(query ?? "").trim().slice(0, 80);
  if (text.length < 2) return [];
  const digits = text.replace(/[\s.]/g, "");
  const kind = kinds && kinds.length === 1 ? { kind: kinds[0]! } : {};
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (!/^\d+$/.test(digits) && words.length === 0) return [];
  const where = /^\d+$/.test(digits)
    ? { ...kind, code: { startsWith: digits } }
    : {
        ...kind,
        AND: words.map((w) => ({
          OR: [{ description: { contains: w, mode: "insensitive" as const } }, { heading: { contains: w, mode: "insensitive" as const } }],
        })),
      };
  const rows = (await refDb().hsnCode.findMany({ where, orderBy: { code: "asc" }, take: 400 })).filter((r) => OFFERABLE.has(r.code.length));
  if (/^\d+$/.test(digits)) return rows.slice(0, SEARCH_LIMIT);
  // Codes whose own description says every word come before those found only through their heading.
  const own = (r: HsnOption) => words.every((w) => r.description.toLowerCase().includes(w));
  return [...rows.filter(own), ...rows.filter((r) => !own(r))].slice(0, SEARCH_LIMIT);
}
