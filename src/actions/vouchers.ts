"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type VoucherStatus, type VoucherType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { ensureChartOfAccounts, writeEntry } from "@/lib/ledger/journal";
import { accountsSettings } from "@/lib/accounts/settings";
import { nextAccountsNumber } from "@/lib/accounts/numbering";
import { MAX_VOUCHER_LINES, mayMove, voucherAmount, voucherProblem, voucherTypeLabels, type AccountFacts, type VoucherLineInput } from "@/lib/accounts/vouchers";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Payment, receipt, contra and journal vouchers (owner, 22 Oct 2026) — src/lib/accounts/vouchers.ts has the rules.
 *
 *   · Writing one is `vouchers.create`: a draft, numbered as it's saved (PMT/2026-27/0001).
 *   · Where Accounts settings ask for a second person, it is sent for approval and approved by someone holding
 *     `vouchers.approve` who didn't write it. Approving doesn't post.
 *   · Posting is `ledger.post`, as a hand-written journal is: one journal entry, under the voucher's own
 *     posting key, so it can't be posted twice; into an open period only.
 *   · A posted voucher is never edited. It is reversed — a dated, opposite entry — and stays on record.
 *
 * Everything here is the Accounting module's, and every step is in the audit log.
 */

const VOUCHER_TYPES = ["PAYMENT", "RECEIPT", "CONTRA", "JOURNAL"] as const;
const VOUCHER_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "POSTED", "CANCELLED", "REVERSED"] as const;
/** A filter's `yyyy-mm-dd`, or nothing — a mistyped address narrows nothing rather than failing the page. */
const dayOrNull = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : null);

async function gate() {
  const user = await requireModuleUser("accounting");
  const [create, approve, post, read] = await Promise.all([
    hasEffectivePermission(user.id, "vouchers.create"),
    hasEffectivePermission(user.id, "vouchers.approve"),
    hasEffectivePermission(user.id, "ledger.post"),
    hasEffectivePermission(user.id, "ledger.viewReports"),
  ]);
  return { user, create, approve, post, read: read || create || approve || post };
}

/** What the voucher screens may show and do for this person. */
export async function voucherCapabilities() {
  const g = await gate();
  const settings = await accountsSettings();
  return { create: g.create, approve: g.approve, post: g.post, read: g.read, approvalRequired: settings.voucherApprovalRequired, migrated: settings.migrated };
}

/** Every postable account with what the rules need to know of it, for the form and the checks. */
async function accountFacts(): Promise<Map<string, AccountFacts>> {
  await ensureChartOfAccounts();
  const rows = await db.ledgerAccount.findMany({
    select: { id: true, code: true, name: true, isGroup: true, active: true, systemKey: true, bankAccount: { select: { id: true } } },
    orderBy: { code: "asc" },
  });
  const money = new Set<string>([SYSTEM_ACCOUNTS.BANK, SYSTEM_ACCOUNTS.CASH]);
  const party = new Set<string>([SYSTEM_ACCOUNTS.AR, SYSTEM_ACCOUNTS.AP]);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        code: r.code,
        name: r.name,
        isGroup: r.isGroup,
        active: r.active,
        isMoney: (r.systemKey !== null && money.has(r.systemKey)) || r.bankAccount !== null,
        needsParty: r.systemKey !== null && party.has(r.systemKey),
      },
    ]),
  );
}

