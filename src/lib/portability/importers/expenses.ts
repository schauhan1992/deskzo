import { ExpenseCategory, ExpensePaymentMode, ExpenseStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { findCompany, requireUserRef } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type Resolved,
} from "./types";

/**
 * Expense claims — the ones nobody has decided yet.
 *
 * A claim that has been approved, rejected or reimbursed is the record of a decision a manager made
 * on a particular day, and a reimbursed one is also a payment the books posted against a bank
 * account. Writing one from a file would create a payout the ledger never saw. That is the same
 * reasoning areas.ts gives for orders and payments not importing at all; here it applies to three of
 * the five statuses rather than to the whole area. `approverUserId`, `decidedAt`, `reimbursedAt` and
 * `reimbursementRef` are never written and are not columns — inventing a decision is worse than not
 * carrying one.
 *
 * ## Refused means "may not be changed", not "may not appear in the file"
 *
 * The exporter writes every claim, decided ones included, because an export that quietly dropped
 * four fifths of the spend would be a worse lie than any import error. So a file handed back
 * unedited necessarily contains approved and reimbursed rows, and the refusal is aimed precisely at
 * what is dangerous: a decided claim that a row would **create or change** is an error naming the
 * reason, and one the row leaves exactly as it stands is a skip. A row that asks for nothing is not
 * a payout. This is what lets somebody export the area, correct three descriptions and hand the
 * whole file back, instead of being told that forty-seven untouched rows are unusable — and it is
 * what `check:import`'s round trip (an exported file must re-import with no errors at all) requires.
 *
 * One consequence worth stating: a claim imported as SUBMITTED carries no approver. The approver is
 * snapshotted by the submit flow from the reporting line as it stood at that moment, and inventing
 * one here would drop a claim into a manager's queue they never received. The claim shows in the
 * expenses list as submitted; it enters somebody's decision queue when it is submitted through the
 * app, which is also what notifies them. (`resolveApprover` can already return null for a claimant
 * with no manager, so this is a state the app itself produces rather than a new one.)
 *
 * ## Matching
 *
 * On EXP-nnnnnn where the file carries one, and otherwise on the four things that identify a claim
 * to the person who made it: who spent it, the day, the amount and the description. Without that
 * fallback a hand-written file imported twice reimburses the same claim twice, which is the
 * expensive direction to be wrong in. The price is that two genuinely separate claims by one person
 * for the same amount on the same day have to differ in their description to be told apart, and that
 * editing any of those four fields in a keyless file raises a new claim rather than amending one.
 * A file that carries the key — which is to say any file our own export produced — has neither
 * problem.
 */

/** A decision and, for the last of them, a payment. None of the three may be written from a file. */
const DECIDED_STATUSES: ExpenseStatus[] = [
  ExpenseStatus.APPROVED,
  ExpenseStatus.REJECTED,
  ExpenseStatus.REIMBURSED,
];

const isDecided = (status: ExpenseStatus) => DECIDED_STATUSES.includes(status);

const cannotArriveDecided = (status: ExpenseStatus) =>
  `Status "${status}" can't be imported. An approved or rejected claim is a decision somebody made, and a reimbursed one is a payment the books recorded — importing it would create a payout the ledger never saw. Bring it in as Draft or Submitted and take it through approval here.`;

type ExistingExpense = {
  id: string;
  expenseSeq: number;
  status: ExpenseStatus;
  personName: string;
  category: ExpenseCategory;
  amount: number;
  taxAmount: number | null;
  spentOn: Date;
  description: string;
  paymentMode: ExpensePaymentMode;
  reimbursable: boolean;
  companyName: string;
};

type ResolvedExpense = {
  userId: string;
  personName: string;
  category?: ExpenseCategory;
  amount?: number;
  taxAmount?: number;
  spentOn?: Date;
  description?: string;
  paymentMode?: ExpensePaymentMode;
  reimbursable?: boolean;
  status?: ExpenseStatus;
  companyId?: string;
  companyName?: string;
  existing?: ExistingExpense;
  /** Why this row may not be written, when the claim behind it has already been decided. */
  frozen?: string;
};

