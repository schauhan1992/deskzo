import { computeLine } from "@/lib/gst-engine";
import type { ProRataResult } from "@/lib/subscriptions/proration";

/**
 * The add-on quote, written out for a customer.
 *
 * A salesperson works this out on the phone and then retypes it into an email, which is where the
 * figures drift: the tax gets rounded differently, the billable days get restated, and the customer
 * ends up with a number the invoice then contradicts. So the block is produced once, from the same
 * pro-rata result the order will use and the same `computeLine` every invoice is built from, and
 * copied verbatim.
 *
 * ## Two flavours, one clipboard
 *
 * `html` is what Gmail and Outlook paste — a two-column table, which is how this is meant to be
 * read. `text` is the same thing in plain lines, and it is not a lesser fallback: it is what lands
 * in WhatsApp, in a plain-text reply, and in anything that strips markup. Both are put on the
 * clipboard together so the receiving application picks whichever it can render.
 */

export type AddonQuoteInput = {
  productName: string;
  quantity: number;
  unit: string | null;
  /** When the new seats start, and when they expire with the parent. */
  from: Date | string;
  to: Date | string;
  /** A full term of one seat, before tax — the figure the pro-rata was worked out from. */
  baseUnitPrice: number;
  taxRatePercent: number;
  proRata: ProRataResult;
};

export type AddonQuote = {
  /** Per seat, before tax. */
  unitExclTax: number;
  /** For the whole quantity. */
  totalExclTax: number;
  taxAmount: number;
  totalInclTax: number;
  unitInclTax: number;
  text: string;
  html: string;
};

/**
 * Addressed to the team rather than to a named person.
 *
 * The quote is usually forwarded on — to a purchase manager, a finance contact, somebody who was
 * copied in — and a greeting naming the one person it was first sent to reads oddly to everybody
 * else who ends up looking at it. It also removes the way this goes most obviously wrong: the
 * wrong customer's name at the top of the right figures.
 */
const GREETING = "Dear Team,";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const day = (value: Date | string) => {
  const d = new Date(value);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
};

/**
 * Escapes anything that goes into the markup.
 *
 * Product names are data: "AT&T <Business>" would otherwise break the table, and the general rule
 * that data never reaches HTML unescaped is not worth making an exception to for a quote.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function addonQuote(input: AddonQuoteInput): AddonQuote {
  /**
   * The tax comes from `computeLine`, not from multiplying by the rate.
   *
   * It is the function every invoice line in this system is built from, and it rounds at the line
   * rather than on the total. Working the tax out here independently would produce a quote that is
   * a paisa or two from the invoice it turns into — which is precisely the discrepancy a purchase
   * manager queries, and it is unanswerable because both numbers look right.
   *
   * The supply type is intra-state so the two halves are computed; only their sum is quoted, since
   * a customer's question is "what do I pay", and whether that is CGST plus SGST or IGST depends on
   * where they are and does not change the total.
   */
  const line = computeLine(
    {
      quantity: input.quantity,
      unitPrice: input.proRata.unitPrice,
      taxRatePercent: input.taxRatePercent,
    },
    "INTRA_STATE",
  );

  const totalExclTax = line.taxableValue;
  const taxAmount = Math.round((line.cgstAmount + line.sgstAmount + line.igstAmount) * 100) / 100;
  const totalInclTax = Math.round((totalExclTax + taxAmount) * 100) / 100;
  const unitInclTax = input.quantity > 0 ? Math.round((totalInclTax / input.quantity) * 100) / 100 : 0;
  const unit = input.unit ?? "User";
  const validity = `${day(input.from)} to ${day(input.to)}`;
  const intro = `Please find below the add-on pricing for ${input.productName} for ${input.proRata.daysCharged} days.`;

  const text = [
    GREETING,
    "",
    intro,
    "",
    `Product: ${input.productName}`,
    `Quantity: ${input.quantity}`,
    `Validity: ${validity}`,
    `Total Period Days: ${input.proRata.fullTermDays}`,
    `Billable Days: ${input.proRata.daysCharged}`,
    `Base Amount / ${unit}: ${money(input.baseUnitPrice)}`,
    "",
    `${money(totalExclTax)} (Excl. Tax)`,
    `${money(taxAmount)} (${input.taxRatePercent}% GST)`,
    `${money(totalInclTax)} (Including Tax / Payable Amount)`,
    "",
    `${money(input.proRata.unitPrice)} (Per ${unit} Excl. Tax)`,
    `${money(unitInclTax)} (Per ${unit} Incl. Tax)`,
    "",
    "Regards,",
  ].join("\n");

  /**
   * Inline styles throughout, and a plain `<table>`.
   *
   * Every email client strips `<style>` blocks and most ignore classes, so anything not written on
   * the element itself is lost the moment this is pasted — which is the only place it is ever going
   * to be rendered. The same reason rules out flexbox and grid: a table is what survives Outlook.
   */
  const cell = "padding:8px 12px;border:1px solid #d9d9d9;vertical-align:top;font-family:Arial,Helvetica,sans-serif;font-size:13px;";
  const head = `${cell}background:#f3f4f6;font-weight:600;text-align:left;`;

  const html = [
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">${GREETING}</p>`,
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">${esc(intro)}</p>`,
    `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #d9d9d9;">`,
    "<tr>",
    `<th style="${head}">Product Details</th>`,
    `<th style="${head}">Pricing</th>`,
    "</tr>",
    "<tr>",
    `<td style="${cell}">`,
    `<strong>${esc(input.productName)}</strong><br>`,
    `Quantity: ${input.quantity}<br>`,
    `Validity: ${validity}<br>`,
    `Total Period Days: ${input.proRata.fullTermDays}<br>`,
    `Billable Days: ${input.proRata.daysCharged}<br>`,
    `Base Amount / ${esc(unit)}: ${money(input.baseUnitPrice)}`,
    "</td>",
    `<td style="${cell}">`,
    `${money(totalExclTax)} (Excl. Tax)<br>`,
    `${money(taxAmount)} (${input.taxRatePercent}% GST)<br>`,
    // The payable figure in bold, because it is the one line anybody actually reads.
    `<strong>${money(totalInclTax)} (Including Tax / Payable Amount)</strong><br><br>`,
    `${money(input.proRata.unitPrice)} (Per ${esc(unit)} Excl. Tax)<br>`,
    `${money(unitInclTax)} (Per ${esc(unit)} Incl. Tax)`,
    "</td>",
    "</tr>",
    "</table>",
    `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">Regards,</p>`,
  ].join("");

  return { unitExclTax: input.proRata.unitPrice, totalExclTax, taxAmount, totalInclTax, unitInclTax, text, html };
}
