import { DEVICE_COOKIE } from "@/lib/access/device-token";

/**
 * What the current request says about where it came from: the address, the browser, and the
 * device cookie.
 *
 * `next/headers` is imported inside the function rather than at the top, for the reason
 * src/lib/activity.ts gives: a static edge to it drags it into every bundle that reaches this file.
 * Outside a request — a script, a background job — everything is null rather than a throw.
 */
export type RequestFacts = {
  /** False outside a request — a script, a background job — where there is nobody at a door. */
  inRequest: boolean;
  ip: string | null;
  userAgent: string | null;
  mobileHint: string | null;
  deviceToken: string | null;
};

export async function requestFacts(): Promise<RequestFacts> {
  try {
    const { headers, cookies } = await import("next/headers");
    const [head, jar] = await Promise.all([headers(), cookies()]);
    return {
      inRequest: true,
      ip: head.get("x-forwarded-for")?.split(",")[0]?.trim() || head.get("x-real-ip") || null,
      userAgent: head.get("user-agent"),
      mobileHint: head.get("sec-ch-ua-mobile"),
      deviceToken: jar.get(DEVICE_COOKIE)?.value ?? null,
    };
  } catch {
    return { inRequest: false, ip: null, userAgent: null, mobileHint: null, deviceToken: null };
  }
}
