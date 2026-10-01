import type { Prisma } from "@deskzo/control-client";
import { partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { actorOf, cleanCountry, cleanId, mailPartnerUsers, oneLine, optionalText, requiredText, staffActor } from "@/lib/partners/registry";
import { PartnerRefused, type PayoutInput, type PayoutMask } from "@/lib/partners/types";
import { controlDb } from "@/lib/platform/control-db";
import { openForPartner, sealForPartner } from "@/lib/platform/kek";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * A partner's bank details (spec D12): sealed in `partners.payoutCipher` under the platform key bound
 * to the partner ("partner-payout"); only a mask — holder, bank, country, currency, the last four,
 * IFSC and SWIFT — is ever shown. The full details come out in one place only, `revealPayout`, for
 * OWNER and BILLING staff, audited and visible to the partner.
 *
 * A partner changes them only by request (requests.ts); staff may set them. Every change emails all
 * the partner's ADMIN users a security notice showing the mask alone.
 *
 * Nothing here logs or echoes a value: a refusal names the field, never what was typed.
 */

/** Bank details as checked — what is sealed, and what `revealPayout` returns. */
export type PayoutDetails = {
  accountHolder: string;
  bankName: string;
  country: string;
  currency: string;
  accountNumber: string | null;
  ifsc: string | null;
  iban: string | null;
  swift: string | null;
  routingNumber: string | null;
  note: string | null;
};

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const SWIFT = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

const compact = (raw: unknown) => oneLine(raw).replace(/[\s-]+/g, "").toUpperCase();

/** ISO 13616: the first four characters moved to the end, letters as 10–35, the number mod 97 is 1. */
function ibanChecks(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/**
 * Bank details as typed → checked, or a PartnerRefused naming the field. India: the account number
 * is 6–20 digits and needs an IFSC. Elsewhere: an account number (4–34 letters or digits) or an IBAN
 * (its check digits verified). At least one of the two.
 */
export function cleanPayout(input: PayoutInput): PayoutDetails {
  if (!input || typeof input !== "object") throw new PartnerRefused("Give the bank details.");
  const accountHolder = requiredText(input.accountHolder, 2, 120, "Give the account holder's name (2 to 120 characters).");
  const bankName = requiredText(input.bankName, 2, 120, "Give the bank's name (2 to 120 characters).");
  const country = cleanCountry(input.country, "Choose the country the account is in.");
  const currency = oneLine(input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PartnerRefused("Give the account's currency as three letters, like INR or USD.");

  const accountNumber = compact(input.accountNumber) || null;
  const iban = compact(input.iban) || null;
  const ifsc = compact(input.ifsc) || null;
  const swift = compact(input.swift) || null;
  const routingNumber = compact(input.routingNumber) || null;
  if (!accountNumber && !iban) throw new PartnerRefused("Give an account number or an IBAN.");
  if (accountNumber) {
    if (country === "IN" && !/^[0-9]{6,20}$/.test(accountNumber)) throw new PartnerRefused("An Indian account number is 6 to 20 digits.");
    if (country !== "IN" && !/^[A-Z0-9]{4,34}$/.test(accountNumber)) throw new PartnerRefused("The account number is 4 to 34 letters and digits.");
  }
  if (iban && (!IBAN.test(iban) || !ibanChecks(iban))) throw new PartnerRefused("That IBAN doesn't check out. Look at it again.");
  if (ifsc && !IFSC.test(ifsc)) throw new PartnerRefused("An IFSC is 11 characters: four letters, a zero, then six letters or digits.");
  if (country === "IN" && accountNumber && !ifsc) throw new PartnerRefused("Give the branch's IFSC.");
  if (swift && !SWIFT.test(swift)) throw new PartnerRefused("A SWIFT (BIC) code is 8 or 11 letters and digits.");
  if (routingNumber && !/^[A-Z0-9]{3,20}$/.test(routingNumber)) throw new PartnerRefused("The routing or sort code is 3 to 20 letters and digits.");
  const note = optionalText(input.note, 200, "Keep the note to 200 characters.");
  return { accountHolder, bankName, country, currency, accountNumber, ifsc, iban, swift, routingNumber, note };
}

/** What may be shown of bank details: never more than the last four characters of the account. */
export function maskOf(details: PayoutDetails): PayoutMask {
  const account = details.accountNumber ?? details.iban ?? "";
  return {
    method: "BANK",
    accountHolder: details.accountHolder,
    bankName: details.bankName,
    country: details.country,
    currency: details.currency,
    last4: account.slice(-4),
    ifsc: details.ifsc,
    swift: details.swift,
  };
}

/** Sealed details read back — the shape checked, since whatever is stored is trusted by nobody. */
export function payoutFromJson(text: string): PayoutDetails {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PartnerRefused("The payout details on file can't be read. Set them again.");
  }
  const v = (value ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  if (!str("accountHolder") || !str("bankName") || !str("country") || !str("currency")) throw new PartnerRefused("The payout details on file can't be read. Set them again.");
  return {
    accountHolder: str("accountHolder")!,
    bankName: str("bankName")!,
    country: str("country")!,
    currency: str("currency")!,
    accountNumber: str("accountNumber"),
    ifsc: str("ifsc"),
    iban: str("iban"),
    swift: str("swift"),
    routingNumber: str("routingNumber"),
    note: str("note"),
  };
}

/**
 * Seals checked details onto the partner inside the caller's transaction, with its `payout.set`
 * row, and returns the new mask. The email is `mailPayoutChanged`, after the transaction.
 */
export async function writePayout(tx: Prisma.TransactionClient, partnerId: string, details: PayoutDetails, actor: PartnerActor, now: Date = new Date()): Promise<PayoutMask> {
  const mask = maskOf(details);
  const cipher = sealForPartner(partnerId, "partner-payout", JSON.stringify(details));
  const set = await tx.partner.updateMany({ where: { id: partnerId }, data: { payoutCipher: cipher, payoutMask: mask as Prisma.InputJsonValue, payoutUpdatedAt: now } });
  if (set.count !== 1) throw new PartnerRefused("That partner no longer exists.");
  await partnerAudit(actor, partnerId, "payout.set", "payout", partnerId, { country: mask.country, currency: mask.currency }, { tx });
  return mask;
}

/** The security notice to every ADMIN user: new payout details are on file — the mask alone. */
export async function mailPayoutChanged(partnerId: string, mask: PayoutMask): Promise<void> {
  await mailPartnerUsers(partnerId, { roles: ["ADMIN"] }, "Partner portal: payout details changed", [
    "The bank details your company's commission is paid to have been changed.",
    "",
    `Now on file: ${mask.accountHolder}, ${mask.bankName}, account ending ${mask.last4} (${mask.currency}).`,
    "",
    "If you did not expect this, contact your partner manager straight away.",
  ]);
}

/**
 * New payout details for a partner (console, PAYERS — or a PAYOUT request approved): checked,
 * sealed, masked, `payoutUpdatedAt` now, audited `payout.set`, and every ADMIN user emailed the mask.
 */
export async function setPayout(partnerId: string, details: PayoutInput, actor: Staff | PartnerActor, now: Date = new Date()): Promise<{ mask: PayoutMask; partnerSlug: string }> {
  const clean = cleanPayout(details);
  const id = cleanId(partnerId);
  const partner = id ? await controlDb().partner.findUnique({ where: { id }, select: { id: true, slug: true } }) : null;
  if (!partner) throw new PartnerRefused("That partner no longer exists.");
  const mask = await controlDb().$transaction(async (tx) => await writePayout(tx, partner.id, clean, actorOf(actor), now));
  await mailPayoutChanged(partner.id, mask);
  return { mask, partnerSlug: partner.slug };
}

/**
 * The full details, opened (console, PAYERS only — the action checks). Audited `payout.reveal`, and
 * the partner sees it in its activity log. The one place a payout cipher is ever selected.
 */
export async function revealPayout(partnerId: string, staff: Staff): Promise<PayoutDetails> {
  const id = cleanId(partnerId);
  const partner = id ? await controlDb().partner.findUnique({ where: { id }, select: { id: true, payoutCipher: true } }) : null;
  if (!partner) throw new PartnerRefused("That partner no longer exists.");
  if (!partner.payoutCipher) throw new PartnerRefused("No payout details on file for this partner.");
  const details = payoutFromJson(openForPartner(partner.id, "partner-payout", partner.payoutCipher));
  await partnerAudit(staffActor(staff), partner.id, "payout.reveal", "payout", partner.id, undefined, { visibleToPartner: true });
  return details;
}
