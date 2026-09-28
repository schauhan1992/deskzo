import { NextResponse, type NextRequest } from "next/server";
import { RENDER_PARAM, printPathDocumentId, verifyRenderToken } from "@/lib/documents/render-token";
import { edgeAuth } from "@/lib/auth-edge";
import { classifyUserAgent, isMachineEndpoint, shouldBlockBot, ROBOTS_HEADER } from "@/lib/security/bots";
import { permissionsPolicyFor } from "@/lib/security/headers";
import { getSecurityPolicy } from "@/lib/security/store";
import { recordBotHit } from "@/lib/security/bot-log";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { currentMaintenance, maintenanceAppName, maintenancePage, maintenanceVerdict, mayBypassMaintenance } from "@/lib/maintenance";
import { evaluateAccess } from "@/lib/access/gate";
import { clientIpFrom } from "@/lib/client-ip";
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE, newDeviceToken, validDeviceToken } from "@/lib/access/device-token";
import { HOST_MISMATCH, classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";
import { referralCookieDays } from "@/lib/partners/settings";
import { tenantForKind } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { billingHeldPage, noWorkspacePage, unavailableWorkspacePage } from "@/lib/tenancy/pages";
import { holdFor } from "@/lib/tenancy/hold";

/**
 * Served from the proxy while a restore is running, so it depends on nothing.
 *
 * Deliberately not a route, a layout or a component. Everything the application renders reaches the
 * database on the way — branding, the session, the nav — and the database is the one thing that is
 * unavailable at this moment. A string of HTML in the process that is already answering is the only
 * page guaranteed to be renderable, and it polls the status endpoint so the screen comes back by
 * itself rather than leaving somebody refreshing.
 */
const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Restoring — please wait</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
         background:#f6f7f9; color:#15181d; }
  @media (prefers-color-scheme: dark) { body { background:#15181d; color:#e8eaed; } }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; }
  p { margin:0 0 .5rem; opacity:.8; }
  code { font-size:.875rem; opacity:.7; }
</style></head>
<body><main>
  <h1>Restoring from a backup</h1>
  <p>The database is being replaced. The application is unavailable until that finishes.</p>
  <p><code id="s">checking…</code></p>
  <script>
    async function tick() {
      try {
        const r = await fetch('/api/backups/restore/status', { cache: 'no-store' });
        const d = await r.json();
        document.getElementById('s').textContent = d?.status?.message || 'working…';
        if (!d?.running) { location.reload(); return; }
      } catch { document.getElementById('s').textContent = 'working…'; }
      setTimeout(tick, 3000);
    }
    tick();
  </script>
</main></body></html>`;

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
/**
 * API paths answered on the platform's own address — the scheduled ticks, which fan out over every
 * workspace, and the billing gateways' webhooks.
 */
const PLATFORM_API = /^\/api\/(marketing\/tick|backup\/tick|platform\/tick|platform\/billing\/(stripe|razorpay))\/?$/;

/** The partner programme's first-touch referral cookie on the public site, and a referral code's shape (6–40 characters). */
const REFERRAL_COOKIE = "wroffy_ref";
const REFERRAL_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const PUBLIC_PREFIXES = ["/login", "/handoff", "/forgot-password", "/reset-password", "/join", "/review", "/preferences", "/forms", "/track", "/kiosk", "/portal"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The caller's address as our own proxy saw it, or null — src/lib/client-ip.ts. */
function clientIp(req: NextRequest): string | null {
  return clientIpFrom(req.headers);
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

const withSession = edgeAuth(async (req: NextRequest & { auth: unknown }) => {
  const { pathname } = req.nextUrl;

  // --- Which workspace ---------------------------------------------------------------------
  /**
   * Before anything that reads a database, because every database is some workspace's. The host
   * decides it, and only the host (src/lib/tenancy/host.ts); everything below — maintenance, the
   * security policy, the access gate — then runs as that workspace.
   *
   * A host that reaches no workspace gets a plain page saying so, not the sign-in screen of some
   * other customer. The platform's own hosts (the public site, the console) have nothing to show
   * yet and get the same page.
   */
  const host = requestHost(req.headers);
  if (host === HOST_MISMATCH) {
    return harden(new NextResponse("Misdirected request.", { status: 421, headers: { "content-type": "text/plain; charset=utf-8" } }) as NextResponse, pathname);
  }
  const kind = host ? classifyHost(host) : null;
  const tenant = kind ? await tenantForKind(kind) : null;
  const api = pathname === "/api" || pathname.startsWith("/api/");
  /**
   * The platform's own address (the bare domain, admin.) is no workspace, but the scheduled ticks are
   * called there to run for every workspace (src/lib/platform/fanout.ts). They authenticate
   * themselves with the operator's secret; nothing else is let through.
   */
  if (!tenant && api && (kind?.kind === "root" || kind?.kind === "console") && PLATFORM_API.test(pathname)) {
    return NextResponse.next();
  }
  if (!tenant && api) {
    // A machine asking the wrong address: a plain answer, not a page and not a stack trace.
    return NextResponse.json({ error: "No such workspace." }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  /**
   * The platform's own pages, each on its own address and nowhere else:
   *
   *   · the public site — signing up — on the bare domain and www., from src/app/platform-site;
   *   · the staff console on admin., from src/app/platform-console (its own sign-in —
   *     src/lib/platform/staff-session.ts; no workspace's session means anything there);
   *   · the website's CMS on cms., from src/app/platform-cms (its own accounts and sign-in —
   *     src/lib/cms/session.ts; neither a staff nor a workspace session means anything there). Server
   *     actions only: no /api path answers on it (the `!tenant && api` refusal above);
   *   · the partner portal on partners., from src/app/platform-partners (its own accounts and sign-in —
   *     src/lib/partners/session.ts; no staff, CMS or workspace session means anything there). Server
   *     actions only, like the CMS: no /api path answers on it either.
   *
   * None reads a workspace's data. Their folders answer on no other address, so a workspace's host
   * can never serve the console, the CMS or the portal, nor their hosts a workspace.
   */
  const inPlatformFolder = /^\/platform-(site|console|cms|partners)(\/|$)/.test(pathname);
  const platformFolder =
    kind?.kind === "root"
      ? "/platform-site"
      : kind?.kind === "console"
        ? "/platform-console"
        : kind?.kind === "cms"
          ? "/platform-cms"
          : kind?.kind === "partners"
            ? "/platform-partners"
            : null;
  if (!tenant && platformFolder && !inPlatformFolder) {
    // The public site's sitemap is src/app/sitemap.ts, at the root like robots.txt — not in the folder.
    if (platformFolder === "/platform-site" && pathname === "/sitemap.xml") return harden(NextResponse.next() as NextResponse, pathname);
    const url = req.nextUrl.clone();
    url.pathname = `${platformFolder}${pathname === "/" ? "" : pathname}`;
    /**
     * The media library's images, on the CMS host too: the CMS's editor previews blocks with the
     * site's own components, whose images are "/media/<id>". Served by the public site's image route
     * (src/app/platform-site/media/[id]/route.ts) — the same public bytes, nothing of the CMS's.
     */
    if (platformFolder === "/platform-cms" && /^\/media\/[a-z0-9]{20,40}$/.test(pathname)) url.pathname = `/platform-site${pathname}`;
    const response = harden(NextResponse.rewrite(url) as NextResponse, pathname);
    if (platformFolder === "/platform-console" || platformFolder === "/platform-cms" || platformFolder === "/platform-partners") response.headers.set("cache-control", "no-store");
    /**
     * The public website exists to be found, so its pages may be indexed — except signing up, a
     * draft's preview (its address carries a token, and it is not published), and any address with a
     * query, which may carry a code or a token (and is otherwise a variant of a page that has its own
     * canonical address). Every other host keeps harden()'s noindex.
     */
    const preview = /^\/preview(\/|$)/.test(pathname);
    if (platformFolder === "/platform-site" && preview) response.headers.set("cache-control", "no-store");
    if (platformFolder === "/platform-site" && !preview && !/^\/signup(\/|$)/.test(pathname) && !req.nextUrl.search) {
      response.headers.set("X-Robots-Tag", "index, follow");
    }
    /**
     * The partner programme's referral cookie — off unless an owner sets partners.refCookieDays
     * (spec D8: the site promises no tracking cookies by default). A public-site GET with a
     * well-formed `?ref=` and no `wroffy_ref` yet gets one; the first touch wins and is never
     * overwritten while present. Without a `ref` nothing is read, so every other request costs
     * nothing; the setting is cached for a minute. Only the code's shape is checked here — the signup
     * page validates it, and prefers the address's own `ref` over the cookie.
     */
    if (platformFolder === "/platform-site" && req.method === "GET" && kind) {
      const ref = req.nextUrl.searchParams.get("ref");
      if (ref && ref.length >= 6 && ref.length <= 40 && REFERRAL_CODE.test(ref) && !req.cookies.has(REFERRAL_COOKIE)) {
        const days = await referralCookieDays();
        if (days > 0) {
          response.cookies.set(REFERRAL_COOKIE, ref, { httpOnly: true, sameSite: "lax", secure: protocolFor(kind.host) === "https", path: "/", maxAge: days * 86_400 });
        }
      }
    }
    return response;
  }
  if (inPlatformFolder) {
    return harden(new NextResponse("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) as NextResponse, pathname);
  }
  if (!tenant) {
    return harden(
      new NextResponse(noWorkspacePage(host), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }) as NextResponse,
      pathname,
    );
  }
  /**
   * A workspace being set up, held, mid-migration or closed is not served — not its pages and not its
   * API. The console runs migrations and provisioning as the workspace explicitly, never through here.
   */
  /**
   * Held for billing, not by staff: signing in and the billing page stay open, so its owner can pay
   * and open it again themselves (src/lib/tenancy/hold.ts). Nothing else — no other page, no API, no
   * scheduled work.
   */
  const hold = holdFor(tenant, pathname);
  if (hold !== "open") {
    if (api) return NextResponse.json({ error: "This workspace is unavailable." }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
    return harden(
      new NextResponse(hold === "billing-notice" ? billingHeldPage(tenant.name) : unavailableWorkspacePage(tenant.name), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "60" },
      }) as NextResponse,
      pathname,
    );
  }
  /**
   * API routes are only asked *which workspace*. Everything below — the session, the crawler block,
   * maintenance, the access gate — is for pages: the cron jobs, webhooks, the lead API and the
   * maintenance status endpoint authenticate themselves and must keep answering while pages are held.
   */
  if (api) return NextResponse.next();
  // A session counts only in the workspace that issued it (its cookie also only decrypts there).
  const sessionTenant = (req.auth as { user?: { tid?: string } } | null)?.user?.tid;
  if (req.auth && sessionTenant !== tenant.id) req.auth = null;
  return runAsTenant(tenant, () => handle(req, pathname, tenant));
});

/**
 * The proxy itself. `edgeAuth` is configured per request (the session secret is the workspace's own —
 * src/lib/auth-session.ts), and a per-request NextAuth hands back its wrapped handler as a promise,
 * which Next does not accept as the export. So the export is a plain function that waits for it.
 */
export default async function proxy(...args: Parameters<Awaited<typeof withSession>>) {
  const handler = await withSession;
  return handler(...args);
}

async function handle(req: NextRequest & { auth: unknown }, pathname: string, tenant: Tenant): Promise<NextResponse> {

  // --- 0. Maintenance ----------------------------------------------------------------------
  /**
   * Before everything, including the session check.
   *
   * While a restore runs, the schema this application reads from is being dropped and rebuilt.
   * Every page below would query a database whose tables are disappearing, and the error boundary
   * each of those hits is not a better answer than a page that says what is happening. Even the
   * login page: a sign-in is a database read like any other, and one that fails halfway through a
   * restore looks like a broken password rather than a machine that is busy.
   *
   * This is two syscalls, not a query — the lock is a file precisely so that it can be checked when
   * the database cannot. `/api` is outside the matcher, which is what keeps the status endpoint the
   * screen polls reachable while everything else is held here.
   */
  if (restoreInProgressFor(tenant)) {
    return harden(
      new NextResponse(MAINTENANCE_PAGE, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "retry-after": "30" },
      }) as NextResponse,
      pathname,
    );
  }

  // --- 0a. The server printing a document for an email --------------------------------------
  /**
   * The server's own headless browser, fetching one document's print page to make the PDF attached
   * to an email — see src/lib/documents/render-grant.ts. It has no session and a headless browser's
   * user agent, so everything below would turn it away. It carries a pass instead, minted moments
   * ago by the send action for this document: signed by this installation, bound to this path, two
   * minutes old at most. Only the signature and the date are checked here; the page spends the pass,
   * so it works once, and renders nothing if it doesn't.
   *
   * Nothing else is let through by this: any other path, any other document, or a missing, forged or
   * stale pass falls through to the checks below exactly as before.
   */
  const renderingDocument = printPathDocumentId(pathname);
  if (renderingDocument && (await verifyRenderToken(req.nextUrl.searchParams.get(RENDER_PARAM), renderingDocument))) {
    const response = harden(NextResponse.next() as NextResponse, pathname);
    // A pass is in the address, so the page must be neither cached nor sent anywhere as a referrer.
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }

  // --- 0b. Maintenance mode ----------------------------------------------------------------
  /**
   * Planned downtime an admin switched on — see src/lib/maintenance.ts. Unlike the restore above,
   * the database is fine, so whoever may change settings carries on and everybody else is held
   * here. A cached read, not a query per request.
   */
  const maintenance = await currentMaintenance();
  if (maintenance.phase === "on" && !isMachineEndpoint(pathname)) {
    const userId = (req.auth as { user?: { id?: string } } | null)?.user?.id ?? null;
    const verdict = await maintenanceVerdict({ pathname, userId, state: maintenance, mayBypass: mayBypassMaintenance });
    if (verdict === "hold") {
      const retryAfter = maintenance.endsAt ? Math.max(60, Math.round((maintenance.endsAt.getTime() - Date.now()) / 1000)) : 300;
      return harden(
        new NextResponse(maintenancePage(maintenance, await maintenanceAppName()), {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8", "retry-after": String(retryAfter), "cache-control": "no-store" },
        }) as NextResponse,
        pathname,
      );
    }
  }

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

  // --- 3. Where and on what ---------------------------------------------------------------
  /**
   * The device cookie, issued to a browser the first time it reaches the sign-in screen or a
   * signed-in page — and never on the public customer pages, which have no business carrying a
   * tracking cookie. See src/lib/access/device-token.ts.
   */
  const presented = req.cookies.get(DEVICE_COOKIE)?.value;
  const hasDevice = validDeviceToken(presented);
  const issued = !hasDevice && (isLoggedIn || isLoginPage) ? newDeviceToken() : null;
  const deviceToken = hasDevice ? presented! : issued;
  const withDevice = (response: NextResponse): NextResponse => {
    if (issued) {
      response.cookies.set(DEVICE_COOKIE, issued, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
        path: "/",
        maxAge: DEVICE_COOKIE_MAX_AGE,
      });
    }
    return response;
  };

  if (isLoggedIn && isLoginPage) {
    return withDevice(harden(NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin)), pathname));
  }

  /**
   * The access gate, for every signed-in page and action — see src/lib/access/gate.ts. Anything it
   * holds is sent to /access, which says why and, where there is something the person can do (share
   * a location, wait for an approval), lets them do it. /access itself is never gated, or a held
   * person could not be told why.
   */
  const onAccessPage = pathname === "/access" || pathname.startsWith("/access/");
  const sessionUser = (req.auth as { user?: { id?: string; sid?: string } } | null)?.user;
  if (isLoggedIn && sessionUser?.id && !isPublicPath(pathname) && !onAccessPage) {
    const verdict = await evaluateAccess({
      userId: sessionUser.id,
      sid: sessionUser.sid ?? null,
      deviceToken,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      mobileHint: req.headers.get("sec-ch-ua-mobile"),
      path: pathname,
    });
    if (!verdict.ok) {
      const access = new URL("/access", req.nextUrl.origin);
      access.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
      return withDevice(harden(NextResponse.redirect(access), pathname));
    }
  }

  // --- 4. Onward ---------------------------------------------------------------------------
  // Forwarded so the dashboard layout can tell it's already rendering /profile (and skip its own
  // force-redirect check) without an extra DB round trip, and so the activity log can record where
  // an event happened without every call site passing it.
  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  // A cookie issued on this response is also handed to this request, so the page rendering now can
  // already see the device it is being rendered for.
  if (issued) headers.set("cookie", [req.headers.get("cookie"), `${DEVICE_COOKIE}=${issued}`].filter(Boolean).join("; "));
  return withDevice(harden(NextResponse.next({ request: { headers } }), pathname));
}

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
  // /api is in, but only for the workspace check above; /iclock stays out until devices are routed
  // by serial number (a terminal is often configured with a bare IP that names no workspace).
  matcher: ["/((?!iclock|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
