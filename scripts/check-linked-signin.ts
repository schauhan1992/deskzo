/**
 * check:linked-signin — linked sign-in (one person's accounts in several workspaces, and switching
 * between them) and "find my workspace"'s email index, for real (spec §9.1, owner decisions 3, 6, 7, 8).
 *
 * On a scratch control plane, with three workspaces set up as signup sets them up — zzlink-a, zzlink-b
 * and zzlink-c, each with its own database, role, keys and owner (every one dropped at the end, pass
 * or fail):
 *
 *   1.    tokens verify only for their workspace, kind and claims, and only their hash is stored;
 *   2–4.  linking (L1–L4), each of its refusals, groups merging, the conflict and the cap of 20;
 *   5–6.  switching (S1–S4) and every check the target makes (§4.5) — owner decision 3 included;
 *   7.    nothing is carried across: not a view-as session, not a support account; a new sign-in;
 *         the pause — the console's switch (decision 8) and the script — keeps the list, refuses the rest;
 *   8.    every way a link ends, each emailed (decision 7), and the nightly sweep;
 *   9.    nobody is shown another workspace's name;
 *   10.   the email index, and the lookup ceiling it raises (decision 6);
 *   11.   the pages and cards render with no session;
 *   11b.  every new account's setup email, and the one-step invite: added with "already uses another
 *         workspace", set up and linked in one go;
 *   11c.  no password until its person chooses one; the setup link when mail fails; "Resend setup email";
 *         "Invitation pending"; HR's conversion and an import made the same way;
 *   12.   every database made is dropped.
 *
 * The library (src/lib/platform/linked/) is called directly, with sessions made as a sign-in makes them
 * (`recordSignIn`); the actions only where the browser is the point — cookies, view-as, the "linked"
 * provider, the admin card — with the session stubbed and the real NextAuth configuration behind a
 * stand-in for next-auth itself. No mail leaves: the platform mailer is replaced. Nothing waits for
 * the clock: expiries are moved in the rows.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@prisma/client";
import type { JoinSide, RevokeReason } from "../src/lib/platform/linked/groups";
import type { SwitchState } from "../src/lib/platform/linked/switch";
import type { Tenant } from "../src/lib/tenancy/state";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.REFERENCE_DATABASE_URL = "";
// Behind "our proxy", so every caller has an address and the per-caller limits and IP rules apply.
process.env.TRUST_PROXY = "1";
process.env.TRUST_PROXY_HOPS = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

const ROOT = path.resolve(__dirname, "..");
const TOKEN = /[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}/;
const VIEW_AS = "Linked workspaces are only for your own account. Switch back to yourself first.";
const PAUSED = "Switching between workspaces is paused. Sign in to each workspace directly.";
const SUPPORT = "Platform support accounts can't be linked.";

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const tally: { title: string; passed: number; failed: number }[] = [];
const show = (detail: unknown) => (detail instanceof Error ? `${detail.name}: ${detail.message}` : typeof detail === "string" ? detail : JSON.stringify(detail));
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${show(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
  const current = tally.at(-1);
  if (current) current[pass ? "passed" : "failed"] += 1;
};
const section = (title: string) => {
  console.log(`\n${title}`);
  tally.push({ title, passed: 0, failed: 0 });
};
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const until = async (done: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  return done();
};

// ─── A request, as the code under test reads one: a host per step, a caller, a browser's cookies ─
class Redirect extends Error {
  constructor(
    public url: string,
    public via: string,
  ) {
    super(`redirect (${via}) to ${url}`);
    this.name = "Redirect";
  }
}
class NotFound extends Error {
  constructor() {
    super("notFound");
    this.name = "NotFound";
  }
}
class UnauthorizedError extends Error {
  constructor() {
    super("You must be signed in to do this.");
    this.name = "UnauthorizedError";
  }
}

type SessionUser = { id: string; name: string; email: string; role: string; sid?: string; tid?: string };
type Cookie = { value: string; options: Record<string, unknown> };
/** One simulated browser: its own cookie jar, the session it holds, and whether it is viewing as somebody. */
type Browser = { name: string; jar: Map<string, Cookie>; session: { user: SessionUser } | null; gateHeld: boolean; viewAs: { actor: { id: string; name: string }; user: SessionUser } | null };
const browser = (name: string): Browser => ({ name, jar: new Map(), session: null, gateHeld: false, viewAs: null });
const nobody = browser("nobody");
const req: { b: Browser; host: string; ip: string | null } = { b: nobody, host: "localhost:3000", ip: "203.0.113.10" };
const cookieOps: { op: "set" | "delete"; browser: string; name: string; value?: string; options: Record<string, unknown> }[] = [];
const signIns: { provider: string; options: Record<string, unknown>; params?: unknown }[] = [];

/** The request's headers now: this step's host, and the caller behind our proxy. */
const requestHeadersNow = () => {
  const h = new Headers({ "user-agent": "check-linked-signin" });
  if (req.host) h.set("host", req.host);
  if (req.ip) h.set("x-forwarded-for", req.ip);
  return h;
};
const headersStub: Record<string, unknown> = {
  headers: async () => requestHeadersNow(),
  cookies: async () => {
    const b = req.b;
    return {
      get: (name: string) => (b.jar.has(name) ? { name, value: b.jar.get(name)!.value } : undefined),
      getAll: () => [...b.jar].map(([name, c]) => ({ name, value: c.value })),
      has: (name: string) => b.jar.has(name),
      set: (first: string | { name: string; value: string }, value?: string, options: Record<string, unknown> = {}) => {
        const name = typeof first === "string" ? first : first.name;
        const v = typeof first === "string" ? (value ?? "") : first.value;
        const opts = typeof first === "string" ? options : { ...first };
        cookieOps.push({ op: "set", browser: b.name, name, value: v, options: opts });
        b.jar.set(name, { value: v, options: opts });
      },
      delete: (arg: string | { name: string }) => {
        const name = typeof arg === "string" ? arg : arg.name;
        cookieOps.push({ op: "delete", browser: b.name, name, options: typeof arg === "string" ? {} : { ...arg } });
        b.jar.delete(name);
      },
    };
  },
  draftMode: async () => ({ isEnabled: false }),
};
// src/lib/tenancy/resolve.ts reads next/headers through a dynamic import, which may hand it `default`.
headersStub.default = headersStub;

// next-auth itself is stood in for, so src/lib/auth.ts — its providers, callbacks and events — is the real one.
type Provider = { id?: string; options?: { id?: string; authorize?: (credentials: unknown) => Promise<unknown> } };
type AuthConfig = {
  providers: Provider[];
  callbacks: { signIn(m: unknown): Promise<boolean>; jwt(m: unknown): Promise<unknown>; session(m: unknown): Promise<{ user: SessionUser }> };
  events: { signIn(m: unknown): Promise<void> };
};
let authConfig: ((request?: Request) => Promise<AuthConfig>) | null = null;
let realNextAuth: { CredentialsSignin: new () => Error } | null = null;

/**
 * NextAuth's signIn for a Credentials provider — "linked", and the ordinary "credentials" the one-step invite's
 * setup page signs in with — as far as this check needs: authorize, the callbacks, the event, the session.
 * `redirect: false` answers with the URL, as NextAuth's does, instead of throwing the redirect.
 */
async function fakeSignIn(provider: string, options: Record<string, unknown> = {}, params?: unknown): Promise<string> {
  signIns.push({ provider, options: { ...options, ...(typeof options.password === "string" ? { password: "(hidden)" } : {}) }, params });
  if ((provider === "linked" || provider === "credentials") && authConfig && realNextAuth) {
    const config = await authConfig();
    const found = config.providers.find((p) => (p.options?.id ?? p.id) === provider);
    const credentials = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "redirect" && key !== "redirectTo"));
    const user = (await found?.options?.authorize?.(credentials)) as SessionUser | null | undefined;
    if (!user) throw new realNextAuth.CredentialsSignin();
    const account = { provider, type: "credentials" };
    if (!(await config.callbacks.signIn({ user, account }))) throw new realNextAuth.CredentialsSignin();
    const token = await config.callbacks.jwt({ token: { name: user.name, email: user.email, sub: user.id }, user, account });
    const session = await config.callbacks.session({ session: { user: { name: user.name, email: user.email }, expires: "" }, token });
    await config.events.signIn({ user, account });
    req.b.session = session;
  }
  if (options.redirect === false) return String(options.redirectTo ?? "/");
  throw new Redirect(String(options.redirectTo ?? "/"), `signIn:${provider}`);
}
const fakeNextAuth = (config: (request?: Request) => Promise<AuthConfig>) => {
  authConfig = config;
  return {
    handlers: { GET: async () => new Response(null, { status: 404 }), POST: async () => new Response(null, { status: 404 }) },
    auth: async () => req.b.session,
    signIn: fakeSignIn,
    signOut: async () => {
      req.b.session = null;
      return undefined;
    },
  };
};

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const load = Module.createRequire(__filename);
const realAuth = async () => (load(path.join(ROOT, "src", "lib", "auth.ts")) as typeof import("../src/lib/auth")).auth();
const sessionStub = {
  UnauthorizedError,
  requireUser: async () => {
    const session = await realAuth();
    if (!session?.user || req.b.gateHeld) throw new UnauthorizedError();
    return req.b.viewAs ? { ...session.user, ...req.b.viewAs.user } : session.user;
  },
  currentUser: async () => {
    const session = await realAuth();
    if (!session?.user || req.b.gateHeld) return null;
    return req.b.viewAs ? { ...session.user, ...req.b.viewAs.user } : session.user;
  },
  viewAsContext: async () => ((await realAuth())?.user && req.b.viewAs ? req.b.viewAs : null),
  refuseWhileViewingAs: async () => (req.b.viewAs ? "Switch back to yourself first." : null),
};

