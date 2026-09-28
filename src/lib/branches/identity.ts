/**
 * Branches: the head office, who "we" are on a document, and the defaults and filters built on that.
 *
 * A plain server module — not `"use server"`: nothing here authorises, so exporting it as actions
 * would publish every branch's address and bank block to anybody signed in. Actions call it after
 * their own gate. The pure half (types, the merge rule, labels) is `src/lib/branches/format.ts`.
 *
 * ## Never inside a transaction
 *
 * Everything here goes through `db` — its own connection — and `ensureHeadOffice` may write: it can
 * create the head office, and `adoptUnassigned` updates `trade_documents`. Called inside a
 * `db.$transaction`, a helper can wait on a row that transaction already holds, while the transaction
 * waits on the helper: a deadlock Postgres cannot see, because the two connections only meet in the
 * application. So callers resolve the branch and its identity *before* opening a transaction, and
 * code that only ever runs inside one (`src/lib/trade-number.ts`, the ledger postings) reads the head
 * office through its own `tx.branch.findFirst({ where: { isHeadOffice: true } })`.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { tenantKey } from "@/lib/tenancy/cache";
import { formatDispatchAddress, mergeIdentity, type BranchChoice, type BranchIdentity, type RegistrationChoice } from "@/lib/branches/format";

/** Fixed ids: the migration, lazy creation and the check suites agree on them. */
export const HEAD_OFFICE_ID = "branch_head_office";
export const HEAD_OFFICE_REGISTRATION_ID = "gstreg_head_office";

export type BranchWithRegistration = Prisma.BranchGetPayload<{ include: { gstRegistration: true } }>;

