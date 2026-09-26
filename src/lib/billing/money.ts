/**
 * An amount in a currency's smallest unit (paise, cents — as the gateways keep it) written out for
 * people: ₹1,499.00, $29.00, ¥3,000. A currency without minor units is not divided by a hundred.
 */
export function formatMoney(minorUnits: number, currency: string): string {
  const code = currency.toUpperCase();
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(code === "INR" ? "en-IN" : "en", { style: "currency", currency: code });
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${code}`;
  }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minorUnits / 10 ** digits);
}