type Loader = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader; _resolveFilename(request: string, parent: unknown, isMain: boolean): string };
const originalLoad = internals._load;
/** The real module's other exports, loaded only when one is asked for. */
const passThrough = (real: () => unknown, own: Record<string, unknown>) => {
  let loaded: Record<string | symbol, unknown> | null = null;
  return new Proxy(own, {
    get(target, key) {
      if (typeof key === "string" && key in target) return target[key];
      loaded ??= real() as Record<string | symbol, unknown>;
      return loaded[key];
    },
  });
};
// Keyed by the resolved file, so a dynamic import (which reaches Module._load with the full path) is caught too.
const stubFor: Record<string, (real: () => unknown) => unknown> = {
  [norm(load.resolve("next/headers"))]: () => headersStub,
  [norm(load.resolve("next/cache"))]: (real) => passThrough(real, { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }),
  [norm(load.resolve("next/navigation"))]: (real) =>
    passThrough(real, {
      redirect: (url: string) => {
        throw new Redirect(url, "navigation");
      },
      permanentRedirect: (url: string) => {
        throw new Redirect(url, "navigation");
      },
      notFound: () => {
        throw new NotFound();
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    }),
  [norm(load.resolve("next-auth"))]: (real) => {
    const actual = real() as Record<string, unknown>;
    realNextAuth = actual as unknown as { CredentialsSignin: new () => Error };
    return { ...actual, __esModule: true, default: fakeNextAuth };
  },
  [norm(path.join(ROOT, "src", "lib", "session.ts"))]: () => sessionStub,
  // requestFacts reads next/headers through a dynamic import, which Module._load never sees (memory: suite
  // stubs miss dynamic imports) — so the module doing the import is stood in for, reading the same request.
  // The door check (an IP rule), the sign-in record and S4 all take the caller's address from it.
  [norm(path.join(ROOT, "src", "lib", "access", "request.ts"))]: () => ({
    requestFacts: async () => {
      const { clientIpFrom } = load(path.join(ROOT, "src", "lib", "client-ip.ts")) as typeof import("../src/lib/client-ip");
      const head = requestHeadersNow();
      return { inRequest: true, ip: clientIpFrom(head), userAgent: head.get("user-agent"), mobileHint: null, deviceToken: null };
    },
  }),
};
const stubbed = new Map<string, unknown>();
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let file = "";
  try {
    file = norm(internals._resolveFilename(request, parent, isMain));
  } catch {
    file = "";
  }
  const make = file ? stubFor[file] : undefined;
  if (make) {
    if (!stubbed.has(file)) stubbed.set(file, make(() => originalLoad.call(this, request, parent, isMain)));
    return stubbed.get(file);
  }
  return originalLoad.call(this, request, parent, isMain);
} as Loader;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);
  const startedAt = Date.now();

  section("Set-up: a scratch control plane and three workspaces");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_linkcheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made = new Set<string>();
  let remember: (() => Promise<void>) | null = null;
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { cwd: ROOT, stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
    const { PLATFORM_DOMAIN } = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { recordSignIn } = require("../src/lib/access/record") as typeof import("../src/lib/access/record");
    const { requestFacts } = require("../src/lib/access/request") as typeof import("../src/lib/access/request");
    const { clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
    const lockout = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
    const { invalidateSecuritySettingsCache } = require("../src/lib/security-settings") as typeof import("../src/lib/security-settings");
    const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    const { generateTotpSecret } = require("../src/lib/totp") as typeof import("../src/lib/totp");
    const finder = require("../src/lib/platform/find-workspaces") as typeof import("../src/lib/platform/find-workspaces");
    const emailIndex = require("../src/lib/platform/email-index") as typeof import("../src/lib/platform/email-index");
    const hooks = require("../src/lib/platform/account-hooks") as typeof import("../src/lib/platform/account-hooks");
    const keys = require("../src/lib/platform/linked/keys") as typeof import("../src/lib/platform/linked/keys");
    const G = require("../src/lib/platform/linked/groups") as typeof import("../src/lib/platform/linked/groups");
    const I = require("../src/lib/platform/linked/intents") as typeof import("../src/lib/platform/linked/intents");
    const S = require("../src/lib/platform/linked/switch") as typeof import("../src/lib/platform/linked/switch");
    const { sweepLinkedSignIn } = require("../src/lib/platform/linked/sweep") as typeof import("../src/lib/platform/linked/sweep");
    const L = require("../src/actions/linked-sign-in") as typeof import("../src/actions/linked-sign-in");
    const ADM = require("../src/actions/linked-sign-in-admin") as typeof import("../src/actions/linked-sign-in-admin");
    const site = require("../src/actions/platform/site") as typeof import("../src/actions/platform/site");
    const consoleLinked = require("../src/actions/platform/console-linked") as typeof import("../src/actions/platform/console-linked");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    require("../src/lib/auth");
    cleanup = async () => {
      await closeAllClients();
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    remember = async () => {
      for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
      for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    };

    // ─── Helpers ─────────────────────────────────────────────────────────────────────────────────
    /** Always `async () => await …`: a Prisma query runs where it is awaited, and must be awaited inside the workspace. */
    const inT = <T>(t: Tenant, work: () => Promise<T>): Promise<T> => runAsTenant(t, async () => await work());
    const ACCOUNT = { id: true, name: true, email: true, passwordHash: true, role: true } as const;
    type Account = { id: string; name: string; email: string; passwordHash: string; role: string };
    const PW = "zz-linkcheck correct horse";
    const HASH = await bcrypt.hash(PW, 4);
    let seq = 0;
    const person = (t: Tenant, name: string, extra: { email?: string; role?: string; kind?: "MEMBER" | "SUPPORT"; active?: boolean } = {}): Promise<Account> => {
      seq += 1;
      const email = extra.email ?? `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${seq}@${t.slug}.example`;
      return inT(t, () => db.user.create({ data: { name, email, passwordHash: HASH, role: extra.role ?? "SALES", kind: extra.kind ?? "MEMBER", active: extra.active ?? true }, select: ACCOUNT }));
    };
    const reread = (t: Tenant, id: string): Promise<Account> => inT(t, () => db.user.findUniqueOrThrow({ where: { id }, select: ACCOUNT }));
    const setUser = (t: Tenant, id: string, data: Prisma.UserUpdateInput) => inT(t, async () => void (await db.user.update({ where: { id }, data })));
    const setSecurity = async (t: Tenant, data: { enforceSso?: boolean; enforceTwoFactor?: boolean }) => {
      await inT(t, () => db.securitySettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data }));
      invalidateSecuritySettingsCache();
    };
    const giveTwoFactor = async (t: Tenant, userId: string) => {
      const secret = generateTotpSecret();
      const cipher = await inT(t, () => encryptSecret(secret));
      await setUser(t, userId, { twoFactorEnabledAt: new Date(Date.now() - 60_000), twoFactorSecretCipher: cipher });
      return secret;
    };
    /** A code the authenticator would not show now, nor a step either side. */
    const wrongCode = (secret: string) => String((Number(authenticator.generate(secret)) + 500_000) % 1_000_000).padStart(6, "0");
    const lockKey = (t: Tenant, email: string) => inT(t, async () => `${await tenantKey()}|account:${email.trim().toLowerCase()}`);
    const side = (t: Tenant, u: Account): JoinSide => ({ tenantId: t.id, userId: u.id, email: u.email, name: u.name, stamp: keys.credentialStamp(t.id, u), provenAt: new Date() });
    /** A link made as L4 records one: both accounts read fresh, so the stamps are their current ones. */
    const link = async (t1: Tenant, u1: Account, t2: Tenant, u2: Account) => G.joinGroup(side(t1, await reread(t1, u1.id)), side(t2, await reread(t2, u2.id)));
    const userOf = (u: Account): SessionUser => ({ id: u.id, name: u.name, email: u.email, role: u.role });
    /** A sign-in at `t`, recorded as the sign-in callback records one: its sid, and the session in `b` if given. */
    const signInAt = async (t: Tenant, u: Account, b: Browser | null = null, provider = "credentials") => {
      const saved = req.host;
      req.host = t.primaryHost;
      try {
        const sid = await inT(t, () => recordSignIn({ userId: u.id, provider }));
        if (b) b.session = { user: { ...userOf(u), sid, tid: t.id } };
        return sid;
      } finally {
        req.host = saved;
      }
    };
    type Outcome<T> = { value?: T; redirect?: string; via?: string; threw?: unknown };
    /** One action call, as browser `b` on workspace `t`'s host. */
    const act = async <T>(b: Browser, t: Tenant, work: () => Promise<T>): Promise<Outcome<T>> => {
      const saved = { b: req.b, host: req.host };
      req.b = b;
      req.host = t.primaryHost;
      try {
        return { value: await inT(t, work) };
      } catch (err) {
        if (err instanceof Redirect) return { redirect: err.url, via: err.via };
        return { threw: err };
      } finally {
        req.b = saved.b;
        req.host = saved.host;
      }
    };
    /** Every token and secret this check saw — none may reach a mail, a log line or an audit row. */
    const secrets: string[] = [];
    const keep = (value: string) => (secrets.push(value), value);
    const frag = (link: string, key: "i" | "c" | "t") => keep(link.slice(link.indexOf(`#${key}=`) + key.length + 2));
    const caught = async (work: () => Promise<unknown>): Promise<{ code: string; workspace?: string }> => {
      try {
        await work();
        return { code: "ok" };
      } catch (err) {
        if (err instanceof G.LinkRefused || err instanceof S.SwitchRefused) return { code: err.code, workspace: err.workspace };
        return { code: `threw ${show(err)}` };
      }
    };
    const refusal = async (work: () => Promise<unknown>) => (await caught(work)).code;
    const stateOf = (s: SwitchState) => (s.state === "refused" ? s.reason : s.state);
    type Detail = Record<string, unknown>;
    const detailOf = (value: unknown): Detail => (value && typeof value === "object" ? (value as Detail) : {});
    /** A stored detail equal to `expected` — key by key, since jsonb keeps keys in its own order. */
    const detailIs = (value: unknown, expected: Detail) => {
      const d = detailOf(value);
      return Object.keys(d).sort().join() === Object.keys(expected).sort().join() && Object.keys(expected).every((k) => JSON.stringify(d[k]) === JSON.stringify(expected[k]));
    };
    /** The link.revoked rows of one group, for one workspace. */
    const revokedIn = async (tenantId: string, groupId: string) =>
      (await control.platformAuditLog.findMany({ where: { action: "link.revoked", tenantId, detail: { path: ["groupId"], equals: groupId } }, select: { actor: true, detail: true } })).map((r): Detail => ({ ...detailOf(r.detail), actor: r.actor }));
    const tenantsOfGroup = async (groupId: string) => (await control.linkMember.findMany({ where: { groupId }, select: { tenantId: true } })).map((m) => m.tenantId).sort();
    const slugs = (found: { slug: string }[]) => found.map((w) => w.slug).sort().join(",");
    const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

    // ─── The three workspaces ───────────────────────────────────────────────────────────────────
    const OWNER_PW = "zz-linkcheck owner password";
    const setups = [
      { slug: "zzlink-a", companyName: "Zz Link Alpha", ownerName: "Anil Owner" },
      { slug: "zzlink-b", companyName: "Zz Link Bravo", ownerName: "Bela Owner" },
      { slug: "zzlink-c", companyName: "Zz Link Charlie", ownerName: "Chetan Owner" },
    ];
    for (const w of setups) {
      await provisioning.startProvisioning({ ...w, ownerEmail: `owner@${w.slug}.example`, ownerPasswordHash: await bcrypt.hash(OWNER_PW, 4), country: "IN" });
      const job = await provisioning.runNextJob();
      await remember();
      ok(`${w.slug} is set up as signup sets one up`, job?.ok === true, job?.error);
      if (!job?.ok) throw new Error(`setting up ${w.slug} failed`);
    }
    // An adopted default takes the environment's own workspace (the dev database) out of the registry,
    // so nothing here can reach it — not a stray query, not a lookup's fan-out.
    await control.tenant.update({ where: { slug: "zzlink-c" }, data: { isDefault: true } });
    // Workspaces without a database, for what needs only a row: one held, and one closed.
    await control.tenant.create({ data: { slug: "zzlink-held", name: "Zz Link Held", status: "SUSPENDED", suspendedFor: "STAFF", keyBundleCipher: "" } });
    const closed = await control.tenant.create({ data: { slug: "zzlink-closed", name: "Zz Link Closed", status: "DEPROVISIONED", keyBundleCipher: "" }, select: { id: true } });
    const papa = await control.tenant.create({ data: { slug: "zzlink-papa", name: "Zz Link Papa", status: "ACTIVE", keyBundleCipher: "" }, select: { id: true } });
    registry.forgetRegistry();
    const A = (await registry.tenantBySlug("zzlink-a"))!;
    const B = (await registry.tenantBySlug("zzlink-b"))!;
    const C = (await registry.tenantBySlug("zzlink-c"))!;
    const everyWorkspace = [A, B, C];
    ok("the three come from the registry, from the control plane, open", everyWorkspace.every((t) => t?.source === "control" && t.status === "ACTIVE" && !!t.dbUrl));
    req.host = A.primaryHost;
    const facts = await inT(A, () => requestFacts());
    ok("the request stand-in gives requestFacts (which imports next/headers dynamically) the caller's address", facts.inRequest && facts.ip === req.ip, facts);
    const roles = (await inT(B, () => db.role.findMany({ select: { key: true } }))).map((r) => r.key);
    ok("each has the ADMIN and SALES roles", roles.includes("ADMIN") && roles.includes("SALES"), roles);
    const ownerOf = (t: Tenant) => inT(t, () => db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: ACCOUNT }));
    const [ownerA, ownerB, ownerC] = [await ownerOf(A), await ownerOf(B), await ownerOf(C)];
    ok("each owner is its workspace's super admin, with the password chosen", await bcrypt.compare(OWNER_PW, ownerB.passwordHash));
    const IP = req.ip;
    const lastCall = <T>(ops: T[], from: number) => ops.slice(from);

    // ═══ 1. Tokens ═══════════════════════════════════════════════════════════════════════════════
    section("1. Tokens");
    const claims = [A.id, "user-1", keys.originOf(A), B.id, new Date("2026-09-28T12:00:00+05:30").toISOString()];
    const minted = keys.mintToken("link-intent", B.id, claims);
    keep(minted.token);
    ok("a minted token is r.m: 43 random characters, a dot, a 22-character MAC", /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/.test(minted.token));
    ok("it verifies for its verifier, its kind and its claims", keys.tokenMacValid("link-intent", B.id, minted.token, claims));
    ok("  not with a claim changed", !keys.tokenMacValid("link-intent", B.id, minted.token, [claims[0], "user-2", ...claims.slice(2)]));
    ok("  not with a later expiry", !keys.tokenMacValid("link-intent", B.id, minted.token, [...claims.slice(0, 4), new Date("2026-09-29T12:00:00+05:30").toISOString()]));
    ok("  not at another workspace", !keys.tokenMacValid("link-intent", A.id, minted.token, claims) && !keys.tokenMacValid("link-intent", C.id, minted.token, claims));
    ok("  not as another kind", !keys.tokenMacValid("link-switch", B.id, minted.token, claims) && !keys.tokenMacValid("link-completion", B.id, minted.token, claims));
    ok("  not truncated (and a truncated one has no hash to look up)", !keys.tokenMacValid("link-intent", B.id, minted.token.slice(0, -1), claims) && keys.tokenHashOf(minted.token.slice(0, -1)) === null);
    const swapped = `${minted.token[0] === "A" ? "B" : "A"}${minted.token.slice(1)}`;
    ok("  not with its random part changed", !keys.tokenMacValid("link-intent", B.id, swapped, claims));
    ok(
      "the stored hash is not the token: SHA-256 of its random part, 64 hex",
      minted.hash === keys.tokenHashOf(minted.token) && minted.hash === keys.sha256Hex(minted.token.slice(0, 43)) && /^[0-9a-f]{64}$/.test(minted.hash) && minted.hash !== minted.token,
    );
    ok("a claim holding a line break can't be signed", (() => {
      try {
        keys.mintToken("link-intent", B.id, ["one\ntwo"]);
        return false;
      } catch {
        return true;
      }
    })());
    const stampOf = { id: "user-1", email: " Asha@Example.test ", passwordHash: "$2a$10$zz" };
    const stamp = keys.credentialStamp(A.id, stampOf);
    ok("a credential stamp is 64 hex, whatever the address's case and spaces", /^[0-9a-f]{64}$/.test(stamp) && stamp === keys.credentialStamp(A.id, { ...stampOf, email: "asha@example.test" }));
    ok(
      "  and changes with the password, the address, the account or the workspace",
      [{ ...stampOf, passwordHash: "$2a$10$yy" }, { ...stampOf, email: "b@example.test" }, { ...stampOf, id: "user-2" }].every((v) => keys.credentialStamp(A.id, v) !== stamp) && keys.credentialStamp(B.id, stampOf) !== stamp,
    );

    // ═══ 2. Linking, the happy path ══════════════════════════════════════════════════════════════
    section("2. Linking, the happy path (L1–L4)");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const uA = await person(A, "Asha Rao", { email: "asha@zzlink-a.example" });
    const uB = await person(B, "Asha Rao", { email: "asha.rao@zzlink-b.example" });
    const sidA = await signInAt(A, uA);
    ok("a session is a SignIn row, recorded as a sign-in records one", (await inT(A, () => db.signIn.findUnique({ where: { sid: sidA } })))?.userId === uA.id);
    const asked = await I.createLinkIntent({ source: A, userId: uA.id, sid: sidA, viewingAs: false, workspace: B.slug, password: PW, ip: IP, origin: keys.originOf(A) });
    keep(asked.browserSecret);
    const intentToken = frag(asked.url, "i");
    const intentHash = keys.tokenHashOf(intentToken) ?? "none";
    ok("L1 with the right password: a URL on B's host, the token in its #i= fragment", asked.url.startsWith(`${keys.originOf(B)}/link/start#i=`) && keys.tokenHashOf(intentToken) !== null, asked.url.split("#")[0]);
    let intentRow = await control.linkIntent.findUnique({ where: { tokenHash: intentHash } });
    ok("  and this browser's secret for the deskzo.link cookie — the row keeps only its hash", /^[A-Za-z0-9_-]{43}$/.test(asked.browserSecret) && intentRow?.browserSecretHash === keys.sha256Hex(asked.browserSecret));
    ok("  the row keeps the token's hash, never the token", !!intentRow && intentRow.tokenHash !== intentToken && !JSON.stringify(intentRow).includes(intentToken.slice(0, 43)));
    ok("  asked by this session, open for ten minutes", intentRow?.sourceSid === sidA && Math.abs(intentRow.expiresAt.getTime() - intentRow.createdAt.getTime() - keys.LINK_INTENT_TTL_MS) < 5_000);
    const presented = await I.presentLinkIntent(B, intentToken, IP);
    keep(presented.targetSecret);
    intentRow = await control.linkIntent.findUnique({ where: { tokenHash: intentHash } });
    ok("L2 at B: the secret for B's deskzo.link-in cookie — only its hash kept", /^[A-Za-z0-9_-]{43}$/.test(presented.targetSecret) && intentRow?.targetBrowserHash === keys.sha256Hex(presented.targetSecret) && !!intentRow.presentedAt);
    ok(
      "  its view: where it was asked (A, its host, that account's address) and B's own name",
      JSON.stringify(presented.view) === JSON.stringify({ sourceName: A.name, sourceHost: A.primaryHost, sourceEmail: uA.email, targetName: B.name, expired: false }),
      presented.view,
    );
    ok(
      "  /link/confirm finds it by that browser's secret only, and at B only",
      JSON.stringify(await I.linkIntentFor(B, presented.targetSecret)) === JSON.stringify(presented.view) && (await I.linkIntentFor(B, keys.newBrowserSecret().secret)) === null && (await I.linkIntentFor(C, presented.targetSecret)) === null,
    );
    const sidB = await signInAt(B, uB);
    const proven = await I.proveLinkIntent(B, { targetSecret: presented.targetSecret, userId: uB.id, sid: sidB, viewingAs: false, ip: IP });
    const completion = frag(proven.url, "c");
    ok("L3 with a fresh sign-in at B: back to A's /link/complete, the token in #c=", proven.url.startsWith(`${keys.originOf(A)}/link/complete#c=`) && keys.tokenHashOf(completion) !== null);
    intentRow = await control.linkIntent.findUnique({ where: { tokenHash: intentHash } });
    ok("  the intent records who proved it and B's stamp", intentRow?.targetUserId === uB.id && intentRow.targetStamp === keys.credentialStamp(B.id, uB) && !!intentRow.provenAt && intentRow.completionHash === keys.tokenHashOf(completion));
    const mailAtLink = mail.length;
    const linked = await I.completeLinkIntent(A, { completion, browserSecret: asked.browserSecret, userId: uA.id, sid: sidA, viewingAs: false, ip: IP });
    const mA = await G.memberOf(A.id, uA.id);
    const mB = await G.memberOf(B.id, uB.id);
    const groupAB = mA?.groupId ?? "none";
    ok("L4 at A, in the browser and session that asked: linked — B's name and B's member", linked.workspace === B.name && linked.memberId === mB?.id, linked);
    ok("a group of two", !!mA && !!mB && mA.groupId === mB.groupId && (await control.linkMember.count({ where: { groupId: groupAB } })) === 2);
    ok("  stamps are 64 hex and equal credentialStamp", !!mA && !!mB && /^[0-9a-f]{64}$/.test(mA.stamp) && mA.stamp === keys.credentialStamp(A.id, uA) && mB.stamp === keys.credentialStamp(B.id, uB));
    const createdRows = await control.platformAuditLog.findMany({ where: { action: "link.created", detail: { path: ["groupId"], equals: groupAB } }, select: { tenantId: true, actor: true, detail: true } });
    ok(
      "  link.created for A and for B, each naming the other by id",
      createdRows.length === 2 && createdRows.some((r) => r.tenantId === A.id && detailOf(r.detail).other === B.id && r.actor === `workspace:${uA.id}`) && createdRows.some((r) => r.tenantId === B.id && detailOf(r.detail).other === A.id),
      createdRows,
    );
    const auditA = await inT(A, () => db.auditLog.findMany({ where: { entityType: "LinkedSignIn" }, select: { action: true, userId: true, entityLabel: true } }));
    const auditB = await inT(B, () => db.auditLog.findMany({ where: { entityType: "LinkedSignIn" }, select: { action: true, userId: true, entityLabel: true } }));
    ok("  an audit row in A's own log and one in B's", auditA.some((r) => r.action === "CREATE" && r.userId === uA.id) && auditB.some((r) => r.action === "CREATE" && r.userId === uB.id), { auditA, auditB });
    const linkedMail = mail.slice(mailAtLink).filter((m) => m.subject === "Your workspaces were linked");
    ok("  two emails, one to each address", linkedMail.length === 2 && [uA.email, uB.email].every((e) => linkedMail.some((m) => m.to === e)), linkedMail.map((m) => m.to));
    ok("  each naming both workspaces, and none carrying a token", linkedMail.every((m) => m.text.includes(A.name) && m.text.includes(B.name) && !TOKEN.test(m.text) && !/#[ict]=/.test(m.text)));
    ok("  and the request is complete", !!(await control.linkIntent.findUnique({ where: { tokenHash: intentHash } }))?.completedAt);

    // ═══ 3. Linking, refused ═════════════════════════════════════════════════════════════════════
    section("3. Linking, refused");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const a3 = await person(A, "Ravi Menon");
    const b3 = await person(B, "Ravi Menon");
    const sid3 = await signInAt(A, a3);
    type Ask = Parameters<typeof I.createLinkIntent>[0];
    const askAs = (u: Account, sid: string | undefined, over: Partial<Ask> = {}) => I.createLinkIntent({ source: A, userId: u.id, sid, viewingAs: false, workspace: B.slug, password: PW, ip: IP, origin: keys.originOf(A), ...over });
    const keyA3 = await lockKey(A, a3.email);
    const callerA = await inT(A, async () => `${await tenantKey()}|caller:${IP}`);
    ok("a wrong password → reauth", (await refusal(() => askAs(a3, sid3, { password: "not the password" }))) === "reauth");
    ok("  again → reauth", (await refusal(() => askAs(a3, sid3, { password: "still not it" }))) === "reauth");
    // recordFailure answers the count so far: one more than each key already held.
    ok("  both counted on the sign-in lockout, the account's key and the caller's", lockout.recordFailure([keyA3]).failures === 3 && lockout.recordFailure([callerA]).failures === 3);
    for (let i = 3; i < lockout.MAX_FAILURES; i += 1) lockout.recordFailure([keyA3]);
    ok("  locked out: even the right password → rate-limited", (await refusal(() => askAs(a3, sid3))) === "rate-limited");
    lockout.resetLockouts();
    finder.resetSiteAllowances();
    for (let i = 0; i < 5; i += 1) await refusal(() => askAs(a3, sid3, { password: "wrong again" }));
    ok("the sixth ask in an hour → rate-limited, even with the right password", (await refusal(() => askAs(a3, sid3))) === "rate-limited");
    lockout.resetLockouts();
    finder.resetSiteAllowances();

    const a2f = await person(A, "Meera Iyer");
    const secretA2f = await giveTwoFactor(A, a2f.id);
    const sid2f = await signInAt(A, a2f);
    let thrown: unknown = null;
    try {
      await askAs(a2f, sid2f);
    } catch (err) {
      thrown = err;
    }
    ok("a two-factor account, the right password and no code → needs the code (LinkNeedsCode, still a reauth)", thrown instanceof I.LinkNeedsCode && (thrown as InstanceType<typeof G.LinkRefused>).code === "reauth", thrown);
    ok("  not counted as a failure", lockout.recordFailure([await lockKey(A, a2f.email)]).failures === 1);
    lockout.resetLockouts();
    ok("  a wrong code → reauth", (await refusal(() => askAs(a2f, sid2f, { totpCode: wrongCode(secretA2f) }))) === "reauth");
    ok("  its code → the request is made", (await refusal(() => askAs(a2f, sid2f, { totpCode: authenticator.generate(secretA2f) }))) === "ok");
    lockout.resetLockouts();
    finder.resetSiteAllowances();

    ok("the Microsoft path on a password session → reauth-sso", (await refusal(() => askAs(a3, sid3, { password: undefined, sso: true }))) === "reauth-sso");
    const sidOldMs = await signInAt(A, a3, null, "microsoft-entra-id");
    await inT(A, () => db.signIn.update({ where: { sid: sidOldMs }, data: { at: new Date(Date.now() - keys.SSO_FRESH_MS - 60_000) } }));
    ok("  on a Microsoft sign-in eleven minutes old → reauth-sso", (await refusal(() => askAs(a3, sidOldMs, { password: undefined, sso: true }))) === "reauth-sso");
    const sidMs = await signInAt(A, a3, null, "microsoft-entra-id");
    ok("  on a fresh Microsoft sign-in of this account's → the request is made", (await refusal(() => askAs(a3, sidMs, { password: undefined, sso: true }))) === "ok");
    ok("  on another account's fresh Microsoft sign-in → reauth-sso", (await refusal(() => askAs(a2f, sidMs, { password: undefined, sso: true }))) === "reauth-sso");
    await setSecurity(A, { enforceSso: true });
    ok("A enforcing Microsoft sign-in: a password from a non-admin → reauth-sso", (await refusal(() => askAs(a3, sid3))) === "reauth-sso");
    await setSecurity(A, { enforceSso: false });
    finder.resetSiteAllowances();

    const bViewing = browser("A: the owner, viewing as Ravi");
    await signInAt(A, ownerA, bViewing);
    bViewing.viewAs = { actor: { id: ownerA.id, name: ownerA.name }, user: userOf(a3) };
    const intentsBefore = await control.linkIntent.count();
    const viewed = await act(bViewing, A, () => L.startLinkingWorkspace({ workspace: B.slug, password: OWNER_PW }));
    ok("while viewing as somebody (session stubbed) → view-as, and no request made", viewed.value?.ok === false && viewed.value.error === VIEW_AS && (await control.linkIntent.count()) === intentsBefore, viewed);
    ok("  the library refuses it the same", (await refusal(() => askAs(a3, sid3, { viewingAs: true }))) === "view-as");
    const aSup = await person(A, "Platform Support", { kind: "SUPPORT", email: "support.zzlinkcheck@platform.invalid" });
    const sidSup = await signInAt(A, aSup, null, "handoff");
    ok("a platform support account → support", (await refusal(() => askAs(aSup, sidSup))) === "support");
    ok("no session id → not-fresh", (await refusal(() => askAs(a3, undefined))) === "not-fresh");
    finder.resetSiteAllowances();
    ok("an unknown workspace → unknown-workspace", (await refusal(() => askAs(a3, sid3, { workspace: "zzlink-nowhere" }))) === "unknown-workspace");
    ok("this same workspace → same-workspace (by its name, or its address typed in full)", (await refusal(() => askAs(a3, sid3, { workspace: A.slug }))) === "same-workspace" && (await refusal(() => askAs(a3, sid3, { workspace: `${keys.originOf(A)}/dashboard` }))) === "same-workspace");
    ok("a workspace held by staff → workspace-unavailable", (await refusal(() => askAs(a3, sid3, { workspace: "zzlink-held" }))) === "workspace-unavailable");
    finder.resetSiteAllowances();

    const past = new Date(Date.now() - 1_000);
    const expiredIntent = keys.mintToken("link-intent", B.id, [A.id, a3.id, keys.originOf(A), B.id, past.toISOString()]);
    keep(expiredIntent.token);
    await control.linkIntent.create({
      data: {
        tokenHash: expiredIntent.hash,
        sourceTenantId: A.id,
        sourceUserId: a3.id,
        sourceSid: sid3,
        sourceOrigin: keys.originOf(A),
        sourceStamp: keys.credentialStamp(A.id, a3),
        sourceEmail: a3.email,
        sourceName: a3.name,
        browserSecretHash: keys.sha256Hex("never used"),
        targetTenantId: B.id,
        expiresAt: past,
        createdAt: new Date(past.getTime() - keys.LINK_INTENT_TTL_MS),
      },
    });
    ok("an intent past its ten minutes (minted then, so its MAC holds) → expired", (await refusal(() => I.presentLinkIntent(B, expiredIntent.token, IP))) === "expired");
    const edited = frag((await askAs(a3, sid3)).url, "i");
    await control.linkIntent.update({ where: { tokenHash: keys.tokenHashOf(edited) ?? "none" }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });
    ok("  one whose expiry was written later → used (its MAC no longer holds)", (await refusal(() => I.presentLinkIntent(B, edited, IP))) === "used");
    const madeForB = frag((await askAs(a3, sid3)).url, "i");
    ok("an intent made for B, presented at C → used", (await refusal(() => I.presentLinkIntent(C, madeForB, IP))) === "used");
    const open3 = await askAs(a3, sid3);
    keep(open3.browserSecret);
    const token3 = frag(open3.url, "i");
    const pres3 = await I.presentLinkIntent(B, token3, IP);
    keep(pres3.targetSecret);
    ok("presented twice → used", (await refusal(() => I.presentLinkIntent(B, token3, IP))) === "used");
    const prove3 = (over: { targetSecret?: string | null; sid?: string }) => I.proveLinkIntent(B, { targetSecret: pres3.targetSecret, userId: b3.id, sid: undefined, viewingAs: false, ip: IP, ...over });
    const sidB3 = await signInAt(B, b3);
    ok("confirmed with no link-in cookie → wrong-browser", (await refusal(() => prove3({ targetSecret: null, sid: sidB3 }))) === "wrong-browser");
    ok("confirmed from another browser's cookie → wrong-browser", (await refusal(() => prove3({ targetSecret: keys.newBrowserSecret().secret, sid: sidB3 }))) === "wrong-browser");
    const presentedAt3 = (await control.linkIntent.findUniqueOrThrow({ where: { tokenHash: keys.tokenHashOf(token3) ?? "none" } })).presentedAt ?? new Date();
    await inT(B, () => db.signIn.update({ where: { sid: sidB3 }, data: { at: new Date(presentedAt3.getTime() - 3_600_000) } }));
    ok("confirmed from a sign-in older than the request's presenting → not-fresh", (await refusal(() => prove3({ sid: sidB3 }))) === "not-fresh");
    await setUser(B, b3.id, { mustChangePassword: true });
    const must = await caught(async () => prove3({ sid: await signInAt(B, b3) }));
    await setUser(B, b3.id, { mustChangePassword: false });
    ok("the account at B must set a new password → must-change-password, naming B", must.code === "must-change-password" && must.workspace === B.name, must);
    await setSecurity(B, { enforceTwoFactor: true });
    const setup = await caught(async () => prove3({ sid: await signInAt(B, b3) }));
    await setSecurity(B, { enforceTwoFactor: false });
    ok("B enforces two-factor and the account has none → two-factor-setup, naming B", setup.code === "two-factor-setup" && setup.workspace === B.name, setup);
    const still3 = await control.linkIntent.findUniqueOrThrow({ where: { tokenHash: keys.tokenHashOf(token3) ?? "none" } });
    ok("  the request stays open, to be put right within its ten minutes", !still3.failedAt && !still3.provenAt);

    /** L1–L3 for a3 → b3, ready for L4. */
    const toProven = async () => {
      finder.resetSiteAllowances();
      const a = await askAs(a3, sid3);
      keep(a.browserSecret);
      const token = frag(a.url, "i");
      const p = await I.presentLinkIntent(B, token, IP);
      keep(p.targetSecret);
      const pr = await I.proveLinkIntent(B, { targetSecret: p.targetSecret, userId: b3.id, sid: await signInAt(B, b3), viewingAs: false, ip: IP });
      return { completion: frag(pr.url, "c"), browserSecret: a.browserSecret, targetSecret: p.targetSecret, hash: keys.tokenHashOf(token) ?? "none" };
    };
    type Proven = Awaited<ReturnType<typeof toProven>>;
    const complete = (p: Proven, over: Partial<Parameters<typeof I.completeLinkIntent>[1]> = {}) =>
      I.completeLinkIntent(A, { completion: p.completion, browserSecret: p.browserSecret, userId: a3.id, sid: sid3, viewingAs: false, ip: IP, ...over });
    const ended = async (p: Proven) => control.linkIntent.findUniqueOrThrow({ where: { tokenHash: p.hash }, select: { completionSeenAt: true, failedAt: true, failure: true, completedAt: true } });
    const spentWrong = async (label: string, over: Partial<Parameters<typeof I.completeLinkIntent>[1]>, expected: string) => {
      const p = await toProven();
      const got = await refusal(() => complete(p, over));
      const row = await ended(p);
      ok(`completed ${label} → ${expected}, spent and ended`, got === expected && !!row.completionSeenAt && !!row.failedAt && row.failure === expected, { got, row });
      ok("  then in the right browser and session → used", (await refusal(() => complete(p))) === "used");
    };
    await spentWrong("in another browser", { browserSecret: keys.newBrowserSecret().secret }, "wrong-browser");
    await spentWrong("with no session at all", { userId: null, sid: undefined }, "wrong-browser");
    await spentWrong("in another session of the same account", { sid: await signInAt(A, a3) }, "wrong-browser");
    const changedPw = await toProven();
    await setUser(A, a3.id, { passwordHash: await bcrypt.hash("a new password for ravi", 4) });
    const stale = await caught(() => complete(changedPw));
    await setUser(A, a3.id, { passwordHash: a3.passwordHash });
    ok("the source's password changed between asking and finishing → stale, naming A", stale.code === "stale" && stale.workspace === A.name && (await ended(changedPw)).failure === "stale", stale);
    const late = await toProven();
    await control.linkIntent.update({ where: { tokenHash: late.hash }, data: { provenAt: new Date(Date.now() - keys.LINK_COMPLETION_TTL_MS - 1_000) } });
    ok("finished more than 60 s after it was proven → expired", (await refusal(() => complete(late))) === "expired" && (await ended(late)).failure === "expired");

    finder.resetSiteAllowances();
    const toCancel = await askAs(a3, sid3);
    keep(toCancel.browserSecret);
    const cancelToken = frag(toCancel.url, "i");
    const cancelPres = await I.presentLinkIntent(B, cancelToken, IP);
    keep(cancelPres.targetSecret);
    await I.cancelLinkIntent(B, cancelPres.targetSecret);
    const cancelledRow = await control.linkIntent.findUniqueOrThrow({ where: { tokenHash: keys.tokenHashOf(cancelToken) ?? "none" } });
    ok("Cancel at B ends the request as cancelled", cancelledRow.failure === "cancelled" && !!cancelledRow.failedAt && (await I.linkIntentFor(B, cancelPres.targetSecret)) === null);
    ok("  confirming it afterwards → used", (await refusal(async () => I.proveLinkIntent(B, { targetSecret: cancelPres.targetSecret, userId: b3.id, sid: await signInAt(B, b3), viewingAs: false, ip: IP }))) === "used");
    const cancelledLate = await toProven();
    await I.cancelLinkIntent(B, cancelledLate.targetSecret);
    ok("  cancelled after it was proven: finishing it → cancelled", (await refusal(() => complete(cancelledLate))) === "cancelled");
    const failedAudit = await control.platformAuditLog.findFirst({ where: { action: "link.failed", tenantId: A.id, detail: { path: ["code"], equals: "cancelled" } }, select: { actor: true, detail: true } });
    ok("  link.failed for A, the code and B's id only", failedAudit?.actor === `workspace:${a3.id}` && detailOf(failedAudit.detail).other === B.id);

    // The conflict: A's account and B's account are each linked with a different account in C.
    const cX = await person(C, "Ravi Menon");
    const cY = await person(C, "R. Menon");
    const beforeConflict = await toProven();
    await link(A, a3, C, cX);
    await link(B, b3, C, cY);
    const atL4 = await caught(() => complete(beforeConflict));
    ok("two groups with accounts in C, arising between L3 and L4 → conflict, naming C", atL4.code === "conflict" && atL4.workspace === C.name && (await ended(beforeConflict)).failure === "conflict", atL4);
    finder.resetSiteAllowances();
    const conflictAsk = await askAs(a3, sid3);
    keep(conflictAsk.browserSecret);
    const conflictPres = await I.presentLinkIntent(B, frag(conflictAsk.url, "i"), IP);
    keep(conflictPres.targetSecret);
    const atL3 = await caught(async () => I.proveLinkIntent(B, { targetSecret: conflictPres.targetSecret, userId: b3.id, sid: await signInAt(B, b3), viewingAs: false, ip: IP }));
    ok("  and told at B already, when it is there before L3", atL3.code === "conflict" && atL3.workspace === C.name, atL3);
    ok("  neither group changed", sameSet(await tenantsOfGroup((await G.memberOf(A.id, a3.id))?.groupId ?? "none"), [A.id, C.id]) && sameSet(await tenantsOfGroup((await G.memberOf(B.id, b3.id))?.groupId ?? "none"), [B.id, C.id]));
    await G.revokeLinksForUser(A.id, a3.id, "user", `user:${a3.id}`);
    await G.revokeLinksForUser(B.id, b3.id, "user", `user:${b3.id}`);
    const good = await toProven();
    ok("with those unlinked, the same accounts link", (await refusal(() => complete(good))) === "ok" && !!(await G.memberOf(B.id, b3.id)));
    ok("  and the same completion again (a replay) → used", (await refusal(() => complete(good))) === "used");

    // The cap: a group of 20 made through joinGroup, 19 of them placeholder workspace rows.
    const aCap = await person(A, "Sunil Cap");
    const bCap = await person(B, "Sunil Cap");
    const sidCap = await signInAt(A, aCap);
    const capTenants: string[] = [];
    for (let i = 1; i <= keys.MAX_LINKED_WORKSPACES - 1; i += 1) {
      const n = String(i).padStart(2, "0");
      capTenants.push((await control.tenant.create({ data: { slug: `zzlink-cap-${n}`, name: `Zz Link Cap ${n}`, status: "ACTIVE", keyBundleCipher: "" }, select: { id: true } })).id);
    }
    let capGroup = "";
    for (const [i, tenantId] of capTenants.entries()) {
      const joined = await G.joinGroup(side(A, aCap), { tenantId, userId: `zz-cap-user-${i}`, email: `cap${i}@zzlink-cap.example`, name: `Cap ${i}`, stamp: keys.sha256Hex(`cap-${i}`), provenAt: new Date() });
      capGroup = joined.groupId;
    }
    ok(`a group of ${keys.MAX_LINKED_WORKSPACES}`, (await control.linkMember.count({ where: { groupId: capGroup } })) === keys.MAX_LINKED_WORKSPACES);
    ok(`  the ${keys.MAX_LINKED_WORKSPACES + 1}st through joinGroup → full`, (await refusal(() => link(A, aCap, B, bCap))) === "full");
    finder.resetSiteAllowances();
    ok("  and asked for at L1 → full", (await refusal(() => askAs(aCap, sidCap))) === "full");
    // Placeholders have no database: out of the way before the sweep.
    await control.linkMember.deleteMany({ where: { groupId: capGroup } });
    await control.linkGroup.delete({ where: { id: capGroup } });

    // ═══ 4. Merging ══════════════════════════════════════════════════════════════════════════════
    section("4. Merging groups");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const uC = await person(C, "Asha Rao", { email: "asha@zzlink-c.example" });
    // C–B through the actions this time: the cookies are theirs.
    const bAtC = browser("C: Asha");
    const sidC = await signInAt(C, uC, bAtC);
    let ops = cookieOps.length;
    const startedLink = await act(bAtC, C, () => L.startLinkingWorkspace({ workspace: B.slug, password: PW }));
    const setLink = lastCall(cookieOps, ops).find((o) => o.op === "set");
    const linkName = keys.linkCookieName("link", false);
    ok(
      "L1 through its action: ok, and this browser gets deskzo.link (HttpOnly, Lax, Path=/, ten minutes)",
      startedLink.value?.ok === true && setLink?.name === linkName && setLink.options.httpOnly === true && setLink.options.sameSite === "lax" && setLink.options.path === "/" && setLink.options.maxAge === 600,
      { value: startedLink.value, setLink: setLink?.name },
    );
    ok("  the cookie holds the secret whose hash the intent keeps", !!setLink?.value && !!(await control.linkIntent.findFirst({ where: { browserSecretHash: keys.sha256Hex(setLink.value) } })));
    keep(setLink?.value ?? "");
    const bAtB = browser("B: Asha, arriving");
    await signInAt(B, ownerB, bAtB);
    ops = cookieOps.length;
    const opened = await act(bAtB, B, () => L.openLinkRequest(startedLink.value?.ok ? frag(startedLink.value.url, "i") : ""));
    const setIn = lastCall(cookieOps, ops).find((o) => o.op === "set");
    ok("L2 through its action: B's browser gets deskzo.link-in, and the session already there is signed out", opened.value?.ok === true && setIn?.name === keys.linkCookieName("link-in", false) && bAtB.session === null, opened);
    keep(setIn?.value ?? "");
    await signInAt(B, uB, bAtB);
    ops = cookieOps.length;
    const confirmed = await act(bAtB, B, () => L.confirmLinkRequest());
    ok("L3 through its action: ok, and deskzo.link-in is cleared", confirmed.value?.ok === true && lastCall(cookieOps, ops).some((o) => o.op === "delete" && o.name === keys.linkCookieName("link-in", false)), confirmed);
    ops = cookieOps.length;
    const finished = await act(bAtC, C, () => L.finishLinkRequest(confirmed.value?.ok ? frag(confirmed.value.url, "c") : ""));
    ok("L4 through its action: linked to B, and deskzo.link is cleared", finished.value?.ok === true && finished.value.workspace === B.name && lastCall(cookieOps, ops).some((o) => o.op === "delete" && o.name === linkName), finished);
    ok("A–B, then C–B: one group of three", (await G.memberOf(C.id, uC.id))?.groupId === groupAB && sameSet(await tenantsOfGroup(groupAB), [A.id, B.id, C.id]));
    void sidC;

    const k1 = await person(A, "Kiran Das");
    const k2 = await person(B, "Kiran Das");
    const k3 = await person(C, "Kiran Das");
    const one = await link(A, k1, B, k2);
    const two = await G.joinGroup(side(C, k3), { tenantId: papa.id, userId: "zz-papa-user", email: "kiran@zzlink-papa.example", name: "Kiran Das", stamp: keys.sha256Hex("papa"), provenAt: new Date() });
    const merged = await link(B, k2, C, k3);
    const mergedInto = merged.groupId;
    ok("two groups meet (A–B and C–P): merged into one of four", merged.merged && !merged.already && sameSet(await tenantsOfGroup(mergedInto), [A.id, B.id, C.id, papa.id]));
    ok("  the emptied group is gone", [one.groupId, two.groupId].includes(mergedInto) && (await control.linkGroup.count({ where: { id: { in: [one.groupId, two.groupId] } } })) === 1);
    const mergedRows = await control.platformAuditLog.findMany({ where: { action: "link.created", detail: { path: ["merged"], equals: true } }, select: { tenantId: true } });
    ok("  link.created for both sides says merged", mergedRows.some((r) => r.tenantId === B.id) && mergedRows.some((r) => r.tenantId === C.id));
    ok("  linking two already in one group again changes nothing", (await link(A, k1, C, k3)).already === true);
    await control.linkMember.deleteMany({ where: { groupId: mergedInto } });
    await control.linkGroup.delete({ where: { id: mergedInto } });

    const y1 = await person(A, "Yash Jain");
    const y2 = await person(C, "Yash Jain");
    const y3 = await person(B, "Yash Jain");
    const y4 = await person(C, "Y. Jain");
    const yA = await link(A, y1, C, y2);
    const yB = await link(B, y3, C, y4);
    const conflict = await caught(() => link(A, y1, B, y3));
    ok("A–C and B–D, D a second account in C: joining them → conflict, naming C", conflict.code === "conflict" && conflict.workspace === C.name, conflict);
    ok("  and nothing moved", sameSet(await tenantsOfGroup(yA.groupId), [A.id, C.id]) && sameSet(await tenantsOfGroup(yB.groupId), [B.id, C.id]));

    // ═══ 5. Switching ════════════════════════════════════════════════════════════════════════════
    section("5. Switching (S1–S4)");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const present = (t: Tenant, token: string, over: Partial<{ signedInUserId: string | null; signedInOk: boolean; ip: string | null }> = {}) =>
      S.presentSwitchTicket(t, token, { signedInUserId: null, signedInOk: false, ip: req.ip, ...over });
    const memberUB = mB?.id ?? "none";
    const issued = await S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: memberUB, viewingAs: false, ip: IP });
    const t1 = frag(issued.url, "t");
    ok("S1: a URL on B's host, the ticket in #t=", issued.url.startsWith(`${keys.originOf(B)}/switch#t=`) && keys.tokenHashOf(t1) !== null);
    const ticketRow = await control.linkSwitchTicket.findUnique({ where: { tokenHash: keys.tokenHashOf(t1) ?? "none" } });
    ok(
      "  the row keeps its hash, for B's account, from this session, for a minute",
      !!ticketRow && ticketRow.tokenHash !== t1 && ticketRow.targetUserId === uB.id && ticketRow.sourceSid === sidA && Math.abs(ticketRow.expiresAt.getTime() - ticketRow.createdAt.getTime() - keys.SWITCH_TICKET_TTL_MS) < 5_000,
    );
    ok("  presented at C instead → ticket, and left unspent for B", stateOf(await present(C, t1)) === "ticket" && !(await control.linkSwitchTicket.findUnique({ where: { tokenHash: keys.tokenHashOf(t1) ?? "none" } }))?.usedAt);
    const s2 = await present(B, t1);
    ok("S2 at B, an account without two-factor → ready", s2.state === "ready", s2);
    const proof = s2.state === "ready" ? keep(s2.proof) : "";
    ok("  presented again → ticket (spent)", stateOf(await present(B, t1)) === "ticket");
    const beforeSwitch = Date.now();
    const who = await S.linkedAccount(proof, B.id);
    ok("S4: linkedAccount(proof) is B's account", JSON.stringify(who) === JSON.stringify({ id: uB.id, name: uB.name, email: uB.email, role: uB.role }), who);
    ok("  once: the second time, nobody", (await S.linkedAccount(proof, B.id)) === null);
    const doneTicket = await control.linkSwitchTicket.findUnique({ where: { tokenHash: keys.tokenHashOf(t1) ?? "none" } });
    ok("  the ticket is done", doneTicket?.stage === "DONE" && !!doneTicket.completedAt);
    const memberAfter = await control.linkMember.findUnique({ where: { id: memberUB } });
    ok("  the member's lastSwitchedInAt is set", !!memberAfter?.lastSwitchedInAt && memberAfter.lastSwitchedInAt.getTime() >= beforeSwitch - 1_000);
    const switchedRow = await control.platformAuditLog.findFirst({ where: { action: "link.switched", tenantId: B.id }, orderBy: { at: "desc" }, select: { actor: true, detail: true } });
    ok("  link.switched for B: from A, the member, ids only", switchedRow?.actor === `workspace:${uB.id}` && detailIs(switchedRow.detail, { from: A.id, memberId: memberUB }), switchedRow);
    const t2 = frag((await S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: memberUB, viewingAs: false, ip: IP })).url, "t");
    ok("S2 when this browser is already signed in at B as that account → signed-in (no new session)", stateOf(await present(B, t2, { signedInUserId: uB.id, signedInOk: true })) === "signed-in");
    const t3 = frag((await S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: memberUB, viewingAs: false, ip: IP })).url, "t");
    ok("  signed in there as somebody else → not reused: ready for a new session", stateOf(await present(B, t3, { signedInUserId: ownerB.id, signedInOk: true })) === "ready");
    ok("S1 into this account's own member, or a stranger's → not-member", (await refusal(() => S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: mA?.id ?? "", viewingAs: false, ip: IP }))) === "not-member" && (await refusal(() => S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: yB.targetMemberId, viewingAs: false, ip: IP }))) === "not-member");

    // ═══ 6. Every check of §4.5 ══════════════════════════════════════════════════════════════════
    section("6. Every check the target makes (§4.5), owner decision 3 included");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const sA = await person(A, "Sanjay Kumar");
    const sidS = await signInAt(A, sA);
    const bT = await person(B, "Sanjay Kumar");
    /** sA linked with `u` alone: whatever either was linked with before is unlinked first. */
    const pairWith = async (t: Tenant, u: Account) => {
      await G.revokeLinksForUser(A.id, sA.id, "user", `user:${sA.id}`);
      await G.revokeLinksForUser(t.id, u.id, "user", `user:${sA.id}`);
      const joined = await link(A, sA, t, u);
      return { memberId: joined.targetMemberId, groupId: joined.groupId };
    };
    const ticketInto = async (memberId: string) => {
      finder.resetSiteAllowances();
      return frag((await S.issueSwitchTicket(A, { userId: sA.id, sid: sidS, memberId, viewingAs: false, ip: req.ip })).url, "t");
    };
    const arrive = async (memberId: string, between?: () => Promise<unknown>) => {
      const token = await ticketInto(memberId);
      if (between) await between();
      return present(B, token);
    };
    let pair = await pairWith(B, bT);
    const by = { id: ownerB.id, name: ownerB.name };

    let s = await arrive(pair.memberId, () => G.saveLinkedSignInSetting(false, "check:linked-signin"));
    await G.saveLinkedSignInSetting(true, "check:linked-signin");
    ok("1. linked sign-in switched off after the ticket was issued → disabled", stateOf(s) === "disabled", s);
    await G.saveLinkedSignInSetting(false, "check:linked-signin");
    const noIssue = await refusal(() => ticketInto(pair.memberId));
    await G.saveLinkedSignInSetting(true, "check:linked-signin");
    ok("   and none is issued while it is off", noIssue === "disabled");
    const hold = async (suspendedFor: "STAFF" | "BILLING" | null) => {
      await control.tenant.update({ where: { id: B.id }, data: suspendedFor ? { status: "SUSPENDED", suspendedFor } : { status: "ACTIVE", suspendedFor: null } });
      registry.forgetRegistry();
    };
    s = await arrive(pair.memberId, () => hold("STAFF"));
    await hold(null);
    ok("2. B held by staff → workspace-unavailable", stateOf(s) === "workspace-unavailable", s);
    s = await arrive(pair.memberId, () => hold("BILLING"));
    await hold(null);
    ok("   B held for billing → billing-hold", stateOf(s) === "billing-hold", s);
    await hold("BILLING");
    const heldIssue = await caught(() => ticketInto(pair.memberId));
    await hold(null);
    ok("   and S1 issues none while it is held, naming B", heldIssue.code === "billing-hold" && heldIssue.workspace === B.name, heldIssue);
    s = await arrive(pair.memberId, () => G.setSwitchInAllowed(B.id, false, by));
    await G.setSwitchInAllowed(B.id, true, by);
    ok("3. B's admins turned switching in off → switching-off", stateOf(s) === "switching-off", s);
    s = await arrive(pair.memberId, () => G.revokeMember(pair.memberId, "user", `user:${sA.id}`));
    ok("4. the member unlinked after the ticket was issued → ticket", stateOf(s) === "ticket", s);
    pair = await pairWith(B, bT);
    s = await arrive(pair.memberId, () => setUser(B, bT.id, { active: false }));
    await setUser(B, bT.id, { active: true });
    ok("5. the account switched off → inactive, and unlinked (deactivated)", stateOf(s) === "inactive" && !(await G.memberOf(B.id, bT.id)) && (await revokedIn(B.id, pair.groupId)).some((r) => r.reason === "deactivated" && r.by === "switch"), s);
    const bGone = await person(B, "Temporary Account");
    const gonePair = await pairWith(B, bGone);
    s = await arrive(gonePair.memberId, () => inT(B, () => db.user.delete({ where: { id: bGone.id } })));
    ok("6. the account deleted → inactive, and unlinked (deleted)", stateOf(s) === "inactive" && !(await control.linkMember.findUnique({ where: { id: gonePair.memberId } })) && (await revokedIn(B.id, gonePair.groupId)).some((r) => r.reason === "deleted"), s);
    pair = await pairWith(B, bT);
    s = await arrive(pair.memberId, async () => setUser(B, bT.id, { passwordHash: await bcrypt.hash("sanjay's new password", 4) }));
    await setUser(B, bT.id, { passwordHash: bT.passwordHash });
    ok("7. its password changed since it was linked (a stale stamp) → stale, and unlinked (credentials)", stateOf(s) === "stale" && !(await G.memberOf(B.id, bT.id)) && (await revokedIn(B.id, pair.groupId)).some((r) => r.reason === "credentials"), s);
    pair = await pairWith(B, bT);
    s = await arrive(pair.memberId, () => setUser(B, bT.id, { mustChangePassword: true }));
    await setUser(B, bT.id, { mustChangePassword: false });
    ok("8. it must set a new password → must-change-password (and stays linked)", stateOf(s) === "must-change-password" && !!(await G.memberOf(B.id, bT.id)), s);
    const keyT = await lockKey(B, bT.email);
    s = await arrive(pair.memberId, async () => {
      for (let i = 0; i < lockout.MAX_FAILURES; i += 1) lockout.recordFailure([keyT]);
    });
    lockout.resetLockouts();
    ok("9. it is locked out at B → locked-out, with the minutes to wait", s.state === "refused" && s.reason === "locked-out" && s.retryInMinutes === Math.ceil(lockout.LOCKOUT_MS / 60_000), s);
    const BLOCKED = "203.0.113.66";
    const rule = await inT(B, () => db.ipRule.create({ data: { cidr: `${BLOCKED}/32`, action: "BLOCK", label: "zz linkcheck: blocked" }, select: { id: true } }));
    clearAccessCache();
    req.ip = BLOCKED;
    s = await arrive(pair.memberId);
    req.ip = IP;
    await inT(B, () => db.ipRule.delete({ where: { id: rule.id } }));
    clearAccessCache();
    ok("10. a BLOCK rule at B for the caller's address (doorCheck) → network", stateOf(s) === "network", s);
    const failedLog = await inT(B, () => db.activityLog.findFirst({ where: { kind: "LOGIN_FAILED", userId: bT.id }, orderBy: { createdAt: "desc" }, select: { summary: true, metadata: true } }));
    ok("    in B's own log as LOGIN_FAILED — the reason, and no other workspace named", detailOf(failedLog?.metadata).reason === "network" && detailOf(failedLog?.metadata).via === "linked" && !failedLog?.summary.includes(A.name), failedLog);
    const refusedRow = await control.platformAuditLog.findFirst({ where: { action: "link.switch-refused", tenantId: B.id }, orderBy: { at: "desc" }, select: { actor: true, detail: true } });
    ok("    and link.switch-refused for B: the reason and ids only", detailIs(refusedRow?.detail, { reason: "network", from: A.id, memberId: pair.memberId }), refusedRow);
    await setSecurity(B, { enforceSso: true });
    s = await arrive(pair.memberId);
    await setSecurity(B, { enforceSso: false });
    ok("11. B enforces Microsoft sign-in, a non-admin → sso (the Microsoft step)", s.state === "sso" && s.email === bT.email && s.workspace === B.name, s);
    const ssoSecret = s.state === "sso" ? keep(s.presentSecret) : "";
    ok("    its address for the login hint — for that browser's secret, at B only", (await S.ssoEmailFor(B, ssoSecret)) === bT.email && (await S.ssoEmailFor(B, keys.newBrowserSecret().secret)) === null && (await S.ssoEmailFor(C, ssoSecret)) === null);
    ok("    audited link.switch-sso", !!(await control.platformAuditLog.findFirst({ where: { action: "link.switch-sso", tenantId: B.id } })));
    await setSecurity(B, { enforceTwoFactor: true });
    s = await arrive(pair.memberId);
    await setSecurity(B, { enforceTwoFactor: false });
    ok("12. B enforces two-factor and the account has none → two-factor-setup", stateOf(s) === "two-factor-setup", s);
    s = await arrive((await pairWith(B, ownerB)).memberId);
    ok("13. B's super admin, without two-factor → super-admin-two-factor", stateOf(s) === "super-admin-two-factor", s);

    const bAdmin = await person(B, "Farah Khan", { role: "ADMIN" });
    s = await arrive((await pairWith(B, bAdmin)).memberId);
    ok("14. owner decision 3: an ADMIN without two-factor → manager-two-factor", stateOf(s) === "manager-two-factor", s);
    const grant = (u: Account, permission: string, allowed: boolean) =>
      inT(B, () => db.userPermission.upsert({ where: { user_permission: { userId: u.id, permission } }, create: { userId: u.id, permission, allowed, reason: "check:linked-signin" }, update: { allowed } }));
    const bUsers = await person(B, "Gita Rao");
    await grant(bUsers, "users.manage", true);
    s = await arrive((await pairWith(B, bUsers)).memberId);
    ok("    an account granted users.manage, without two-factor → manager-two-factor", stateOf(s) === "manager-two-factor", s);
    const bSec = await person(B, "Hari Nair");
    await grant(bSec, "security.manage", true);
    const secPair = await pairWith(B, bSec);
    s = await arrive(secPair.memberId);
    ok("    an account granted security.manage, without two-factor → manager-two-factor", stateOf(s) === "manager-two-factor", s);
    await grant(bSec, "security.manage", false);
    s = await arrive(secPair.memberId);
    ok("    that grant made a denial → ready", stateOf(s) === "ready", s);
    await inT(B, () => db.rolePermission.createMany({ data: ["users.manage", "security.manage"].map((permission) => ({ role: "ADMIN", permission, allowed: false })) }));
    const adminPair = await pairWith(B, bAdmin);
    const sAdmin = await arrive(adminPair.memberId);
    ok("    a role override denying ADMIN both keys lets the ADMIN through → ready", stateOf(sAdmin) === "ready", sAdmin);
    ok("    and the provider signs that ADMIN in", sAdmin.state === "ready" && (await S.linkedAccount(keep(sAdmin.proof), B.id))?.id === bAdmin.id);
    await inT(B, () => db.rolePermission.deleteMany({ where: { role: "ADMIN", permission: { in: ["users.manage", "security.manage"] } } }));

    const bTwo = await person(B, "Isha Menon");
    const secretTwo = await giveTwoFactor(B, bTwo.id);
    const twoPair = await pairWith(B, bTwo);
    const sc = await arrive(twoPair.memberId);
    ok("15. an account with two-factor → code, five tries", sc.state === "code" && sc.triesLeft === keys.SWITCH_MAX_CODE_ATTEMPTS && sc.email === bTwo.email, sc);
    const codeSecret = sc.state === "code" ? keep(sc.presentSecret) : "";
    const tries: number[] = [];
    let lastState: SwitchState = sc;
    for (let i = 0; i < keys.SWITCH_MAX_CODE_ATTEMPTS; i += 1) {
      lastState = await S.verifySwitchCode(B, codeSecret, wrongCode(secretTwo), IP);
      if (lastState.state === "code") tries.push(lastState.triesLeft);
    }
    ok("    wrong four times → 4, 3, 2, 1 tries left", JSON.stringify(tries) === "[4,3,2,1]", tries);
    ok("    the fifth → refused (code)", lastState.state === "refused" && lastState.reason === "code", lastState);
    ok("    that ticket is over: the right code now → ticket", stateOf(await S.verifySwitchCode(B, codeSecret, authenticator.generate(secretTwo), IP)) === "ticket");
    const sc2 = await arrive(twoPair.memberId);
    const codeSecret2 = sc2.state === "code" ? keep(sc2.presentSecret) : "";
    const ready2 = await S.verifySwitchCode(B, codeSecret2, authenticator.generate(secretTwo), IP);
    ok("    a new ticket, the right code → ready", ready2.state === "ready", ready2);
    ok("    and the provider signs that account in", ready2.state === "ready" && (await S.linkedAccount(ready2.proof, B.id))?.id === bTwo.id);
    lockout.resetLockouts();

    const plainPair = await pairWith(B, bT);
    const r16 = await arrive(plainPair.memberId);
    const p16 = r16.state === "ready" ? keep(r16.proof) : "";
    ok("16. the provider refuses a READY ticket at another workspace", r16.state === "ready" && (await S.linkedAccount(p16, C.id)) === null);
    ok("    which leaves it for its own", (await S.linkedAccount(p16, B.id))?.id === bT.id);
    const r16b = await arrive(plainPair.memberId);
    const p16b = r16b.state === "ready" ? keep(r16b.proof) : "";
    await control.linkSwitchTicket.updateMany({ where: { presentHash: keys.sha256Hex(p16b) }, data: { finishBy: new Date(Date.now() - 1_000) } });
    ok("    and a READY ticket past its finishBy", r16b.state === "ready" && (await S.linkedAccount(p16b, B.id)) === null);

    // ═══ 7. Nothing carried ══════════════════════════════════════════════════════════════════════
    section("7. Nothing carried across (the actions, sessions stubbed)");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const bA = browser("A: Asha");
    bA.session = { user: { ...userOf(uA), sid: sidA, tid: A.id } };
    const ticketsBefore = await control.linkSwitchTicket.count();
    const fromViewAs = await act(bViewing, A, () => L.switchToWorkspace(memberUB));
    ok("a switch from a view-as session → refused, and no ticket", fromViewAs.value?.ok === false && fromViewAs.value.error === VIEW_AS && (await control.linkSwitchTicket.count()) === ticketsBefore, fromViewAs);
    ok("  the library refuses it the same", (await refusal(() => S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: memberUB, viewingAs: true, ip: IP }))) === "view-as");
    const bSup = browser("A: platform support");
    await signInAt(A, aSup, bSup, "handoff");
    const supS1 = await act(bSup, A, () => L.switchToWorkspace(memberUB));
    ok("a platform support account at S1 → refused (support)", supS1.value?.ok === false && supS1.value.error === SUPPORT, supS1);
    ok("  the library refuses it the same", (await refusal(() => S.issueSwitchTicket(A, { userId: aSup.id, sid: sidSup, memberId: memberUB, viewingAs: false, ip: IP }))) === "support");
    const aK = await person(A, "Kavya Shah");
    const bK = await person(B, "Kavya Shah");
    const sidK = await signInAt(A, aK);
    const kPair = await link(A, aK, B, bK);
    const tK = frag((await S.issueSwitchTicket(A, { userId: aK.id, sid: sidK, memberId: kPair.targetMemberId, viewingAs: false, ip: IP })).url, "t");
    await setUser(B, bK.id, { kind: "SUPPORT" });
    const bArriveK = browser("B: arriving as Kavya");
    const supS2 = await act(bArriveK, B, () => L.arriveBySwitch(tK));
    ok(
      "an account that is platform support at the target (S2) → refused (support), nobody signed in, unlinked",
      supS2.value?.state === "refused" && supS2.value.message === SUPPORT && !bArriveK.session && !(await control.linkMember.findUnique({ where: { id: kPair.targetMemberId } })),
      supS2,
    );
    const switchedOut = await act(bA, A, () => L.switchToWorkspace(memberUB));
    ok("S1 through its action: a URL on B's host", switchedOut.value?.ok === true && switchedOut.value.url.startsWith(`${keys.originOf(B)}/switch#t=`), switchedOut);
    const bArrive = browser("B: arriving as Asha");
    const signInsBefore = signIns.length;
    const arrived = await act(bArrive, B, () => L.arriveBySwitch(switchedOut.value?.ok ? frag(switchedOut.value.url, "t") : ""));
    ok(
      "S2 through its action: signed in by the \"linked\" provider (src/lib/auth.ts), then /dashboard",
      arrived.redirect === "/dashboard" && arrived.via === "signIn:linked" && signIns[signInsBefore]?.provider === "linked" && bArrive.session?.user.id === uB.id && bArrive.session.user.tid === B.id,
      arrived,
    );
    const newSid = bArrive.session?.user.sid ?? "none";
    const newSignIn = await inT(B, () => db.signIn.findUnique({ where: { sid: newSid }, select: { provider: true, userId: true } }));
    ok("the new SignIn row at B has provider linked", newSignIn?.provider === "linked" && newSignIn.userId === uB.id, newSignIn);
    ok("  a session of B's own: not A's sign-in, and no such sign-in at A", newSid !== sidA && !(await inT(A, () => db.signIn.findUnique({ where: { sid: newSid } }))));
    const loginRow = await inT(B, () => db.activityLog.findFirst({ where: { kind: "LOGIN", userId: uB.id }, orderBy: { createdAt: "desc" }, select: { summary: true, metadata: true } }));
    ok("  B's log: signed in from a linked workspace, provider linked, naming no workspace", loginRow?.summary === `${uB.name} signed in from a linked workspace` && detailOf(loginRow.metadata).provider === "linked", loginRow);

    // ═══ The pause: the console's switch (decision 8), the script, and Profile's list ═══════════
    section("7b. The pause: the console's switch (owner decision 8), the script, Profile's paused list");
    const ownerStaff = await staffLib.createStaff({ email: "owner@zzlink-staff.example", name: "Zz Staff Owner", role: "OWNER" }, "script:check-linked-signin");
    const adminStaff = await staffLib.createStaff({ email: "admin@zzlink-staff.example", name: "Zz Staff Admin", role: "ADMIN" }, "script:check-linked-signin");
    const consoleBrowser = async (staffId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: keys.sha256Hex(token), userId: staffId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date(), userAgent: "check-linked-signin" } });
      const b = browser(`console: ${staffId}`);
      b.jar.set("deskzo-console", { value: token, options: {} });
      return b;
    };
    const atConsole = async <T>(b: Browser, work: () => Promise<T>): Promise<T> => {
      const saved = { b: req.b, host: req.host };
      req.b = b;
      req.host = registry.subdomainHost("admin");
      try {
        return await work();
      } finally {
        req.b = saved.b;
        req.host = saved.host;
      }
    };
    const ownerConsole = await consoleBrowser(ownerStaff.id);
    const refusedStaff = await atConsole(await consoleBrowser(adminStaff.id), () => consoleLinked.consoleSetLinkedSignIn(false));
    ok("a console ADMIN can't switch it: refused, and it stays on", !refusedStaff.ok && refusedStaff.error === "Your role cannot do that." && (await G.linkedSignInSetting()).enabled, refusedStaff);
    const turnedOff = await atConsole(ownerConsole, () => consoleLinked.consoleSetLinkedSignIn(false));
    const settingOff = await G.linkedSignInSetting();
    ok("a console OWNER switches linked sign-in off: saved, under them", turnedOff.ok && !settingOff.enabled && settingOff.updatedBy === ownerStaff.id, { turnedOff, settingOff });
    const staffAudit = await control.platformAuditLog.findFirst({ where: { action: "linked.settings" }, orderBy: { at: "desc" }, select: { actorKind: true, actor: true, tenantId: true, detail: true } });
    ok("  audited linked.settings as the staff member, for no workspace", staffAudit?.actorKind === "STAFF" && staffAudit.actor === ownerStaff.id && staffAudit.tenantId === null && detailIs(staffAudit.detail, { enabled: false }), staffAudit);
    ok("  this process follows at once", !(await G.linkedSignInEnabled()));
    const groupNow = (await G.memberOf(A.id, uA.id))?.groupId ?? "none";
    const groupMembers = await control.linkMember.findMany({ where: { groupId: groupNow }, select: { id: true } });
    const pausedList = await act(bA, A, () => L.myLinkedWorkspaces());
    ok(
      "paused: Profile's list still has every link, marked not enabled",
      pausedList.value?.enabled === false && pausedList.value.items.length === groupMembers.length && groupMembers.every((m) => pausedList.value?.items.some((i) => i.memberId === m.id)),
      pausedList,
    );
    ok("  every other workspace shows as unavailable", !!pausedList.value && pausedList.value.items.filter((i) => !i.current).every((i) => i.state === "unavailable"));
    const pausedSwitch = await act(bA, A, () => L.switchToWorkspace(memberUB));
    ok("  and switching is refused on the server", pausedSwitch.value?.ok === false && pausedSwitch.value.error === PAUSED, pausedSwitch);
    ok("  so is issuing a ticket in the library", (await refusal(() => S.issueSwitchTicket(A, { userId: uA.id, sid: sidA, memberId: memberUB, viewingAs: false, ip: IP }))) === "disabled");
    finder.resetSiteAllowances();
    ok("  and linking: asking, and presenting", (await refusal(() => askAs(a3, sid3))) === "disabled" && (await refusal(() => I.presentLinkIntent(B, minted.token, IP))) === "disabled");
    const turnedOn = await atConsole(ownerConsole, () => consoleLinked.consoleSetLinkedSignIn(true));
    const onList = await act(bA, A, () => L.myLinkedWorkspaces());
    ok("switched on again from the console: the list is enabled", turnedOn.ok && (await G.linkedSignInEnabled()) && onList.value?.enabled === true);
    const script = (command: string) =>
      execSync(`npm run --silent linked-sign-in -- ${command}`, { cwd: ROOT, env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, encoding: "utf8", stdio: "pipe", timeout: 180_000 });
    const offOut = script("off");
    const scripted = await G.linkedSignInSetting();
    const killRow = await control.platformAuditLog.findFirst({ where: { action: "link.kill-switch" }, orderBy: { at: "desc" }, select: { actorKind: true, actor: true, detail: true } });
    ok(
      "npm run linked-sign-in -- off: saved as the script, audited link.kill-switch",
      /is off/.test(offOut) && !scripted.enabled && scripted.updatedBy === "script:linked-sign-in" && killRow?.actorKind === "SCRIPT" && detailIs(killRow.detail, { enabled: false }),
      offOut.trim(),
    );
    G.forgetLinkedSignInEnabled();
    ok("  this process follows once its copy is forgotten", !(await G.linkedSignInEnabled()));
    const onOut = script("on");
    G.forgetLinkedSignInEnabled();
    ok("npm run linked-sign-in -- on: on again", /is on/.test(onOut) && (await G.linkedSignInEnabled()), onOut.trim());

    // ═══ 8. Revocation ═══════════════════════════════════════════════════════════════════════════
    section("8. Revocation, the unlink email (owner decision 7), and the nightly sweep");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    let since = mail.length;
    ok("unlink another member (B, from A's Profile): removed", await G.revokeMember(memberUB, "user", `user:${uA.id}`));
    ok("  the group keeps A and C", sameSet(await tenantsOfGroup(groupAB), [A.id, C.id]));
    const byUser = (await revokedIn(B.id, groupAB)).find((r) => r.reason === "user");
    ok("  link.revoked for B: reason user, by the person, as workspace:<id>", byUser?.by === `user:${uA.id}` && byUser.actor === `workspace:${uA.id}`, byUser);
    let sent = mail.slice(since);
    const unlinkedNotice = (m: { subject: string }) => m.subject === "A workspace was unlinked";
    ok(
      "  one email, to that account's address: why, and only its own workspace named",
      sent.length === 1 && sent[0].to === uB.email && unlinkedNotice(sent[0]) && sent[0].text.includes(B.name) && !sent[0].text.includes(A.name) && !sent[0].text.includes(C.name) && /\nWhy: /.test(sent[0].text),
      sent.map((m) => `${m.to}: ${m.subject}`),
    );
    ok("  unlinking it again does nothing, and sends nothing", !(await G.revokeMember(memberUB, "user", `user:${uA.id}`)) && mail.length === since + 1);
    since = mail.length;
    ok("leave (A's Profile, from all): A's member goes, and the group of two with it", (await G.revokeMember(mA?.id ?? "none", "left", `user:${uA.id}`)) && !(await G.memberOf(C.id, uC.id)) && !(await control.linkGroup.findUnique({ where: { id: groupAB } })));
    sent = mail.slice(since);
    ok("  emails to A's address, and to C's — its last partner went", sent.length === 2 && sent.some((m) => m.to === uA.email) && sent.some((m) => m.to === uC.email && m.text.includes("The last workspace linked with it was unlinked.")), sent.map((m) => m.to));
    ok("  C's link.revoked row says dissolved", (await revokedIn(C.id, groupAB)).some((r) => r.reason === "left" && r.dissolved === true));
    const z1 = await person(A, "Leela Pillai");
    const z2 = await person(B, "Leela Pillai");
    const zPair = await link(A, z1, B, z2);
    since = mail.length;
    ok("an admin unlinks one of B's accounts: removed", await G.revokeLinksForUser(B.id, z2.id, "admin", `admin:${ownerB.id}`));
    const byAdmin = (await revokedIn(B.id, zPair.groupId))[0];
    ok("  reason admin, by admin:<id>, as workspace:<id>", byAdmin?.reason === "admin" && byAdmin.by === `admin:${ownerB.id}` && byAdmin.actor === `workspace:${ownerB.id}`, byAdmin);
    ok("  emailed: 'an administrator of that workspace'", mail.slice(since).some((m) => m.to === z2.email && m.text.includes("An administrator of that workspace unlinked it.")));
    await link(A, z1, B, z2);
    await link(C, uC, B, uB);
    const bMembers = await control.linkMember.count({ where: { tenantId: B.id } });
    const unlinkedAll = await G.revokeWorkspaceLinks(B.id, "admin", `admin:${ownerB.id}`);
    ok("an admin unlinks everyone at B: every one of B's members, counted", bMembers >= 2 && unlinkedAll === bMembers && (await control.linkMember.count({ where: { tenantId: B.id } })) === 0, { bMembers, unlinkedAll });

    const reasons: RevokeReason[] = ["user", "left", "admin", "deactivated", "deleted", "credentials", "two-factor-reset", "workspace-closed", "data-reset"];
    const closedReasons = new Set<RevokeReason>(["deactivated", "deleted", "workspace-closed", "data-reset"]);
    const rA = await person(A, "Mohan Lal");
    const rB = await person(B, "Mohan Lal");
    for (const reason of reasons) {
      const pairR = await link(A, rA, B, rB);
      since = mail.length;
      await inT(B, () => hooks.accountsChanged([rB.id], { revoke: reason, by: `admin:${ownerB.id}` }));
      const row = (await revokedIn(B.id, pairR.groupId))[0];
      const notice = mail.slice(since).find((m) => m.to === rB.email);
      const closing = closedReasons.has(reason) ? `ask an administrator of ${B.name}` : `sign in to ${B.name} directly and change your password`;
      ok(`accountsChanged (${reason}): unlinked, audited ${reason}, and emailed`, !(await G.memberOf(B.id, rB.id)) && row?.reason === reason && !!notice && notice.text.includes(closing), { row, notice: notice?.text });
    }
    await link(A, rA, B, rB);
    await inT(B, () => hooks.accountsChanged([rB.id], { by: `admin:${ownerB.id}` }));
    ok("accountsChanged with no reason (a new or re-activated account) keeps the link", !!(await G.memberOf(B.id, rB.id)));
    await link(C, uC, B, uB);
    const resetGroup = (await G.memberOf(B.id, uB.id))?.groupId ?? "none";
    await inT(B, () => hooks.workspaceAccountsReset("reset"));
    const resetRow = (await revokedIn(B.id, resetGroup))[0];
    ok(
      "a data reset at B (workspaceAccountsReset): every B member unlinked — data-reset, by reset",
      (await control.linkMember.count({ where: { tenantId: B.id } })) === 0 && resetRow?.reason === "data-reset" && resetRow.by === "reset" && resetRow.actor === "reset",
      resetRow,
    );

    // The sweep: members whose account went (deleted, inactive, changed) another way, a closed workspace, lone groups, old rows.
    const sweepPair = async (label: string) => {
      const a = await person(A, `${label} Sweep`);
      const c = await person(C, `${label} Sweep`);
      const joined = await link(A, a, C, c);
      return { a, c, groupId: joined.groupId };
    };
    const swGone = await sweepPair("Gone");
    const swOff = await sweepPair("Off");
    const swStale = await sweepPair("Stale");
    const swHealthy = await sweepPair("Healthy");
    const swClosedA = await person(A, "Closed Sweep");
    const swClosed = await G.joinGroup(side(A, swClosedA), { tenantId: closed.id, userId: "zz-closed-user", email: "closed@zzlink-closed.example", name: "Closed Sweep", stamp: keys.sha256Hex("closed"), provenAt: new Date() });
    const swLoneA = await person(A, "Lone Sweep");
    const loneGroup = await control.linkGroup.create({ data: {}, select: { id: true } });
    await control.linkMember.create({ data: { groupId: loneGroup.id, tenantId: A.id, userId: swLoneA.id, email: swLoneA.email, name: swLoneA.name, stamp: keys.credentialStamp(A.id, swLoneA), provenAt: new Date() } });
    const emptyGroup = await control.linkGroup.create({ data: {}, select: { id: true } });
    await inT(C, () => db.user.delete({ where: { id: swGone.c.id } }));
    await setUser(C, swOff.c.id, { active: false });
    await setUser(C, swStale.c.id, { passwordHash: await bcrypt.hash("changed outside the app", 4) });
    const sweepAt = new Date();
    const day = 86_400_000;
    const oldIntents = await control.linkIntent.findMany({ take: 2, orderBy: { createdAt: "asc" }, select: { tokenHash: true } });
    const oldTickets = await control.linkSwitchTicket.findMany({ take: 2, orderBy: { createdAt: "asc" }, select: { tokenHash: true } });
    await control.linkIntent.update({ where: { tokenHash: oldIntents[0].tokenHash }, data: { createdAt: new Date(sweepAt.getTime() - 31 * day) } });
    await control.linkIntent.update({ where: { tokenHash: oldIntents[1].tokenHash }, data: { createdAt: new Date(sweepAt.getTime() - 29 * day) } });
    await control.linkSwitchTicket.update({ where: { tokenHash: oldTickets[0].tokenHash }, data: { createdAt: new Date(sweepAt.getTime() - 31 * day) } });
    await control.linkSwitchTicket.update({ where: { tokenHash: oldTickets[1].tokenHash }, data: { createdAt: new Date(sweepAt.getTime() - 29 * day) } });
    const expectPurged = (await control.linkIntent.count({ where: { createdAt: { lt: new Date(sweepAt.getTime() - 30 * day) } } })) + (await control.linkSwitchTicket.count({ where: { createdAt: { lt: new Date(sweepAt.getTime() - 30 * day) } } }));
    since = mail.length;
    const swept = await sweepLinkedSignIn(sweepAt);
    const sweepReason = async (tenantId: string, groupId: string) => (await revokedIn(tenantId, groupId)).find((r) => !r.dissolved)?.reason;
    ok("the sweep unlinks a deleted account (deleted)", !(await G.memberOf(C.id, swGone.c.id)) && (await sweepReason(C.id, swGone.groupId)) === "deleted");
    ok("  an account switched off (deactivated)", !(await G.memberOf(C.id, swOff.c.id)) && (await sweepReason(C.id, swOff.groupId)) === "deactivated");
    ok("  an account whose password changed another way — a stale stamp (credentials)", !(await G.memberOf(C.id, swStale.c.id)) && (await sweepReason(C.id, swStale.groupId)) === "credentials");
    ok("  a DEPROVISIONED workspace's members (workspace-closed)", (await control.linkMember.count({ where: { tenantId: closed.id } })) === 0 && (await sweepReason(closed.id, swClosed.groupId)) === "workspace-closed");
    ok("  their partners go with the dissolved groups", !(await G.memberOf(A.id, swGone.a.id)) && !(await G.memberOf(A.id, swOff.a.id)) && !(await G.memberOf(A.id, swStale.a.id)) && !(await G.memberOf(A.id, swClosedA.id)));
    ok("  a one-member group is dissolved, and an empty one deleted", !(await G.memberOf(A.id, swLoneA.id)) && (await control.linkGroup.count({ where: { id: { in: [loneGroup.id, emptyGroup.id] } } })) === 0);
    ok("  a link whose accounts are unchanged stays", (await G.memberOf(C.id, swHealthy.c.id))?.groupId === swHealthy.groupId && (await G.memberOf(A.id, swHealthy.a.id))?.groupId === swHealthy.groupId);
    ok(
      "  intents and tickets older than 30 days purged; 29 days old kept",
      swept.purged === expectPurged && expectPurged >= 2 && !(await control.linkIntent.findUnique({ where: { tokenHash: oldIntents[0].tokenHash } })) && !!(await control.linkIntent.findUnique({ where: { tokenHash: oldIntents[1].tokenHash } })) && !(await control.linkSwitchTicket.findUnique({ where: { tokenHash: oldTickets[0].tokenHash } })) && !!(await control.linkSwitchTicket.findUnique({ where: { tokenHash: oldTickets[1].tokenHash } })),
      { swept, expectPurged },
    );
    ok("  nothing failed", swept.failed.length === 0, swept.failed);
    ok("  each removed account emailed", [swOff.c.email, swStale.c.email, swGone.c.email].every((e) => mail.slice(since).some((m) => m.to === e && unlinkedNotice(m))));
    const sweepRow = await control.platformAuditLog.findFirst({ where: { action: "link.sweep" }, orderBy: { at: "desc" }, select: { actor: true, tenantId: true, detail: true } });
    ok("  audited link.sweep with counts only", sweepRow?.actor === "sweep" && sweepRow.tenantId === null && detailIs(sweepRow.detail, { checked: swept.checked, revoked: swept.revoked, purged: swept.purged, failed: 0 }), sweepRow);

    // ═══ 9. Privacy ══════════════════════════════════════════════════════════════════════════════
    section("9. Privacy");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    await link(A, uA, B, uB);
    const uB2 = await person(B, "Priya Sen");
    const cGroup = await link(C, uC, B, uB2);
    const cMembers = await control.linkMember.findMany({ where: { groupId: cGroup.groupId }, select: { id: true } });
    const forC = await G.linkedWorkspacesFor(C.id, uC.id);
    ok(
      "linkedWorkspacesFor C's account: its own group only — C first, then B",
      forC.length === 2 && forC[0].current && forC[0].tenantId === C.id && forC[1].tenantId === B.id && forC.every((w) => cMembers.some((m) => m.id === w.memberId)),
      forC.map((w) => w.name),
    );
    ok("  nothing of A's: no name, no id, no address", ![A.name, A.id, uA.email, A.slug].some((v) => JSON.stringify(forC).includes(v)));
    const users = await G.linkedUsersOf(B.id);
    ok(
      "linkedUsersOf(B): B's linked accounts, ids and dates only — no workspace named",
      sameSet(users.map((u) => u.userId), [uB.id, uB2.id]) && users.every((u) => Object.keys(u).sort().join() === "lastSwitchedInAt,linkedAt,memberId,userId") && ![A, C].some((t) => JSON.stringify(users).includes(t.name) || JSON.stringify(users).includes(t.id)),
      users,
    );
    const bOwnerB = browser("B: the owner");
    await signInAt(B, ownerB, bOwnerB);
    const adminState = await act(bOwnerB, B, () => ADM.getLinkedSignInAdmin());
    const stateJson = JSON.stringify(adminState.value);
    ok("the admin card's state (session stubbed): B's two linked people", sameSet(adminState.value?.people.map((p) => p.userId) ?? [], [uB.id, uB2.id]), adminState);
    ok("  and no other workspace's name, slug or id", ![A, C].some((t) => stateJson.includes(t.name) || stateJson.includes(t.slug) || stateJson.includes(t.id)));
    const bPlainB = browser("B: Asha, no security.manage");
    await signInAt(B, uB, bPlainB);
    ok("  nothing for an account without security.manage", (await act(bPlainB, B, () => ADM.getLinkedSignInAdmin())).value === null);
    const bAtCNow = browser("C: Asha, again");
    await signInAt(C, uC, bAtCNow);
    const cList = await act(bAtCNow, C, () => L.myLinkedWorkspaces());
    ok("myLinkedWorkspaces for C's account (session stubbed): C and B, nothing of A's", cList.value?.enabled === true && cList.value.items.map((i) => i.tenantId).join() === `${C.id},${B.id}` && !JSON.stringify(cList.value).includes(A.name), cList);
    const linkRows = await control.platformAuditLog.findMany({ where: { action: { startsWith: "link." } }, select: { actor: true, detail: true } });
    const linkText = JSON.stringify(linkRows);
    ok(
      `no link.* platform audit row (${linkRows.length}) holds an address, a token, a secret or a workspace's name`,
      linkRows.length > 50 && !linkText.includes("@") && !TOKEN.test(linkText) && !secrets.some((v) => v && linkText.includes(v)) && !everyWorkspace.some((t) => linkText.includes(t.name)),
    );
    const labels = (await Promise.all(everyWorkspace.map((t) => inT(t, () => db.auditLog.findMany({ where: { entityType: "LinkedSignIn" }, select: { entityLabel: true } }))))).flat();
    ok(`the workspaces' own LinkedSignIn audit rows (${labels.length}) name no workspace`, labels.length >= 4 && labels.every((l) => !everyWorkspace.some((t) => l.entityLabel.includes(t.name))));

    // ═══ 10. The email index ═════════════════════════════════════════════════════════════════════
    section("10. The email index, and the lookup ceiling (owner decision 6)");
    finder.resetSiteAllowances();
    const SHARED = "priya.shared@zzlink.example";
    const pA = await person(A, "Priya Shah", { email: SHARED });
    const pB = await person(B, "Priya Shah", { email: "Priya.Shared@zzlink.example" });
    const aOff = await person(A, "Quentin Roy", { active: false });
    // Whatever the hooks indexed so far goes: the reconcile is what is under test.
    await control.workspaceEmail.deleteMany({});
    ok("before any reconcile: not built, and 60 lookups an hour", !(await emailIndex.emailIndexReady()) && (await finder.findLookupsPerHour()) === finder.FIND_LOOKUPS_PER_HOUR.fanOut);
    ok("  a lookup asks every workspace (the fan-out) and finds A and B", slugs(await finder.findWorkspacesFor(SHARED)) === "zzlink-a,zzlink-b");
    const fill = (n: number) => {
      for (let i = 0; i < n; i += 1) finder.siteAllowance([{ key: "platform|find:all", max: 100_000 }]);
    };
    /** Whether findMyWorkspaces started a lookup: if it did, it counted the address, and one more for it is refused. */
    const lookedUp = async (email: string) => {
      await site.findMyWorkspaces({ email });
      return !finder.siteAllowance([{ key: `platform|find:${finder.addressKey(email)}`, max: 1 }]);
    };
    fill(finder.FIND_LOOKUPS_PER_HOUR.fanOut);
    ok("  so the 61st lookup in an hour is not made", !(await lookedUp("stranger.one@zzlink.example")));
    finder.resetSiteAllowances();
    const reconciled = await emailIndex.reconcileEmailIndex();
    ok("reconcileEmailIndex: every workspace, nothing failed", reconciled.workspaces === 3 && reconciled.failed.length === 0, reconciled);
    const rows = await control.workspaceEmail.findMany({ select: { tenantId: true, userId: true, emailHmac: true } });
    for (const t of everyWorkspace) {
      const active = (await inT(t, () => db.user.findMany({ where: { active: true, kind: "MEMBER" }, select: { id: true } }))).map((u) => u.id);
      ok(`  ${t.slug}: a row for each active member account, and none other`, sameSet(active, rows.filter((r) => r.tenantId === t.id).map((r) => r.userId)));
    }
    ok("  none for an account switched off, or platform support", !rows.some((r) => r.userId === aOff.id || r.userId === aSup.id));
    ok("  every row an HMAC — 64 hex, no address", rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.emailHmac) && !r.emailHmac.includes("@")));
    ok("  the two accounts with one address, in any case, share one key", rows.filter((r) => r.userId === pA.id || r.userId === pB.id).every((r) => r.emailHmac === emailIndex.emailKey(SHARED)));
    const builtAt = await control.platformSetting.findUnique({ where: { key: "emailIndex.builtAt" } });
    ok("  emailIndex.builtAt is set", !!builtAt?.value && !Number.isNaN(Date.parse(builtAt.value)) && builtAt.updatedBy === "email-index" && (await emailIndex.emailIndexReady()));
    ok("  and the ceiling is now 300 lookups an hour", (await finder.findLookupsPerHour()) === finder.FIND_LOOKUPS_PER_HOUR.indexed);
    ok("index mode finds A and B for the shared address, whatever its case", slugs(await finder.findWorkspacesFor(SHARED.toUpperCase())) === "zzlink-a,zzlink-b");
    await control.workspaceEmail.deleteMany({ where: { tenantId: B.id, userId: pB.id } });
    ok("  it asks only where the index points: with B's row gone, B isn't found", slugs(await finder.findWorkspacesFor(SHARED)) === "zzlink-a");
    await inT(B, () => emailIndex.indexWorkspaceUsers([pB.id]));
    ok("  indexWorkspaceUsers puts it back", slugs(await finder.findWorkspacesFor(SHARED)) === "zzlink-a,zzlink-b");
    await setUser(B, pB.id, { active: false });
    ok("  an account switched off since (its row still there) is dropped — the live check", !!(await control.workspaceEmail.findUnique({ where: { tenantId_userId: { tenantId: B.id, userId: pB.id } } })) && slugs(await finder.findWorkspacesFor(SHARED)) === "zzlink-a");
    await setUser(B, pB.id, { active: true });
    const pC = await person(C, "Priya Shah", { email: SHARED });
    await inT(C, () => hooks.accountsChanged([pC.id], { by: `admin:${ownerC.id}` }));
    ok("  one created since, through accountsChanged, is found", !!(await control.workspaceEmail.findUnique({ where: { tenantId_userId: { tenantId: C.id, userId: pC.id } } })) && slugs(await finder.findWorkspacesFor(SHARED)) === "zzlink-a,zzlink-b,zzlink-c");
    finder.resetSiteAllowances();
    fill(finder.FIND_LOOKUPS_PER_HOUR.fanOut);
    const mailAtFind = mail.length;
    ok("with the index built, the 61st lookup in an hour is made", await lookedUp(SHARED));
    await until(() => mail.slice(mailAtFind).some((m) => m.to === SHARED), 15_000);
    const listMail = mail.slice(mailAtFind).find((m) => m.to === SHARED);
    ok("  and the address is mailed its three workspaces", everyWorkspace.every((t) => !!listMail?.text.includes(t.name) && listMail.text.includes(`${keys.originOf(t)}/login`)), listMail?.text);
    fill(finder.FIND_LOOKUPS_PER_HOUR.indexed - finder.FIND_LOOKUPS_PER_HOUR.fanOut - 1);
    ok("  the 301st is not", !(await lookedUp("stranger.two@zzlink.example")));
    const linkedDir = path.join(ROOT, "src", "lib", "platform", "linked");
    const linkedFiles = readdirSync(linkedDir).filter((f) => /\.tsx?$/.test(f));
    ok(`linked sign-in's files (${linkedFiles.length}) import nothing from email-index.ts`, linkedFiles.length >= 5 && linkedFiles.every((f) => !/email-index/.test(readFileSync(path.join(linkedDir, f), "utf8"))));

    // ═══ 11. Pages ═══════════════════════════════════════════════════════════════════════════════
    section("11. Pages and cards render (no session)");
    type Page = { default: () => Promise<ReactElement>; metadata?: { title?: unknown } };
    const switchPage = require("../src/app/(auth)/switch/page") as Page;
    const startPage = require("../src/app/(auth)/link/start/page") as Page;
    const { LinkedWorkspacesCard } = require("../src/components/linked/linked-workspaces-card") as typeof import("../src/components/linked/linked-workspaces-card");
    const { LinkedSignInCard } = require("../src/components/settings/linked-sign-in-card") as typeof import("../src/components/settings/linked-sign-in-card");
    const { WorkspaceSwitcher } = require("../src/components/linked/workspace-switcher") as typeof import("../src/components/linked/workspace-switcher");
    const pageHtml = async (t: Tenant, page: Page) => {
      const rendered = await act(nobody, t, () => page.default());
      if (!rendered.value) throw new Error(`the page did not render: ${show(rendered.threw ?? rendered.redirect)}`);
      return renderToStaticMarkup(rendered.value);
    };
    const html: string[] = [];
    const switchHtml = await pageHtml(A, switchPage);
    html.push(switchHtml);
    ok("/switch renders with no session: the workspace's name, and 'Switching to …'", switchPage.metadata?.title === "Switching…" && switchHtml.includes(`>${A.name}</h1>`) && switchHtml.includes(`Switching to ${A.name}…`), switchHtml.slice(0, 400));
    const startHtml = await pageHtml(B, startPage);
    html.push(startHtml);
    ok("/link/start renders with no session: the neutral text, nothing about the request", startHtml.includes(`>Sign in to ${B.name}</button>`) && !startHtml.includes("signed in here as") && !startHtml.includes(A.name), startHtml.slice(0, 400));
    const initial = cList.value ?? { enabled: true, items: [], reauth: "password" as const };
    const cardHtml = renderToStaticMarkup(createElement(LinkedWorkspacesCard, { initial, domain: PLATFORM_DOMAIN, openWith: null, currentName: C.name }));
    html.push(cardHtml);
    ok(
      "LinkedWorkspacesCard, with C's account's list: both workspaces, Switch and Unlink for B, Add a workspace",
      cardHtml.includes(C.name) && cardHtml.includes(`aria-label="Switch to ${B.name}"`) && cardHtml.includes(`aria-label="Unlink ${B.name}"`) && cardHtml.includes("Add a workspace") && !cardHtml.includes(A.name),
      cardHtml.slice(0, 600),
    );
    const adminHtml = renderToStaticMarkup(createElement(LinkedSignInCard, { state: adminState.value ?? { allowSwitchIn: true, updatedByName: null, updatedAtText: null, people: [] } }));
    html.push(adminHtml);
    ok("LinkedSignInCard, with B's admin state: the switch, labelled, and B's linked people", adminHtml.includes("Allow switching into this workspace from linked accounts") && /role="switch"/.test(adminHtml) && adminHtml.includes(`aria-label="Unlink ${uB.name}"`) && adminHtml.includes(`aria-label="Unlink ${uB2.name}"`), adminHtml.slice(0, 600));
    ok("  and no other workspace's name", ![A, C].some((t) => adminHtml.includes(t.name)));
    const switcherHtml = renderToStaticMarkup(createElement(WorkspaceSwitcher, { current: { name: C.name, initials: "ZC", logoDataUrl: null }, domain: PLATFORM_DOMAIN }));
    html.push(switcherHtml);
    ok("WorkspaceSwitcher: its trigger, named for this workspace", switcherHtml.includes(`aria-label="Workspaces: ${C.name}"`) && switcherHtml.includes('aria-expanded="false"'), switcherHtml.slice(0, 400));
    ok("no dark: class, no fragment and no token in any of them", html.every((h) => !/\bdark:/.test(h) && !/#[ict]=/.test(h) && !TOKEN.test(h)));

    // ═══ 11b. The setup email, and the one-step invite ════════════════════════════════════════════
    section("11b. The setup email, and the one-step invite: added here, then set up and linked in one go");
    finder.resetSiteAllowances();
    lockout.resetLockouts();
    const USERS = require("../src/actions/user") as typeof import("../src/actions/user");
    const FORM = require("../src/components/auth/password-reset-forms") as typeof import("../src/components/auth/password-reset-forms");
    const SETUP = require("../src/lib/account-setup") as typeof import("../src/lib/account-setup");
    const resetPage = require("../src/app/(auth)/reset-password/page") as { default: (props: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement> };
    const CHOSEN = "zz-linkcheck chosen at set-up";
    const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");
    const bOwnerAdding = browser("B: the owner, adding people");
    await signInAt(B, ownerB, bOwnerAdding);
    // The scratch control plane sells no plans, so B has no seats: an override gives it room to add people.
    await control.tenant.update({ where: { id: B.id }, data: { seatOverride: 1000 } });
    await (require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements")).refreshEntitlements(B.id);
    const bWithSeats = (await registry.tenantBySlug(B.slug))!;
    ok("set-up: B has seats to add people into", bWithSeats.entitlements.seats === 1000, bWithSeats.entitlements);
    const linkIn = (text = "") => text.split("\n").find((line) => line.includes("/reset-password?")) ?? "";
    const tokenOf = (url: string) => (url ? (new URL(url).searchParams.get("t") ?? "") : "");
    /** The add-user dialog's submit, as B's owner: the account, the mail it sent, and the setup link in it. */
    const addUser = async (name: string, email: string, usesAnotherWorkspace?: boolean) => {
      const from = mail.length;
      const made = await act(bOwnerAdding, bWithSeats, () => USERS.createUser({ name, email, role: "SALES", departmentId: "", ...(usesAnotherWorkspace === undefined ? {} : { usesAnotherWorkspace }) }));
      const sent = mail.slice(from).filter((m) => m.to === email);
      const url = linkIn(sent[0]?.text);
      const token = tokenOf(url);
      const user = await inT(B, () => db.user.findUnique({ where: { email }, select: { ...ACCOUNT, mustChangePassword: true } }));
      if (!user) throw new Error(`createUser made no account for ${email}: ${show(made.value ?? made.threw ?? made.redirect)}`);
      return { made, sent, url, token, user };
    };
    const accountNow = (id: string) => inT(B, () => db.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true, mustChangePassword: true } }));
    const pendingNow = (id: string) => inT(B, () => SETUP.awaitingSetup(id));
    /** Nothing anybody could type matches it: not a bcrypt hash, not 60 characters — and not even itself. */
    const unusable = async (stored: string) =>
      stored.length !== 60 && !stored.startsWith("$2") && !(await bcrypt.compare(stored, stored)) && !(await bcrypt.compare("", stored)) && !(await bcrypt.compare(CHOSEN, stored));
    const setupLinkOf = (token: string) => inT(B, () => db.passwordResetToken.findUnique({ where: { tokenHash: hashOf(token) } }));
    const forThreeDays = (row: { expiresAt: Date; createdAt: Date } | null) => !!row && Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - SETUP.SETUP_LINK_TTL_MS) < 60_000;
    const indexed = async (userId: string) => (await control.workspaceEmail.count({ where: { tenantId: B.id, userId } })) === 1;
    const linkSpent = async (token: string) => !!(await setupLinkOf(token))?.usedAt;
    const intentsFrom = (userId: string) => control.linkIntent.count({ where: { sourceTenantId: B.id, sourceUserId: userId } });
    const namesNoOther = (text: string) => ![A, C].some((t) => text.includes(t.name) || text.includes(t.slug)) && !TOKEN.test(text) && !/#[ict]=/.test(text);

    // The admin's side: every new user is emailed — without the tick and with it.
    const plain = await addUser("Zz Plain Person", "zz.plain@zzlink-b.example");
    const setupMail = plain.sent[0] ?? { subject: "", text: "" };
    ok(
      "added without the tick: created, and the setup email sent — nothing else comes back",
      plain.made.value?.ok === true && Object.keys(plain.made.value.data).sort().join() === "emailed,id" && plain.made.value.data.emailed && plain.sent.length === 1,
      plain.made,
    );
    ok(
      "  the email: \"You've been given an account in <B>. Set it up by choosing your password.\"",
      setupMail.subject === `Set up your account in ${B.name}` &&
        setupMail.text.startsWith("Hello Zz Plain Person,") &&
        setupMail.text.includes(`You've been given an account in ${B.name}. Set it up by choosing your password.`) &&
        !setupMail.text.includes("link it to the workspace you already use"),
      setupMail,
    );
    const plainUrl = plain.url ? new URL(plain.url) : null;
    ok("  its link: B's own setup page, with setup=1 and no link=1", !!plainUrl && plainUrl.origin === keys.originOf(B) && plainUrl.pathname === "/reset-password" && plainUrl.searchParams.get("setup") === "1" && !plainUrl.searchParams.has("link"), plain.url);
    const plainLink = await setupLinkOf(plain.token);
    ok("  a one-time password link for that account — only its hash kept — for three days", !!plainLink && plainLink.userId === plain.user.id && !plainLink.usedAt && plainLink.tokenHash !== plain.token && forThreeDays(plainLink));
    ok("  naming no other workspace, and carrying no link token", namesNoOther(setupMail.text));
    ok(
      "  the account: no usable password, no change to ask for, waiting to be set up, the role chosen here",
      (await unusable(plain.user.passwordHash)) && !plain.user.mustChangePassword && (await pendingNow(plain.user.id)) && plain.user.role === "SALES",
    );
    ok("  and the email index follows it, as it follows every new account (accountsChanged)", await indexed(plain.user.id));
    const aMeera = await person(A, "Meera Nair", { email: "meera@zzlink-a.example" });
    const meera = await addUser("Meera Nair", "meera.nair@zzlink-b.example", true);
    ok("added with the tick: created, and the invitation sent", meera.made.value?.ok === true && meera.made.value.data.emailed && meera.sent.length === 1, meera.made);
    ok(
      "  the account as without it: no usable password, the role chosen here, waiting to be set up",
      (await unusable(meera.user.passwordHash)) && !meera.user.mustChangePassword && meera.user.role === "SALES" && (await pendingNow(meera.user.id)),
    );
    const invitation = meera.sent[0] ?? { subject: "", text: "" };
    ok(
      "  the email: \"Set up your account in <B> and link it to the workspace you already use.\"",
      invitation.subject === `Set up your account in ${B.name}` && invitation.text.includes(`Set up your account in ${B.name} and link it to the workspace you already use.`) && invitation.text.startsWith("Hello Meera Nair,"),
      invitation,
    );
    ok(
      "  its link: B's own setup page, with link=1",
      !!meera.url && new URL(meera.url).origin === keys.originOf(B) && new URL(meera.url).pathname === "/reset-password" && new URL(meera.url).searchParams.get("link") === "1" && !new URL(meera.url).searchParams.has("setup"),
      meera.url,
    );
    const invitedLink = await setupLinkOf(meera.token);
    ok("  a one-time password link for that account — only its hash kept — for three days", !!invitedLink && invitedLink.userId === meera.user.id && !invitedLink.usedAt && invitedLink.tokenHash !== meera.token && forThreeDays(invitedLink));
    ok("  naming no other workspace, and carrying no link token", namesNoOther(invitation.text));

    // The setup page: headed as setting up with either flag; the optional field only with link=1.
    const setupPage = async (params: Record<string, string>) => {
      const rendered = await act(nobody, B, () => resetPage.default({ searchParams: Promise.resolve(params) }));
      if (!rendered.value) throw new Error(`the setup page did not render: ${show(rendered.threw ?? rendered.redirect)}`);
      return renderToStaticMarkup(rendered.value);
    };
    const pagePlain = await setupPage({ t: "zz-not-a-token" });
    const pageSetup = await setupPage({ t: "zz-not-a-token", setup: "1" });
    const pageOther = await setupPage({ t: "zz-not-a-token", link: "yes" });
    const pageFlagged = await setupPage({ t: "zz-not-a-token", link: "1" });
    const hasField = (h: string) => h.includes('id="link-workspace"') || h.includes("Link it to the workspace you already use");
    ok("the password page without a flag: as it was — \"Choose a new password.\", no link field", pagePlain.includes("Choose a new password.") && !hasField(pagePlain) && pagePlain.includes(">Set my password</button>"), pagePlain.slice(0, 400));
    ok("  with setup=1: \"Set up your account: choose a password.\", and still no link field", pageSetup.includes("Set up your account: choose a password.") && !hasField(pageSetup) && pageSetup.includes(">Set my password</button>"), pageSetup.slice(0, 400));
    ok("  nor with any other value of link", !hasField(pageOther));
    const workspaceInput = pageFlagged.match(/<input[^>]*id="link-workspace"[^>]*>/)?.[0] ?? "";
    ok(
      "with link=1: set up, and the optional section \"Link it to the workspace you already use\", its field labelled, not required",
      pageFlagged.includes("Set up your account: choose a password.") &&
        pageFlagged.includes(">Link it to the workspace you already use</legend>") &&
        /<label[^>]*for="link-workspace"[^>]*>Workspace address \(optional\)<\/label>/.test(pageFlagged) &&
        !!workspaceInput &&
        !/\brequired\b/.test(workspaceInput) &&
        /aria-describedby="link-workspace-help/.test(workspaceInput),
      pageFlagged.slice(0, 900),
    );
    ok("  after the password fields, with no dark: class", pageFlagged.indexOf('id="again"') < pageFlagged.indexOf('id="link-workspace"') && ![pagePlain, pageSetup, pageFlagged].some((h) => /\bdark:/.test(h)));

    // Set up without an address: exactly as before.
    const nikhil = await addUser("Nikhil Bose", "nikhil.bose@zzlink-b.example", true);
    const pendingStamp = keys.credentialStamp(B.id, nikhil.user);
    const bNikhil = browser("B: Nikhil, setting up");
    let signInsFrom = signIns.length;
    let opsFrom = cookieOps.length;
    const noAddress = await act(bNikhil, B, () => FORM.setUpAccount({ token: nikhil.token, password: CHOSEN, workspace: "   " }));
    const nikhilNow = await accountNow(nikhil.user.id);
    ok("set up with the address left empty: done, the page as it always was", noAddress.value?.next === "done", noAddress);
    ok("  the password chosen is set, and no change asked for", (await bcrypt.compare(CHOSEN, nikhilNow.passwordHash)) && !nikhilNow.mustChangePassword);
    ok(
      "  no longer waiting to be set up, and linked sign-in's stamp — an ordinary one before — has moved with it",
      !(await pendingNow(nikhil.user.id)) && /^[0-9a-f]{64}$/.test(pendingStamp) && keys.credentialStamp(B.id, { ...nikhil.user, passwordHash: nikhilNow.passwordHash }) !== pendingStamp,
    );
    ok("  the link is spent", await linkSpent(nikhil.token));
    ok(
      "  nobody signed in, no cookie, nothing asked of another workspace",
      bNikhil.session === null && signIns.length === signInsFrom && lastCall(cookieOps, opsFrom).length === 0 && (await intentsFrom(nikhil.user.id)) === 0,
    );
    const again = await act(bNikhil, B, () => FORM.setUpAccount({ token: nikhil.token, password: `${CHOSEN} again`, workspace: "" }));
    ok("  and the link a second time: refused, as before", again.value?.next === "retry" && again.value.error === "This link has expired or been used. Ask for a new one from the sign-in page.", again);

    // Set up with an address: set, signed in, and linking started.
    const bMeera = browser("B: Meera, setting up");
    signInsFrom = signIns.length;
    opsFrom = cookieOps.length;
    const withAddress = await act(bMeera, B, () => FORM.setUpAccount({ token: meera.token, password: CHOSEN, workspace: A.slug }));
    const startUrl = withAddress.value?.next === "leave" ? withAddress.value.url : "";
    ok("set up with A's address: on to A's /link/start, the token in #i=", startUrl.startsWith(`${keys.originOf(A)}/link/start#i=`) && keys.tokenHashOf(frag(startUrl, "i")) !== null, withAddress);
    const meeraNow = await accountNow(meera.user.id);
    ok("  the password chosen is set, and the link spent", (await bcrypt.compare(CHOSEN, meeraNow.passwordHash)) && !meeraNow.mustChangePassword && (await linkSpent(meera.token)));
    const setupSid = bMeera.session?.user.sid ?? "none";
    const setupSignIn = await inT(B, () => db.signIn.findUnique({ where: { sid: setupSid }, select: { userId: true, provider: true, endedAt: true } }));
    ok(
      "  signed in at B with it: the ordinary password sign-in, a session of B's own",
      bMeera.session?.user.id === meera.user.id && bMeera.session.user.tid === B.id && signIns.slice(signInsFrom).some((s) => s.provider === "credentials" && s.options.redirect === false) && setupSignIn?.userId === meera.user.id && setupSignIn.provider === "credentials" && !setupSignIn.endedAt,
      { session: bMeera.session, setupSignIn },
    );
    const setupIntent = await control.linkIntent.findUnique({ where: { tokenHash: keys.tokenHashOf(frag(startUrl, "i")) ?? "none" } });
    ok(
      "  the link request: from Meera at B, asked by that session, for A, with her new credentials' stamp",
      setupIntent?.sourceTenantId === B.id && setupIntent.sourceUserId === meera.user.id && setupIntent.sourceSid === setupSid && setupIntent.targetTenantId === A.id && setupIntent.sourceStamp === keys.credentialStamp(B.id, await reread(B, meera.user.id)),
      setupIntent,
    );
    const meeraLinkCookie = lastCall(cookieOps, opsFrom).find((o) => o.op === "set" && o.browser === bMeera.name && o.name === linkName);
    ok("  and this browser holds deskzo.link for it", !!meeraLinkCookie?.value && keys.sha256Hex(meeraLinkCookie.value) === setupIntent?.browserSecretHash);
    keep(meeraLinkCookie?.value ?? "");
    const bMeeraAtA = browser("A: Meera, confirming");
    const openedAtA = await act(bMeeraAtA, A, () => L.openLinkRequest(frag(startUrl, "i")));
    await signInAt(A, aMeera, bMeeraAtA);
    const confirmedAtA = await act(bMeeraAtA, A, () => L.confirmLinkRequest());
    const finishedAtB = await act(bMeera, B, () => L.finishLinkRequest(confirmedAtA.value?.ok ? frag(confirmedAtA.value.url, "c") : ""));
    ok(
      "then as any link: a sign-in at A and its confirmation, finished back at B in the session the set-up made",
      openedAtA.value?.ok === true && confirmedAtA.value?.ok === true && finishedAtB.value?.ok === true && finishedAtB.value.workspace === A.name,
      { openedAtA, confirmedAtA, finishedAtB },
    );
    const [meeraAtA, meeraAtB] = [await G.memberOf(A.id, aMeera.id), await G.memberOf(B.id, meera.user.id)];
    ok("  one group: her account in A and her new one in B", !!meeraAtA && !!meeraAtB && meeraAtA.groupId === meeraAtB.groupId);
    const adminView = await act(bOwnerAdding, B, () => ADM.getLinkedSignInAdmin());
    ok(
      "  B's admin sees that she is linked, and nothing of A",
      !!adminView.value?.people.some((p) => p.userId === meera.user.id) && ![A.name, A.slug, A.id].some((v) => JSON.stringify(adminView.value).includes(v)) && !JSON.stringify(meera.made.value).includes(A.name),
    );

    // A link that is refused, or a sign-in: the password is kept all the same.
    const omar = await addUser("Omar Khan", "omar.khan@zzlink-b.example", true);
    const bOmar = browser("B: Omar, setting up");
    opsFrom = cookieOps.length;
    const refusedLink = await act(bOmar, B, () => FORM.setUpAccount({ token: omar.token, password: CHOSEN, workspace: "zzlink-nowhere" }));
    ok(
      "an address that is no workspace: linking refused with its own message — later, from Profile",
      refusedLink.value?.next === "later" && refusedLink.value.error === "There's no workspace at that address." && refusedLink.value.signedIn,
      refusedLink,
    );
    const omarNow = await accountNow(omar.user.id);
    ok("  the password is saved all the same, and the link spent", (await bcrypt.compare(CHOSEN, omarNow.passwordHash)) && !omarNow.mustChangePassword && (await linkSpent(omar.token)));
    ok("  signed in here; no request, and no deskzo.link", bOmar.session?.user.id === omar.user.id && (await intentsFrom(omar.user.id)) === 0 && !lastCall(cookieOps, opsFrom).some((o) => o.name === linkName));
    const priti = await addUser("Priti Das", "priti.das@zzlink-b.example", true);
    await setSecurity(B, { enforceSso: true });
    const bPriti = browser("B: Priti, setting up");
    const refusedSignIn = await act(bPriti, B, () => FORM.setUpAccount({ token: priti.token, password: CHOSEN, workspace: A.slug }));
    await setSecurity(B, { enforceSso: false });
    const pritiNow = await accountNow(priti.user.id);
    ok(
      "B enforcing Microsoft sign-in: the password sign-in is refused, so linking doesn't start — later",
      refusedSignIn.value?.next === "later" && !refusedSignIn.value.signedIn && bPriti.session === null && (await intentsFrom(priti.user.id)) === 0,
      refusedSignIn,
    );
    ok("  and the password is saved all the same", (await bcrypt.compare(CHOSEN, pritiNow.passwordHash)) && !pritiNow.mustChangePassword && (await linkSpent(priti.token)));
    const ravi = await addUser("Ravi Iyer", "ravi.iyer@zzlink-b.example", true);
    await setSecurity(B, { enforceTwoFactor: true });
    const bRavi = browser("B: Ravi, setting up");
    const withTwoFactorRule = await act(bRavi, B, () => FORM.setUpAccount({ token: ravi.token, password: CHOSEN, workspace: A.slug }));
    await setSecurity(B, { enforceTwoFactor: false });
    ok(
      "B requiring two-factor: nothing at B refuses linking from it (the target's rule, L3) — it starts, and B's pages ask for two-factor as at any first sign-in",
      withTwoFactorRule.value?.next === "leave" && bRavi.session?.user.id === ravi.user.id && (await intentsFrom(ravi.user.id)) === 1,
      withTwoFactorRule,
    );

    // ═══ 11c. Every new user ═════════════════════════════════════════════════════════════════════
    section("11c. Every new user: no password until they choose one, the link when mail fails, resend, \"Invitation pending\"");
    lockout.resetLockouts();
    const AUTH = require("../src/lib/auth") as typeof import("../src/lib/auth");
    const LOGIN = require("../src/actions/auth") as typeof import("../src/actions/auth");
    const RESET = require("../src/actions/password-reset") as typeof import("../src/actions/password-reset");
    const DIALOG = require("../src/components/settings/new-user-dialog") as typeof import("../src/components/settings/new-user-dialog");
    const { TeamManager } = require("../src/components/settings/team-manager") as typeof import("../src/components/settings/team-manager");
    const PERM = require("../src/actions/permission") as typeof import("../src/actions/permission");
    const CANDIDATES = require("../src/actions/candidate") as typeof import("../src/actions/candidate");
    const { usersImporter } = require("../src/lib/portability/importers/users") as typeof import("../src/lib/portability/importers/users");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    /** Mail to these addresses fails, as it does when the mail server is down. */
    const mailDownFor = new Set<string>();
    mailer.setTestPlatformMailer(async (m) => {
      if (mailDownFor.has(m.to)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      mail.push(m);
    });
    const sentTo = (from: number, email: string) => mail.slice(from).filter((m) => m.to === email);

    // No password is usable until the person chooses one.
    const pat = await addUser("Zz Pending Person", "zz.pending@zzlink-b.example");
    const bGuess = browser("B: somebody guessing");
    const guesses = ["", CHOSEN, pat.user.passwordHash, "no-password-yet:"];
    const tried: Outcome<unknown>[] = [];
    for (const password of guesses) tried.push(await act(bGuess, B, () => AUTH.signIn("credentials", { email: pat.user.email, password, totpCode: "", redirect: false })));
    ok(
      "nothing signs in to a new account before its person chooses a password — not blank, not a guess, not the stored value itself",
      tried.every((t) => !!t.threw && t.value === undefined) && bGuess.session === null,
      tried.map((t) => show(t.threw ?? t.value ?? "signed in")),
    );
    const preCheck = await act(bGuess, B, () => LOGIN.checkCredentials(pat.user.email, pat.user.passwordHash));
    ok("  nor passes the sign-in form's password check", preCheck.value?.ok === false, preCheck);
    let from = mail.length;
    await act(nobody, B, () => RESET.requestPasswordReset(pat.user.email));
    ok("  and somebody who lost the email can ask for a link from the sign-in page, as anybody can", sentTo(from, pat.user.email).some((m) => m.subject === "Set a new password"));
    lockout.resetLockouts();

    // The mail can't be sent: the link, once, for the admin to pass on.
    const downEmail = "zz.mailfails@zzlink-b.example";
    mailDownFor.add(downEmail);
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const down = await addUser("Zz Mail Fails", downEmail).finally(() => {
      console.error = realError;
    });
    const downData = down.made.value?.ok ? down.made.value.data : null;
    const fallback = downData && !downData.emailed ? (downData.setupUrl ?? "") : "";
    const fallbackUrl = fallback ? new URL(fallback) : null;
    const fallbackToken = keep(tokenOf(fallback));
    ok(
      "mail down: the account is made, and its setup link comes back instead",
      !!downData && !downData.emailed && !!fallbackUrl && fallbackUrl.origin === keys.originOf(B) && fallbackUrl.pathname === "/reset-password" && fallbackUrl.searchParams.get("setup") === "1" && down.sent.length === 0,
      down.made,
    );
    const fallbackRow = await setupLinkOf(fallbackToken);
    ok(
      "  stored only as its hash, for three days",
      !!fallbackRow && fallbackRow.userId === down.user.id && forThreeDays(fallbackRow) && (await inT(B, () => db.passwordResetToken.count({ where: { tokenHash: fallbackToken } }))) === 0,
    );
    ok(
      "  the failure logged by its code only — neither the link nor the address",
      logged.some((line) => line.includes("[setup] a setup email could not be sent: ECONNREFUSED")) && !logged.some((line) => line.includes(fallbackToken) || line.includes(downEmail)),
      logged,
    );
    const doneHtml = renderToStaticMarkup(createElement(DIALOG.NewUserCreated, { created: { email: downEmail, linking: false, emailed: false, setupUrl: fallback }, onDone() {} }));
    ok(
      "  the dialog shows it once, to copy: \"Copy setup link\", the link itself, and why",
      doneHtml.includes("Copy setup link</button>") && doneHtml.includes(fallback.replace(/&/g, "&amp;")) && /role="alert"[^>]*>The setup email to zz\.mailfails@zzlink-b\.example couldn&#x27;t be sent\./.test(doneHtml) && doneHtml.includes("Shown once"),
      doneHtml.slice(0, 900),
    );
    const usedFallback = await act(browser("B: Mail Fails, setting up"), B, () => FORM.setUpAccount({ token: fallbackToken, password: CHOSEN, workspace: "" }));
    ok(
      "  and it works as the email's would: the password is theirs, and they're no longer waiting",
      usedFallback.value?.next === "done" && (await bcrypt.compare(CHOSEN, (await accountNow(down.user.id)).passwordHash)) && !(await pendingNow(down.user.id)),
      usedFallback,
    );
    const bDown = browser("B: Mail Fails, signing in");
    const downSignIn = await act(bDown, B, () => AUTH.signIn("credentials", { email: downEmail, password: CHOSEN, totpCode: "", redirect: false }));
    ok("  so the sign-in that refused every guess above lets them in with it", !downSignIn.threw && bDown.session?.user.id === down.user.id, downSignIn);
    const sentHtml = renderToStaticMarkup(createElement(DIALOG.NewUserCreated, { created: { email: "zz.sent@zzlink-b.example", linking: false, emailed: true }, onDone() {} }));
    const sentLinkingHtml = renderToStaticMarkup(createElement(DIALOG.NewUserCreated, { created: { email: "zz.sent@zzlink-b.example", linking: true, emailed: true }, onDone() {} }));
    ok(
      "when it went, the dialog says so — where, and what the link does — and shows no link",
      sentHtml.includes("We&#x27;ve emailed zz.sent@zzlink-b.example a link to choose their own password") &&
        sentHtml.includes("Invitation pending") &&
        sentLinkingHtml.includes("a link to set up their account and link it to the workspace they already use") &&
        ![sentHtml, sentLinkingHtml].some((h) => h.includes("Copy setup link") || h.includes("/reset-password")),
      sentHtml,
    );

    // The add-user form itself: no password, and it says an email will be sent.
    const formHtml = (offerLinking: boolean) => renderToStaticMarkup(createElement(DIALOG.NewUserForm, { roles: ["SALES", "SUPPORT"], departments: [], offerLinking, onCreated() {}, onCancel() {} }));
    const [formPlain, formLinking] = [formHtml(false), formHtml(true)];
    ok("the add-user form: no password field of any kind", [formPlain, formLinking].every((h) => !/type="password"/.test(h) && !/nu-password|emporary password|Regenerate/.test(h)), formPlain.slice(0, 600));
    const emailInput = formPlain.match(/<input[^>]*id="nu-email"[^>]*>/)?.[0] ?? "";
    ok(
      "  it says an email will be sent: under the address, tied to it, and on the button",
      emailInput.includes('aria-describedby="nu-setup-help"') &&
        /<p id="nu-setup-help"[^>]*>We&#x27;ll email them a link to choose their own password\./.test(formPlain) &&
        formPlain.includes(">Create and send setup email</button>"),
      emailInput,
    );
    ok(
      "  the tick only where linking is offered, and no dark: class",
      formLinking.includes("This person already uses another workspace on this platform") && !formPlain.includes("This person already uses another workspace") && ![formPlain, formLinking, doneHtml, sentHtml].some((h) => /\bdark:/.test(h)),
    );

    // Resend.
    const resendAs = (b: Browser, id: string) => act(b, bWithSeats, () => USERS.resendSetupEmail(id));
    const rhea = await addUser("Rhea Kapoor", "rhea.kapoor@zzlink-b.example");
    from = mail.length;
    const resent = await resendAs(bOwnerAdding, rhea.user.id);
    const resentMail = sentTo(from, rhea.user.email);
    const resentToken = tokenOf(linkIn(resentMail[0]?.text));
    ok(
      "\"Resend setup email\": the same email again, with a new link",
      resent.value?.ok === true && resent.value.data.emailed && resentMail.length === 1 && resentMail[0].subject === `Set up your account in ${B.name}` && !!resentToken && resentToken !== rhea.token && new URL(linkIn(resentMail[0].text)).searchParams.get("setup") === "1",
      resent,
    );
    ok(
      "  replacing the unused one: its row gone, one live link for her, for three days",
      !(await setupLinkOf(rhea.token)) && forThreeDays(await setupLinkOf(resentToken)) && (await inT(B, () => db.passwordResetToken.count({ where: { userId: rhea.user.id, usedAt: null } }))) === 1,
    );
    const oldLink = await act(browser("B: Rhea, the first email"), B, () => FORM.setUpAccount({ token: rhea.token, password: CHOSEN, workspace: "" }));
    ok(
      "  so the first email's link is refused, and she's still waiting",
      oldLink.value?.next === "retry" && oldLink.value.error === "This link has expired or been used. Ask for a new one from the sign-in page." && (await pendingNow(rhea.user.id)),
      oldLink,
    );
    mailDownFor.add(rhea.user.email);
    const resentDown = await resendAs(bOwnerAdding, rhea.user.id);
    mailDownFor.delete(rhea.user.email);
    const resentUrl = resentDown.value?.ok && !resentDown.value.data.emailed ? (resentDown.value.data.setupUrl ?? "") : "";
    const resentDownToken = keep(tokenOf(resentUrl));
    ok("  mail down: the new link comes back to pass on, and the one before it stops working", !!resentDownToken && !(await setupLinkOf(resentToken)) && !!(await setupLinkOf(resentDownToken)), resentDown);
    const rheaSetUp = await act(browser("B: Rhea, setting up"), B, () => FORM.setUpAccount({ token: resentDownToken, password: CHOSEN, workspace: "" }));
    ok("  and with it she sets her password", rheaSetUp.value?.next === "done" && !(await pendingNow(rhea.user.id)), rheaSetUp);
    from = mail.length;
    const afterSetUp = await resendAs(bOwnerAdding, rhea.user.id);
    ok(
      "  once she has one: refused, and nothing sent — resending is never an admin's password reset",
      afterSetUp.value?.ok === false && afterSetUp.value.error.startsWith("They've already chosen a password.") && sentTo(from, rhea.user.email).length === 0,
      afterSetUp,
    );
    const sam = await addUser("Sam Pending", "sam.pending@zzlink-b.example");
    const rep = await person(B, "Zz Sales Rep");
    const bRep = browser("B: a sales rep");
    await signInAt(B, rep, bRep);
    const byRep = await resendAs(bRep, sam.user.id);
    ok("  somebody without users.manage: refused", byRep.value?.ok === false && byRep.value.error === "You can't send setup emails.", byRep);
    const plainAdmin = await person(B, "Zz Plain Admin", { role: "ADMIN" });
    const bPlainAdmin = browser("B: an admin, not the super admin");
    await signInAt(B, plainAdmin, bPlainAdmin);
    const onOwner = await resendAs(bPlainAdmin, ownerB.id);
    ok("  an admin who isn't the super admin, on the super admin's account: refused", onOwner.value?.ok === false && onOwner.value.error === "Only a super admin can change another super admin's account.", onOwner);
    await setUser(B, sam.user.id, { active: false });
    const switchedOff = await resendAs(bOwnerAdding, sam.user.id);
    await setUser(B, sam.user.id, { active: true });
    ok("  a switched-off account: refused", switchedOff.value?.ok === false && switchedOff.value.error.startsWith("Activate them first"), switchedOff);
    // Mail down, the link comes back only to somebody who could have made the account with all it holds.
    await inT(B, () => db.userPermission.create({ data: { userId: rep.id, permission: "users.manage", allowed: true } }));
    const pendingAdminEmail = "zz.pending.admin@zzlink-b.example";
    const madeAdmin = await act(bOwnerAdding, bWithSeats, () => USERS.createUser({ name: "Zz Pending Admin", email: pendingAdminEmail, role: "ADMIN", departmentId: "" }));
    const pendingAdmin = await inT(B, () => db.user.findUniqueOrThrow({ where: { email: pendingAdminEmail }, select: { id: true } }));
    mailDownFor.add(pendingAdminEmail);
    mailDownFor.add(sam.user.email);
    const repOnAdmin = await resendAs(bRep, pendingAdmin.id);
    const repOnSales = await resendAs(bRep, sam.user.id);
    const ownerOnAdmin = await resendAs(bOwnerAdding, pendingAdmin.id);
    mailDownFor.delete(pendingAdminEmail);
    mailDownFor.delete(sam.user.email);
    ok(
      "  mail down, asked by somebody with users.manage who doesn't hold all an ADMIN account does: not sent, and no link for them",
      madeAdmin.value?.ok === true && repOnAdmin.value?.ok === false && repOnAdmin.value.error === "The setup email couldn't be sent. Try again in a while." && !JSON.stringify(repOnAdmin).includes("/reset-password"),
      repOnAdmin,
    );
    const repSalesUrl = repOnSales.value?.ok && !repOnSales.value.data.emailed ? keep(repOnSales.value.data.setupUrl ?? "") : "";
    const ownerAdminUrl = ownerOnAdmin.value?.ok && !ownerOnAdmin.value.data.emailed ? keep(ownerOnAdmin.value.data.setupUrl ?? "") : "";
    ok("  the same person, for a SALES account whose every permission they hold: the link", repSalesUrl.includes("/reset-password?t="), repOnSales);
    ok("  the super admin, for the ADMIN account: the link", ownerAdminUrl.includes("/reset-password?t="), ownerOnAdmin);
    lockout.resetLockouts();
    const asks: boolean[] = [];
    for (let i = 0; i < lockout.MAX_FAILURES; i += 1) asks.push((await resendAs(bOwnerAdding, sam.user.id)).value?.ok === true);
    const tooMany = await resendAs(bOwnerAdding, sam.user.id);
    from = mail.length;
    await act(nobody, B, () => RESET.requestPasswordReset(sam.user.email));
    ok(
      `  ${lockout.MAX_FAILURES} in a row, then refused — one limit with "Forgot your password?", which then sends nothing either`,
      asks.every(Boolean) && tooMany.value?.ok === false && tooMany.value.error.startsWith("Too many setup emails for this address.") && sentTo(from, sam.user.email).length === 0,
      { asks, tooMany },
    );
    lockout.resetLockouts();

    // HR converting a candidate.
    await plans.setModuleOverride(B.id, "hr", true, "zz candidate conversion, from check:linked-signin", "zz-staff");
    const bWithHr = (await registry.tenantBySlug(B.slug))!;
    ok("set-up: B has the HR module", bWithHr.entitlements.all || bWithHr.entitlements.modules.includes("hr"), bWithHr.entitlements);
    const newJoiner = (name: string, email: string) => inT(B, () => db.candidate.create({ data: { name, email, status: "ACCEPTED", role: "SALES" }, select: { id: true } }));
    const convert = (id: string) => act(bOwnerAdding, bWithHr, () => CANDIDATES.convertCandidate(id, { joinedOn: "2026-10-05", probationMonths: 6 }));
    const accountOf = (email: string) => inT(B, () => db.user.findUnique({ where: { email }, select: { ...ACCOUNT, mustChangePassword: true } }));
    const priyaEmail = "priya.menon@zzlink-b.example";
    const priya = await newJoiner("Priya Menon", priyaEmail);
    from = mail.length;
    const converted = await convert(priya.id);
    const priyaMail = sentTo(from, priyaEmail);
    const priyaUser = await accountOf(priyaEmail);
    ok(
      "HR converting a candidate: the login and its setup email — no password HR chose",
      converted.value?.ok === true && converted.value.data.emailed && priyaMail.length === 1 && priyaMail[0].subject === `Set up your account in ${B.name}` && new URL(linkIn(priyaMail[0].text) || "http://x").searchParams.get("setup") === "1",
      converted,
    );
    ok(
      "  the login: no usable password, no change to ask for, waiting to be set up, and in the email index",
      !!priyaUser && (await unusable(priyaUser.passwordHash)) && !priyaUser.mustChangePassword && (await pendingNow(priyaUser.id)) && (await indexed(priyaUser.id)),
    );
    const arjunEmail = "arjun.rao@zzlink-b.example";
    const arjun = await newJoiner("Arjun Rao", arjunEmail);
    mailDownFor.add(arjunEmail);
    const convertedDown = await convert(arjun.id);
    mailDownFor.delete(arjunEmail);
    const arjunUrl = convertedDown.value?.ok && !convertedDown.value.data.emailed ? (convertedDown.value.data.setupUrl ?? "") : "";
    const arjunToken = keep(tokenOf(arjunUrl));
    const arjunLink = arjunToken ? await setupLinkOf(arjunToken) : null;
    ok(
      "  mail down: converted all the same, and the setup link comes back for HR to pass on",
      convertedDown.value?.ok === true && !!arjunUrl && new URL(arjunUrl).origin === keys.originOf(B) && arjunLink?.userId === (await accountOf(arjunEmail))?.id,
      convertedDown,
    );

    // An import: the same account, and no email.
    from = mail.length;
    const importedEmail = "zz.imported@zzlink-b.example";
    const imported = await act(bOwnerAdding, bWithSeats, () =>
      usersImporter.apply({ Name: "Zz Imported Person", Email: importedEmail, Role: "SALES", Active: "true" }, { actorUserId: ownerB.id, area: "users", pendingKeys: new Set() }),
    );
    const importedUser = await accountOf(importedEmail);
    ok(
      "an import creates the same account: no usable password, no change to ask for, waiting — and sends no email",
      imported.threw === undefined && !!importedUser && (await unusable(importedUser.passwordHash)) && !importedUser.mustChangePassword && (await pendingNow(importedUser.id)) && sentTo(from, importedEmail).length === 0,
      imported.threw,
    );
    const earlier = await inT(B, () =>
      db.user.create({ data: { name: "Zz Imported Earlier", email: "zz.imported.earlier@zzlink-b.example", role: "SALES", passwordHash: "no-password-set-by-import", mustChangePassword: true }, select: { id: true, name: true, email: true } }),
    );
    ok("  one an import made before this is waiting to be set up too", await pendingNow(earlier.id));

    // "Invitation pending".
    const listed = await act(bOwnerAdding, B, () => USERS.listUsers());
    const listedRow = (id: string) => listed.value?.find((u) => u.id === id);
    ok(
      "\"Invitation pending\" in the list: whoever hasn't chosen a password yet — and whether a link has gone to them",
      listedRow(sam.user.id)?.setupPending === true && listedRow(sam.user.id)?.setupLinkIssued === true && listedRow(pat.user.id)?.setupPending === true && listedRow(importedUser?.id ?? "")?.setupPending === true && listedRow(importedUser?.id ?? "")?.setupLinkIssued === false && listedRow(earlier.id)?.setupPending === true,
      listed.threw,
    );
    ok("  and nobody who has one: the owner, and everybody set up above", [ownerB.id, rhea.user.id, down.user.id, nikhil.user.id, meera.user.id, rep.id].every((id) => listedRow(id)?.setupPending === false));
    const roster = await act(bOwnerAdding, B, () => PERM.accessRoster());
    const rosterRow = (id: string) => roster.value?.find((r) => r.id === id);
    ok("  on the People roster too", rosterRow(sam.user.id)?.setupPending === true && rosterRow(rhea.user.id)?.setupPending === false && rosterRow(ownerB.id)?.setupPending === false, roster.threw);
    const teamHtml = renderToStaticMarkup(createElement(TeamManager, { users: listed.value ?? [], departments: [], roles: ["ADMIN", "SALES"] }));
    const rowFor = (email: string) => {
      const at = teamHtml.indexOf(`>${email}<`);
      return at < 0 ? "" : teamHtml.slice(teamHtml.lastIndexOf("<tr", at), teamHtml.indexOf("</tr>", at));
    };
    const [samRow, rheaRow, importedRow, earlierRow] = [rowFor(sam.user.email), rowFor(rhea.user.email), rowFor(importedEmail), rowFor(earlier.email)];
    ok(
      "  the team table: the badge, and \"Resend setup email\" named for the person",
      samRow.includes(">Invitation pending</span>") && samRow.includes(`aria-label="Resend setup email to ${sam.user.name}"`) && samRow.includes(">Resend setup email</button>"),
      samRow.slice(0, 700),
    );
    ok("  \"Send setup email\" for one no link has gone to yet, and never \"Temp password\" beside the badge", importedRow.includes(">Send setup email</button>") && earlierRow.includes(">Invitation pending</span>") && !earlierRow.includes("Temp password"));
    ok("  neither for somebody set up", !!rheaRow && !rheaRow.includes("Invitation pending") && !rheaRow.includes("setup email") && !/\bdark:/.test(teamHtml));
    from = mail.length;
    const toEarlier = await resendAs(bOwnerAdding, earlier.id);
    const listedAfter = await act(bOwnerAdding, B, () => USERS.listUsers());
    ok(
      "  sending it to one imported before this: the setup email, and the list now offers to resend",
      toEarlier.value?.ok === true && toEarlier.value.data.emailed && sentTo(from, earlier.email).length === 1 && listedAfter.value?.find((u) => u.id === earlier.id)?.setupLinkIssued === true,
      toEarlier,
    );
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));

    section("Every email");
    const linkedMails = mail.filter((m) => ["Your workspaces were linked", "A workspace was unlinked"].includes(m.subject) || m.to === SHARED);
    ok(
      `no linked sign-in or lookup email (${linkedMails.length}) carries a token, a fragment or a secret`,
      linkedMails.length > 20 && linkedMails.every((m) => !TOKEN.test(`${m.subject}\n${m.text}`) && !/#[ict]=/.test(m.text) && !secrets.some((v) => v && m.text.includes(v))),
    );
    await remember();
  } finally {
    section("12. Cleanup");
    if (remember) await remember().catch(() => {});
    if (cleanup) await cleanup().catch(() => {});
    for (const name of made) {
      if (/^w_[0-9a-f]{12}$/.test(name)) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
      }
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = any(${[...made, controlName]})`;
    const rolesLeft = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_roles where rolname = any(${[...made]})`;
    ok("every database this check made is dropped, and every role", Number(left[0].n) === 0 && Number(rolesLeft[0].n) === 0, `${made.size + 1} made`);
    await admin.$disconnect();
  }

  console.log("\nSummary");
  for (const s of tally) console.log(`  ${s.failed ? "FAIL" : " ok "}  ${s.passed}/${s.passed + s.failed}  ${s.title}`);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(failures === 0 ? `\nAll ${passes} linked sign-in checks passed (${seconds} s).` : `\n${failures} of ${passes + failures} check(s) FAILED (${seconds} s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