const isUniqueViolation = (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === "P2002";

function findHeadOffice(): Promise<BranchWithRegistration | null> {
  return db.branch.findFirst({ where: { isHeadOffice: true }, include: { gstRegistration: true } });
}

/**
 * The head office, created if there is none — a fresh workspace, a workspace whose migration found
 * nothing to attach one to, or one just emptied by the data reset.
 *
 * Race-safe the way `ensureChartOfAccounts` is: a page fires several report queries in parallel and
 * each may get here first. The create is an upsert on the fixed id, so parallel callers settle on
 * one row; the partial unique index (`branches_one_head_office`) refuses a second head office, and
 * whoever loses that race reads the winner's.
 *
 * Also adopts rows written without a branch, once per process per workspace (§13.2).
 */
export async function ensureHeadOffice(): Promise<BranchWithRegistration> {
  const existing = await findHeadOffice();
  const headOffice = existing ?? (await createHeadOffice());
  // A head office that did not exist a moment ago may have rows waiting for it, whatever this process
  // adopted before — a data reset followed by raw inserts, say.
  await adoptOncePerWorkspace(!existing);
  return headOffice;
}

async function createHeadOffice(): Promise<BranchWithRegistration> {
  const [registration, taken] = await Promise.all([
    db.gstRegistration.findUnique({ where: { id: HEAD_OFFICE_REGISTRATION_ID }, select: { id: true } }),
    db.branch.findMany({ where: { code: { startsWith: "HO" } }, select: { code: true } }),
  ]);
  const codes = new Set(taken.map((b) => b.code));
  let code = "HO";
  for (let n = 2; codes.has(code); n++) code = `HO${n}`;

  try {
    return await db.branch.upsert({
      where: { id: HEAD_OFFICE_ID },
      // The fixed row exists but lost the flag, and nothing else holds it: it is the head office again.
      update: { isHeadOffice: true, active: true },
      // Every override blank, address included: it prints the registered office, as the company always has.
      create: { id: HEAD_OFFICE_ID, name: "Head office", code, isHeadOffice: true, gstRegistrationId: registration?.id ?? null },
      include: { gstRegistration: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A parallel call made the head office first (or took the code): read theirs.
    const winner = await findHeadOffice();
    if (winner) return winner;
    throw err;
  }
}

/** Per workspace: the adoption this process has run (or is running), so it happens once. */
const adopted = new Map<string, Promise<void>>();

async function adoptOncePerWorkspace(force: boolean): Promise<void> {
  const key = await tenantKey();
  const previous = adopted.get(key);
  if (previous && !force) return previous;
  // Chained rather than parallel: two adoptions of the same rows would only wait on each other.
  const run = (previous ?? Promise.resolve()).then(() =>
    adoptUnassigned().catch((err) => {
      // Not fatal — readers treat a null branch as the head office anyway. The next call retries.
      if (adopted.get(key) === run) adopted.delete(key);
      console.error("[branches] adopting rows without a branch failed; will retry", err);
    }),
  );
  adopted.set(key, run);
  return run;
}

/**
 * Rows written with no branch — by the previous release, which keeps serving between
 * `tenants:migrate` and the deploy, or by a raw insert since — given the head office, as the
 * migration's backfill gave everything before it (spec §13.1 steps 3–6, §13.2).
 *
 * Every statement touches only rows whose `branchId` is still null, so once nothing is left it is a
 * handful of index lookups that change nothing. Journal lines are restricted to the postings new code
 * always tags — a document's, a payment's, an expense's, and the reversal of a document's — so the
 * legitimately untagged ones (payroll, depreciation, manual lines, cheque clearing, exchange
 * differences) stay untagged. The ids are the head office's as it stands now, which is what a reader
 * takes a null to mean (`branchIdentity(null)`, `branchFilter`); right after the migration those are
 * the fixed ids.
 *
 * Removed in the contract release, which makes `branchId` NOT NULL with the head office as its default.
 */
export async function adoptUnassigned(): Promise<void> {
  const headOffice = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true, gstRegistrationId: true } });
  // Nothing to adopt into. `ensureHeadOffice` creates one and comes back here.
  if (!headOffice) return;
  const branchId = headOffice.id;
  const registrationId = headOffice.gstRegistrationId;

  await db.$transaction(async (tx) => {
    // A caller that broke the rule and holds one of these rows must not hang this for ever.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);

    // ── Step 3, registrations: a sales document the one its snapshot names; a purchase, or a sale with
    // no snapshot, the head office's. Before the branch is set, while "branchId IS NULL" still marks them.
    await tx.$executeRaw`
      UPDATE "trade_documents" d SET "gstRegistrationId" = r."id"
        FROM "gst_registrations" r
       WHERE d."branchId" IS NULL AND d."gstRegistrationId" IS NULL
         AND d."direction" = 'SALES' AND upper(btrim(d."sellerGstin")) = r."gstin"`;
    if (registrationId) {
      await tx.$executeRaw`
        UPDATE "trade_documents" SET "gstRegistrationId" = ${registrationId}
         WHERE "branchId" IS NULL AND "gstRegistrationId" IS NULL AND ("direction" = 'PURCHASE' OR "sellerGstin" IS NULL)`;
    }

    // ── Step 4 (X1): the previous release put the vendor's GSTIN in buyerGstin on a purchase. Keep it as
    // the seller's and put ours where it belongs — only on the rows being adopted now.
    await tx.$executeRaw`
      UPDATE "trade_documents" d
         SET "sellerGstin" = coalesce(nullif(upper(btrim(d."buyerGstin")), r."gstin"), d."sellerGstin"),
             "buyerGstin"  = r."gstin"
        FROM "gst_registrations" r
       WHERE d."branchId" IS NULL AND d."direction" = 'PURCHASE' AND d."gstRegistrationId" = r."id"
         AND d."buyerGstin" IS DISTINCT FROM r."gstin"`;

    // ── Step 3, branch; step 5, payments and consignments.
    await tx.$executeRaw`UPDATE "trade_documents" SET "branchId" = ${branchId} WHERE "branchId" IS NULL`;
    await tx.$executeRaw`UPDATE "payments" SET "branchId" = ${branchId} WHERE "branchId" IS NULL`;
    await tx.$executeRaw`UPDATE "consignments" SET "branchId" = ${branchId} WHERE "branchId" IS NULL`;

    // ── Step 6, journal lines. A document's own posting (not the exchange difference that also names
    // it), and the reversal of one, take the document's branch and registration on every line.
    await tx.$executeRaw`
      UPDATE "journal_lines" l SET "branchId" = d."branchId", "gstRegistrationId" = d."gstRegistrationId"
        FROM "journal_entries" e JOIN "trade_documents" d ON d."id" = e."documentId"
       WHERE l."entryId" = e."id" AND l."branchId" IS NULL AND e."source" IN ('INVOICE', 'CREDIT_NOTE', 'BILL')`;
    await tx.$executeRaw`
      UPDATE "journal_lines" l SET "branchId" = d."branchId", "gstRegistrationId" = d."gstRegistrationId"
        FROM "journal_entries" e
        JOIN "journal_entries" o ON o."id" = e."reversesId"
        JOIN "trade_documents" d ON d."id" = o."documentId"
       WHERE l."entryId" = e."id" AND l."branchId" IS NULL AND o."source" IN ('INVOICE', 'CREDIT_NOTE', 'BILL')`;
    // A payment's posting takes the payment's branch. A cheque clearing is untagged by design; its
    // narration is how the ledger itself finds one (journal.ts, postChequeClearingToLedger).
    await tx.$executeRaw`
      UPDATE "journal_lines" l SET "branchId" = coalesce(p."branchId", ${branchId})
        FROM "journal_entries" e JOIN "payments" p ON p."id" = e."paymentId"
       WHERE l."entryId" = e."id" AND l."branchId" IS NULL AND e."source" = 'PAYMENT'
         AND e."narration" NOT LIKE 'Cheque % cleared'`;
    // An expense claim or its reimbursement: the head office's registration on the GST lines (before the
    // branch, which is what still marks them), then the head office on every line. Whose GSTIN claims the
    // ITC on an expense is CA question C7; this follows the migration's default.
    if (registrationId) {
      await tx.$executeRaw`
        UPDATE "journal_lines" l SET "gstRegistrationId" = ${registrationId}
          FROM "journal_entries" e, "ledger_accounts" a
         WHERE l."entryId" = e."id" AND l."accountId" = a."id" AND l."branchId" IS NULL AND l."gstRegistrationId" IS NULL
           AND e."expenseId" IS NOT NULL
           AND a."systemKey" IN ('INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST')`;
    }
    await tx.$executeRaw`
      UPDATE "journal_lines" l SET "branchId" = ${branchId}
        FROM "journal_entries" e
       WHERE l."entryId" = e."id" AND l."branchId" IS NULL AND e."expenseId" IS NOT NULL`;
  });
}

/** The organisation row, or null before anybody has filled in the Profile. */
function organisationRow() {
  return db.organisationSettings.findUnique({ where: { id: "global" } });
}

/** Stands in for the head office when even creating one failed — so a page still prints the company. */
const PLACEHOLDER_HEAD_OFFICE = { id: HEAD_OFFICE_ID, name: "Head office", code: "HO", isHeadOffice: true, active: true, gstRegistration: null };

/**
 * Who "we" are on a document raised from this branch (or, on a purchase, bought by it). A null or
 * unknown id is the head office — how every document written before branches reads.
 *
 * Never throws, like `getOrganisation`: this is read on every document page, and a half-migrated or
 * unreachable database should print the organisation rather than a 500.
 */
export async function branchIdentity(branchId: string | null | undefined): Promise<BranchIdentity> {
  try {
    const [branch, org] = await Promise.all([
      branchId ? db.branch.findUnique({ where: { id: branchId }, include: { gstRegistration: true } }) : Promise.resolve(null),
      organisationRow(),
    ]);
    return mergeIdentity(branch ?? (await ensureHeadOffice()), org);
  } catch (err) {
    console.error("[branches] branch identity unavailable; printing the organisation", err);
    const org = await organisationRow().catch(() => null);
    return mergeIdentity(PLACEHOLDER_HEAD_OFFICE, org);
  }
}

/** The branch a new document, consignment or payment is raised from: the user's own when active, else the head office. */
export async function defaultBranchIdFor(userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { branch: { select: { id: true, active: true } } } });
  if (user?.branch?.active) return user.branch.id;
  return (await ensureHeadOffice()).id;
}

