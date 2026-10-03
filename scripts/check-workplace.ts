/**
 * check:workplace — Microsoft 365, Google Workspace and Zoho (owner, 2 Oct 2026): each workspace sets up
 * whichever it uses, for signing in and for people's own mailboxes (src/lib/workplace, src/lib/mail,
 * src/actions/{security,workplace}.ts, src/app/api/mail/[provider]).
 *
 * The pure part needs no database: the providers' names and addresses, Zoho's data centres (and that
 * an accounts server a redirect names must be one of Zoho's), Google's domain rule, the authorize
 * addresses each provider is sent to, and the whole message Gmail is given.
 *
 * The rest builds a scratch workspace database beside the real one (as check:wording does), runs the
 * real code as a workspace pointed at it (`runAsTenant`), and drops it at the end:
 *
 *   · settings: only the super admin's; client IDs checked; secrets encrypted and never shown back;
 *     single sign-on can't be required with no way to do it, nor its last way in switched off;
 *   · signing in: who Google, Zoho and Microsoft may let in (verified, the domain, an account here,
 *     switched on), what Auth.js is given for Google and Zoho, the sign-in page's buttons, and a
 *     password refused while single sign-on is required naming the ways that are;
 *   · mailboxes, against a stand-in Microsoft, Google and Zoho on a local port: connecting through the
 *     real routes (PKCE, state, the provider it was started for, somebody else's account, a missing
 *     permission, Zoho's data centre and an accounts server that isn't Zoho's, no Zoho Mail account);
 *     sending as the person with the PDF attached, through each; refreshing, a retry after one 401, a
 *     failure reported, a withdrawn consent marked broken; a provider switched off for mail;
 *   · sign-in rules, by role and by person: the person's wins over the role's, the role's over the
 *     company's; a password or a provider refused where a rule says so, and told which way to use;
 *     only switched-on sign-ins named; the super admin never bound; a provider people rely on can't
 *     be switched off; a rule goes with its role;
 *   · the screens: the Security cards' redirect addresses, the profile card;
 *   · a workspace still waiting for the migration signs in and sends as before;
 *   · and the real workspace untouched.
 *
 * Never talks to Microsoft, Google or Zoho, and never sends mail.
 *
 *   npm run check:workplace
 */
