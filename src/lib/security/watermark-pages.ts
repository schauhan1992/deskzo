/**
 * The pages that show customers' details — where the watermark goes when a workspace keeps it to them
 * (SecurityPolicy.watermarkScope, the default; owner, 2 Oct 2026). Elsewhere — the dashboard, settings,
 * a person's own tasks and notes — it is only in the way.
 *
 * Why not "only while a screenshot is taken": no browser is told one is being taken. Windows' Snipping
 * Tool, a Mac's shortcuts, recording apps and a phone camera never reach the page, and the PrintScreen
 * key arrives after the picture exists. A watermark that waited would never be in the picture.
 *
 * A prefix covers its record pages too: /companies covers /companies/123.
 */
export const CUSTOMER_DATA_PATHS = [
  "/accounting",
  "/calls",
  "/collections",
  "/companies",
  "/contacts",
  "/customer-portal",
  "/customer-requests",
  "/customers",
  "/documents",
  "/feedback",
  "/forecast",
  "/leads",
  "/logistics",
  "/mail-log",
  "/marketing",
  "/orders",
  "/payables",
  "/payments",
  "/projects",
  "/purchase",
  "/receivables",
  "/renewals",
  "/reports",
  "/resellers",
  "/sales",
  "/surveys",
  "/tickets",
  "/vendors",
  "/verifications",
  "/visits",
] as const;

export function showsCustomerData(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return CUSTOMER_DATA_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