/**
 * Branches for a picker: the active ones, plus any ids passed (a draft's current branch, since
 * deactivated — it must still show what the draft says). Head office first, then by name.
 */
export async function listBranchChoices(opts?: { include?: string[] }): Promise<BranchChoice[]> {
  const include = (opts?.include ?? []).filter(Boolean);
  // A fresh workspace's picker still has its head office in it.
  await ensureHeadOffice();
  const [branches, org, activeRegistrations] = await Promise.all([
    db.branch.findMany({
      where: include.length ? { OR: [{ active: true }, { id: { in: include } }] } : { active: true },
      include: { gstRegistration: true },
    }),
    organisationRow(),
    db.gstRegistration.count({ where: { active: true } }),
  ]);
  return branches
    .sort((a, b) => Number(b.isHeadOffice) - Number(a.isHeadOffice) || a.name.localeCompare(b.name))
    .map((branch) => {
      const identity = mergeIdentity(branch, org);
      return {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        isHeadOffice: branch.isHeadOffice,
        active: branch.active,
        gstRegistrationId: identity.gstRegistrationId,
        gstin: identity.gstin,
        stateCode: identity.stateCode,
        dispatchAddress: formatDispatchAddress(identity),
        invoiceTerms: identity.invoiceTerms,
        // An unregistered company (or one abroad) issues as it always has; a registered one only from a
        // branch that holds an active registration.
        canIssueTaxDocuments: Boolean(branch.gstRegistration?.active) || activeRegistrations === 0,
      };
    });
}

/** More than one active branch — the switch for every branch picker, column and filter. */
export async function isMultiBranch(): Promise<boolean> {
  return (await db.branch.count({ where: { active: true } })) > 1;
}

/**
 * Registrations for the returns picker and the settings screens: the active ones, and an inactive
 * one only while something still names it — a return for a GSTIN given up last year is still due.
 */
export async function listRegistrationChoices(): Promise<RegistrationChoice[]> {
  const [registrations, headOffice] = await Promise.all([
    db.gstRegistration.findMany({
      where: { OR: [{ active: true }, { documents: { some: {} } }, { journalLines: { some: {} } }] },
      select: { id: true, gstin: true, stateCode: true, code: true, active: true },
    }),
    db.branch.findFirst({ where: { isHeadOffice: true }, select: { gstRegistrationId: true } }),
  ]);
  return registrations
    .map((r) => ({ ...r, isHeadOffice: r.id === headOffice?.gstRegistrationId }))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.isHeadOffice) - Number(a.isHeadOffice) || a.code.localeCompare(b.code));
}

/**
 * A list filter for one branch, to go inside an `AND` array. For the head office it also matches a
 * null branch — a row the previous release wrote before it was adopted (§13.2). The null half goes
 * in the contract release, with `adoptUnassigned`.
 */
export async function branchFilter(branchId: string): Promise<Prisma.TradeDocumentWhereInput> {
  const headOffice = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
  return headOffice?.id === branchId ? { OR: [{ branchId }, { branchId: null }] } : { branchId };
}
