import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Vendor codes, given as a vendor is created (owner, 8 Oct 2026): the workspace's prefix, set in
 * Settings › Vendor codes, then the next number — VEN-0001, VEN-0002. A code typed by hand still wins,
 * and is kept; numbering carries on from the highest number already under the prefix, so a code
 * entered as VEN-0040 makes the next one VEN-0041 rather than a duplicate.
 */

export const DEFAULT_VENDOR_CODE_PREFIX = "VEN-";
/** Zero-padded to this many digits; more once there are more vendors than that. */
export const VENDOR_CODE_DIGITS = 4;

/** Letters, digits and a separator or two, up to 12 — what fits in a code column and on a cheque. */
export const VENDOR_CODE_PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9/_-]{0,11}$/;

type Client = Prisma.TransactionClient | PrismaClient;

/** The workspace's prefix — the default until it is set, or while its column is not there yet. */
export async function vendorCodePrefix(client: Client): Promise<string> {
  try {
    // Named, not select-less: the column is in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts).
    const row = await client.organisationSettings.findUnique({ where: { id: "global" }, select: { vendorCodePrefix: true } });
    return row?.vendorCodePrefix || DEFAULT_VENDOR_CODE_PREFIX;
  } catch {
    return DEFAULT_VENDOR_CODE_PREFIX;
  }
}

/** The number after `prefix` in `code`, when the rest of it is a number. */
export function vendorCodeNumber(code: string, prefix: string): number | null {
  if (code.length <= prefix.length || code.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase()) return null;
  const rest = code.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

export function formatVendorCode(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(VENDOR_CODE_DIGITS, "0")}`;
}

/**
 * The next `count` codes, in order. Inside the caller's transaction, under a lock held until it
 * commits: two vendors created at once would otherwise both read the same highest number.
 */
export async function nextVendorCodes(tx: Prisma.TransactionClient, count = 1): Promise<string[]> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:vendor-code'))`;
  const prefix = await vendorCodePrefix(tx);
  const taken = await tx.company.findMany({
    where: { vendorCode: { startsWith: prefix, mode: "insensitive" } },
    select: { vendorCode: true },
  });
  let highest = 0;
  for (const { vendorCode } of taken) {
    const n = vendorCode ? vendorCodeNumber(vendorCode, prefix) : null;
    if (n !== null && n > highest) highest = n;
  }
  return Array.from({ length: count }, (_, i) => formatVendorCode(prefix, highest + 1 + i));
}

/**
 * Gives each of these companies that has no code yet the next one, oldest first — a vendor just
 * created, an imported one, or every vendor from before codes were automatic (Settings › Vendor codes).
 * One transaction under the lock, so codes are never handed out twice. Returns the codes given.
 */
export async function assignVendorCodes(companyIds: string[]): Promise<{ id: string; vendorCode: string }[]> {
  if (companyIds.length === 0) return [];
  return db.$transaction(
    async (tx) => {
      const waiting = await tx.company.findMany({
        where: { id: { in: companyIds }, vendorCode: null },
        orderBy: { companySeq: "asc" },
        select: { id: true },
      });
      if (waiting.length === 0) return [];
      const codes = await nextVendorCodes(tx, waiting.length);
      const given = waiting.map((c, i) => ({ id: c.id, vendorCode: codes[i]! }));
      for (const g of given) await tx.company.update({ where: { id: g.id }, data: { vendorCode: g.vendorCode } });
      return given;
    },
    // A workspace numbering a few thousand vendors at once, the first time.
    { timeout: 60_000 },
  );
}

/** Another company already holding this code, compared without case — codes are read aloud and typed. */
export async function vendorCodeHolder(client: Client, code: string, exceptCompanyId?: string) {
  return client.company.findFirst({
    where: { vendorCode: { equals: code, mode: "insensitive" }, ...(exceptCompanyId ? { id: { not: exceptCompanyId } } : {}) },
    select: { id: true, name: true },
  });
}