import "dotenv/config";
import Module from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  MAIL_SLUGS,
  SIGN_IN_IDS,
  WORKPLACE_PROVIDERS,
  ZOHO_REGIONS,
  ZOHO_REGION_KEYS,
  mailCallbackPath,
  mailConnectPath,
  providerOfMailSlug,
  providerOfSignIn,
  readGoogleDomain,
  readZohoRegion,
  sayEither,
  signInCallbackPath,
  type ZohoRegion,
} from "../src/lib/workplace/providers";
import { resolveSignIn } from "../src/lib/workplace/sign-in-rules";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const TAG = "ZZWORKPLACE";
const GOOGLE_CLIENT = "123456789012-zzworkplace.apps.googleusercontent.com";
const GOOGLE_SECRET = "zz-google-secret";
const ZOHO_CLIENT = "1000.ZZWORKPLACE";
const ZOHO_SECRET = "zz-zoho-secret";
const FAKE_PDF = Buffer.from("%PDF-1.4 zz-workplace-check %%EOF");
const PASSWORD = "zz-Workplace-Pass-1";

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
/** Where the page being rendered is, for components that ask (usePathname). */
let pathname = "/settings/security";

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
  UnauthorizedError,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const nextHeaders = {
  headers: async () => new Headers({ host: "zzworkplace.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const email = { sendEmailNotification: async () => {} };
/**
 * NextAuth itself, standing in so the suite holds the real config src/lib/auth.ts builds — its
 * credentials `authorize` and its `signIn` callback are where a sign-in is actually decided.
 */
type AuthConfigShape = {
  providers: { id?: string; options?: { id?: string; authorize?: (credentials: unknown) => Promise<unknown> } }[];
  callbacks: { signIn(m: unknown): Promise<boolean | string> };
};
let authConfig: (() => Promise<AuthConfigShape>) | null = null;
const nextAuthStub = {
  ...(load("next-auth") as Record<string, unknown>),
  __esModule: true,
  default: (config: () => Promise<AuthConfigShape>) => {
    authConfig = config;
    return { handlers: {}, auth: async () => null, signIn: async () => undefined, signOut: async () => undefined };
  },
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/email", email],
  ["next-auth", nextAuthStub],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/email"), email],
  [load.resolve("next-auth"), nextAuthStub],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

/** Awaits every async server component in a tree, so a static render can take it. */
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

// ── A stand-in Microsoft, Google and Zoho ───────────────────────────────────────────────────────

type Who = "ms" | "google" | "zoho";
const stand = {
  msMe: "",
  google: { email: "", verified: true, hd: null as string | null, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send" },
  zoho: { email: "", accounts: [] as Record<string, unknown>[] },
  token: { ms: "ok", google: "ok", zoho: "ok" } as Record<Who, "ok" | "revoked">,
  send: { ms: "ok", google: "ok", zoho: "ok" } as Record<Who, "ok" | "401-once" | "fail">,
  refusedOnce: new Set<Who>(),
  issued: 0,
  tokens: [] as { who: Who; path: string; form: Record<string, string> }[],
  sends: [] as { who: Who; path: string; auth: string; type: string; body: Buffer }[],
};

function startStandIn(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const form = () => Object.fromEntries(new URLSearchParams(body.toString("utf8")));
      const refuseOnce = (who: Who) => {
        if (stand.send[who] === "401-once" && !stand.refusedOnce.has(who)) {
          stand.refusedOnce.add(who);
          return true;
        }
        return false;
      };
      const record = (who: Who) => stand.sends.push({ who, path, auth: String(req.headers.authorization ?? ""), type: String(req.headers["content-type"] ?? ""), body });

      // Microsoft
      if (path === "/ms/zz-tenant/oauth2/v2.0/token" && req.method === "POST") {
        const f = form();
        stand.tokens.push({ who: "ms", path, form: f });
        if (f.client_secret !== "zz-secret") return json(401, { error: "invalid_client" });
        if (stand.token.ms === "revoked") return json(400, { error: "invalid_grant", error_description: "AADSTS50173: The provided grant has expired." });
        stand.issued += 1;
        return json(200, { access_token: `ms-access-${stand.issued}`, refresh_token: `ms-refresh-${stand.issued}`, expires_in: 3600, scope: "User.Read Mail.Send" });
      }
      if (path === "/ms/v1.0/me") return json(200, { mail: stand.msMe, userPrincipalName: stand.msMe, displayName: "Zz Sender" });
      if (path === "/ms/v1.0/me/sendMail" && req.method === "POST") {
        record("ms");
        if (refuseOnce("ms")) return json(401, { error: { message: "Access token has expired." } });
        if (stand.send.ms === "fail") return json(500, { error: { message: "The mailbox is temporarily unavailable." } });
        res.writeHead(202);
        return res.end();
      }

      // Google
      if (path === "/g-oauth2/token" && req.method === "POST") {
        const f = form();
        stand.tokens.push({ who: "google", path, form: f });
        if (f.client_id !== GOOGLE_CLIENT || f.client_secret !== GOOGLE_SECRET) return json(401, { error: "invalid_client" });
        if (stand.token.google === "revoked") return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        stand.issued += 1;
        // Google gives a refresh token for the code only, and keeps it on a refresh.
        return json(200, {
          access_token: `g-access-${stand.issued}`,
          ...(f.grant_type === "authorization_code" ? { refresh_token: `g-refresh-${stand.issued}` } : {}),
          expires_in: 3599,
          scope: stand.google.scope,
          token_type: "Bearer",
        });
      }
      if (path === "/g-openid/v1/userinfo") {
        return json(200, { sub: "zz-sub", email: stand.google.email, email_verified: stand.google.verified, name: "Zz Sender", ...(stand.google.hd ? { hd: stand.google.hd } : {}) });
      }
      if (path === "/g-gmail/upload/gmail/v1/users/me/messages/send" && req.method === "POST") {
        record("google");
        if (refuseOnce("google")) return json(401, { error: { message: "Invalid Credentials" } });
        if (stand.send.google === "fail") return json(500, { error: { message: "Backend Error" } });
        return json(200, { id: "zz-gmail-id", labelIds: ["SENT"] });
      }

      // Zoho, at any of its data centres: /z-<region>-accounts and /z-<region>-mail
      const z = /^\/z-([a-z.]+)-(accounts|mail)(\/.*)$/.exec(path);
      if (z) {
        const [, , kind, rest] = z;
        if (kind === "accounts" && rest === "/oauth/v2/token" && req.method === "POST") {
          const f = form();
          stand.tokens.push({ who: "zoho", path, form: f });
          if (f.client_id !== ZOHO_CLIENT || f.client_secret !== ZOHO_SECRET) return json(200, { error: "invalid_client" });
          // Zoho answers some refusals with a 200.
          if (stand.token.zoho === "revoked") return json(200, { error: "invalid_code" });
          stand.issued += 1;
          return json(200, {
            access_token: `z-access-${stand.issued}`,
            ...(f.grant_type === "authorization_code" ? { refresh_token: `z-refresh-${stand.issued}` } : {}),
            api_domain: "https://www.zohoapis.example",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (kind === "accounts" && rest === "/oauth/user/info") return json(200, { Email: stand.zoho.email, Display_Name: "Zz Sender", ZUID: 7 });
        if (kind === "mail" && rest === "/api/accounts") return json(200, { status: { code: 200 }, data: stand.zoho.accounts });
        if (kind === "mail" && /^\/api\/accounts\/[^/]+\/messages\/attachments$/.test(rest) && req.method === "POST") {
          record("zoho");
          if (refuseOnce("zoho")) return json(401, { status: { code: 401, description: "Invalid OAuthtoken" } });
          return json(200, { status: { code: 200 }, data: [{ storeName: "zz-store", attachmentName: "zz.pdf", attachmentPath: "/Mail/zz-path" }] });
        }
        if (kind === "mail" && /^\/api\/accounts\/[^/]+\/messages$/.test(rest) && req.method === "POST") {
          record("zoho");
          if (stand.send.zoho === "fail") return json(500, { status: { code: 500, description: "Internal error" }, data: { moreInfo: "Mail server busy" } });
          return json(200, { status: { code: 200, description: "success" }, data: {} });
        }
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── The pure part ───────────────────────────────────────────────────────────────────────────────

function pure() {
  section("The three suites, by name and address");
  ok("each sign-in id names its suite, and a password names none", WORKPLACE_PROVIDERS.every((p) => providerOfSignIn(SIGN_IN_IDS[p]) === p) && providerOfSignIn("credentials") === null && providerOfSignIn("linked") === null);
  ok("each mailbox route names its suite", WORKPLACE_PROVIDERS.every((p) => providerOfMailSlug(MAIL_SLUGS[p]) === p) && providerOfMailSlug("yahoo") === null);
  ok("Outlook keeps the redirect address already registered in Entra", mailCallbackPath("MICROSOFT") === "/api/mail/microsoft/callback" && signInCallbackPath("MICROSOFT") === "/api/auth/callback/microsoft-entra-id");
  ok("  Gmail and Zoho Mail have their own", mailCallbackPath("GOOGLE") === "/api/mail/google/callback" && signInCallbackPath("ZOHO") === "/api/auth/callback/zoho");
  ok("a connect link carries where to land", mailConnectPath("GOOGLE", "/profile") === "/api/mail/google/connect?next=%2Fprofile");
  ok("an unknown Zoho data centre is India's", readZohoRegion("mars") === "in" && readZohoRegion("eu") === "eu" && ZOHO_REGION_KEYS.length === 8);
  ok(
    "a Google Workspace domain is just a domain",
    readGoogleDomain("Wroffy.com") === "wroffy.com" && readGoogleDomain("@wroffy.com") === "wroffy.com" && readGoogleDomain("https://wroffy.com") === null && readGoogleDomain("a@wroffy.com") === null,
  );
  ok("names said as a person would", sayEither(["Gmail"]) === "Gmail" && sayEither(["Outlook", "Gmail"]) === "Outlook or Gmail" && sayEither(["Outlook", "Gmail", "Zoho Mail"]) === "Outlook, Gmail or Zoho Mail");
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  pure();

  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_workplace`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  const server = await startStandIn();
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    /* eslint-enable @typescript-eslint/no-require-imports */
    await run(scratchUrl, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its mailboxes and settings are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} workplace checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** What the suite must never change in the real workspace. Read-only. */
async function snapshot(client: PrismaClient): Promise<string> {
  const [mailboxes, workplace, users] = await Promise.all([
    client.mailConnection.findMany({ select: { userId: true, provider: true, mailbox: true, connectedAt: true }, orderBy: { userId: "asc" } }),
    client.workplaceSettings.findUnique({ where: { id: "global" } }).catch(() => null),
    client.user.count({ where: { email: { startsWith: TAG.toLowerCase() } } }),
  ]);
  return JSON.stringify({ mailboxes, workplace, users });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string, base: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { encryptSecret, decryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const ms = require("../src/lib/mail/microsoft") as typeof import("../src/lib/mail/microsoft");
  const google = require("../src/lib/mail/google") as typeof import("../src/lib/mail/google");
  const zoho = require("../src/lib/mail/zoho") as typeof import("../src/lib/mail/zoho");
  const mailbox = require("../src/lib/mail/mailbox") as typeof import("../src/lib/mail/mailbox");
  const connectState = require("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  const settings = require("../src/lib/workplace/settings") as typeof import("../src/lib/workplace/settings");
  const signInRule = require("../src/lib/workplace/sign-in") as typeof import("../src/lib/workplace/sign-in");
  const authProviders = require("../src/lib/workplace/auth-providers") as typeof import("../src/lib/workplace/auth-providers");
  const securityLib = require("../src/lib/security-settings") as typeof import("../src/lib/security-settings");
  const security = require("../src/actions/security") as typeof import("../src/actions/security");
  const workplace = require("../src/actions/workplace") as typeof import("../src/actions/workplace");
  const authActions = require("../src/actions/auth") as typeof import("../src/actions/auth");
  const connectRoute = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
  const callbackRoute = require("../src/app/api/mail/[provider]/callback/route") as typeof import("../src/app/api/mail/[provider]/callback/route");
  const forms = require("../src/components/settings/security-settings-form") as typeof import("../src/components/settings/security-settings-form");
  const { WorkplaceProviderPicker } = require("../src/components/settings/workplace-provider-picker") as typeof import("../src/components/settings/workplace-provider-picker");
  const appForms = require("../src/components/settings/workplace-app-forms") as typeof import("../src/components/settings/workplace-app-forms");
  const { MailboxConnection } = require("../src/components/profile/mailbox-connection") as typeof import("../src/components/profile/mailbox-connection");
  const { SideRail } = require("../src/components/layout/side-rail") as typeof import("../src/components/layout/side-rail");
  const { Watermark } = require("../src/components/security/watermark") as typeof import("../src/components/security/watermark");
  const rules = require("../src/actions/sign-in-rules") as typeof import("../src/actions/sign-in-rules");
  const { RoleSignInRules } = require("../src/components/settings/role-sign-in-rules") as typeof import("../src/components/settings/role-sign-in-rules");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // Every provider address at the stand-in.
  ms.setTestMicrosoftEndpoints({ login: `${base}/ms`, graph: `${base}/ms` });
  google.setTestGoogleEndpoints({ accounts: `${base}/g-accounts`, oauth2: `${base}/g-oauth2`, openid: `${base}/g-openid`, gmail: `${base}/g-gmail` });
  const zohoHosts = Object.fromEntries(ZOHO_REGION_KEYS.map((r) => [r, { accounts: `${base}/z-${r}-accounts`, mail: `${base}/z-${r}-mail` }])) as Record<ZohoRegion, { accounts: string; mail: string }>;
  zoho.setTestZohoRegions(zohoHosts);

  const tenant = {
    id: randomUUID(),
    slug: "zzworkplace",
    name: "zzworkplace",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzworkplace.localhost",
    hosts: ["zzworkplace.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };
  const fresh = () => {
    settings.invalidateWorkplaceSettingsCache();
    securityLib.invalidateSecuritySettingsCache();
  };

  try {
    await runAsTenant(tenant, async () => {
      // ── Fixture ──────────────────────────────────────────────────────────────────────────────
      section("Fixture");
      // Mail on its own: with Calendar on, a connection asks for the calendar too, and the stand-in here
      // grants mail only. Calendars have their own suite (check:calendar).
      await db.systemModule.upsert({ where: { key: "calendar" }, create: { key: "calendar", enabled: false }, update: { enabled: false } });
      const passwordHash = await bcrypt.hash(PASSWORD, 4);
      const person = (key: string, extra: { isSuperAdmin?: boolean; role?: string; active?: boolean } = {}) =>
        db.user.create({
          data: {
            name: `${TAG} ${key}`,
            email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`,
            passwordHash,
            role: extra.role ?? "SALES",
            isSuperAdmin: extra.isSuperAdmin ?? false,
            active: extra.active ?? true,
          },
          select: { id: true, name: true, email: true, role: true },
        });
      const owner = await person("Owner", { isSuperAdmin: true, role: "ADMIN" });
      const rep = await person("Rep", { role: "PROFILE" });
      const sender = await person("Sender");
      const away = await person("Away", { active: false });
      const as = (u: { id: string; name: string; email: string; role: string } | null) => {
        actor = u;
      };
      await db.securitySettings.create({
        data: { id: "global", microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecretCipher: await encryptSecret("zz-secret"), ssoEnabled: false },
      });
      fresh();
      ok("a super admin, a rep, a sender, a switched-off account, and Microsoft's app (sign-in off)", !!owner.id && !!away.id);

      // ── Settings ─────────────────────────────────────────────────────────────────────────────
      section("Settings → Security: Google Workspace and Zoho");
      as(rep);
      ok("a rep sees none of it", (await workplace.getWorkplaceSettings()) === null && (await security.getSecuritySettings()) === null);
      ok("  and changes none of it", !(await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: GOOGLE_SECRET, domain: "", sso: true, mail: true })).ok);
      as(owner);
      const start = await workplace.getWorkplaceSettings();
      ok("the super admin starts with nothing set up, mail on for whatever is", start?.google.clientId === "" && start.google.mail && !start.google.sso && start.zoho.region === "in", start);
      const badId = await workplace.updateGoogleApp({ clientId: "my-app", clientSecret: GOOGLE_SECRET, domain: "", sso: false, mail: true });
      ok("a Google client ID is checked", !badId.ok && /googleusercontent/.test(errorOf(badId) ?? ""), errorOf(badId));
      const noSecret = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: false, mail: true });
      ok("  and needs its secret", !noSecret.ok, errorOf(noSecret));
      const badDomain = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: GOOGLE_SECRET, domain: "https://example.test", sso: false, mail: true });
      ok("  a domain is just a domain", !badDomain.ok, errorOf(badDomain));
      const savedGoogle = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: GOOGLE_SECRET, domain: "", sso: false, mail: true });
      const googleRow = await db.workplaceSettings.findUniqueOrThrow({ where: { id: "global" } });
      ok(
        "saved, the secret encrypted",
        savedGoogle.ok && googleRow.googleClientSecretCipher !== GOOGLE_SECRET && (await decryptSecret(googleRow.googleClientSecretCipher!)) === GOOGLE_SECRET,
        errorOf(savedGoogle),
      );
      const shown = await workplace.getWorkplaceSettings();
      ok(
        "  and never shown back — whether one is set, nothing more",
        shown?.google.hasClientSecret === true &&
          Object.keys(shown.google).sort().join() === "clientId,domain,hasClientSecret,mail,sso" &&
          Object.keys(shown.zoho).sort().join() === "clientId,hasClientSecret,mail,region,sso" &&
          !JSON.stringify(shown).includes(GOOGLE_SECRET),
        shown,
      );
      const badZoho = await workplace.updateZohoApp({ region: "com", clientId: "zoho-app", clientSecret: ZOHO_SECRET, sso: false, mail: true });
      ok("a Zoho client ID is checked", !badZoho.ok, errorOf(badZoho));
      const savedZoho = await workplace.updateZohoApp({ region: "com", clientId: ZOHO_CLIENT, clientSecret: ZOHO_SECRET, sso: false, mail: true });
      ok("  saved, at the data centre chosen", savedZoho.ok && (await db.workplaceSettings.findUniqueOrThrow({ where: { id: "global" } })).zohoRegion === "com", errorOf(savedZoho));
      const audits = await db.auditLog.findMany({ where: { entityType: { in: ["WorkplaceSettings", "SecuritySettings"] } }, select: { entityLabel: true } });
      ok("every change audited, no secret in the log", audits.length >= 2 && audits.every((a) => !a.entityLabel.includes(GOOGLE_SECRET) && !a.entityLabel.includes(ZOHO_SECRET)), audits.map((a) => a.entityLabel));

      section("Single sign-on can't lock people out");
      const nobody = await security.updateSignInPolicy({ enforceTwoFactor: false, enforceSso: true });
      ok("required with no way to do it — refused", !nobody.ok, errorOf(nobody));
      const googleOn = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: true, mail: true });
      fresh();
      ok("Google sign-in on, keeping the saved secret", googleOn.ok && (await settings.signInProviders()).join() === "GOOGLE", errorOf(googleOn));
      const required = await security.updateSignInPolicy({ enforceTwoFactor: true, enforceSso: true });
      ok("then it can be required", required.ok, errorOf(required));
      const lastOff = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: false, mail: true });
      ok("its last way in can't be switched off", !lastOff.ok && /only way in/.test(errorOf(lastOff) ?? ""), errorOf(lastOff));
      ok("  nor its app removed", !(await workplace.removeWorkplaceApp("GOOGLE")).ok);
      ok("  while another provider's card still saves — Google is the way in, not Microsoft", (await security.updateMicrosoftApp({ microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecret: "", sso: false, mail: true })).ok);
      const zohoOn = await workplace.updateZohoApp({ region: "com", clientId: ZOHO_CLIENT, clientSecret: "", sso: true, mail: true });
      const googleOffNow = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: false, mail: true });
      fresh();
      ok("with Zoho on too, Google can go", zohoOn.ok && googleOffNow.ok && (await settings.signInProviders()).join() === "ZOHO", `${errorOf(zohoOn)} ${errorOf(googleOffNow)}`);

      as(sender);
      const pw = await authActions.checkCredentials(sender.email, PASSWORD);
      ok("a password while single sign-on is required: refused, naming the way that is", !pw.ok && /signs in with Zoho/.test(pw.ok ? "" : pw.error), pw);
      as(owner);
      const msOn = await security.updateMicrosoftApp({ microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecret: "", sso: true, mail: true });
      fresh();
      as(sender);
      const pw2 = await authActions.checkCredentials(sender.email, PASSWORD);
      ok("  both, once Microsoft is on as well", msOn.ok && !pw2.ok && /signs in with Microsoft or Zoho/.test(pw2.ok ? "" : pw2.error), pw2);
      const admin = await person("Admin", { role: "ADMIN" });
      as(admin);
      const adminPw = await authActions.checkCredentials(admin.email, PASSWORD);
      ok("  while an admin's password still works — the way back in if single sign-on breaks", adminPw.ok, adminPw);
      as(owner);
      ok("back to passwords allowed", (await security.updateSignInPolicy({ enforceTwoFactor: false, enforceSso: false })).ok);
      await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: true, mail: true });
      fresh();

      // ── Signing in ───────────────────────────────────────────────────────────────────────────
      section("Who Microsoft, Google and Zoho may let in");
      const v = (provider: "MICROSOFT" | "GOOGLE" | "ZOHO", address: string, profile: Record<string, unknown> = {}) => signInRule.ssoVerdict(provider, address, profile);
      const unverified = await v("GOOGLE", sender.email, { email_verified: false });
      ok("an address Google hasn't verified — no", !unverified.ok && /verified/.test(unverified.ok ? "" : unverified.reason));
      const shouted = await v("GOOGLE", sender.email.toUpperCase(), { email_verified: true });
      ok("  a verified one, however it is cased — the account here", shouted.ok && shouted.user.id === sender.id);
      await db.workplaceSettings.update({ where: { id: "global" }, data: { googleDomain: "example.test" } });
      fresh();
      const outside = await v("GOOGLE", sender.email, { email_verified: true, hd: "elsewhere.test" });
      const inside = await v("GOOGLE", sender.email, { email_verified: true, hd: "example.test" });
      ok("kept to the company's Google domain: another domain's account — no; its own — yes", !outside.ok && inside.ok);
      const stranger = await v("ZOHO", "nobody@example.test");
      ok("an address with no account here — no, never a new account", !stranger.ok && stranger.user === null && (await db.user.count({ where: { email: "nobody@example.test" } })) === 0);
      const switchedOff = await v("MICROSOFT", away.email);
      ok("  a switched-off account — no", !switchedOff.ok && /deactivated/.test(switchedOff.ok ? "" : switchedOff.reason));

      section("What Auth.js is given");
      const given = (await authProviders.workplaceSignInProviders()) as unknown as { id: string; options: Record<string, unknown> }[];
      const g = given.find((p) => p.id === "google");
      const zo = given.find((p) => p.id === "zoho");
      ok("Google and Zoho, as switched on", given.map((p) => p.id).join() === "google,zoho", given.map((p) => p.id));
      const gAuth = g?.options.authorization as { params?: Record<string, string> } | undefined;
      ok("  Google: the company's client, its domain steering the account picker", g?.options.clientId === GOOGLE_CLIENT && g.options.clientSecret === GOOGLE_SECRET && gAuth?.params?.hd === "example.test");
      const gProfile = (g?.options.profile as (p: Record<string, unknown>) => { email: string }) ?? null;
      ok("  …and an address lower-cased as accounts here are", gProfile?.({ sub: "1", email: "Zz@Example.TEST", name: "Z" }).email === "zz@example.test");
      const accounts = ZOHO_REGIONS.com.accounts;
      ok(
        "  Zoho: its data centre's servers, the secret in the form, the state checked",
        zo?.options.token === `${accounts}/oauth/v2/token` &&
          (zo.options.authorization as { url?: string }).url === `${accounts}/oauth/v2/auth` &&
          (zo.options.client as { token_endpoint_auth_method?: string }).token_endpoint_auth_method === "client_secret_post" &&
          JSON.stringify(zo.options.checks) === '["state"]',
        zo?.options.token,
      );

      section("The sign-in page");
      let loginText = "";
      try {
        const LoginPage = (require("../src/app/(auth)/login/page") as { default: (p: unknown) => Promise<ReactElement> }).default; // eslint-disable-line @typescript-eslint/no-require-imports
        loginText = textOf(renderToStaticMarkup((await resolveAsync(await LoginPage({ searchParams: Promise.resolve({}) }))) as ReactElement));
      } catch (err) {
        loginText = `render failed: ${(err as Error).message}`;
      }
      ok("a button for each sign-in switched on", ["Microsoft", "Google", "Zoho"].every((n) => loginText.includes(`Sign in with ${n}`)), loginText.slice(0, 300));
      await workplace.updateZohoApp({ region: "com", clientId: ZOHO_CLIENT, clientSecret: "", sso: false, mail: true });
      fresh();
      ok("  and none for one switched off", (await settings.signInProviders()).join() === "MICROSOFT,GOOGLE");
      await db.workplaceSettings.update({ where: { id: "global" }, data: { googleDomain: null } });
      fresh();

      // ── Mailboxes ────────────────────────────────────────────────────────────────────────────
      section("Connecting Gmail, through the real routes");
      as(sender);
      ok("nothing connected yet: all three offered", JSON.stringify(await mailbox.mailboxState(sender.id)) === JSON.stringify({ state: "not-connected", providers: ["MICROSOFT", "GOOGLE", "ZOHO"] }));
      const origin = "http://zzworkplace.localhost";
      const params = (provider: string) => ({ params: Promise.resolve({ provider }) });
      const startAt = async (provider: string) => {
        const res = await connectRoute.GET(new NextRequest(`${origin}/api/mail/${provider}/connect?next=/profile`), params(provider));
        const to = new URL(res.headers.get("location") ?? "about:blank");
        return { to, cookie: res.cookies.get(connectState.CONNECT_COOKIE)?.value ?? "", path: res.cookies.get(connectState.CONNECT_COOKIE)?.path };
      };
      const comeBack = async (provider: string, cookie: string, query: Record<string, string>) => {
        const url = new URL(`${origin}/api/mail/${provider}/callback`);
        for (const [k, val] of Object.entries(query)) url.searchParams.set(k, val);
        const res = await callbackRoute.GET(new NextRequest(url, { headers: { cookie: `${connectState.CONNECT_COOKIE}=${cookie}` } }), params(provider));
        return new URL(res.headers.get("location") ?? "about:blank");
      };
      stand.google.email = sender.email;
      const goG = await startAt("google");
      ok(
        "off to the company's Google app, asking to send mail and for a refresh token, with PKCE",
        goG.to.origin === base &&
          goG.to.pathname === "/g-accounts/o/oauth2/v2/auth" &&
          goG.to.searchParams.get("client_id") === GOOGLE_CLIENT &&
          /gmail\.send/.test(goG.to.searchParams.get("scope") ?? "") &&
          goG.to.searchParams.get("access_type") === "offline" &&
          goG.to.searchParams.get("code_challenge_method") === "S256" &&
          goG.to.searchParams.get("redirect_uri") === `${origin}/api/mail/google/callback`,
        goG.to.toString(),
      );
      ok("  the round trip's state in a cookie for the mail routes", !!goG.cookie && goG.path === "/api/mail");
      const state = goG.to.searchParams.get("state") ?? "";
      const wrongDoor = await comeBack("zoho", goG.cookie, { code: "zz-code", state });
      ok("brought back to another provider's door — refused", wrongDoor.searchParams.get("mailbox") === "expired");
      const forged = await comeBack("google", goG.cookie, { code: "zz-code", state: "not-the-state" });
      ok("  with another state — refused", forged.searchParams.get("mailbox") === "expired");
      stand.google.email = "someone.else@example.test";
      const theirs = await comeBack("google", goG.cookie, { code: "zz-code", state });
      ok("somebody else's Google account — refused, nothing kept", theirs.searchParams.get("mailbox") === "mismatch" && !(await db.mailConnection.findUnique({ where: { userId: sender.id } })));
      stand.google.email = sender.email;
      stand.google.scope = "openid https://www.googleapis.com/auth/userinfo.email";
      ok("  sending unticked on Google's screen — refused, saying so", (await comeBack("google", goG.cookie, { code: "zz-code", state })).searchParams.get("mailbox") === "no-permission");
      stand.google.scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";
      stand.google.verified = false;
      ok("  an address Google hasn't verified — refused", (await comeBack("google", goG.cookie, { code: "zz-code", state })).searchParams.get("mailbox") === "mismatch");
      stand.google.verified = true;
      stand.tokens = [];
      const connected = await comeBack("google", goG.cookie, { code: "zz-code", state });
      const grant = stand.tokens.find((t) => t.who === "google");
      const challenge = goG.to.searchParams.get("code_challenge");
      ok("their own account, sending allowed: connected", connected.searchParams.get("mailbox") === "connected" && connected.searchParams.get("via") === "google" && connected.pathname === "/profile", connected.toString());
      ok(
        "  the code spent with the company's secret and the verifier behind the challenge",
        grant?.form.client_secret === GOOGLE_SECRET && createHash("sha256").update(grant.form.code_verifier ?? "").digest("base64url") === challenge && grant.form.redirect_uri === `${origin}/api/mail/google/callback`,
      );
      const gRow = await db.mailConnection.findUniqueOrThrow({ where: { userId: sender.id } });
      ok("  kept as a Gmail mailbox, the refresh token encrypted", gRow.provider === "GOOGLE" && gRow.mailbox === sender.email && gRow.refreshTokenCipher.length > 20 && (await decryptSecret(gRow.refreshTokenCipher)).startsWith("g-refresh-"));
      ok("  and audited", (await db.auditLog.count({ where: { entityType: "MailConnection", entityLabel: { startsWith: "Gmail connected" } } })) === 1);

      section("Sending from Gmail");
      const mail = {
        subject: "Tax invoice ₹1,200 — Zz",
        html: "<p>Dear Rahul, please find the invoice attached.</p>",
        to: [
          { name: "Rahul Mehta", email: "rahul@customer.example" },
          { name: null, email: "priya@customer.example" },
        ],
        attachments: [{ name: "Tax-invoice-ZZ-1.pdf", contentType: "application/pdf", bytes: FAKE_PDF }],
      };
      stand.sends = [];
      const sentG = await mailbox.sendAsUser(sender.id, mail);
      const gSend = stand.sends.find((s) => s.who === "google");
      const raw = gSend?.body.toString("utf8") ?? "";
      ok("it sends, through Gmail", sentG.ok && sentG.provider === "GOOGLE" && sentG.mailbox === sender.email, sentG);
      ok("  the whole message, as the person, with their token", gSend?.type === "message/rfc822" && /^Bearer g-access-/.test(gSend.auth) && raw.includes(sender.email));
      ok("  to exactly the people given, the subject encoded for any language", raw.includes("rahul@customer.example") && raw.includes("priya@customer.example") && /Subject: =\?UTF-8\?/i.test(raw));
      ok("  the PDF attached, named for the document", raw.includes("Tax-invoice-ZZ-1.pdf") && raw.includes(FAKE_PDF.toString("base64")));
      await db.mailConnection.update({ where: { userId: sender.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
      stand.tokens = [];
      const afterExpiry = await mailbox.sendAsUser(sender.id, mail);
      const kept = await db.mailConnection.findUniqueOrThrow({ where: { userId: sender.id } });
      ok("an expired token is refreshed and the send goes", afterExpiry.ok && stand.tokens.some((t) => t.who === "google" && t.form.grant_type === "refresh_token"));
      ok("  Google's refresh token kept, as Google keeps it", (await decryptSecret(kept.refreshTokenCipher)) === (await decryptSecret(gRow.refreshTokenCipher)));
      stand.send.google = "401-once";
      stand.sends = [];
      const retried = await mailbox.sendAsUser(sender.id, mail);
      const auths = stand.sends.filter((s) => s.who === "google").map((s) => s.auth);
      ok("one 401: a fresh token and one more try", retried.ok && auths.length === 2 && auths[0] !== auths[1], auths);
      stand.send.google = "fail";
      const failedG = await mailbox.sendAsUser(sender.id, mail);
      ok("Gmail failing: reported, and kept against the mailbox", !failedG.ok && /Backend Error/.test(failedG.ok ? "" : failedG.error) && (await db.mailConnection.findUniqueOrThrow({ where: { userId: sender.id } })).lastError === "Backend Error");
      stand.send.google = "ok";

      section("Connecting Zoho Mail, at the person's data centre");
      stand.zoho.email = sender.email;
      stand.zoho.accounts = [{ accountId: "zz-acc-1", primaryEmailAddress: sender.email.toUpperCase(), emailAddress: [{ mailId: sender.email, isPrimary: true }] }];
      const goZ = await startAt("zoho");
      ok(
        "off to the company's data centre, asking for Zoho Mail, offline",
        goZ.to.pathname === "/z-com-accounts/oauth/v2/auth" && goZ.to.searchParams.get("client_id") === ZOHO_CLIENT && /ZohoMail\.messages\.CREATE/.test(goZ.to.searchParams.get("scope") ?? "") && goZ.to.searchParams.get("access_type") === "offline",
        goZ.to.toString(),
      );
      const zState = goZ.to.searchParams.get("state") ?? "";
      stand.tokens = [];
      const evil = await comeBack("zoho", goZ.cookie, { code: "zz-code", state: zState, "accounts-server": "https://accounts.zoho.evil.example" });
      ok("an accounts server that isn't Zoho's — refused, and the secret never sent", evil.searchParams.get("mailbox") === "failed" && stand.tokens.length === 0);
      stand.zoho.accounts = [];
      ok("  no Zoho Mail account for their address — refused, saying so", (await comeBack("zoho", goZ.cookie, { code: "zz-code", state: zState, "accounts-server": zohoHosts.eu.accounts })).searchParams.get("mailbox") === "no-mailbox");
      stand.zoho.accounts = [{ accountId: "zz-acc-1", primaryEmailAddress: sender.email.toUpperCase(), emailAddress: [{ mailId: sender.email, isPrimary: true }] }];
      stand.tokens = [];
      const zConnected = await comeBack("zoho", goZ.cookie, { code: "zz-code", state: zState, "accounts-server": zohoHosts.eu.accounts });
      const zRow = await db.mailConnection.findUniqueOrThrow({ where: { userId: sender.id }, select: { provider: true, mailbox: true, zohoAccountsServer: true, zohoMailAccountId: true } });
      ok("connected, the code spent where Zoho said the account is", zConnected.searchParams.get("mailbox") === "connected" && stand.tokens.every((t) => t.path.startsWith("/z-eu-accounts/")) && stand.tokens.length === 1, zConnected.toString());
      ok("  replacing Gmail: one mailbox a person", zRow.provider === "ZOHO" && zRow.zohoAccountsServer === zohoHosts.eu.accounts && zRow.zohoMailAccountId === "zz-acc-1", zRow);

      section("Sending from Zoho Mail");
      stand.sends = [];
      const sentZ = await mailbox.sendAsUser(sender.id, mail);
      const upload = stand.sends.find((s) => s.who === "zoho" && s.path.endsWith("/attachments"));
      const message = stand.sends.find((s) => s.who === "zoho" && s.path.endsWith("/messages"));
      const zBody = message ? (JSON.parse(message.body.toString("utf8")) as Record<string, unknown>) : {};
      ok("it sends, through Zoho Mail at the person's data centre", sentZ.ok && sentZ.provider === "ZOHO" && !!message?.path.startsWith("/z-eu-mail/api/accounts/zz-acc-1/"), sentZ);
      ok("  the PDF uploaded first, with Zoho's own token header", !!upload && upload.auth.startsWith("Zoho-oauthtoken z-access-") && upload.body.indexOf(FAKE_PDF) >= 0 && upload.body.toString("latin1").includes("Tax-invoice-ZZ-1.pdf"));
      ok(
        "  then the message, from their address, to the people given, naming the upload",
        zBody.fromAddress === sender.email.toUpperCase() &&
          zBody.toAddress === "rahul@customer.example,priya@customer.example" &&
          zBody.mailFormat === "html" &&
          JSON.stringify(zBody.attachments) === JSON.stringify([{ storeName: "zz-store", attachmentPath: "/Mail/zz-path", attachmentName: "zz.pdf" }]),
        zBody,
      );
      stand.token.zoho = "revoked";
      await db.mailConnection.update({ where: { userId: sender.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
      const withdrawn = await mailbox.sendAsUser(sender.id, mail);
      ok("a withdrawn consent stops the send, saying so", !withdrawn.ok && /Zoho stopped accepting your Zoho Mail connection/.test(withdrawn.ok ? "" : withdrawn.error), withdrawn);
      ok("  and is marked broken until connected again", (await mailbox.mailboxState(sender.id)).state === "broken");
      stand.token.zoho = "ok";

      section("Outlook, through the same door");
      stand.msMe = sender.email;
      const goM = await startAt("microsoft");
      const mState = goM.to.searchParams.get("state") ?? "";
      const mConnected = await comeBack("microsoft", goM.cookie, { code: "zz-code", state: mState });
      stand.sends = [];
      const sentM = await mailbox.sendAsUser(sender.id, mail);
      const graph = stand.sends.find((s) => s.who === "ms");
      const graphBody = graph ? (JSON.parse(graph.body.toString("utf8")) as { message: { attachments: { contentBytes: string }[] }; saveToSentItems: boolean }) : null;
      ok("connected and sending as before", mConnected.searchParams.get("mailbox") === "connected" && sentM.ok && sentM.provider === "MICROSOFT" && graphBody?.saveToSentItems === true, mConnected.toString());
      ok("  the PDF attached", graphBody?.message.attachments[0]?.contentBytes === FAKE_PDF.toString("base64"));

      section("A provider switched off for mail");
      as(owner);
      await security.updateMicrosoftApp({ microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecret: "", sso: true, mail: false });
      fresh();
      as(sender);
      const offState = await mailbox.mailboxState(sender.id);
      ok("an Outlook mailbox no longer counts: connect one the company uses", offState.state === "not-connected" && JSON.stringify(offState) === JSON.stringify({ state: "not-connected", providers: ["GOOGLE", "ZOHO"] }), offState);
      const offSend = await mailbox.sendAsUser(sender.id, mail);
      ok("  and nothing goes out through it", !offSend.ok && /doesn't send mail through Microsoft 365/.test(offSend.ok ? "" : offSend.error), offSend);

      // ── The screens ──────────────────────────────────────────────────────────────────────────
      section("The screens");
      const origins = ["http://zzworkplace.localhost", "https://crm.example.test"];
      const gForm = renderToStaticMarkup(createElement(appForms.GoogleAppForm, { settings: { clientId: GOOGLE_CLIENT, hasClientSecret: true, domain: "", sso: true, mail: true }, origins }));
      ok(
        "the Google card: sign-in and Gmail redirect addresses for every address the workspace answers at",
        origins.every((o) => gForm.includes(`${o}/api/auth/callback/google`) && gForm.includes(`${o}/api/mail/google/callback`)) && !gForm.includes(GOOGLE_SECRET),
      );
      const zForm = renderToStaticMarkup(createElement(appForms.ZohoAppForm, { settings: { clientId: ZOHO_CLIENT, hasClientSecret: true, region: "eu", sso: false, mail: true }, origins }));
      ok("the Zoho card: its addresses, and the API console of the data centre chosen", origins.every((o) => zForm.includes(`${o}/api/auth/callback/zoho`)) && zForm.includes("api-console.zoho.eu"));
      const mForm = renderToStaticMarkup(createElement(forms.MicrosoftAppForm, { settings: { tenantId: "zz-tenant", clientId: "zz-client", hasClientSecret: true, sso: true, mail: true }, origins }));
      ok("the Microsoft card: the addresses already registered, unchanged", origins.every((o) => mForm.includes(`${o}/api/auth/callback/microsoft-entra-id`) && mForm.includes(`${o}/api/mail/microsoft/callback`)));
      const unconfiguredMicrosoft = { tenantId: "", clientId: "", hasClientSecret: false, sso: false, mail: true };
      const picked = renderToStaticMarkup(
        createElement(WorkplaceProviderPicker, {
          microsoft: unconfiguredMicrosoft,
          google: { clientId: GOOGLE_CLIENT, hasClientSecret: true, domain: "", sso: true, mail: true },
          zoho: { clientId: "", hasClientSecret: false, region: "in", sso: false, mail: true },
          origins,
        }),
      );
      ok(
        "one card: the company picks its suite and sees only that one — the one it uses, marked set up",
        picked.includes("/api/auth/callback/google") && !picked.includes("/api/auth/callback/zoho") && !picked.includes("/api/auth/callback/microsoft-entra-id") && textOf(picked).includes("Set up"),
      );
      const nothingYet = renderToStaticMarkup(createElement(WorkplaceProviderPicker, { microsoft: unconfiguredMicrosoft, google: null, zoho: null, origins }));
      ok("  nothing set up yet: Microsoft first, as before", nothingYet.includes("/api/auth/callback/microsoft-entra-id") && !nothingYet.includes("/api/auth/callback/google"));
      const policy = textOf(renderToStaticMarkup(createElement(forms.SignInPolicyForm, { settings: { enforceTwoFactor: true, enforceSso: false }, signInWith: ["Microsoft", "Google"] })));
      ok("the sign-in card: who requiring single sign-on would mean — and no app to pick, any authenticator works", policy.includes("Microsoft or Google") && !policy.includes("Authenticator app"));
      const card = renderToStaticMarkup(createElement(MailboxConnection, { providers: ["GOOGLE", "ZOHO"], connection: null, outcome: "connected", via: "zoho" }));
      ok(
        "the profile card: a Connect for each mailbox the company offers, and what came back said for its provider",
        card.includes('href="/api/mail/google/connect?next=%2Fprofile"') && textOf(card).includes("Connect Zoho Mail") && textOf(card).includes("Zoho Mail connected"),
      );

      const railFor = (supportAccess: { inside: boolean } | null) => renderToStaticMarkup(createElement(SideRail, { supportAccess }));
      const noDoor = railFor(null);
      const door = railFor({ inside: false });
      const doorIn = railFor({ inside: true });
      ok("the right rail: a door for Deskzo support, for the super admin only", !noDoor.includes("Deskzo support access") && door.includes('aria-label="Deskzo support access"'));
      ok("  saying so while support can see the workspace", doorIn.includes("support can see your workspace now") && !door.includes("support can see your workspace now"));

      const marked = (at: string, scope: "CUSTOMER_DATA" | "EVERY_PAGE") => {
        pathname = at;
        return renderToStaticMarkup(createElement(Watermark, { label: "Zz Sender · zz@example.test", opacity: 7, scope })).includes("Zz Sender");
      };
      ok("the watermark on a company's page, kept to customer pages", marked("/companies/cmp_1", "CUSTOMER_DATA"));
      ok("  and not on settings", !marked("/settings/security", "CUSTOMER_DATA"));
      ok("  unless the workspace wants it on every page", marked("/settings/security", "EVERY_PAGE"));
      pathname = "/settings/security";

      // ── Sign-in rules ──────────────────────────────────────────────────────────────────────────
      section("Sign-in rules, by role and by person");
      fresh();
      const ruleCase = { isSuperAdmin: false, role: "SALES", enforceSso: false, offered: ["MICROSOFT", "GOOGLE"] as ("MICROSOFT" | "GOOGLE" | "ZOHO")[] };
      ok(
        "a person's rule wins over their role's, the role's over the company's",
        resolveSignIn({ ...ruleCase, personRule: "PASSWORD", roleRule: "MICROSOFT" }).method === "PASSWORD" &&
          resolveSignIn({ ...ruleCase, personRule: null, roleRule: "MICROSOFT" }).providers.join() === "MICROSOFT" &&
          resolveSignIn({ ...ruleCase, personRule: null, roleRule: null }).password,
      );
      ok("  the super admin is never bound by one", resolveSignIn({ ...ruleCase, isSuperAdmin: true, personRule: "MICROSOFT", roleRule: null }).password);
      ok(
        "  with no rule, single sign-on required keeps admins on their password, and only them",
        resolveSignIn({ ...ruleCase, role: "ADMIN", enforceSso: true, personRule: null, roleRule: null }).password &&
          !resolveSignIn({ ...ruleCase, enforceSso: true, personRule: null, roleRule: null }).password,
      );
      ok("  and a rule never opens a sign-in the company closed", resolveSignIn({ ...ruleCase, personRule: "ZOHO", roleRule: null }).providers.length === 0);

      as(rep);
      ok("a rep can neither see nor set them", (await rules.getRoleSignInRules()) === null && !(await rules.setRoleSignIn({ role: "SALES", method: "MICROSOFT" })).ok);
      as(owner);
      const zohoRule = await rules.setRoleSignIn({ role: "SALES", method: "ZOHO" });
      ok("a rule can only name a sign-in that is switched on — Zoho is off", !zohoRule.ok && /Zoho sign-in isn't switched on/.test(errorOf(zohoRule) ?? ""), errorOf(zohoRule));
      const salesMicrosoft = await rules.setRoleSignIn({ role: "SALES", method: "MICROSOFT" });
      ok("the Sales role tied to Microsoft", salesMicrosoft.ok, errorOf(salesMicrosoft));

      as(sender);
      const salesPassword = await authActions.checkCredentials(sender.email, PASSWORD);
      ok("  a salesperson's right password is refused, naming Microsoft", !salesPassword.ok && /signs in with Microsoft/.test(salesPassword.ok ? "" : salesPassword.error), salesPassword);
      const salesGoogle = await signInRule.ssoVerdict("GOOGLE", sender.email, { email_verified: true });
      ok("  so is their Google sign-in, saying the way they do use", !salesGoogle.ok && JSON.stringify(salesGoogle.ok ? null : salesGoogle.use) === '["MICROSOFT"]', salesGoogle);
      ok("  while Microsoft lets them in", (await signInRule.ssoVerdict("MICROSOFT", sender.email, {})).ok);
      if (!authConfig) throw new Error("src/lib/auth.ts never built its config");
      const config = await (authConfig as () => Promise<AuthConfigShape>)();
      const authorize = config.providers.find((p) => (p.options?.id ?? p.id) === "credentials")?.options?.authorize;
      ok("  the sign-in itself refuses their password — not just the form's check", !!authorize && (await authorize({ email: sender.email, password: PASSWORD, totpCode: "" })) === null);
      const sentBack = await config.callbacks.signIn({ user: { email: sender.email }, account: { provider: "google" }, profile: { email_verified: true } });
      ok("  and sends a Google sign-in back to the sign-in page, saying to use Microsoft", sentBack === "/login?use=MICROSOFT", sentBack);
      ok("  and linked sign-in asks them for Microsoft", (await signInRule.ssoProviderFor(sender.id, ["MICROSOFT"])) === "MICROSOFT");

      as(owner);
      const personPassword = await rules.setPersonSignIn({ userId: sender.id, method: "PASSWORD" });
      as(sender);
      ok(
        "a person's own rule wins: password only for this salesperson, Microsoft refused",
        personPassword.ok && (await authActions.checkCredentials(sender.email, PASSWORD)).ok && !(await signInRule.ssoVerdict("MICROSOFT", sender.email, {})).ok,
        errorOf(personPassword),
      );
      as(owner);
      const backToRole = await rules.setPersonSignIn({ userId: sender.id, method: null });
      const shownState = await rules.getPersonSignIn(sender.id);
      ok(
        "  back to their role's — and Staff & roles says how they sign in now",
        backToRole.ok && shownState?.method === null && shownState.roleMethod === "MICROSOFT" && shownState.ways === "Microsoft",
        shownState,
      );
      const superAdminRule = await rules.setPersonSignIn({ userId: owner.id, method: "MICROSOFT" });
      ok("the super admin can't be given a rule — they always keep their password", !superAdminRule.ok && /super admin always keeps/.test(errorOf(superAdminRule) ?? ""), errorOf(superAdminRule));
      const msOffWhileRelied = await security.updateMicrosoftApp({ microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecret: "", sso: false, mail: false });
      ok(
        "Microsoft sign-in can't be switched off while the Sales role relies on it",
        !msOffWhileRelied.ok && /Sales/.test(errorOf(msOffWhileRelied) ?? ""),
        errorOf(msOffWhileRelied),
      );

      const roleData = await rules.getRoleSignInRules();
      const roleTable = renderToStaticMarkup(createElement(RoleSignInRules, { roles: roleData?.roles ?? [], choices: roleData?.choices ?? [] }));
      ok(
        "the rules by role list every role, Sales on Microsoft only, and offer only switched-on sign-ins",
        textOf(roleTable).includes("Sales") && roleTable.includes('value="MICROSOFT" selected=""') && !roleTable.includes('value="ZOHO"'),
        roleData?.choices,
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Login = (require("../src/app/(auth)/login/page") as { default: (p: unknown) => Promise<ReactElement> }).default;
      const refusedPage = textOf(renderToStaticMarkup((await resolveAsync(await Login({ searchParams: Promise.resolve({ use: "MICROSOFT,EVIL" }) }))) as ReactElement));
      ok("the sign-in page says which way a refused account uses — only names it knows", refusedPage.includes("This account signs in with Microsoft.") && !refusedPage.includes("EVIL"));

      const salesOnGoogle = await rules.setRoleSignIn({ role: "SALES", method: "GOOGLE" });
      const googleOffWhileRelied = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: false, mail: true });
      ok(
        "nor Google sign-in while the Sales role relies on it — nor its app removed",
        salesOnGoogle.ok && !googleOffWhileRelied.ok && /Sales.*without Google/.test(errorOf(googleOffWhileRelied) ?? "") && !(await workplace.removeWorkplaceApp("GOOGLE")).ok,
        errorOf(salesOnGoogle) ?? errorOf(googleOffWhileRelied),
      );
      await rules.setRoleSignIn({ role: "SALES", method: "SSO" });
      const googleOffForAny = await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: false, mail: true });
      const lastOffForAny = await security.updateMicrosoftApp({ microsoftTenantId: "zz-tenant", microsoftClientId: "zz-client", microsoftClientSecret: "", sso: false, mail: false });
      ok(
        "a role on any single sign-on lets one go while another is left — but not the last",
        googleOffForAny.ok && !lastOffForAny.ok && /Sales.*without Microsoft/.test(errorOf(lastOffForAny) ?? ""),
        errorOf(googleOffForAny) ?? errorOf(lastOffForAny),
      );
      await workplace.updateGoogleApp({ clientId: GOOGLE_CLIENT, clientSecret: "", domain: "", sso: true, mail: true });
      await rules.setRoleSignIn({ role: "SALES", method: "MICROSOFT" });

      await db.role.create({ data: { key: "ZZ_FIELD", name: "Zz Field" } });
      const fieldRule = await rules.setRoleSignIn({ role: "ZZ_FIELD", method: "GOOGLE" });
      await db.role.delete({ where: { key: "ZZ_FIELD" } });
      ok("a rule goes with its role", fieldRule.ok && (await db.signInRule.count({ where: { roleKey: "ZZ_FIELD" } })) === 0, errorOf(fieldRule));
      ok("everything audited", (await db.auditLog.count({ where: { entityType: "SignInRule" } })) >= 4);
      await rules.setRoleSignIn({ role: "SALES", method: null });

      // ── Before the migration ─────────────────────────────────────────────────────────────────
      section("A workspace still waiting for the migration");
      await db.$executeRawUnsafe(`DROP TABLE "workplace_settings"`);
      await db.$executeRawUnsafe(`DROP TABLE "sign_in_rules"`);
      fresh();
      const stillSecurity = await securityLib.getCachedSecuritySettings();
      ok("sign-in still reads its settings", stillSecurity?.ssoEnabled === true && stillSecurity.microsoftClientId === "zz-client");
      ok("  Microsoft as before, and no Google or Zoho", (await settings.signInProviders()).join() === "MICROSOFT" && (await authProviders.workplaceSignInProviders()).length === 0);
      ok("  Outlook offered for mail, as it always was", (await settings.mailProviders()).join() === "MICROSOFT");
      as(sender);
      ok("  and with no rules table, a password signs in by the company's setting", (await authActions.checkCredentials(sender.email, PASSWORD)).ok);
      as(owner);
      ok("  and the Security page leaves the Google and Zoho cards out", (await workplace.getWorkplaceSettings()) === null);
    });
  } finally {
    ms.setTestMicrosoftEndpoints(null);
    google.setTestGoogleEndpoints(null);
    zoho.setTestZohoRegions(null);
    actor = null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
