"use server";

import type { BillingInterval, OfflinePaymentMethod, StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OFFLINE_METHODS, quoteOffline, recordOfflinePayment, voidOfflinePayment, type OfflineQuote, type RecordedPayment } from "@/lib/billing/offline";
import { saveBank, saveSeller } from "@/lib/billing/tax-invoice";
import { cancelProforma } from "@/lib/billing/proforma";
import { applyStanding } from "@/lib/billing/lifecycle";
import { MANAGERS, OWNERS, SELLERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Offline payments and the platform's own tax invoices, from the console (owner, 12 Oct 2026): a
 * payment no gateway took is recorded by staff — sellers record, managers void — and the seller's
 * details the tax invoices carry are the owner's to set. The work is src/lib/billing/offline.ts and
 * src/lib/billing/tax-invoice.ts; these only coerce what a browser sent, check who is asking, and
 * audit what the libraries don't.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    const data = await work(staff);
    revalidateConsole();
    return { ok: true, data };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

const ID = /^[a-z0-9]{20,40}$/;
const idOf = (value: unknown, gone: string) => {
  const id = String(value ?? "").trim();
  if (!ID.test(id) && !/^[0-9a-f-]{36}$/.test(id)) throw new ConsoleRefused(gone);
  return id;
};
const intervalOf = (value: unknown): BillingInterval => (value === "YEAR" ? "YEAR" : "MONTH");
const itemsOf = (value: unknown) => (Array.isArray(value) ? value.slice(0, 20).map((i) => ({ planKey: cleanText((i as { planKey?: unknown })?.planKey, 64), quantity: Number((i as { quantity?: unknown })?.quantity) })) : []);

/** What the price list says the period costs — what the form checks the amount received against. */
export async function consoleQuoteOffline(tenantId: string, items: { planKey: string; quantity: number }[], interval: BillingInterval, periods: number): Promise<ConsoleResult<OfflineQuote>> {
  return asStaff(SELLERS, async () => quoteOffline(idOf(tenantId, "That workspace no longer exists."), itemsOf(items), intervalOf(interval), Number(periods)));
}

export type OfflinePaymentForm = {
  tenantId: string;
  items: { planKey: string; quantity: number }[];
  interval: BillingInterval;
  periods: number;
  startsOn: string;
  /** Rupees as typed — whole or with paise. */
  amount: string;
  method: OfflinePaymentMethod;
  reference: string;
  receivedOn: string;
  partnerId: string;
  note: string;
  /** The workspace's proforma this pays, when it pays one; empty: none. */
  proformaId?: string;
};

/** "1,77,000.50" → paise; null when it isn't an amount. */
function paiseOf(text: unknown): number | null {
  const value = String(text ?? "").trim().replace(/[,\s₹]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export async function consoleRecordOfflinePayment(form: OfflinePaymentForm): Promise<ConsoleResult<RecordedPayment>> {
  return asStaff(SELLERS, async (staff) => {
    const f = form && typeof form === "object" ? form : ({} as OfflinePaymentForm);
    const amount = paiseOf(f.amount);
    if (amount === null || amount < 1) throw new ConsoleRefused("Enter the amount received, in rupees.");
    const method = OFFLINE_METHODS.find((m) => m === f.method);
    if (!method) throw new ConsoleRefused("Choose how it was paid.");
    const tenantId = idOf(f.tenantId, "That workspace no longer exists.");
    const partnerId = cleanText(f.partnerId, 64) || null;
    const made = await recordOfflinePayment(
      {
        tenantId,
        items: itemsOf(f.items),
        interval: intervalOf(f.interval),
        periods: Number(f.periods),
        startsOn: cleanText(f.startsOn, 10) || null,
        amount,
        method,
        reference: cleanText(f.reference, 80) || null,
        receivedOn: cleanText(f.receivedOn, 10),
        partnerId: partnerId ? idOf(partnerId, "Choose a partner from the directory.") : null,
        note: cleanText(f.note, 500) || null,
        proformaId: cleanText(f.proformaId, 64) ? idOf(cleanText(f.proformaId, 64), "That proforma no longer exists.") : null,
      },
      staff.id,
    );
    // Held for billing until now: let back in straight away, not at the next tick.
    await applyStanding(tenantId);
    return made;
  });
}

/** A payment recorded by mistake — voided, never deleted, with why. Managers only: it takes paid time away. */
export async function consoleVoidOfflinePayment(paymentId: string, reason: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = idOf(paymentId, "That payment no longer exists.");
    await voidOfflinePayment(id, cleanText(reason, 500), staff.id);
    return null;
  });
}

/** A proforma a workspace asked for, closed unpaid — asked for by mistake, or settled another way. */
export async function consoleCancelProforma(proformaId: string): Promise<ConsoleResult<null>> {
  return asStaff(SELLERS, async (staff) => {
    await cancelProforma(idOf(proformaId, "That proforma no longer exists."), staff.id);
    return null;
  });
}

export type InvoicingForm = {
  name: string;
  address: string;
  state: string;
  gstin: string;
  pan: string;
  sac: string;
  prefix: string;
  /** Where a bank transfer goes, printed on every proforma — all of it, or none. */
  bankAccountName?: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankUpi?: string;
};

/** The seller's details on every tax invoice. Owners only; saving issues every invoice waiting for them. */
export async function consoleSaveInvoicing(form: InvoicingForm): Promise<ConsoleResult<{ issued: number }>> {
  return asStaff(OWNERS, async (staff) => {
    const f = form && typeof form === "object" ? form : ({} as InvoicingForm);
    const input = {
      name: cleanText(f.name, 200),
      address: String(f.address ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").slice(0, 500),
      state: cleanText(f.state, 2),
      gstin: cleanText(f.gstin, 15),
      pan: cleanText(f.pan, 10),
      sac: cleanText(f.sac, 8),
      prefix: cleanText(f.prefix, 6),
    };
    const bank = { accountName: cleanText(f.bankAccountName, 120), bankName: cleanText(f.bankName, 120), account: cleanText(f.bankAccount, 24), ifsc: cleanText(f.bankIfsc, 11), upi: cleanText(f.bankUpi, 120) || null };
    // The bank account first: a mistake there leaves the seller's details as they were.
    await saveBank(bank, staff.id);
    const done = await saveSeller(input, staff.id);
    await consoleAudit(staff, "invoicing.settings", { name: input.name, state: input.state, gstin: input.gstin, sac: input.sac, prefix: input.prefix, issued: done.issued, bank: bank.account ? `…${bank.account.slice(-4)} ${bank.ifsc}` : null });
    return done;
  });
}
