/**
 * check:domains — a workspace at an address of its own (src/lib/platform/domains.ts and
 * domain-rules.ts, Settings › Domain, Workspace 360's Domains panel).
 *
 * Against the local control plane, with scratch workspaces, plans and staff of its own (prefix
 * "zzdom", removed at the end, pass or fail) and the workspace pages run against the local workspace
 * database as one of them:
 *
 *   · what an address typed becomes, and every refusal, in words; the bare-domain warning;
 *   · what DNS answered, judged — and that production never skips asking it;
 *   · the allowance: none, one, a staff override, no limit; an add-on without a number adds nothing;
 *   · two workspaces waiting on one address: the first to prove it gets it, the other's row goes —
 *     and the unique-index race is "taken";
 *   · verified, primary, failing, stopped after 72 hours, working again — and the registry serving
 *     only live addresses, links falling back to the subdomain;
 *   · the daily sweep: re-checks, 14-day expiry, the owner told once per episode, never by a check;
 *   · Settings › Domain: the owner's alone, never while viewing as somebody, closed by the switch,
 *     rendered in each state (HTML saved to $CHECK_DOMAINS_RENDERS when it is set);
 *   · the console's role gates, audit entries and limit override;
 *   · the Security page listing a redirect address for every live address.
 *
 * DNS is a stub (no lookup leaves the machine), and so is the platform mailer (no mail is sent).
 * No password is typed anywhere — the staff are made here, signed in by a session row.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
const MEMBER_EMAIL = "member@zzdom.example";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ─── A request: the console's cookie, and whoever is signed in to the workspace ────────────────
let consoleToken: string | null = null;
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:domains" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    // Only the console's own cookie, under whatever name the console asks for it by.
    const get = (name: string) => (consoleToken && name.includes("console") ? { name, value: consoleToken } : undefined);
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({ get, getAll: () => [], has: (name: string) => !!get(name), set() {}, delete() {} }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      permanentRedirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/domain",
      useSearchParams: () => new URLSearchParams(),
      useParams: () => ({}),
    };
  }
  if (request === "@/lib/auth") {
    const session = async () => (actor ? { user: { ...actor, sid: null } } : null);
    return { auth: session, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  // The workspace's sign-in as `actor`, "viewing as" somebody when `viewingAs` says so.
  if (request === "@/lib/session") {
    class UnauthorizedError extends Error {}
    const viewAs = async () => (viewingAs && actor ? { actor: { id: actor.id, name: actor.name }, user: actor } : null);
    return {
      UnauthorizedError,
      requireUser: async () => {
        if (!actor) throw new UnauthorizedError("You must be signed in to do this.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: viewAs,
      refuseWhileViewingAs: async () => ((await viewAs()) ? "Switch back to your own account first." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;
/** Renders a server page, awaiting the async components inside it (see scripts/check-item-import.ts). */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
async function render(page: Page): Promise<string> {
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
const RENDERS = process.env.CHECK_DOMAINS_RENDERS?.trim() || null;
function saveRender(name: string, html: string) {
  if (!RENDERS) return;
  mkdirSync(RENDERS, { recursive: true });
  writeFileSync(path.join(RENDERS, `${name}.html`), `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${html}\n`, "utf8");
}

// ─── DNS, stubbed ────────────────────────────────────────────────────────────────────────────────
const dns = {
  txt: new Map<string, string[][]>(),
  cname: new Map<string, string[]>(),
  a: new Map<string, string[]>(),
  aaaa: new Map<string, string[]>(),
  slow: new Set<string>(),
  calls: [] as string[],
};
const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
function answer<T>(kind: string, map: Map<string, T>, name: string): T {
  dns.calls.push(`${kind} ${name}`);
  if (dns.slow.has(name)) throw dnsError("ETIMEOUT");
  const found = map.get(name);
  if (found === undefined) throw dnsError(kind === "TXT" ? "ENOTFOUND" : "ENODATA");
  return found;
}
const fakeResolver = {
  resolveTxt: async (name: string) => answer("TXT", dns.txt, name),
  resolveCname: async (name: string) => answer("CNAME", dns.cname, name),
  resolve4: async (name: string) => answer("A", dns.a, name),
  resolve6: async (name: string) => answer("AAAA", dns.aaaa, name),
};
/** The records an address needs, as its owner would create them. */
function publish(host: string, token: string | null, target: string) {
  if (token) dns.txt.set(`_domain-verify.${host}`, [[`domain-verify=${token}`]]);
  dns.cname.set(host, [target]);
}
function unpublish(host: string) {
  dns.txt.delete(`_domain-verify.${host}`);
  dns.cname.delete(host);
  dns.a.delete(host);
  dns.aaaa.delete(host);
}

async function main() {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl || !process.env.DATABASE_URL || !process.env.PLATFORM_MASTER_KEY) throw new Error("CONTROL_DATABASE_URL, DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const local = (u: string) => ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(u).hostname);
  if (!local(controlUrl) || !local(process.env.DATABASE_URL)) throw new Error("check:domains runs against local databases only.");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/platform/domain-rules") as typeof import("../src/lib/platform/domain-rules");
  const domains = require("../src/lib/platform/domains") as typeof import("../src/lib/platform/domains");
  const hostLib = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
  const entRules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");

  domains.setTestDomainResolver(fakeResolver);
  const dev = { production: false, platformDomain: "localhost" };
  const prod = { production: true, platformDomain: "platform.example" };
  const norm = (input: unknown, r = dev) => rules.normaliseHost(input, r);
  const hostOf = (input: unknown, r = dev) => {
    const n = norm(input, r);
    return n.ok ? n.host : `REFUSED: ${n.error}`;
  };
  const refusedWith = (input: unknown, pattern: RegExp, r = dev) => {
    const n = norm(input, r);
    return !n.ok && pattern.test(n.error);
  };

  section("What an address typed becomes");
  ok("a pasted link is its host, in lower case", hostOf("https://ERP.Acme.com/path?x=1") === "erp.acme.com", hostOf("https://ERP.Acme.com/path?x=1"));
  ok("  spaces and a trailing dot go", hostOf("  erp.acme.com.  ") === "erp.acme.com");
  ok("  an international name becomes its ASCII form", hostOf("bücher.example") === "xn--bcher-kva.example", hostOf("bücher.example"));
  ok("an IP address is refused, in words", refusedWith("1.2.3.4", /IP address/) && refusedWith("http://10.0.0.1:8080/x", /IP address/) && refusedWith("[::1]", /IP address/));
  ok("a single word is refused", refusedWith("erp", /whole address/));
  ok("a part over 63 characters is refused", refusedWith(`${"a".repeat(64)}.acme.com`, /63 characters/));
  ok("a whole over 253 is refused", refusedWith(Array.from({ length: 5 }, () => "a".repeat(60)).join("."), /253/));
  ok("odd characters are refused", refusedWith("erp_acme.com", /letters, digits/) && refusedWith("*.acme.com", /letters, digits/));
  ok("empty is asked for", refusedWith("   ", /Type the address/) && refusedWith(null, /Type the address/));
  ok("the platform's domain and everything under it are refused", refusedWith("platform.example", /platform's own/, prod) && refusedWith("acme.platform.example", /platform's own/, prod) && refusedWith("erp.acme.platform.example", /platform's own/, prod));
  ok("  in development too: nothing under localhost", refusedWith("erp.zz-acme.localhost:3000", /platform's own/));
  ok("a port: refused in production, kept in development", refusedWith("erp.acme.com:8443", /port/, prod) && hostOf("erp.acme.com:8443") === "erp.acme.com:8443");
  ok(
    "private names are refused in production",
    refusedWith("app.localhost", /private network/, prod) && refusedWith("erp.acme.local", /private network/, prod) && refusedWith("erp.acme.internal", /private network/, prod) && refusedWith("erp.acme.test", /private network/, prod),
  );
  ok("  and allowed in development, where .test is how it is tried", hostOf("erp.acme.local") === "erp.acme.local" && hostOf("erp.zz-acme.test:3000") === "erp.zz-acme.test:3000");
  ok("a bare domain is told apart", rules.isApex("acme.com") && rules.isApex("acme.co.in") && !rules.isApex("erp.acme.com") && !rules.isApex("erp.acme.co.in") && (norm("acme.com") as { apex: boolean }).apex === true);
  ok("the dev test host is not read as a platform subdomain", hostLib.classifyHost("erp.zz-acme.test:3000").kind === "other");
  ok("  while one under localhost would be (so it is not the one used)", hostLib.classifyHost("erp.zz-acme.localhost:3000").kind !== "other");
  ok("  and is served over http in development, so its session cookie sticks", hostLib.protocolFor("erp.zz-acme.test:3000") === "http" && hostLib.protocolFor("erp.acme.com") === "https");

  section("What DNS said, judged");
  const T = "zzdom-a.localhost";
  const judged = (lookups: import("../src/lib/platform/domain-rules").Lookups, token: string | null = "tok") => rules.judgeRecords("erp.acme.com", token, T, lookups);
  const found = (...values: string[]) => ({ found: values });
  const none = { missing: true as const };
  let j = judged({ txt: found("domain-verify=tok"), cname: found(`${T}.`) });
  ok("the TXT value and the CNAME to the workspace's own address pass", j.txtOk && j.routeOk && j.problems.length === 0, j);
  j = judged({ txt: none, cname: none, a: none, aaaa: none, targetA: none, targetAaaa: none });
  ok("nothing there: two problems, in words", !j.txtOk && !j.routeOk && j.problems.includes("No TXT record found at _domain-verify.erp.acme.com") && j.problems.some((p) => p.startsWith("No CNAME record found at erp.acme.com")), j.problems);
  j = judged({ txt: found("domain-verify=other"), cname: found("x.y"), a: found("9.9.9.9"), aaaa: none, targetA: found("1.1.1.1"), targetAaaa: none });
  ok("a wrong TXT value and a CNAME elsewhere are named", j.problems.some((p) => p.includes("does not have the value domain-verify=tok")) && j.problems.includes(`erp.acme.com points to x.y, not ${T}`), j.problems);
  j = judged({ txt: found("domain-verify=tok"), cname: none, a: found("1.1.1.1"), aaaa: found("::1"), targetA: found("1.1.1.1", "2.2.2.2"), targetAaaa: found("::1") });
  ok("a bare domain whose addresses are all the target's passes (ALIAS, flattening)", j.routeOk, j.problems);
  j = judged({ txt: found("domain-verify=tok"), cname: none, a: found("1.1.1.1", "3.3.3.3"), aaaa: none, targetA: found("1.1.1.1"), targetAaaa: none });
  ok("  but not when one of them is somewhere else", !j.routeOk && j.problems.includes(`erp.acme.com points to 1.1.1.1, 3.3.3.3, not ${T}`), j.problems);
  j = judged({ txt: { failed: "timed out" }, cname: found(T) });
  ok("no answer is not 'no record': try again", !j.txtOk && j.problems.some((p) => /could not be looked up \(timed out\)/.test(p)), j.problems);
  ok("no token (an address from before checks): only the pointer is needed", rules.judgeRecords("erp.acme.com", null, T, { cname: found(T) }).txtOk);

  section("Production never skips DNS");
  ok("the rule: .localhost and .test are skipped only outside production", rules.dnsSkipped("erp.acme.test", false) && rules.dnsSkipped("erp.acme.localhost:3000", false) && !rules.dnsSkipped("erp.acme.test", true) && !rules.dnsSkipped("erp.acme.localhost", true) && !rules.dnsSkipped("erp.acme.com", false));
  dns.calls.length = 0;
  const skipped = await domains.checkRecords("erp.zzdom-dev.test:3000", "tok", T, fakeResolver);
  ok("in development a .test address is not looked up — its records count as found", skipped.skipped && skipped.txtOk && skipped.routeOk && dns.calls.length === 0, dns.calls);
  // NODE_ENV is typed read-only; it is an ordinary variable at run time.
  const env = process.env as Record<string, string | undefined>;
  const wasEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  let inProduction: Awaited<ReturnType<typeof domains.checkRecords>>;
  try {
    inProduction = await domains.checkRecords("erp.zzdom-dev.test", "tok", T, fakeResolver);
  } finally {
    if (wasEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = wasEnv;
  }
  ok("in production the same address is asked about, and fails without records", !inProduction.skipped && dns.calls.some((c) => c === "TXT _domain-verify.erp.zzdom-dev.test") && !inProduction.txtOk, dns.calls);

  section("How a check moves an address on");
  const t0 = new Date("2026-10-03T06:30:00Z");
  const step = rules.nextDomainState;
  ok("waiting → live when it checks out", step({ status: "PENDING", failingSince: null }, true, t0).outcome === "verified");
  ok("live → failing, from now", (() => {
    const s = step({ status: "ACTIVE", failingSince: null }, false, t0);
    return s.status === "ACTIVE" && s.failingSince?.getTime() === t0.getTime() && s.outcome === "failing-started";
  })());
  ok("  still live 71 hours on", step({ status: "ACTIVE", failingSince: t0 }, false, new Date(t0.getTime() + 71 * HOUR)).status === "ACTIVE");
  ok("  stopped once 72 hours have passed", step({ status: "ACTIVE", failingSince: t0 }, false, new Date(t0.getTime() + 72 * HOUR)).outcome === "stopped");
  ok("stopped → live again as soon as it passes", step({ status: "BROKEN", failingSince: t0 }, true, t0).status === "ACTIVE");
  ok(
    "in words: waiting, live, failing with both dates, stopped",
    rules.domainStatusText({ status: "PENDING", failingSince: null }).label === "Waiting for DNS records" &&
      rules.domainStatusText({ status: "ACTIVE", failingSince: null }).label === "Live" &&
      rules.domainStatusText({ status: "ACTIVE", failingSince: t0 }).label === "Live — records failing since 3 Oct, stops on 6 Oct" &&
      rules.domainStatusText({ status: "BROKEN", failingSince: t0 }).label === "Stopped — records not found",
    rules.domainStatusText({ status: "ACTIVE", failingSince: t0 }).label,
  );
  ok("the allowance in words", rules.allowanceText(1, 1) === "1 of 1 used" && rules.allowanceText(0, 0) === "Your plan doesn't include a custom domain" && /no limit/.test(rules.allowanceText(null, 2)));

  section("The allowance, worked out");
  const plan = (kind: "EDITION" | "ADDON" | "INTERNAL", customDomains: number | null) => ({ quantity: 1, plan: { key: `p-${kind}`, kind, allModules: false, seats: null, copilotTokens: null, customDomains, modules: [] } });
  const noOverride = { country: "IN", seatOverride: null, copilotTokenOverride: null, customDomainOverride: null };
  ok("an edition of none: none", ent.entitlementsFrom(noOverride, [plan("EDITION", 0)], []).customDomains === 0);
  ok("an edition of one with an add-on of two, twice: five", ent.entitlementsFrom(noOverride, [plan("EDITION", 1), { ...plan("ADDON", 2), quantity: 2 }], []).customDomains === 5);
  ok("an add-on with no number adds nothing", ent.entitlementsFrom(noOverride, [plan("EDITION", 0), plan("ADDON", null)], []).customDomains === 0);
  ok("an internal plan without a number: no limit", ent.entitlementsFrom(noOverride, [plan("INTERNAL", null)], []).customDomains === null);
  ok("a staff override replaces the sum", ent.entitlementsFrom({ ...noOverride, customDomainOverride: 3 }, [plan("EDITION", 0)], []).customDomains === 3);
  ok("an answer from before custom domains reads as none", entRules.parseEntitlements({ v: 1, all: true, modules: [], seats: null, copilotTokens: null, plans: [] }).customDomains === 0);

  // ─── The fixture ───────────────────────────────────────────────────────────────────────────────
  section("A scratch fixture in the control plane");
  const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
  const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
  const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
  const { runAsTenant, tenantOrigin } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const keysLib = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
  const { sessionOptions } = require("../src/lib/auth-session") as typeof import("../src/lib/auth-session");
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const control = controlDb();
  const mail: { to: string; subject: string; text: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  const PREFIX = "zzdom-";
  const staffIds: string[] = [];
  const tenantIds: string[] = [];
  const offeredBefore = await control.platformSetting.findUnique({ where: { key: "domains.offered" } });
  /** The local workspace's database, directly — for its scratch member and the activity rows this run writes. */
  const workspaceDirect = directClient(process.env.DATABASE_URL!);

  async function cleanup() {
    const tenants = await control.tenant.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
    const ids = [...new Set([...tenantIds, ...tenants.map((t) => t.id)])];
    const staff = await control.platformUser.findMany({ where: { email: { endsWith: "@zzdom.example" } }, select: { id: true } });
    const actors = [...new Set([...staffIds, ...staff.map((s) => s.id)]), "check:domains"];
    await control.platformAuditLog.deleteMany({ where: { OR: [{ tenantId: { in: ids } }, { actor: { in: actors } }] } });
    await control.tenant.deleteMany({ where: { id: { in: ids } } });
    await control.platformUser.deleteMany({ where: { email: { endsWith: "@zzdom.example" } } });
    await control.plan.deleteMany({ where: { key: { startsWith: PREFIX } } });
    await workspaceDirect.auditLog.deleteMany({ where: { entityType: "CustomDomain", OR: [{ entityLabel: { contains: "zzdom" } }, { entityId: { in: ids } }] } });
    await workspaceDirect.user.deleteMany({ where: { email: MEMBER_EMAIL } });
  }
  await cleanup();

  const PLANS = { none: `${PREFIX}none`, one: `${PREFIX}one`, internal: `${PREFIX}internal`, addonNull: `${PREFIX}addon-null` };
  const base = { countries: [] as string[], modules: [] as string[], seats: null, copilotTokens: null };
  try {
    await plans.savePlan({ ...base, key: PLANS.none, name: "Zz dom none", kind: "EDITION" }, "script:check:domains");
    await plans.savePlan({ ...base, key: PLANS.one, name: "Zz dom one", kind: "EDITION", customDomains: 1 }, "script:check:domains");
    await plans.savePlan({ ...base, key: PLANS.addonNull, name: "Zz dom add-on", kind: "ADDON", customDomains: null }, "script:check:domains");
    await plans.savePlan({ ...base, key: PLANS.internal, name: "Zz dom internal", kind: "INTERNAL" }, "script:check:domains");
    const planRows = await control.plan.findMany({ where: { key: { startsWith: PREFIX } }, select: { key: true, customDomains: true } });
    const cd = (key: string) => planRows.find((p) => p.key === key)?.customDomains;
    ok("a sold plan made without a number has none; an internal one no limit", cd(PLANS.none) === 0 && cd(PLANS.internal) === null && cd(PLANS.one) === 1, planRows);
    await plans.savePlan({ ...base, key: PLANS.one, name: "Zz dom one", kind: "EDITION" }, "script:check:domains");
    ok("  and a plan saved again without it keeps its own", (await control.plan.findUniqueOrThrow({ where: { key: PLANS.one } })).customDomains === 1);

    const make = async (key: string, planKeys: string[]) => {
      const t = await control.tenant.create({
        data: { slug: `${PREFIX}${key}`, name: `Zz Dom ${key.toUpperCase()}`, status: "ACTIVE", keyBundleCipher: "pending", ownerEmail: `owner@${key}.zzdom.example` },
        select: { id: true, slug: true },
      });
      tenantIds.push(t.id);
      // Keys of its own, sealed to it as the provisioner seals them — so its sign-in can be set up below.
      await control.tenant.update({ where: { id: t.id }, data: { keyBundleCipher: keysLib.sealKeyBundle(t.id, keysLib.newKeyBundle()) } });
      await plans.setWorkspacePlans(t.id, planKeys.map((planKey) => ({ planKey, quantity: 1 })), "script:check:domains");
      return t;
    };
    const A = await make("a", [PLANS.one]);
    const B = await make("b", [PLANS.one]);
    const C = await make("c", [PLANS.none, PLANS.addonNull]);
    const D = await make("d", [PLANS.internal]);
    const E = await make("e", [PLANS.one]);
    const target = (slug: string) => rules.routingTarget(slug);
    const limitOf = async (id: string) => entRules.parseEntitlements((await control.tenant.findUniqueOrThrow({ where: { id }, select: { entitlements: true } })).entitlements).customDomains;
    ok("five scratch workspaces, their entitlements worked out", (await limitOf(A.id)) === 1 && (await limitOf(C.id)) === 0 && (await limitOf(D.id)) === null);

    // ─── Allowance ───────────────────────────────────────────────────────────────────────────────
    section("The allowance: none, one, an override, no limit");
    ok("none (an edition of none, an add-on of nothing): refused, in words", /doesn't include a custom domain/.test(await thrown(() => domains.addDomain(C.id, "erp.zzdom-c.example", "owner@c.zzdom.example"))));
    await plans.setLimitOverrides(C.id, { seats: null, copilotTokens: null, customDomains: 1 }, "script:check:domains");
    ok("a staff override of one: one may be added", (await domains.addDomain(C.id, "erp.zzdom-c.example", "owner@c.zzdom.example")).status === "PENDING");
    ok("  and a second is refused", /allows one custom domain, and one is added already/.test(await thrown(() => domains.addDomain(C.id, "two.zzdom-c.example", "owner@c.zzdom.example"))));
    await plans.setLimitOverrides(C.id, { seats: null, copilotTokens: null }, "script:check:domains");
    ok("the seat and copilot overrides leave the custom-domain override as it is", (await control.tenant.findUniqueOrThrow({ where: { id: C.id } })).customDomainOverride === 1);
    for (const n of [1, 2, 3]) await domains.addDomain(D.id, `n${n}.zzdom-d.example`, "owner@d.zzdom.example");
    ok("no limit (an internal plan): three and more", (await control.tenantDomain.count({ where: { tenantId: D.id } })) === 3);
    await control.tenantDomain.deleteMany({ where: { tenantId: D.id } });
    ok("an address already on the workspace is refused", /already on this workspace/.test(await thrown(() => domains.addDomain(C.id, "ERP.zzdom-c.example", "x"))));

    // ─── Two workspaces, one address ─────────────────────────────────────────────────────────────
    section("Two workspaces waiting on one address");
    const SHARED = "erp.zzdom-shared.example";
    const aShared = await domains.addDomain(A.id, `https://${SHARED}/`, "owner@a.zzdom.example");
    const bShared = await domains.addDomain(B.id, SHARED, "owner@b.zzdom.example");
    ok("both may wait on it, each with a token of its own (192 bits)", aShared.status === "PENDING" && bShared.status === "PENDING" && aShared.verifyToken !== bShared.verifyToken && Buffer.from(bShared.verifyToken!, "base64url").length >= 16);
    publish(SHARED, bShared.verifyToken, target(B.slug));
    const aFirst = await domains.checkDomain(aShared.id);
    ok(
      "A's check fails: the TXT record has B's token, and it points at B",
      aFirst.outcome === "waiting" && aFirst.problems.some((p) => p.includes("does not have the value")) && aFirst.problems.includes(`${SHARED} points to ${target(B.slug)}, not ${target(A.slug)}`),
      aFirst.problems,
    );
    const aRow = await control.tenantDomain.findUnique({ where: { id: aShared.id } });
    ok("  every check keeps when it ran and what it found", !!aRow?.lastCheckedAt && !!aRow.lastCheckError?.includes("points to"));
    const bCheck = await domains.checkDomain(bShared.id);
    ok("B proves it: live", bCheck.outcome === "verified" && bCheck.domain?.status === "ACTIVE" && !!bCheck.domain.verifiedAt);
    ok("  and A's waiting row is gone in the same moment", !(await control.tenantDomain.findUnique({ where: { id: aShared.id } })));
    ok("  recorded: verified, and how many waiting rows went", !!(await control.platformAuditLog.findFirst({ where: { tenantId: B.id, action: "tenant.domain.verified", detail: { path: ["othersRemoved"], equals: 1 } } })));
    ok("A cannot add it again: taken", /already used by another workspace/.test(await thrown(() => domains.addDomain(A.id, SHARED, "owner@a.zzdom.example"))));
    // The race: B's address live in the same moment as A's check passes — the unique index decides.
    const RACE = "race.zzdom-shared.example";
    const aRace = await domains.addDomain(A.id, RACE, "owner@a.zzdom.example");
    await control.tenantDomain.create({ data: { tenantId: D.id, host: RACE, kind: "CUSTOM", status: "ACTIVE" } });
    publish(RACE, aRace.verifyToken, target(A.slug));
    const raced = await domains.checkDomain(aRace.id);
    ok("the unique-index race is 'taken', and the loser's waiting row goes", raced.outcome === "taken" && !(await control.tenantDomain.findUnique({ where: { id: aRace.id } })), raced.outcome);
    await control.tenantDomain.deleteMany({ where: { tenantId: D.id, host: RACE } });
    unpublish(RACE);

    // ─── Verify, primary, grace, recovery, serving ───────────────────────────────────────────────
    section("Verified, primary, failing, stopped, working again — and what is served");
    const HOST = "erp.zzdom-a.example";
    const aMain = await domains.addDomain(A.id, HOST, "owner@a.zzdom.example");
    registry.forgetRegistry();
    ok("a waiting address is not served", (await registry.tenantForHost(HOST)) === null);
    ok("  nor made primary", /Only a live address/.test(await thrown(() => domains.makePrimary(aMain.id, A.id))));
    publish(HOST, aMain.verifyToken, target(A.slug));
    const verified = await domains.checkDomain(aMain.id);
    ok("its records check out: live", verified.outcome === "verified");
    ok("  and served: the host reaches A", (await registry.tenantForHost(HOST))?.id === A.id);
    ok("someone else's workspace id cannot act on it", /no longer exists/.test(await thrown(() => domains.makePrimary(aMain.id, B.id))));
    await domains.makePrimary(aMain.id, A.id);
    ok("made primary: links use it", (await registry.tenantById(A.id))?.primaryHost === HOST);
    ok("  as the console's header says", (await (require("../src/lib/platform/workspace-data") as typeof import("../src/lib/platform/workspace-data")).workspaceHeader(A.slug, "x"))?.primaryHost === HOST);
    ok("  and tenantOrigin() builds links on it", (await tenantOrigin((await registry.tenantById(A.id))!)) === `https://${HOST}`);
    const signIn = async (host: string) => (await sessionOptions({ headers: new Headers({ host }) } as unknown as Request)).tenantId;
    ok("signing in at it is signing in to A: its own keys, its own session", (await signIn(HOST)) === A.id && (await signIn(registry.subdomainHost(A.slug))) === A.id);
    ok("  another workspace's live address is that workspace's; a waiting one, nobody's", (await signIn(SHARED)) === B.id && (await signIn("erp.zzdom-c.example")) === null);
    unpublish(HOST);
    const tFail = new Date();
    const failing = await domains.checkDomain(aMain.id, { now: tFail });
    ok("its records go: still live, failing from now", failing.outcome === "failing-started" && failing.domain?.status === "ACTIVE" && failing.domain.failingSince?.getTime() === tFail.getTime());
    ok("  no mail from a check", mail.length === 0);
    const later = await domains.checkDomain(aMain.id, { now: new Date(tFail.getTime() + 71 * HOUR) });
    ok("  71 hours on: still live, still from the first failure", later.domain?.status === "ACTIVE" && later.domain.failingSince?.getTime() === tFail.getTime());
    registry.forgetRegistry();
    ok("  and still served meanwhile", (await registry.tenantForHost(HOST))?.id === A.id);
    const stopped = await domains.checkDomain(aMain.id, { now: new Date(tFail.getTime() + 73 * HOUR) });
    ok("past 72 hours: stopped", stopped.outcome === "stopped" && stopped.domain?.status === "BROKEN");
    ok("  not served", (await registry.tenantForHost(HOST)) === null);
    ok("  and links fall back to its own subdomain, though it is still marked primary", (await registry.tenantById(A.id))?.primaryHost === registry.subdomainHost(A.slug) && stopped.domain?.isPrimary === true);
    ok("  tenantOrigin() too, and nobody signs in at the stopped address", (await tenantOrigin((await registry.tenantById(A.id))!)) === `http://${registry.subdomainHost(A.slug)}` && (await signIn(HOST)) === null);
    ok("  recorded as stopped", !!(await control.platformAuditLog.findFirst({ where: { tenantId: A.id, action: "tenant.domain.broken" } })));
    publish(HOST, aMain.verifyToken, target(A.slug));
    const back = await domains.checkDomain(aMain.id, { now: new Date(tFail.getTime() + 80 * HOUR) });
    ok("its records back: live again, the failure forgotten", back.outcome === "recovered" && back.domain?.status === "ACTIVE" && back.domain.failingSince === null && back.domain.lastCheckError === null);
    ok("  served and primary again", (await registry.tenantForHost(HOST))?.id === A.id && (await registry.tenantById(A.id))?.primaryHost === HOST);
    await domains.clearPrimary(A.id);
    ok("primary cleared: links go back to the subdomain", (await registry.tenantById(A.id))?.primaryHost === registry.subdomainHost(A.slug));
    await domains.makePrimary(aMain.id, A.id);
    const removed = await domains.removeDomain(aMain.id, A.id);
    ok("a removed primary: not served, links on the subdomain", removed.isPrimary && (await registry.tenantForHost(HOST)) === null && (await registry.tenantById(A.id))?.primaryHost === registry.subdomainHost(A.slug));
    unpublish(HOST);
    // A bare domain pointed by its addresses (ALIAS / flattening), and a resolver that does not answer.
    const APEX = "zzdom-apex.example";
    const apex = await domains.addDomain(D.id, APEX, "owner@d.zzdom.example");
    dns.txt.set(`_domain-verify.${APEX}`, [[`domain-verify=${apex.verifyToken}`]]);
    dns.a.set(APEX, ["203.0.113.7"]);
    dns.a.set(target(D.slug), ["203.0.113.7", "203.0.113.8"]);
    ok("a bare domain whose address is the workspace's goes live", (await domains.checkDomain(apex.id)).outcome === "verified");
    const SLOW = "slow.zzdom-d.example";
    const slow = await domains.addDomain(D.id, SLOW, "owner@d.zzdom.example");
    dns.slow.add(`_domain-verify.${SLOW}`);
    const slowCheck = await domains.checkDomain(slow.id);
    ok("a lookup without an answer says so, and stays waiting", slowCheck.outcome === "waiting" && slowCheck.problems.some((p) => /could not be looked up \(timed out\)/.test(p)), slowCheck.problems);
    const DEVHOST = "erp.zzdom-d.test:3000";
    const devRow = await domains.addDomain(D.id, DEVHOST, "owner@d.zzdom.example");
    dns.calls.length = 0;
    const devCheck = await domains.checkDomain(devRow.id);
    ok("in development a .test address goes live without DNS being asked", devCheck.outcome === "verified" && devCheck.skipped && dns.calls.length === 0);
    ok("  and is served at its port", (await registry.tenantForHost(DEVHOST))?.id === D.id);
    ok("an address kept from before workspaces is not checked", /needs no records/.test(await thrown(async () => {
      const legacy = await control.tenantDomain.create({ data: { tenantId: D.id, host: "legacy.zzdom-d.example", kind: "LEGACY" }, select: { id: true } });
      await domains.checkDomain(legacy.id);
    })));

    // ─── The sweep ───────────────────────────────────────────────────────────────────────────────
    section("The daily sweep");
    const SW = "sweep.zzdom-d.example";
    const sw = await domains.addDomain(D.id, SW, "owner@d.zzdom.example");
    publish(SW, sw.verifyToken, target(D.slug));
    await domains.checkDomain(sw.id);
    const now0 = new Date();
    const old = await control.tenantDomain.create({ data: { tenantId: D.id, host: "old.zzdom-d.example", kind: "CUSTOM", status: "PENDING", verifyToken: "x", createdAt: new Date(now0.getTime() - 15 * DAY) }, select: { id: true } });
    const young = await control.tenantDomain.create({ data: { tenantId: D.id, host: "young.zzdom-d.example", kind: "CUSTOM", status: "PENDING", verifyToken: "y", createdAt: new Date(now0.getTime() - 13 * DAY) }, select: { id: true } });
    unpublish(SW);
    mail.length = 0;
    dns.calls.length = 0;
    const only = [A.id, B.id, C.id, D.id, E.id];
    const s1 = await domains.domainSweep(now0, { only });
    ok("waiting addresses older than 14 days go; younger ones stay", s1.expired === 1 && !(await control.tenantDomain.findUnique({ where: { id: old.id } })) && !!(await control.tenantDomain.findUnique({ where: { id: young.id } })), s1);
    ok("every live or stopped address is checked again — never a waiting one", s1.checked >= 3 && !dns.calls.some((c) => c.includes("young.zzdom-d") || c.includes("slow.zzdom-d")), dns.calls);
    ok("the failing one counted, its owner told once", s1.failing === 1 && s1.mailed === 1 && mail.length === 1 && mail[0]!.to === "owner@d.zzdom.example" && mail[0]!.subject.includes(SW), mail.map((m) => m.subject));
    ok("  in words, with the date it stops and its own address", mail[0]!.text.includes("keeps working for now") && mail[0]!.text.includes(registry.subdomainHost(D.slug)) && /No TXT record found/.test(mail[0]!.text));
    const s2 = await domains.domainSweep(new Date(now0.getTime() + DAY), { only });
    ok("the next day: still failing, nobody told again", s2.failing === 1 && s2.mailed === 0 && mail.length === 1, s2);
    const s3 = await domains.domainSweep(new Date(now0.getTime() + 73 * HOUR), { only });
    ok("past the grace: stopped, its owner told once more", s3.stopped === 1 && s3.mailed === 1 && mail.length === 2 && mail[1]!.subject.includes("has stopped reaching"), s3);
    const s4 = await domains.domainSweep(new Date(now0.getTime() + 4 * DAY), { only });
    ok("  and not again after that", s4.mailed === 0 && mail.length === 2 && s4.checked >= 3);
    publish(SW, sw.verifyToken, target(D.slug));
    const s5 = await domains.domainSweep(new Date(now0.getTime() + 5 * DAY), { only });
    ok("its records back: working again", s5.recovered === 1 && (await control.tenantDomain.findUniqueOrThrow({ where: { id: sw.id } })).status === "ACTIVE", s5);
    ok("a sweep's failure to check one address is reported, not thrown", Array.isArray(s5.failed) && s5.failed.length === 0);

    // ─── Settings › Domain ───────────────────────────────────────────────────────────────────────
    section("Settings › Domain: the owner's alone");
    const workspaceDb = process.env.DATABASE_URL!;
    /** The scratch workspace as the registry has it now, run against the local workspace database. */
    const asWorkspace = async (id: string) => ({ ...(await registry.tenantById(id))!, dbUrl: workspaceDb });
    const workspaceDbTenant = await asWorkspace(E.id);
    const ownerUser = await runAsTenant(workspaceDbTenant, () => db.user.findFirst({ where: { isSuperAdmin: true, kind: "MEMBER" }, select: { id: true, name: true, email: true } }));
    // A member who is not the super admin, made for this run (the local workspace may have none) and removed after.
    const memberUser = await runAsTenant(workspaceDbTenant, () =>
      db.user.create({ data: { name: "Zzdom Member", email: MEMBER_EMAIL, role: "SALES", passwordHash: "x".repeat(60) }, select: { id: true, name: true, email: true } }),
    );
    ok("the workspace database has its super admin, and another member", !!ownerUser && !!memberUser);
    if (!ownerUser) throw new Error("the local workspace has no super admin");
    const asOwner = () => (actor = { ...ownerUser, role: "ADMIN" });
    const asMember = () => (actor = { ...memberUser, role: "USER" });
    const actions = require("../src/actions/domains") as typeof import("../src/actions/domains");
    const DomainPage = (require("../src/app/(dashboard)/settings/domain/page") as { default: Page }).default;
    const SecurityPage = (require("../src/app/(dashboard)/settings/security/page") as { default: Page }).default;
    const inE = async <T,>(work: () => Promise<T>) => runAsTenant(await asWorkspace(E.id), work);
    const page = async (name: string) => {
      const html = await inE(() => render(DomainPage));
      saveRender(name, html);
      return text(html);
    };

    asMember();
    ok("a member who is not the super admin is refused", /Only the workspace owner/.test(((await inE(() => actions.addCustomDomain("x.zzdom-e.example"))) as { error?: string }).error ?? ""));
    const notOwner = await page("01-not-owner");
    ok("  and shown whose page it is, nothing else", notOwner.includes("Only the workspace owner manages its custom domain") && !notOwner.includes("Add an address"));
    asOwner();
    viewingAs = true;
    const viewAs = await inE(() => actions.addCustomDomain("x.zzdom-e.example"));
    ok("the owner viewing as somebody is refused", !viewAs.ok && /Switch back to your own account/.test(viewAs.error), viewAs);
    ok("  and the page shows nothing of it", (await inE(() => actions.getDomainSettings())) === null);
    viewingAs = false;

    section("The switch");
    await settings.setSetting("domains.offered", "0", "check:domains");
    const off = await inE(() => actions.addCustomDomain("x.zzdom-e.example"));
    ok("off: the owner cannot add", !off.ok && /aren't offered yet/.test(off.error), off);
    const offPage = await page("02-switch-off");
    ok("  and the page says so, with its own address", offPage.includes("Custom domains aren't offered yet") && offPage.includes(registry.subdomainHost(E.slug)) && !offPage.includes("Add address"));
    await settings.setSetting("domains.offered", "1", "check:domains");
    ok("the typed getter follows it", await settings.customDomainsOffered());

    section("Settings › Domain, rendered in each state");
    const cPage = text(await runAsTenant(await asWorkspace(C.id), async () => {
      await plans.setLimitOverrides(C.id, { seats: null, copilotTokens: null, customDomains: 0 }, "script:check:domains");
      const html = await render(DomainPage);
      saveRender("03-plan-has-none", html);
      return html;
    }));
    ok("a plan of none: says so, links to Plan & billing, no form", cPage.includes("Your plan doesn't include a custom domain") && cPage.includes("Plan & billing") && !cPage.includes("Add address"), cPage.slice(0, 400));
    const empty = await page("04-empty");
    ok("nothing added: its own address, the allowance, the form, the Microsoft line", empty.includes(registry.subdomainHost(E.slug)) && empty.includes("0 of 1 used") && empty.includes("Add address") && empty.includes("listed under Security"));
    const added = await inE(() => actions.addCustomDomain("ZZDOM-E.example"));
    ok("the owner adds a bare domain", added.ok && added.data.status === "PENDING" && added.data.apex, added);
    const pending = await page("05-waiting-bare-domain-full");
    const eToken = (await control.tenantDomain.findFirstOrThrow({ where: { tenantId: E.id, host: "zzdom-e.example" } })).verifyToken!;
    ok(
      "waiting: in words, the two records with their names and values, the warning, '1 of 1 used'",
      pending.includes("Waiting for DNS records") &&
        pending.includes("_domain-verify.zzdom-e.example") &&
        pending.includes(`domain-verify=${eToken}`) &&
        pending.includes(target(E.slug)) &&
        pending.includes("is a bare domain") &&
        pending.includes("1 of 1 used") &&
        pending.includes("remove one to add another"),
    );
    ok("  with a copy button for each name and value", (await inE(() => render(DomainPage))).split("aria-label=\"Copy the").length - 1 === 4);
    const second = await inE(() => actions.addCustomDomain("two.zzdom-e.example"));
    ok("a second is refused: one of one", !second.ok && /allows one custom domain/.test(second.error));
    ok("  and so is one under the platform's own domain", /platform's own/.test(((await inE(() => actions.addCustomDomain("x.zzdom-e.localhost"))) as { error?: string }).error ?? ""));
    const gone = await inE(() => actions.removeCustomDomain(added.ok ? added.data.id : ""));
    ok("removed by its owner", gone.ok && (await control.tenantDomain.count({ where: { tenantId: E.id } })) === 0);
    const eAdd = await inE(() => actions.addCustomDomain("erp.zzdom-e.example"));
    if (!eAdd.ok) throw new Error(eAdd.error);
    const eRow = await control.tenantDomain.findUniqueOrThrow({ where: { id: eAdd.data.id } });
    const notYet = await inE(() => actions.checkCustomDomain(eRow.id));
    ok("Check now before the records: not yet, in a sentence", notYet.ok && notYet.data.status === "PENDING" && /^Not yet: No TXT record found/.test(notYet.data.message), notYet);
    publish(eRow.host, eRow.verifyToken, target(E.slug));
    const tooSoon = await inE(() => actions.checkCustomDomain(eRow.id));
    ok("Check now again at once: at most every 30 seconds", !tooSoon.ok && /checked a moment ago/.test(tooSoon.error), tooSoon);
    await control.tenantDomain.update({ where: { id: eRow.id }, data: { lastCheckedAt: new Date(Date.now() - 31_000) } });
    const live = await inE(() => actions.checkCustomDomain(eRow.id));
    ok("after 30 seconds, with its records: live", live.ok && live.data.status === "ACTIVE" && /is live/.test(live.data.message), live);
    const primary = await inE(() => actions.makeCustomDomainPrimary(eRow.id));
    ok("made primary by its owner", primary.ok && (await registry.tenantById(E.id))?.primaryHost === eRow.host);
    const livePage = await page("06-live-primary");
    ok("live and primary: in words, and its own address offered back for links", livePage.includes("Live") && livePage.includes("Primary") && livePage.includes("Use for links") && livePage.includes("Last checked"));
    const audit = await inE(() => db.auditLog.findMany({ where: { entityType: "CustomDomain", entityId: { in: [eRow.id, added.ok ? added.data.id : ""] } }, select: { action: true, entityLabel: true } }));
    ok("every change is in the workspace's activity log: added, removed, verified, made primary", audit.some((r) => r.action === "CREATE") && audit.some((r) => r.action === "DELETE") && audit.some((r) => /verified/.test(r.entityLabel)) && audit.some((r) => /primary/.test(r.entityLabel)), audit);

    section("The Security page lists every live address");
    const security = async () => text(await runAsTenant(await asWorkspace(E.id), () => render(SecurityPage)));
    let sec = await security();
    const own = `${hostLib.protocolFor(registry.subdomainHost(E.slug))}://${registry.subdomainHost(E.slug)}`;
    ok(
      "a sign-in and a mail redirect address for its own address and for the custom one",
      sec.includes(`${own}/api/auth/callback/microsoft-entra-id`) &&
        sec.includes(`${own}/api/mail/microsoft/callback`) &&
        sec.includes(`https://${eRow.host}/api/auth/callback/microsoft-entra-id`) &&
        sec.includes(`https://${eRow.host}/api/mail/microsoft/callback`),
      sec.slice(sec.indexOf("Microsoft"), sec.indexOf("Microsoft") + 600),
    );
    unpublish(eRow.host);
    const tE = new Date();
    await domains.checkDomain(eRow.id, { now: tE });
    const failingPage = await page("07-live-failing");
    const failText = rules.domainStatusText({ status: "ACTIVE", failingSince: tE }).label;
    ok("failing: 'Live — records failing since …, stops on …', and what the check found", failingPage.includes(failText) && failingPage.includes("No TXT record found"), failText);
    await domains.checkDomain(eRow.id, { now: new Date(tE.getTime() + 73 * HOUR) });
    const stoppedPage = await page("08-stopped");
    ok("stopped: 'Stopped — records not found', and links back on its own address", stoppedPage.includes("Stopped — records not found") && stoppedPage.includes("Primary when live"));
    sec = await security();
    ok("  a stopped address is not among the Security page's", !sec.includes(eRow.host) && sec.includes(own));

    // ─── The console ─────────────────────────────────────────────────────────────────────────────
    section("The console: who may do what");
    const roles = ["OWNER", "ADMIN", "SUPPORT", "BILLING", "READONLY"] as const;
    const staff: Record<(typeof roles)[number], { id: string; email: string }> = {} as never;
    for (const role of roles) {
      const u = await control.platformUser.create({ data: { email: `${role.toLowerCase()}@zzdom.example`, name: `Zz Dom ${role}`, role, passwordHash: "!" }, select: { id: true, email: true } });
      staffIds.push(u.id);
      staff[role] = u;
    }
    const signInAs = async (role: (typeof roles)[number]) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId: staff[role].id, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:domains" } });
      consoleToken = token;
    };
    const consoleDomains = require("../src/actions/platform/console-domains") as typeof import("../src/actions/platform/console-domains");
    const consoleMain = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const consoleWorkspace = require("../src/actions/platform/console-workspace") as typeof import("../src/actions/platform/console-workspace");
    const refusedRole = (r: { ok: boolean; error?: string }) => !r.ok && /Your role cannot do that/.test(r.error ?? "");

    await settings.setSetting("domains.offered", "0", "check:domains");
    for (const role of ["SUPPORT", "BILLING", "READONLY"] as const) {
      await signInAs(role);
      ok(`${role.toLowerCase()} cannot add an address`, refusedRole(await consoleDomains.consoleAddDomain(B.id, "staff.zzdom-b.example")));
    }
    await signInAs("ADMIN");
    await plans.setLimitOverrides(B.id, { seats: null, copilotTokens: null, customDomains: 3 }, "script:check:domains");
    const staffAdd = await consoleDomains.consoleAddDomain(B.id, "staff.zzdom-b.example");
    ok("an admin adds one while the switch is off", staffAdd.ok, staffAdd);
    const staffRow = staffAdd.ok ? await control.tenantDomain.findUniqueOrThrow({ where: { id: staffAdd.data.id } }) : null;
    ok("  added by staff:<email>, and in the platform audit log under them", staffRow?.addedBy === `staff:${staff.ADMIN.email}` && !!(await control.platformAuditLog.findFirst({ where: { actor: staff.ADMIN.id, action: "tenant.domain.add", tenantId: B.id } })));
    await signInAs("SUPPORT");
    const supportCheck = await consoleDomains.consoleCheckDomain(B.id, staffRow!.id);
    ok("support may check it", supportCheck.ok && supportCheck.data.outcome === "waiting", supportCheck);
    ok("  but not make it primary or remove it", refusedRole(await consoleDomains.consoleMakeDomainPrimary(B.id, bShared.id)) && refusedRole(await consoleDomains.consoleRemoveDomain(B.id, staffRow!.id, "not needed now")));
    await signInAs("BILLING");
    ok("billing cannot check one", refusedRole(await consoleDomains.consoleCheckDomain(B.id, staffRow!.id)));
    await signInAs("READONLY");
    ok("read-only staff cannot either", refusedRole(await consoleDomains.consoleCheckDomain(B.id, staffRow!.id)));
    await signInAs("ADMIN");
    ok("an admin makes the live one primary", (await consoleDomains.consoleMakeDomainPrimary(B.id, bShared.id)).ok && (await registry.tenantById(B.id))?.primaryHost === SHARED);
    ok("  a waiting one is refused", /Only a live address/.test(((await consoleDomains.consoleMakeDomainPrimary(B.id, staffRow!.id)) as { error?: string }).error ?? ""));
    ok("  and an address of another workspace 'no longer exists'", /no longer exists/.test(((await consoleDomains.consoleMakeDomainPrimary(A.id, bShared.id)) as { error?: string }).error ?? ""));
    ok("removing asks why", /Say why/.test(((await consoleDomains.consoleRemoveDomain(B.id, staffRow!.id, "no")) as { error?: string }).error ?? ""));
    const removedByStaff = await consoleDomains.consoleRemoveDomain(B.id, staffRow!.id, "the customer asked for it to go");
    ok("  and with a reason it goes, the reason kept", removedByStaff.ok && !!(await control.platformAuditLog.findFirst({ where: { actor: staff.ADMIN.id, action: "tenant.domain.remove", detail: { path: ["reason"], equals: "the customer asked for it to go" } } })));
    ok("clearing the primary goes back to its own address", (await consoleDomains.consoleClearDomainPrimary(B.id)).ok && (await registry.tenantById(B.id))?.primaryHost === registry.subdomainHost(B.slug));
    ok("the switch is an owner's", refusedRole(await consoleDomains.consoleSetDomainsOffered(true)));
    await signInAs("OWNER");
    ok("  an owner turns it on", (await consoleDomains.consoleSetDomainsOffered(true)).ok && (await settings.customDomainsOffered()) && !!(await control.platformAuditLog.findFirst({ where: { actor: staff.OWNER.id, action: "domains.settings" } })));
    ok("  and only a real boolean", /on or off/.test(((await consoleDomains.consoleSetDomainsOffered("yes" as unknown as boolean)) as { error?: string }).error ?? ""));

    section("The console: limits and plans");
    await signInAs("BILLING");
    const preview = await consoleWorkspace.consolePreviewEntitlements(B.id, { limits: { seats: null, copilotTokens: null, customDomains: 5 } });
    ok("the limits preview shows custom domains before and after", preview.ok && preview.data.diff.customDomains[0] === 3 && preview.data.diff.customDomains[1] === 5, preview.ok ? preview.data.diff : preview);
    const kept = await consoleWorkspace.consolePreviewEntitlements(B.id, { limits: { seats: null, copilotTokens: null } });
    ok("  left out, it keeps the override", kept.ok && kept.data.diff.customDomains[1] === 3);
    ok("billing sets the override beside seats and copilot", (await consoleMain.consoleSetLimitOverrides(B.id, { seats: null, copilotTokens: null, customDomains: "2" })).ok && (await limitOf(B.id)) === 2);
    ok("  and empty lets the plans decide again", (await consoleMain.consoleSetLimitOverrides(B.id, { seats: null, copilotTokens: null, customDomains: "" })).ok && (await limitOf(B.id)) === 1);
    ok("  a bad number is refused in words", /Custom domains is a whole number/.test(((await consoleMain.consoleSetLimitOverrides(B.id, { seats: null, copilotTokens: null, customDomains: "-1" })) as { error?: string }).error ?? ""));
    await signInAs("SUPPORT");
    ok("  support cannot", refusedRole(await consoleMain.consoleSetLimitOverrides(B.id, { seats: null, copilotTokens: null, customDomains: 9 })));
    await signInAs("ADMIN");
    const billingActions = require("../src/actions/platform/console-billing") as typeof import("../src/actions/platform/console-billing");
    const planPreview = await billingActions.consolePreviewPlanSave({ ...base, key: PLANS.one, name: "Zz dom one", kind: "EDITION", customDomains: 2 });
    ok("the plan editor's preview shows a plan's custom domains changing", planPreview.ok && planPreview.data.customDomains[0] === 1 && planPreview.data.customDomains[1] === 2, planPreview);
    ok("  and saving it works the workspaces on it out again", (await consoleMain.consoleSavePlan({ ...base, key: PLANS.one, name: "Zz dom one", kind: "EDITION", customDomains: 2 })).ok && (await limitOf(A.id)) === 2);
    ok("  blank in the editor is no limit", (await consoleMain.consoleSavePlan({ ...base, key: PLANS.one, name: "Zz dom one", kind: "EDITION", customDomains: null })).ok && (await limitOf(A.id)) === null);

    section("The console's Domains panel, per role");
    const { DomainsPanel } = require("../src/components/console/workspace/domains-panel") as typeof import("../src/components/console/workspace/domains-panel");
    const { capsFor } = require("../src/lib/console-shared/roles") as typeof import("../src/lib/console-shared/roles");
    const ops = { ...(await domains.workspaceDomains(E.id)), offered: true };
    const panel = (role: (typeof roles)[number]) => text(renderToStaticMarkup(createElement(DomainsPanel, { domains: ops, tenant: { id: E.id, slug: E.slug, status: "ACTIVE" }, caps: capsFor(role) })));
    const adminPanel = panel("ADMIN");
    saveRender("09-console-panel-admin", renderToStaticMarkup(createElement(DomainsPanel, { domains: ops, tenant: { id: E.id, slug: E.slug, status: "ACTIVE" }, caps: capsFor("ADMIN") })));
    ok("it shows the state, the last check and its error, failing since, the TXT record", adminPanel.includes("Stopped — records not found") && adminPanel.includes("Last check") && adminPanel.includes("No TXT record found") && adminPanel.includes(`domain-verify=${eRow.verifyToken}`));
    ok("  an admin gets Add, Check now and Remove", adminPanel.includes("Add address") && adminPanel.includes("Check now") && adminPanel.includes("Remove"));
    const supportPanel = panel("SUPPORT");
    ok("  support gets Check now only", supportPanel.includes("Check now") && !supportPanel.includes("Add address") && !supportPanel.includes("Remove"));
    const readPanel = panel("READONLY");
    ok("  read-only staff get no control", !readPanel.includes("Check now") && !readPanel.includes("Add address") && !readPanel.includes("Remove") && readPanel.includes("erp.zzdom-e.example"));
  } finally {
    consoleToken = null;
    actor = null;
    domains.setTestDomainResolver(null);
    mailer.setTestPlatformMailer(null);
    try {
      await cleanup();
      if (offeredBefore) await control.platformSetting.update({ where: { key: "domains.offered" }, data: { value: offeredBefore.value, updatedBy: offeredBefore.updatedBy } });
      else await control.platformSetting.deleteMany({ where: { key: "domains.offered" } });
      registry.forgetRegistry();
      const leftovers =
        (await control.tenant.count({ where: { slug: { startsWith: PREFIX } } })) +
        (await control.plan.count({ where: { key: { startsWith: PREFIX } } })) +
        (await control.platformUser.count({ where: { email: { endsWith: "@zzdom.example" } } })) +
        (await workspaceDirect.user.count({ where: { email: MEMBER_EMAIL } })) +
        (await workspaceDirect.auditLog.count({ where: { entityType: "CustomDomain", entityLabel: { contains: "zzdom" } } }));
      ok("the fixture is gone, the switch as it was", leftovers === 0 && (await control.platformSetting.findUnique({ where: { key: "domains.offered" } }))?.value === offeredBefore?.value);
    } finally {
      await db.$disconnect();
      await workspaceDirect.$disconnect();
      await closeControlDb();
    }
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll custom-domain checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
