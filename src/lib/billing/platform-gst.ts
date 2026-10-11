/**
 * GST on Deskzo's own subscriptions, sold in India through Razorpay (owner, 11 Oct 2026: launch in
 * India). Prices are listed before GST, as Indian businesses expect: they claim it back. Razorpay
 * charges exactly a plan's amount, adding nothing, so the plan made there carries the GST, and an
 * invoice's tax is the GST inside what was charged — never the payment's `tax`, which is GST on
 * Razorpay's own fee.
 *
 * 18% is the rate for software as a service (SAC 9983) — for the company's CA to confirm, with its
 * GSTIN on the invoices. Pure: the pricing pages say the same.
 */

export const PLATFORM_GST_PERCENT = 18;

/** What Razorpay charges for an amount before GST, in paise. */
export const withPlatformGst = (paise: number): number => Math.round((paise * (100 + PLATFORM_GST_PERCENT)) / 100);

/** The GST inside an amount charged, in paise. */
export const platformGstIn = (chargedPaise: number): number => Math.round((chargedPaise * PLATFORM_GST_PERCENT) / (100 + PLATFORM_GST_PERCENT));
