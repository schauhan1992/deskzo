import { NextResponse, type NextRequest } from "next/server";
import { edgeAuth } from "@/lib/auth-edge";
import { classifyUserAgent, isMachineEndpoint, shouldBlockBot, ROBOTS_HEADER } from "@/lib/security/bots";
import { permissionsPolicyFor } from "@/lib/security/headers";
import { getSecurityPolicy } from "@/lib/security/store";
import { recordBotHit } from "@/lib/security/bot-log";

/**
 * Renamed from `middleware.ts`: Next 16 deprecates that convention in favour of `proxy`, and runs
 * it on the Node runtime by default rather than the Edge one. That change is what makes the policy
 * lookup below possible at all — `auth-edge.ts` exists precisely because Prisma could not run here
 * before.
 *
 * Three jobs, in order, and the order matters:
 *
 *   1. Turn away crawlers — before authentication, so a crawler hitting a page that needs no login
 *      is still refused.
 *   2. Require a session for everything that is not a public customer edge.
 *   3. Mark every response as not-for-indexing, not-for-training.
 */

/**
 * Reachable with no account, because the person on the other end does not have one.
 *
 * Each of these authenticates by a one-time or long-lived token instead — see
 * `src/actions/feedback-public.ts` and `src/actions/intake.ts` for what that does and does not
 * grant. Bouncing a customer to a sign-in they can never pass would make the link useless, which
 * is why an unsubscribe link behind a login is not an unsubscribe link.
 */
const PUBLIC_PREFIXES = ["/login", "/join", "/review", "/preferences", "/forms", "/track", "/kiosk", "/portal"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Behind a proxy `x-forwarded-for` is a list whose first entry is the client; behind nothing it is
 * absent, and null is the right answer rather than the load balancer's address recorded as if it
 * were a user's.
 */
function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip") ?? null;
}

/** Applied to everything that leaves here, including redirects. */
function harden(response: NextResponse, pathname: string): NextResponse {
  response.headers.set("X-Robots-Tag", ROBOTS_HEADER);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Referrer-Policy", "no-referrer");
  // Nothing in an ERP needs a microphone or a location, and saying so means a compromised dependency
  // cannot quietly ask for one. The camera is the single exception — see `permissionsPolicyFor`.
  response.headers.set("Permissions-Policy", permissionsPolicyFor(pathname));
  return response;
}

export default edgeAuth(async (req: NextRequest & { auth: unknown }) => {
  const { pathname } = req.nextUrl;

  // --- 1. Crawlers -------------------------------------------------------------------------
  // Machine endpoints are exempt and must stay that way: the eSSL biometric terminals post to
  // /iclock with firmware user agents that look nothing like a browser, and the marketing cron and
  // provider webhooks are no different. Blocking those would stop attendance uploads and the
  // firmware would retry forever. They authenticate by registered serial and shared secret.
  if (!isMachineEndpoint(pathname)) {
    const verdict = classifyUserAgent(req.headers.get("user-agent"));
    if (verdict) {
      const policy = await getSecurityPolicy();
      const blocking = shouldBlockBot(verdict, policy) && policy.botMode === "BLOCK";

      if (shouldBlockBot(verdict, policy)) {
        // Awaited, but almost always a map lookup: `recordBotHit` writes the first sighting of a
        // given address and agent and folds the rest of the window into the next row. Without that
        // throttle, a crawler that ignores the 403 turns this log into a denial of service against
        // our own database.
        await recordBotHit({ verdict, path: pathname, ipAddress: clientIp(req), blocked: blocking });
      }

      if (blocking) {
        return harden(
          new NextResponse("Not available to automated clients.", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }) as NextResponse,
          pathname,
        );
      }
      // Log-only mode falls through deliberately: an admin working out what is hitting the site
      // needs to see it arrive before deciding to turn it away.
    }
  }

  // --- 2. Session --------------------------------------------------------------------------
  const isLoggedIn = !!req.auth;
  const isLoginPage = pathname.startsWith("/login");

  if (!isLoggedIn && !isPublicPath(pathname)) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return harden(NextResponse.redirect(loginUrl), pathname);
  }

  if (isLoggedIn && isLoginPage) {
    return harden(NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin)), pathname);
  }

  // --- 3. Onward ---------------------------------------------------------------------------
  // Forwarded so the dashboard layout can tell it's already rendering /profile (and skip its own
  // force-redirect check) without an extra DB round trip, and so the activity log can record where
  // an event happened without every call site passing it.
  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  return harden(NextResponse.next({ request: { headers } }), pathname);
});

export const config = {
  /**
   * Wider than the matcher this replaced, and deliberately so.
   *
   * The old one excluded the public customer routes entirely, which meant the one part of the app
   * a crawler could actually reach without a password — a feedback form, a preference centre, an
   * inbound form, each carrying a customer's details behind a token in the URL — was the one part
   * with nothing in front of it. They are still exempt from *authentication* (see
   * `PUBLIC_PREFIXES`); they are no longer exempt from the crawler check.
   *
   * `api` and `iclock` stay out altogether — see the note above about the biometric terminals.
   *
   * `robots.txt` is excluded for a reason that is easy to get backwards: it is the one URL a
   * crawler *must* be able to fetch. Inside the matcher it gets the crawler block, or failing that
   * a redirect to a sign-in page — either way the polite crawlers, the ones that would have read
   * "Disallow: /" and gone away, never see the instruction. Serving it freely is what makes
   * blocking those crawlers unnecessary in the first place.
   */
  matcher: ["/((?!api|iclock|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
