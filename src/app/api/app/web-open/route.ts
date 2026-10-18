import { db } from "@/lib/db";
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, hashDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { safeAppPath } from "@/lib/app/paths";

/**
 * The app's page view opening Deskzo (owner, 18 Oct 2026): a form POST of what /api/app/web-session gave it.
 * Sets the phone's device cookie — so the pages are the phone in Security › Devices — and sends them to the
 * one-time pass's sign-in, or to the sign-in page for somebody with two-factor.
 *
 * Only as the app's own navigation: a form on another site posting here (to sign somebody's browser in as
 * somebody else) is refused by the browser's own Sec-Fetch-Site. The pass is spent by /handoff, not here.
 */

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "none" && site !== "same-origin") return new Response("Not allowed.", { status: 403 });

  const form = await req.formData().catch(() => null);
  const deviceToken = String(form?.get("d") ?? "");
  const ticket = String(form?.get("t") ?? "");
  const next = safeAppPath(String(form?.get("n") ?? "")) ?? "/dashboard";
  if (!validDeviceToken(deviceToken)) return new Response("Open Deskzo from the app again.", { status: 400 });

  // A device row that is a paired phone's — anything else is no cookie to set.
  const device = await db.userDevice.findFirst({ where: { tokenHash: hashDeviceToken(deviceToken), app: { isNot: null } }, select: { id: true } });
  if (!device) return new Response("Open Deskzo from the app again.", { status: 403 });

  const secure = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  const location = /^[A-Za-z0-9_-]{43}$/.test(ticket) ? `/handoff?t=${ticket}&n=${encodeURIComponent(next)}` : `/login?callbackUrl=${encodeURIComponent(next)}`;
  const res = new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  res.headers.append("set-cookie", `${DEVICE_COOKIE}=${deviceToken}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  return res;
}