/** The form's lists: accounts (bank and cash marked), cost centres and branches. Parties are searched. */
export async function voucherFormOptions() {
  const g = await gate();
  if (!g.create) return null;
  const [accounts, departments, branches] = await Promise.all([
    accountFacts(),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.branch.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return toPlain({ accounts: [...accounts.values()].filter((a) => !a.isGroup && a.active), departments, branches });
}

/** Companies whose name starts like `term`, for a voucher's party. */
export async function searchVoucherParties(term: string) {
  const g = await gate();
  if (!g.create) return [];
  const q = term.trim();
  if (q.length < 2) return [];
  return db.company.findMany({
    where: { name: { contains: q, mode: "insensitive" } },
    orderBy: { name: "asc" },
    take: 15,
    select: { id: true, name: true },
  });
}

export type VoucherFilters = { type?: string; status?: string; from?: string; to?: string; search?: string; page?: number; pageSize?: number };

export async function listVouchers(filters: VoucherFilters = {}) {
  const g = await gate();
  if (!g.read) return null;
  const pageSize = Math.min(100, Math.max(10, Number(filters.pageSize) || 25));
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const from = dayOrNull(filters.from);
  const to = dayOrNull(filters.to);
  const where: Prisma.AccountVoucherWhereInput = {
    ...((VOUCHER_TYPES as readonly string[]).includes(filters.type ?? "") ? { type: filters.type as VoucherType } : {}),
    ...((VOUCHER_STATUSES as readonly string[]).includes(filters.status ?? "") ? { status: filters.status as VoucherStatus } : {}),
    ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(filters.search?.trim()
      ? {
          OR: [
            { number: { contains: filters.search.trim(), mode: "insensitive" } },
            { narration: { contains: filters.search.trim(), mode: "insensitive" } },
            { reference: { contains: filters.search.trim(), mode: "insensitive" } },
          ],
        }
      : {}),
  };
  try {
    const [rows, total, pending] = await Promise.all([
      db.accountVoucher.findMany({
        where,
        orderBy: [{ date: "desc" }, { number: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, type: true, number: true, date: true, status: true, narration: true, reference: true, amount: true,
          company: { select: { id: true, name: true } },
          moneyAccount: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
      }),
      db.accountVoucher.count({ where }),
      db.accountVoucher.count({ where: { status: "PENDING_APPROVAL" } }),
    ]);
    return toPlain({ rows, total, page, pageSize, pending });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function getVoucher(id: string) {
  const g = await gate();
  if (!g.read) return null;
  const voucher = await db.accountVoucher.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { sortOrder: "asc" }, include: { account: { select: { id: true, code: true, name: true } } } },
      company: { select: { id: true, name: true, companySeq: true } },
      moneyAccount: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      journalEntries: { orderBy: { createdAt: "asc" }, select: { id: true, entryNumber: true, date: true, reversesId: true } },
    },
  });
  if (!voucher) return null;
  const people = await db.user.findMany({
    where: { id: { in: [voucher.submittedById, voucher.approvedById, voucher.postedById, voucher.cancelledById, voucher.reversedById].filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  // A line's party, cost centre and branch are plain ids on the line; their names, for reading and editing.
  const lines = voucher.lines;
  const ids = (pick: (l: (typeof lines)[number]) => string | null) => [...new Set(lines.map(pick).filter((x): x is string => !!x))];
  const [parties, departments, branches] = await Promise.all([
    db.company.findMany({ where: { id: { in: ids((l) => l.companyId) } }, select: { id: true, name: true } }),
    db.department.findMany({ where: { id: { in: ids((l) => l.departmentId) } }, select: { id: true, name: true } }),
    db.branch.findMany({ where: { id: { in: ids((l) => l.branchId) } }, select: { id: true, name: true } }),
  ]);
  const named = (list: { id: string; name: string }[], id: string | null) => (id ? (list.find((x) => x.id === id) ?? null) : null);
  return toPlain({
    ...voucher,
    lines: lines.map((l) => ({ ...l, company: named(parties, l.companyId), department: named(departments, l.departmentId), branch: named(branches, l.branchId) })),
    submittedBy: name(voucher.submittedById),
    approvedBy: name(voucher.approvedById),
    postedBy: name(voucher.postedById),
    cancelledBy: name(voucher.cancelledById),
    reversedBy: name(voucher.reversedById),
  });
}

/**
 * BUSY's F4 on a voucher's form (src/lib/shortcuts/busy.ts): the narrations written before, to pick one rather
 * than type it again — the most recent first, this kind's ahead of the others, each once. Twenty at most.
 */
export async function recentNarrations(type?: VoucherType | null): Promise<string[]> {
  const g = await gate();
  if (!g.read) return [];
  try {
    const rows = await db.accountVoucher.findMany({ orderBy: { createdAt: "desc" }, take: 300, select: { type: true, narration: true } });
    const seen = new Set<string>();
    const pick = (list: typeof rows) =>
      list.flatMap((r) => {
        const text = r.narration.trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) return [];
        seen.add(key);
        return [text];
      });
    const own = (VOUCHER_TYPES as readonly string[]).includes(type ?? "") ? rows.filter((r) => r.type === type) : [];
    return [...pick(own), ...pick(rows)].slice(0, 20);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/**
 * BUSY's Page Up / Page Down on a voucher's page: the voucher listed just above it ("previous" — newer) or
 * just below it ("next" — older), in the list's own order (date, then number, newest first). Null at the ends.
 */
export async function adjacentVoucher(id: string, direction: "previous" | "next"): Promise<string | null> {
  const g = await gate();
  if (!g.read) return null;
  const current = await db.accountVoucher.findUnique({ where: { id }, select: { date: true, number: true } });
  if (!current) return null;
  const above = direction === "previous";
  const neighbour = await db.accountVoucher.findFirst({
    where: {
      id: { not: id },
      OR: [{ date: above ? { gt: current.date } : { lt: current.date } }, { date: current.date, number: above ? { gt: current.number } : { lt: current.number } }],
    },
    orderBy: above ? [{ date: "asc" }, { number: "asc" }] : [{ date: "desc" }, { number: "desc" }],
    select: { id: true },
  });
  return neighbour?.id ?? null;
}

export type SaveVoucherInput = {
  id?: string;
  type: VoucherType;
  date: string;
  narration: string;
  reference?: string;
  companyId?: string | null;
  lines: VoucherLineInput[];
  /** The form's own token: submitting twice makes one voucher. */
  requestId?: string;
};

/** Writes or rewrites a draft. Only a draft can be changed; anything sent on is withdrawn to change it. */
export async function saveVoucher(input: SaveVoucherInput): Promise<ActionResult<{ id: string; number: string }>> {
  const g = await gate();
  if (!g.create) return { ok: false, error: "Writing vouchers needs “Write vouchers”." };
  if (!(VOUCHER_TYPES as readonly string[]).includes(input.type)) return { ok: false, error: "Choose the kind of voucher." };
  const narration = input.narration?.trim();
  if (!narration) return { ok: false, error: "Say what the voucher is for — it's what the books will say later." };
  if (narration.length > 500) return { ok: false, error: "Keep the narration under 500 characters." };
  const date = input.date ? new Date(`${input.date.slice(0, 10)}T12:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: "Pick the voucher's date." };
  const today = (await workspaceClock()).today();
  if (input.date.slice(0, 10) > today) return { ok: false, error: "A voucher can't be dated in the future." };

  const lines: VoucherLineInput[] = (input.lines ?? [])
    .map((l) => ({
      accountId: String(l.accountId ?? ""),
      debit: Math.round((Number(l.debit) || 0) * 100) / 100,
      credit: Math.round((Number(l.credit) || 0) * 100) / 100,
      companyId: l.companyId || null,
      departmentId: l.departmentId || null,
      branchId: l.branchId || null,
      narration: l.narration?.trim().slice(0, 200) || null,
    }))
    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0))
    .slice(0, MAX_VOUCHER_LINES + 1);
  const accounts = await accountFacts();
  const problem = voucherProblem(input.type, lines, accounts);
  if (problem) return { ok: false, error: problem };
  if (input.companyId && !(await db.company.findUnique({ where: { id: input.companyId }, select: { id: true } }))) {
    return { ok: false, error: "That party no longer exists." };
  }
  const moneyAccountId = lines.find((l) => accounts.get(l.accountId)?.isMoney)?.accountId ?? null;
  const amount = voucherAmount(lines);
  const settings = await accountsSettings();
  if (!settings.migrated) return { ok: false, error: "This workspace's database hasn't been brought up to date for vouchers yet." };

  const data = {
    type: input.type,
    date,
    narration,
    reference: input.reference?.trim().slice(0, 80) || null,
    companyId: input.companyId || null,
    moneyAccountId,
    amount,
  };
  const lineRows = lines.map((l, i) => ({ ...l, sortOrder: i }));

  try {
    const saved = await db.$transaction(async (tx) => {
      if (input.id) {
        const existing = await tx.accountVoucher.findUnique({ where: { id: input.id }, select: { status: true, type: true, number: true } });
        if (!existing) throw new Error("That voucher no longer exists.");
        if (existing.status !== "DRAFT") throw new Error("Only a draft can be changed — send it back to draft, or reverse it if it's posted.");
        if (existing.type !== input.type) throw new Error("A voucher keeps its kind — cancel this one and write the other kind.");
        const changed = await tx.accountVoucher.updateMany({ where: { id: input.id, status: "DRAFT" }, data });
        if (changed.count === 0) throw new Error("Somebody else has just changed this voucher.");
        await tx.accountVoucherLine.deleteMany({ where: { voucherId: input.id } });
        await tx.accountVoucherLine.createMany({ data: lineRows.map((l) => ({ ...l, voucherId: input.id! })) });
        return { id: input.id, number: existing.number, created: false, replay: false };
      }
      const key = input.requestId ? `voucher-form:${input.requestId}` : null;
      if (key) {
        const again = await tx.accountVoucher.findUnique({ where: { idempotencyKey: key }, select: { id: true, number: true } });
        if (again) return { ...again, created: false, replay: true };
      }
      const number = await nextAccountsNumber(tx, input.type, date, settings.seriesPrefixes);
      const created = await tx.accountVoucher.create({
        data: { ...data, number, idempotencyKey: key, createdById: g.user.id, lines: { create: lineRows } },
        select: { id: true, number: true },
      });
      return { ...created, created: true, replay: false };
    });
    // A form sent again changed nothing — the first save is already on record.
    if (!saved.replay) await recordAudit({
      userId: g.user.id,
      action: saved.created ? "CREATE" : "UPDATE",
      entityType: "AccountVoucher",
      entityId: saved.id,
      entityLabel: `${voucherTypeLabels[input.type]} voucher ${saved.number} — ₹${amount.toLocaleString("en-IN")} — ${narration}`,
    });
    revalidatePath("/accounting/vouchers");
    return { ok: true, data: { id: saved.id, number: saved.number } };
  } catch (err) {
    // The same form saved twice at once: the second finds the first's token taken — it's the same voucher.
    if (input.requestId && !input.id && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const same = await db.accountVoucher.findUnique({ where: { idempotencyKey: `voucher-form:${input.requestId}` }, select: { id: true, number: true } });
      if (same) return { ok: true, data: same };
    }
    return { ok: false, error: err instanceof Error && !(err instanceof Prisma.PrismaClientKnownRequestError) ? err.message : "Could not save the voucher." };
  }
}

/** Moves a voucher from one state to the next — only along the allowed ways, and only from where it is now. */
async function move(id: string, to: VoucherStatus, data: Prisma.AccountVoucherUpdateManyMutationInput) {
  const voucher = await db.accountVoucher.findUnique({ where: { id }, select: { status: true, number: true, type: true, createdById: true } });
  if (!voucher) return { ok: false as const, error: "That voucher no longer exists." };
  if (!mayMove(voucher.status, to)) return { ok: false as const, error: `A ${voucher.status.toLowerCase().replace("_", " ")} voucher can't be ${to.toLowerCase().replace("_", " ")}.` };
  const changed = await db.accountVoucher.updateMany({ where: { id, status: voucher.status }, data: { status: to, ...data } });
  if (changed.count === 0) return { ok: false as const, error: "Somebody else has just changed this voucher." };
  return { ok: true as const, voucher };
}

/** Sends a draft to be approved, where Accounts settings ask for a second person. */
export async function submitVoucher(id: string): Promise<ActionResult<null>> {
  const g = await gate();
  if (!g.create) return { ok: false, error: "Sending vouchers for approval needs “Write vouchers”." };
  const moved = await move(id, "PENDING_APPROVAL", { submittedById: g.user.id, submittedAt: new Date() });
  if (!moved.ok) return moved;
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher ${moved.voucher.number} sent for approval` });
  revalidatePath("/accounting/vouchers");
  return { ok: true, data: null };
}

/** Approves a voucher somebody else wrote. Approving doesn't post it. */
export async function approveVoucher(id: string): Promise<ActionResult<null>> {
  const g = await gate();
  if (!g.approve) return { ok: false, error: "Approving vouchers needs “Approve vouchers”." };
  const voucher = await db.accountVoucher.findUnique({ where: { id }, select: { createdById: true } });
  if (voucher?.createdById === g.user.id) return { ok: false, error: "You can't approve a voucher you wrote — somebody else has to." };
  const moved = await move(id, "APPROVED", { approvedById: g.user.id, approvedAt: new Date() });
  if (!moved.ok) return moved;
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher ${moved.voucher.number} approved` });
  revalidatePath("/accounting/vouchers");
  return { ok: true, data: null };
}

/** Sends a voucher waiting for approval back to its writer, as a draft. */
export async function returnVoucher(id: string, note?: string): Promise<ActionResult<null>> {
  const g = await gate();
  if (!g.approve) return { ok: false, error: "Sending vouchers back needs “Approve vouchers”." };
  const moved = await move(id, "DRAFT", { submittedById: null, submittedAt: null });
  if (!moved.ok) return moved;
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher ${moved.voucher.number} sent back${note?.trim() ? `: ${note.trim()}` : ""}` });
  revalidatePath("/accounting/vouchers");
  return { ok: true, data: null };
}

/** Cancels a voucher that never posted. Its number stays used. */
export async function cancelVoucher(id: string, reason: string): Promise<ActionResult<null>> {
  const g = await gate();
  if (!g.create && !g.approve) return { ok: false, error: "Cancelling vouchers needs “Write vouchers”." };
  const why = reason?.trim();
  if (!why) return { ok: false, error: "Say why it's being cancelled." };
  const moved = await move(id, "CANCELLED", { cancelledById: g.user.id, cancelledAt: new Date(), cancelReason: why.slice(0, 300) });
  if (!moved.ok) return moved;
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher ${moved.voucher.number} cancelled: ${why}` });
  revalidatePath("/accounting/vouchers");
  return { ok: true, data: null };
}

/** The GSTIN a line on a GST account is booked to: its branch's, else the only one there is. */
async function gstinFor(tx: Prisma.TransactionClient, branchId: string | null): Promise<string | null | "ASK"> {
  if (branchId) {
    const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { gstRegistrationId: true } });
    if (branch?.gstRegistrationId) return branch.gstRegistrationId;
  }
  const registrations = await tx.gstRegistration.findMany({ where: { active: true }, select: { id: true }, take: 2 });
  if (registrations.length === 0) return null;
  if (registrations.length === 1) return registrations[0]!.id;
  return "ASK";
}

/** Posts a voucher to the ledger: one entry, once, into an open period. */
export async function postVoucher(id: string): Promise<ActionResult<{ entryNumber: string }>> {
  const g = await gate();
  if (!g.post) return { ok: false, error: "Posting vouchers needs “Write and reverse journal entries”." };
  const settings = await accountsSettings();
  const gstKeys = [
    SYSTEM_ACCOUNTS.INPUT_CGST, SYSTEM_ACCOUNTS.INPUT_SGST, SYSTEM_ACCOUNTS.INPUT_IGST,
    SYSTEM_ACCOUNTS.OUTPUT_CGST, SYSTEM_ACCOUNTS.OUTPUT_SGST, SYSTEM_ACCOUNTS.OUTPUT_IGST,
  ] as string[];
  try {
    const result = await db.$transaction(async (tx) => {
      const voucher = await tx.accountVoucher.findUnique({
        where: { id },
        include: { lines: { orderBy: { sortOrder: "asc" }, include: { account: { select: { systemKey: true, isGroup: true, active: true, name: true } } } } },
      });
      if (!voucher) throw new Error("That voucher no longer exists.");
      const from = voucher.status;
      if (from === "POSTED") throw new Error("It's already posted.");
      if (settings.voucherApprovalRequired && from !== "APPROVED") throw new Error("This needs approving before it posts.");
      if (!settings.voucherApprovalRequired && from !== "DRAFT" && from !== "APPROVED") throw new Error(`A ${from.toLowerCase().replace("_", " ")} voucher can't be posted.`);
      for (const line of voucher.lines) {
        if (line.account.isGroup || !line.account.active) throw new Error(`${line.account.name} is ${line.account.isGroup ? "a group" : "closed"} now — change the voucher first.`);
      }
      // Claimed first, conditionally: of two posts at once, one goes through.
      const claimed = await tx.accountVoucher.updateMany({ where: { id, status: from }, data: { status: "POSTED", postedById: g.user.id, postedAt: new Date() } });
      if (claimed.count === 0) throw new Error("Somebody else has just posted this voucher.");

      const lines = [];
      for (const l of voucher.lines) {
        let gstRegistrationId: string | null = null;
        if (l.account.systemKey && gstKeys.includes(l.account.systemKey)) {
          const gstin = await gstinFor(tx, l.branchId);
          if (gstin === "ASK") throw new Error(`Line on ${l.account.name}: choose the branch whose GSTIN it's for.`);
          gstRegistrationId = gstin;
        }
        lines.push({
          accountId: l.accountId,
          debit: Number(l.debit),
          credit: Number(l.credit),
          companyId: l.companyId ?? voucher.companyId,
          departmentId: l.departmentId,
          branchId: l.branchId,
          narration: l.narration,
          gstRegistrationId,
        });
      }
      return writeEntry(tx, {
        date: voucher.date,
        narration: `${voucherTypeLabels[voucher.type]} voucher ${voucher.number} — ${voucher.narration}`,
        source: "VOUCHER",
        userId: g.user.id,
        lines,
        companyId: voucher.companyId,
        accountVoucherId: voucher.id,
        postingKey: `voucher:${voucher.id}`,
      });
    });
    await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher posted as ${result.entryNumber}` });
    revalidatePath("/accounting/vouchers");
    revalidatePath("/accounting/journal");
    return { ok: true, data: { entryNumber: result.entryNumber } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not post the voucher." };
  }
}

/** Reverses a posted voucher with a dated, opposite entry — today's unless a later open date is given. */
export async function reverseVoucher(id: string, reason: string, date?: string): Promise<ActionResult<{ entryNumber: string }>> {
  const g = await gate();
  if (!g.post) return { ok: false, error: "Reversing vouchers needs “Write and reverse journal entries”." };
  const why = reason?.trim();
  if (!why) return { ok: false, error: "Say why it's being reversed." };
  const on = date?.slice(0, 10);
  if (on) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(new Date(on).getTime())) return { ok: false, error: "Pick the day to reverse it on." };
    if (on > (await workspaceClock()).today()) return { ok: false, error: "A reversal can't be dated in the future." };
  }
  try {
    const result = await db.$transaction(async (tx) => {
      const claimed = await tx.accountVoucher.updateMany({
        where: { id, status: "POSTED" },
        data: { status: "REVERSED", reversedById: g.user.id, reversedAt: new Date(), cancelReason: why.slice(0, 300) },
      });
      if (claimed.count === 0) throw new Error("Only a posted voucher can be reversed.");
      const original = await tx.journalEntry.findUnique({
        where: { postingKey: `voucher:${id}` },
        select: {
          id: true, entryNumber: true, date: true, companyId: true, accountVoucherId: true, reversedBy: { select: { id: true } },
          lines: { orderBy: { sortOrder: "asc" }, select: { accountId: true, debit: true, credit: true, companyId: true, departmentId: true, branchId: true, gstRegistrationId: true, narration: true } },
        },
      });
      if (!original) throw new Error("This voucher's entry isn't there to reverse.");
      if (on && on < original.date.toISOString().slice(0, 10)) throw new Error("A reversal can't be dated before the voucher it reverses.");
      return writeEntry(tx, {
        date: on ? new Date(`${on}T12:00:00.000Z`) : new Date(),
        narration: `Reversal of ${original.entryNumber} — ${why}`,
        source: "VOUCHER",
        userId: g.user.id,
        lines: original.lines.map((l) => ({
          accountId: l.accountId,
          debit: Number(l.credit),
          credit: Number(l.debit),
          companyId: l.companyId,
          departmentId: l.departmentId,
          branchId: l.branchId,
          gstRegistrationId: l.gstRegistrationId,
          narration: l.narration,
        })),
        companyId: original.companyId,
        reversesId: original.id,
        accountVoucherId: id,
        postingKey: `voucher:${id}:reversal`,
      });
    });
    await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "AccountVoucher", entityId: id, entityLabel: `Voucher reversed by ${result.entryNumber}: ${why}` });
    revalidatePath("/accounting/vouchers");
    revalidatePath("/accounting/journal");
    return { ok: true, data: { entryNumber: result.entryNumber } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reverse the voucher." };
  }
}
