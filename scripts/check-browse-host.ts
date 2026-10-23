/**
 * check:browse-host — one address to use (src/lib/tenancy/browse-host.ts; owner, 23 Oct 2026): a person's browser
 * opening a page on a workspace's own subdomain is sent to its primary custom domain, and nothing else is.
 *
 *   · Chrome, Safari or an older browser opening a page — signed out or in, with its query string — is sent on,
 *     with a temporary redirect; HEAD too.
 *   · Kept where it is: a form's POST, /api (the app, the public API, webhooks, sign-in callbacks), a script's
 *     fetch or a prefetch, a client that doesn't ask for a page, the Deskzo app's page view (an Android web view),
 *     the server's PDF printer, the service worker and /.well-known files, and a request already on the custom
 *     domain or on another address.
 *   · Only while the primary checks out: none made primary, or one that has started failing, sends nobody.
 *   · The registry reads whether an address is failing, the proxy asks before the session, and Settings says so.
 *
 *   npm run check:browse-host
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { browseHostOf, browseRedirect, type BrowseRequest } from "../src/lib/tenancy/browse-host";

const ROOT = path.join(__dirname, "..");
let failures = 0;
let passes = 0;
function ok(label: string, cond: unknown, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(` FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const section = (name: string) => console.log(`\n— ${name} —\n`);

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WEBVIEW = "Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UE1A.230829.050; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
const HEADLESS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";

const navigate = (agent = CHROME) => new Headers({ "user-agent": agent, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml" });
const base: BrowseRequest = { host: "acme.deskzo.com", onSubdomain: true, browseHost: "crm.acme.com", method: "GET", pathname: "/leads", search: "?view=mine", headers: navigate() };
const to = (over: Partial<BrowseRequest>) => browseRedirect({ ...base, ...over });

section("Sent on");
ok("Chrome opening a page on the subdomain: the same page on the primary, query string and all", to({}) === "https://crm.acme.com/leads?view=mine", to({}));
ok("Safari on an iPhone, likewise", to({ headers: navigate(SAFARI) }) === "https://crm.acme.com/leads?view=mine");
ok("an older browser without Sec-Fetch headers asking for a page", to({ headers: new Headers({ "user-agent": CHROME, accept: "text/html" }) }) === "https://crm.acme.com/leads?view=mine");
ok("the sign-in page, so somebody signed out signs in on the primary", to({ pathname: "/login", search: "?callbackUrl=%2Fleads" }) === "https://crm.acme.com/login?callbackUrl=%2Fleads");
ok("a one-time sign-in link (its ticket is the workspace's, not the address's)", to({ pathname: "/handoff", search: "?t=abc" }) === "https://crm.acme.com/handoff?t=abc");
ok("HEAD too", to({ method: "HEAD" }) !== null);

section("Kept where it is");
ok("a form's POST", to({ method: "POST" }) === null);
ok("/api — the app, the public API, webhooks, sign-in callbacks", to({ pathname: "/api/app/today" }) === null && to({ pathname: "/api/auth/callback/microsoft-entra-id" }) === null);
ok("Next's own files", to({ pathname: "/_next/static/chunks/main.js" }) === null);
ok("a script's fetch or a prefetch (not a navigation)", to({ headers: new Headers({ "user-agent": CHROME, "sec-fetch-mode": "cors", accept: "*/*" }) }) === null);
ok("a client that doesn't ask for a page (a link checker, a device)", to({ headers: new Headers({ "user-agent": "curl/8.4", accept: "*/*" }) }) === null);
ok("the Deskzo app's page view (an Android web view) — it would open the primary in the phone's browser", to({ headers: navigate(WEBVIEW) }) === null);
ok("the server's PDF printer (headless Chrome)", to({ headers: navigate(HEADLESS) }) === null);
ok("the service worker's script and /.well-known files", to({ pathname: "/sw.js", search: "" }) === null && to({ pathname: "/.well-known/microsoft-officeaddins-allowed.json", search: "" }) === null);
ok("a request already on the primary", to({ host: "crm.acme.com", onSubdomain: false }) === null);
ok("another of the workspace's addresses (not its subdomain)", to({ host: "erp.acme.com", onSubdomain: false }) === null);

section("Only while the primary checks out");
ok("no primary: nobody is sent anywhere", to({ browseHost: null }) === null && to({ browseHost: undefined }) === null);
ok("browseHostOf: the primary while it passes", browseHostOf([{ host: "erp.acme.com", isPrimary: false, failingSince: null }, { host: "crm.acme.com", isPrimary: true, failingSince: null }]) === "crm.acme.com");
ok("…none once it has started failing (the subdomain serves meanwhile)", browseHostOf([{ host: "crm.acme.com", isPrimary: true, failingSince: new Date() }]) === null);
ok("…none without a primary", browseHostOf([{ host: "crm.acme.com", isPrimary: false, failingSince: null }]) === null);
ok("a custom domain tried locally (.test) is sent to over http", browseRedirect({ ...base, browseHost: "erp.acme.test:3000" })?.startsWith("http://erp.acme.test:3000/") === true);

section("Wired in");
const registry = readFileSync(path.join(ROOT, "src", "lib", "tenancy", "registry.ts"), "utf8");
ok("the registry reads whether each live address is failing, and works out browseHost", /select: \{ host: true, isPrimary: true, failingSince: true \}/.test(registry) && /browseHost: browseHostOf\(row\.domains\)/.test(registry));
const proxy = readFileSync(path.join(ROOT, "src", "proxy.ts"), "utf8");
const apiPass = proxy.indexOf("if (api) return NextResponse.next();");
const asked = proxy.indexOf("browseRedirect({");
const session = proxy.indexOf("const sessionTenant =");
ok("the proxy asks after /api has gone through and before the session is looked at", apiPass > 0 && asked > apiPass && session > asked, { apiPass, asked, session });
ok("…with a temporary redirect browsers don't keep", /NextResponse\.redirect\(browseTo, \{ status: 307/.test(proxy));
ok("…only for the workspace's own subdomain", /onSubdomain: kind\?\.kind === "tenant"/.test(proxy));
const settings = readFileSync(path.join(ROOT, "src", "components", "settings", "domain-settings.tsx"), "utf8");
ok("Settings › Domain says making it primary sends browsers there, and what stays", /is sent to/.test(settings) && /keep using/.test(settings));

console.log(failures ? `\n${failures} check(s) FAILED (${passes} passed).` : `\nAll ${passes} browse-host checks passed.`);
process.exit(failures ? 1 : 0);