/** Compared by the day rather than the instant: a spreadsheet carries a date, not a timestamp. */
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The whole day a cell names, so a claim stored with a time on it still matches the date typed. */
function dayRange(d: Date) {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const expenseInclude = {
  user: { select: { name: true, email: true } },
  company: { select: { name: true } },
} as const;

type ExpenseRecord = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

function snapshot(e: ExpenseRecord): ExistingExpense {
  return {
    id: e.id,
    expenseSeq: e.expenseSeq,
    status: e.status,
    personName: e.user.name,
    category: e.category,
    amount: Number(e.amount),
    taxAmount: e.taxAmount === null ? null : Number(e.taxAmount),
    spentOn: e.spentOn,
    description: e.description,
    paymentMode: e.paymentMode,
    reimbursable: e.reimbursable,
    companyName: e.company?.name ?? "",
  };
}

/** Does the Person cell still name the person the stored claim belongs to? */
function stillNames(user: { name: string; email: string }, cell: string): boolean {
  const v = cell.trim().toLowerCase();
  return v === user.name.trim().toLowerCase() || v === user.email.trim().toLowerCase();
}

async function resolve(row: Record<string, string>): Promise<Resolved<ResolvedExpense>> {
  const r = new RowReader(row);

  const category = r.enum("Category", ExpenseCategory);
  const paymentMode = r.enum("Payment mode", ExpensePaymentMode);
  const status = r.enum("Status", ExpenseStatus);
  const reimbursable = r.boolean("Reimbursable");
  const amount = r.number("Amount");
  const taxAmount = r.number("Tax");
  const spentOn = r.date("Spent on");
  if (r.error) return { error: r.error };

  const description = r.text("Description") || undefined;

  const seq = seqFromKey("EXP", r.text("Expense"));
  let found: ExpenseRecord | null = seq
    ? await db.expense.findUnique({ where: { expenseSeq: seq }, include: expenseInclude })
    : null;
  if (seq && !found) {
    return { error: `No expense with key ${keyOf("EXP", seq)}. Remove the Expense cell to raise a new claim.` };
  }

  // The claimant. A claim we have already matched keeps the person it belongs to when the cell still
  // names them — `findUser` matches active accounts only, which is right for handing somebody work
  // and wrong for a record of who was out of pocket. Without this, every claim filed by an employee
  // who has since left comes back from our own export as an error row. Naming a *different* person
  // is a reassignment, and that does have to be somebody who still works here.
  const personCell = r.text("Person");
  let userId: string;
  let personName: string;
  if (found && (!personCell || stillNames(found.user, personCell))) {
    userId = found.userId;
    personName = found.user.name;
  } else {
    const person = await requireUserRef("Person", personCell);
    if ("error" in person) return { error: person.error };
    userId = person.value.id;
    personName = person.value.name;
  }

  // No key: the natural key is the claimant, the day, the amount and the description together.
  if (!seq && amount !== undefined && spentOn && description) {
    found = await db.expense.findFirst({
      where: {
        userId,
        amount,
        description: { equals: description, mode: "insensitive" },
        spentOn: dayRange(spentOn),
      },
      include: expenseInclude,
      // Deterministic, so a preview and the write that follows it agree about which claim they meant.
      orderBy: { expenseSeq: "asc" },
    });
  }

  const existing = found ? snapshot(found) : undefined;

  // Optional on the model, so a blank cell is an expense with no customer behind it — the phone bill
  // rather than a missing company. A name we cannot place is still refused.
  const companyCell = r.text("Company");
  const company = companyCell ? await findCompany(companyCell) : null;
  if (companyCell && !company) {
    return {
      error: `No company named "${companyCell}" (Company). Import the company first, correct the spelling, or leave the cell empty — an expense need not belong to one.`,
    };
  }

  // Raising a decided claim from nothing is refused outright: there is no reading of it that isn't a
  // payout the ledger never saw.
  if (status && isDecided(status) && !existing) return { error: cannotArriveDecided(status) };

  // Touching one is refused by `plan`/`apply` if and only if the row actually changes something.
  const frozen =
    existing && isDecided(existing.status)
      ? `${keyOf("EXP", existing.expenseSeq)} has already been ${existing.status.toLowerCase()} here. Editing it from a spreadsheet would rewrite a claim somebody has decided and, once reimbursed, paid. Change it on the claim's own screen.`
      : status && isDecided(status)
        ? cannotArriveDecided(status)
        : undefined;

  if (!existing) {
    if (amount === undefined) return { error: "Amount is required on a new claim." };
    if (!spentOn) return { error: "Spent on is required on a new claim." };
    if (!description) return { error: "Description is required on a new claim." };
  }

  return {
    value: {
      userId,
      personName,
      category,
      amount,
      taxAmount,
      spentOn,
      description,
      paymentMode,
      reimbursable,
      status,
      companyId: company?.id,
      companyName: company?.name,
      existing,
      frozen,
    },
  };
}

export const expensesImporter: Importer = {
  templateColumns: [
    "Expense",
    "Person",
    "Category",
    "Amount",
    "Tax",
    "Spent on",
    "Description",
    "Payment mode",
    "Reimbursable",
    "Status",
    "Company",
  ],

  async plan(row, line) {
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, row.Expense || row.Person || "", resolved.error);
    const e = resolved.value;
    const label = `${e.personName} — ${e.description ?? e.existing?.description ?? ""}`;

    if (!e.existing) {
      return createRow(line, `${e.personName} ${day(e.spentOn!)} ${e.amount}`, label, {
        Person: e.personName,
        Category: e.category,
        Amount: e.amount,
        Tax: e.taxAmount,
        "Spent on": e.spentOn,
        Description: e.description,
        "Payment mode": e.paymentMode,
        Reimbursable: e.reimbursable,
        Status: e.status,
        Company: e.companyName,
      });
    }

    const was = e.existing;
    const key = keyOf("EXP", was.expenseSeq);
    const planned = updateRow(line, key, label, [
      diff("Person", was.personName, e.personName),
      e.category ? diff("Category", was.category, e.category) : null,
      e.amount !== undefined ? diff("Amount", was.amount, e.amount) : null,
      e.taxAmount !== undefined ? diff("Tax", was.taxAmount, e.taxAmount) : null,
      e.spentOn ? diff("Spent on", day(was.spentOn), day(e.spentOn)) : null,
      e.description ? diff("Description", was.description, e.description) : null,
      e.paymentMode ? diff("Payment mode", was.paymentMode, e.paymentMode) : null,
      e.reimbursable !== undefined ? diff("Reimbursable", was.reimbursable, e.reimbursable) : null,
      e.status ? diff("Status", was.status, e.status) : null,
      e.companyName ? diff("Company", was.companyName, e.companyName) : null,
    ]);

    // A decided claim reads back unchanged — which is what makes an exported file re-importable —
    // but an actual edit to one is refused rather than written.
    if (e.frozen && planned.action === "update") return errorRow(line, key, e.frozen);
    return planned;
  },

  async apply(row) {
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const e = resolved.value;

    // Unreachable through import.ts, which only applies the rows `plan` called a create or an update
    // and never one it called a skip. The writer refuses on its own account rather than trusting it.
    if (e.frozen) throw new Error(e.frozen);

    // `plan` compares Spent on by the day, so writing back a same-day value would replace a stored
    // time nobody asked to change and the preview never mentioned.
    const spentOnChanges = e.spentOn !== undefined && (!e.existing || day(e.existing.spentOn) !== day(e.spentOn));

    const data = {
      userId: e.userId,
      ...(e.category ? { category: e.category } : {}),
      ...(e.amount !== undefined ? { amount: e.amount } : {}),
      ...(e.taxAmount !== undefined ? { taxAmount: e.taxAmount } : {}),
      ...(spentOnChanges ? { spentOn: e.spentOn } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.paymentMode ? { paymentMode: e.paymentMode } : {}),
      ...(e.reimbursable !== undefined ? { reimbursable: e.reimbursable } : {}),
      ...(e.status ? { status: e.status } : {}),
      ...(e.companyId ? { companyId: e.companyId } : {}),
    };

    if (e.existing) {
      await db.expense.update({ where: { id: e.existing.id }, data });
      return;
    }

    // resolve() has already refused a new claim missing any of these, so the file carries them.
    await db.expense.create({
      data: { ...data, amount: e.amount!, spentOn: e.spentOn!, description: e.description! },
    });
  },
};
