import { appRoute } from "@/lib/app/handler";
import { reportScreenshot } from "@/actions/dlp";

/**
 * A screenshot taken in the Deskzo app (owner, 18 Oct 2026): `{ screen }` — counted against the person's daily
 * allowance and told to the administrators exactly as one on the website is (src/actions/dlp.ts), with the
 * app's screen as the page. The answer says how many are left; at none, the app blocks them (src/lib/app/dlp.ts).
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ body, device }) => {
  const input = await body();
  const screen = typeof input.screen === "string" ? input.screen.replace(/[^\w/[\]-]/g, "").slice(0, 60) : "";
  const verdict = await reportScreenshot({ path: `Deskzo app on ${device.model ?? device.platform}${screen ? `: ${screen}` : ""}` });
  return { data: { allowed: verdict.allowed, remaining: verdict.remaining, enforced: verdict.enforced, message: verdict.reason } };
});
