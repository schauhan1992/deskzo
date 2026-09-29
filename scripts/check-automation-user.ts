/**
 * check:automation-user — the workspace's hidden "Automation" account (User.kind AUTOMATION,
 * src/lib/automation-user.ts), which automatic journal postings are made by (Revenue & Close, D1).
 *
 * In a scratch workspace database built from the migrations beside the real one (<db>_automation_check,
 * dropped at the end, pass or fail), served as a workspace of its own through `runAsTenant`, so `db`
 * and every action behind it read and write only that database:
 *
 *   1. the account: made once however many ask at once (through `db`, through three clients, through
 *      two transactions), a rolled-back transaction takes it with it, the least-privileged built-in
 *      role counting this workspace's changes, remembered per workspace and forgotten on request, and
 *      refused when a person holds its address;
 *   2. it never signs in: the credentials provider (refused by kind, with a real password set on it),
 *      the login form's check, Microsoft sign-in and the session it would make, handoff passes,
 *      linked sign-in, password reset and the setup email, view-as, the access gate, and the
 *      permission resolver (a grant made to it gives it nothing);
 *   3. it is never listed, counted or picked: seats, db's own listings, assignable users and the
 *      Copilot's find_colleague and propose_task, view-as targets, lock candidates, the Most Active
 *      standings, Users & access, the users export, both importers, and new accounts' validation;
 *   4. "Posted automatically": the journal list reads its creator's kind and the list renders it;
 *   5. static scans: every refusal site names the kind, and `kind: "MEMBER"` is written only once.
 *
 * No mail leaves (the platform mailer is replaced), no control plane is reached (CONTROL_DATABASE_URL is
 * emptied), no password is typed into a sign-in form: the NextAuth configuration is the real one, called
 * directly with fixtures' passwords generated here. Nothing is written to the real workspace database.
 *
 *   npm run check:automation-user
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tenant } from "../src/lib/tenancy/state";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.REFERENCE_DATABASE_URL = "";
process.env.CONTROL_DATABASE_URL = "";
process.env.TRUST_PROXY = "1";
process.env.TRUST_PROXY_HOPS = "";

const ROOT = path.resolve(__dirname, "..");
/** The scratch workspace's id: what `runAsTenant` serves it as, and the workspace its sessions name. */
const TENANT_ID = "zzauto-check";

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const show = (detail: unknown) => (detail instanceof Error ? `${detail.name}: ${detail.message}` : typeof detail === "string" ? detail : JSON.stringify(detail));
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${show(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const refusal = async (work: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await work();
    return null;
  } catch (err) {
    return err as Error;
  }
};

// ─── Stand-ins: the request, the session, next-auth ─────────────────────────────────────────────
type SessionUser = { id: string; name: string; email: string; role: string };
let sessionUser: SessionUser | null = null;
const jar = new Map<string, string>();
const headersStub: Record<string, unknown> = {
  headers: async () => new Headers({ host: "zzauto.localhost:3000", "user-agent": "check-automation-user", "x-forwarded-for": "203.0.113.41" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (first: string | { name: string; value: string }, value?: string) => {
      if (typeof first === "string") jar.set(first, value ?? "");
      else jar.set(first.name, first.value);
    },
    delete: (arg: string | { name: string }) => void jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
  draftMode: async () => ({ isEnabled: false }),
};
headersStub.default = headersStub;

class UnauthorizedError extends Error {
  constructor() {
    super("You must be signed in to do this.");
    this.name = "UnauthorizedError";
  }
}
const sessionStub = {
  UnauthorizedError,
  requireUser: async () => {
    if (!sessionUser) throw new UnauthorizedError();
    return sessionUser;
  },
  currentUser: async () => sessionUser,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};

type Provider = { id?: string; options?: { id?: string; authorize?: (credentials: unknown) => Promise<unknown> } };
type AuthConfig = {
  providers: Provider[];
  callbacks: { signIn(m: unknown): Promise<boolean>; jwt(m: unknown): Promise<Record<string, unknown>> };
};
let authConfig: ((request?: Request) => Promise<AuthConfig>) | null = null;
const fakeNextAuth = (config: (request?: Request) => Promise<AuthConfig>) => {
  authConfig = config;
  return {
    handlers: { GET: async () => new Response(null, { status: 404 }), POST: async () => new Response(null, { status: 404 }) },
    // Issued by the scratch workspace, as src/lib/auth.ts's own `auth()` checks.
    auth: async () => (sessionUser ? { user: { ...sessionUser, tid: TENANT_ID }, expires: "" } : null),
    signIn: async () => undefined,
    signOut: async () => undefined,
  };
};

/** The pass the handoff sign-in spends next, instead of the control plane's row. */
let nextPass: { email: string; purpose: "owner-signup" | "support" } | null = null;

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const load = Module.createRequire(__filename);
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
        throw new Error(`redirect ${url}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
      usePathname: () => "/accounting/journal",
      useSearchParams: () => new URLSearchParams(),
    }),
  [norm(load.resolve("next-auth"))]: (real) => ({ ...(real() as Record<string, unknown>), __esModule: true, default: fakeNextAuth }),
  [norm(path.join(ROOT, "src", "lib", "session.ts"))]: (real) => passThrough(real, sessionStub),
  // requestFacts reads next/headers through a dynamic import, which Module._load never sees.
  [norm(path.join(ROOT, "src", "lib", "access", "request.ts"))]: () => ({
    requestFacts: async () => ({ inRequest: true, ip: "203.0.113.41", userAgent: "check-automation-user", mobileHint: null, deviceToken: null }),
  }),
  // Only the spending of a pass is stood in for: making one is the real function.
  [norm(path.join(ROOT, "src", "lib", "platform", "handoff.ts"))]: (real) =>
    passThrough(real, {
      spendHandoffTicket: async () => {
        const pass = nextPass;
        nextPass = null;
        return pass;
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

// ─── The suite ───────────────────────────────────────────────────────────────────────────────────
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("Set-up: a scratch workspace database");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_automation_check`;
  const scratchUrl = withDatabase(url, scratchName);
  ok("the scratch database is never the real one", scratchName !== realName && scratchUrl !== url);
  const admin = directClient(withDatabase(url, "postgres"));
  const clients: ReturnType<typeof directClient>[] = [];
  let closeTenancy: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    execSync("npx prisma migrate deploy", { cwd: ROOT, stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { UNRESTRICTED } = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const A = require("../src/lib/automation-user") as typeof import("../src/lib/automation-user");
    const P = require("../src/lib/people") as typeof import("../src/lib/people");
    const { PERMISSIONS } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const { checkCredentials } = require("../src/actions/auth") as typeof import("../src/actions/auth");
    const { requestPasswordReset, resetPassword } = require("../src/actions/password-reset") as typeof import("../src/actions/password-reset");
    const setup = require("../src/lib/account-setup") as typeof import("../src/lib/account-setup");
    const { createHandoffTicket } = require("../src/lib/platform/handoff") as typeof import("../src/lib/platform/handoff");
    const G = require("../src/lib/platform/linked/groups") as typeof import("../src/lib/platform/linked/groups");
    const I = require("../src/lib/platform/linked/intents") as typeof import("../src/lib/platform/linked/intents");
    const VA = require("../src/actions/impersonation") as typeof import("../src/actions/impersonation");
    const VL = require("../src/lib/impersonation") as typeof import("../src/lib/impersonation");
    const { evaluateAccess, clearAccessCache } = require("../src/lib/access/gate") as typeof import("../src/lib/access/gate");
    const { can, permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    const { seatsInUse, seatProblem } = require("../src/lib/seats") as typeof import("../src/lib/seats");
    const { listAssignableUsers } = require("../src/actions/company") as typeof import("../src/actions/company");
    const copilot = require("../src/lib/copilot/tools") as typeof import("../src/lib/copilot/tools");
    const { getAccessLocks } = require("../src/actions/access-lock") as typeof import("../src/actions/access-lock");
    const { standingsFor } = require("../src/lib/performance/announce") as typeof import("../src/lib/performance/announce");
    const { listUsers } = require("../src/actions/user") as typeof import("../src/actions/user");
    const { usersExporter } = require("../src/lib/portability/exporters/users") as typeof import("../src/lib/portability/exporters/users");
    const { usersImporter } = require("../src/lib/portability/importers/users") as typeof import("../src/lib/portability/importers/users");
    const { peopleImporter } = require("../src/lib/portability/importers/people") as typeof import("../src/lib/portability/importers/people");
    const { createUserSchema } = require("../src/lib/validation/user") as typeof import("../src/lib/validation/user");
    const { ensureChartOfAccounts } = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
    const { listJournalEntries } = require("../src/actions/ledger-reports") as typeof import("../src/actions/ledger-reports");
    const { JournalEntries } = require("../src/components/accounting/journal-entries") as typeof import("../src/components/accounting/journal-entries");
    require("../src/lib/auth");
    closeTenancy = async () => {
      await closeAllClients();
      await db.$disconnect();
    };

    const scratch = directClient(scratchUrl);
    clients.push(scratch);
    const tenant: Tenant = {
      id: TENANT_ID,
      slug: "zzauto",
      name: "Zz Automation Check",
      status: "ACTIVE",
      dbUrl: scratchUrl,
      primaryHost: "zzauto.localhost:3000",
      hosts: ["zzauto.localhost:3000"],
      source: "env",
      isDefault: false,
      keyBundleCipher: null,
      country: "IN",
      entitlements: { ...UNRESTRICTED },
      holdReason: null,
    };
    /** Always `async () => await …`: a Prisma query runs where it is awaited, and must be awaited inside the workspace. */
    const inWs = <T>(work: () => Promise<T>): Promise<T> => runAsTenant(tenant, async () => await work());
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));

    // Fixtures: a super admin, a salesperson who can sign in, and somebody still waiting for their setup email.
    const password = randomBytes(18).toString("base64url");
    const hash = await bcrypt.hash(password, 4);
    const sa = await scratch.user.create({ data: { name: "Zz Owner", email: "owner@zzauto.example", role: "ADMIN", isSuperAdmin: true, passwordHash: await bcrypt.hash(randomBytes(18).toString("hex"), 4) } });
    const rep = await scratch.user.create({ data: { name: "Zz Rep", email: "rep@zzauto.example", role: "SALES", passwordHash: hash } });
    const newbie = await scratch.user.create({ data: { name: "Zz Newbie", email: "newbie@zzauto.example", role: "SALES", passwordHash: require("../src/lib/no-password").noPasswordYet() } });
    const automationRows = async () => scratch.user.findMany({ where: { email: A.AUTOMATION_EMAIL }, select: { id: true } });
    const heldBy = async (role: string) => {
      const overrides = await scratch.rolePermission.findMany({ where: { role }, select: { permission: true, allowed: true } });
      const o = new Map(overrides.map((r) => [r.permission, r.allowed]));
      return PERMISSIONS.filter((p) => o.get(p.key) ?? (p.defaultRoles as readonly string[]).includes(role)).length;
    };

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("1. The account: made once, whoever asks");

    ok("there is none until something asks", (await automationRows()).length === 0);
    const six = await inWs(async () => await Promise.all(Array.from({ length: 6 }, () => A.automationUserId())));
    ok("six calls at once through db answer with one id", new Set(six).size === 1, six);
    ok("  and made one account", (await automationRows()).length === 1);
    const row = await scratch.user.findUniqueOrThrow({ where: { id: six[0]! } });
    ok("it is the Automation account: its address, its name, its kind", row.email === "automation@system.invalid" && row.name === "Automation" && row.kind === "AUTOMATION", row);
    ok("  active, and never a super admin", row.active && !row.isSuperAdmin);
    ok("  its password is the no-password placeholder, which no bcrypt compare can match", row.passwordHash.startsWith("no-password-yet:") && row.passwordHash.length !== 60, row.passwordHash.length);
    const systemRoles = (await scratch.role.findMany({ where: { isSystem: true, key: { notIn: ["ADMIN", "SUPPORT_READONLY"] } }, select: { key: true } })).map((r) => r.key);
    const counts = await Promise.all(systemRoles.map(async (key) => ({ key, n: await heldBy(key) })));
    const fewest = Math.min(...counts.map((c) => c.n));
    ok("  its role is a built-in one holding the fewest permissions", systemRoles.includes(row.role) && (await heldBy(row.role)) === fewest, { role: row.role, counts });
    ok("  never the administrator's or support's read-only role", row.role !== "ADMIN" && row.role !== "SUPPORT_READONLY");

    await scratch.user.delete({ where: { id: row.id } });
    const remembered = await inWs(async () => await A.automationUserId());
    ok("the answer is remembered per workspace: asked again, it is not looked up", remembered === row.id && (await automationRows()).length === 0);
    await inWs(async () => await A.forgetAutomationUser());
    const again = await inWs(async () => await A.automationUserId());
    ok("  forgotten (as a data reset does), it is made again", again !== row.id && (await automationRows()).length === 1);

    // Counting this workspace's changes: PROFILE given five more permissions than it has by default.
    const profileBefore = await heldBy("PROFILE");
    const extra = PERMISSIONS.filter((p) => !(p.defaultRoles as readonly string[]).includes("PROFILE")).slice(0, 25).map((p) => p.key);
    await scratch.rolePermission.createMany({ data: extra.map((permission) => ({ role: "PROFILE", permission, allowed: true })) });
    await scratch.user.delete({ where: { id: again } });
    const c1 = directClient(scratchUrl);
    const c2 = directClient(scratchUrl);
    const c3 = directClient(scratchUrl);
    clients.push(c1, c2, c3);
    const reroled = await A.automationUserId(c1);
    const reroledRow = await scratch.user.findUniqueOrThrow({ where: { id: reroled } });
    const countsNow = await Promise.all(systemRoles.map(async (key) => ({ key, n: await heldBy(key) })));
    ok(
      "the role counts this workspace's changes to the matrix: PROFILE, given more, is passed over",
      reroledRow.role !== "PROFILE" && (await heldBy(reroledRow.role)) === Math.min(...countsNow.map((c) => c.n)) && (await heldBy("PROFILE")) > profileBefore,
      { role: reroledRow.role, countsNow },
    );
    await scratch.rolePermission.deleteMany({ where: { role: "PROFILE", permission: { in: extra } } });

    let raced = 0;
    for (let round = 0; round < 5; round += 1) {
      await scratch.user.deleteMany({ where: { email: A.AUTOMATION_EMAIL } });
      const ids = await Promise.all([A.automationUserId(c1), A.automationUserId(c2), A.automationUserId(c3)]);
      if (new Set(ids).size === 1 && (await automationRows()).length === 1) raced += 1;
    }
    ok("three clients asking at once make one account — five rounds out of five", raced === 5, raced);

    await scratch.user.deleteMany({ where: { email: A.AUTOMATION_EMAIL } });
    const inTx = await Promise.all([c1.$transaction(async (tx) => await A.automationUserId(tx)), c2.$transaction(async (tx) => await A.automationUserId(tx))]);
    ok("two transactions asking at once make one account, and neither is aborted", inTx[0] === inTx[1] && (await automationRows()).length === 1, inTx);

    await scratch.user.deleteMany({ where: { email: A.AUTOMATION_EMAIL } });
    const rolledBack = await refusal(() =>
      c1.$transaction(async (tx) => {
        await A.automationUserId(tx);
        throw new Error("zz roll back");
      }),
    );
    ok("a transaction that rolls back takes the account with it", rolledBack?.message === "zz roll back" && (await automationRows()).length === 0, rolledBack);

    const squatter = await scratch.user.create({ data: { name: "Zz Squatter", email: A.AUTOMATION_EMAIL, role: "SALES", passwordHash: hash } });
    const squatted = await refusal(() => A.automationUserId(c1));
    ok("a person holding its address is never taken for it", !!squatted && /isn't the workspace's Automation account/.test(squatted.message), squatted);
    await scratch.user.delete({ where: { id: squatter.id } });

    await inWs(async () => await A.forgetAutomationUser());
    const autoId = await inWs(async () => await A.automationUserId());
    const auto = await scratch.user.findUniqueOrThrow({ where: { id: autoId } });
    ok("made once more for the rest of this check", auto.kind === "AUTOMATION");

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("2. It never signs in");

    const config = await inWs(async () => await authConfig!());
    const provider = (id: string) => config.providers.find((p) => (p.options?.id ?? p.id) === id)?.options?.authorize;
    const authorize = provider("credentials");
    ok("the credentials provider is the real one", typeof authorize === "function");
    const control = (await inWs(async () => await authorize!({ email: rep.email, password, totpCode: "" }))) as { id?: string } | null;
    ok("  a person signs in with their password (the control)", control?.id === rep.id, control);

    const placeholder = auto.passwordHash;
    ok("the Automation account is refused with its own placeholder as the password", (await inWs(async () => await authorize!({ email: A.AUTOMATION_EMAIL, password: placeholder, totpCode: "" }))) === null);
    // A real password on it, as if somebody had set one: still refused, by its kind.
    const known = randomBytes(18).toString("base64url");
    await scratch.user.update({ where: { id: autoId }, data: { passwordHash: await bcrypt.hash(known, 4) } });
    ok("  and with a password that matches, refused all the same", (await inWs(async () => await authorize!({ email: A.AUTOMATION_EMAIL, password: known, totpCode: "" }))) === null);
    const logged = await scratch.activityLog.findFirst({ where: { kind: "LOGIN_FAILED", userId: autoId }, orderBy: { createdAt: "desc" }, select: { summary: true } });
    ok("  the log says why: by kind, not by a wrong password", /Automation account never signs in/.test(logged?.summary ?? ""), logged);

    const formCheck = await inWs(async () => await checkCredentials(A.AUTOMATION_EMAIL, known));
    ok("the login form's check refuses it, as it answers a wrong password", !formCheck.ok && formCheck.error === "Invalid email or password.", formCheck);
    const formControl = await inWs(async () => await checkCredentials(rep.email, password));
    ok("  and passes a person (the control)", formControl.ok, formControl);

    const microsoft = { provider: "microsoft-entra-id" };
    ok("Microsoft sign-in refuses it", (await inWs(async () => await config.callbacks.signIn({ user: { email: A.AUTOMATION_EMAIL }, account: microsoft }))) === false);
    ok("  and lets a person in (the control)", (await inWs(async () => await config.callbacks.signIn({ user: { email: rep.email }, account: microsoft }))) === true);
    const token = await inWs(async () => await config.callbacks.jwt({ token: {}, user: { email: A.AUTOMATION_EMAIL }, account: microsoft }));
    ok("no session is made for it, whichever provider named its address", token.id === undefined && (await scratch.signIn.count({ where: { userId: autoId } })) === 0, token);
    const repToken = await inWs(async () => await config.callbacks.jwt({ token: {}, user: { email: rep.email }, account: microsoft }));
    ok("  while a person's session is (the control)", repToken.id === rep.id, repToken);
    await scratch.user.update({ where: { id: autoId }, data: { passwordHash: placeholder } });

    const handoff = provider("handoff");
    for (const purpose of ["owner-signup", "support"] as const) {
      nextPass = { email: A.AUTOMATION_EMAIL, purpose };
      ok(`a handoff pass (${purpose}) never signs it in`, (await inWs(async () => await handoff!({ ticket: "zz-pass" }))) === null);
    }
    nextPass = { email: rep.email, purpose: "owner-signup" };
    const handedIn = (await inWs(async () => await handoff!({ ticket: "zz-pass" }))) as { id?: string } | null;
    ok("  while an owner's pass signs its member in (the control)", handedIn?.id === rep.id, handedIn);
    const noPass = await refusal(() => createHandoffTicket(tenant.id, " Automation@System.INVALID ", "support"));
    ok("  and no pass is ever made for its address", !!noPass && /no pass for the Automation account/.test(noPass.message), noPass);

    const linkInput = (userId: string) => ({ source: tenant, userId, sid: "zz-sid", viewingAs: false, workspace: "zzother", ip: null, origin: "http://zzauto.localhost:3000" });
    const linkAuto = await refusal(() => I.createLinkIntent(linkInput(autoId)));
    ok("linked sign-in refuses to link it", linkAuto instanceof G.LinkRefused && linkAuto.code === "support", linkAuto);
    const linkRep = await refusal(() => I.createLinkIntent(linkInput(rep.id)));
    ok("  while a person gets past that check (the control: refused only because this workspace isn't in a control plane)", linkRep instanceof G.LinkRefused && linkRep.code === "disabled", linkRep);
    const side = (email: string, tenantId: string) => ({ tenantId, userId: `zz-${tenantId}`, email, name: "Zz", stamp: "0".repeat(64), provenAt: new Date() });
    const joined = await refusal(() => G.joinGroup(side(A.AUTOMATION_EMAIL, "zz-a"), side(rep.email, "zz-b")));
    ok("  and no link group ever takes its address", joined instanceof G.LinkRefused && joined.code === "support", joined);

    mail.length = 0;
    await inWs(async () => await requestPasswordReset(A.AUTOMATION_EMAIL));
    ok("password reset: no link is made or mailed for it", (await scratch.passwordResetToken.count({ where: { userId: autoId } })) === 0 && mail.length === 0, mail);
    await inWs(async () => await requestPasswordReset(rep.email));
    ok("  while a person's is (the control)", (await scratch.passwordResetToken.count({ where: { userId: rep.id } })) === 1 && mail.some((m) => m.to === rep.email));
    const planted = randomBytes(32).toString("base64url");
    await scratch.passwordResetToken.create({ data: { tokenHash: createHash("sha256").update(planted).digest("hex"), userId: autoId, expiresAt: new Date(Date.now() + 3_600_000) } });
    const spent = await inWs(async () => await resetPassword({ token: planted, password: "zz-a-long-enough-password" }));
    const afterReset = await scratch.user.findUniqueOrThrow({ where: { id: autoId }, select: { passwordHash: true } });
    ok("  and a link that somehow exists for it sets nothing", !spent.ok && afterReset.passwordHash === placeholder, spent);
    await scratch.passwordResetToken.deleteMany({ where: { userId: autoId } });

    mail.length = 0;
    const invite = await inWs(async () => await setup.sendSetupInvitation({ id: autoId, name: auto.name, email: auto.email }, { by: { id: sa.id, isSuperAdmin: true } }));
    ok("the setup email is never sent for it, and no link comes back", invite.emailed === false && !("setupUrl" in invite && invite.setupUrl) && mail.length === 0 && (await scratch.passwordResetToken.count({ where: { userId: autoId } })) === 0, invite);
    const inviteControl = await inWs(async () => await setup.sendSetupInvitation({ id: newbie.id, name: newbie.name, email: newbie.email }, { by: { id: sa.id, isSuperAdmin: true } }));
    ok("  while a new person's is (the control)", inviteControl.emailed === true && mail.some((m) => m.to === newbie.email), inviteControl);
    ok("  and it never shows as \"Invitation pending\"", (await inWs(async () => await setup.awaitingSetup(autoId))) === false && (await inWs(async () => await setup.awaitingSetup(newbie.id))) === true);

    sessionUser = { id: sa.id, name: sa.name, email: sa.email, role: "ADMIN" };
    jar.clear();
    const viewAuto = await inWs(async () => await VA.startViewingAs(autoId));
    ok("view-as refuses it", !viewAuto.ok, viewAuto);
    const viewRep = await inWs(async () => await VA.startViewingAs(rep.id));
    ok("  and lets the super admin view as a person (the control)", viewRep.ok, viewRep);
    jar.clear();
    await inWs(async () => await VL.setViewAsCookie(sa.id, autoId));
    ok("  a view-as ticket naming it resolves to nobody", (await inWs(async () => await VL.resolveViewAs(sa.id))) === null);
    jar.clear();
    await inWs(async () => await VL.setViewAsCookie(sa.id, rep.id));
    ok("  while one naming a person resolves (the control)", (await inWs(async () => await VL.resolveViewAs(sa.id)))?.user.id === rep.id);
    jar.clear();

    clearAccessCache();
    const gateInput = (userId: string) => ({ userId, sid: null, deviceToken: null, ip: "203.0.113.41", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) check-automation-user", mobileHint: null });
    const gated = await inWs(async () => await evaluateAccess(gateInput(autoId)));
    ok("the access gate ends any session that claims to be it", !gated.ok && gated.reason === "SESSION_ENDED", gated);
    ok("  before a device or a network is recorded for it", (await scratch.userDevice.count({ where: { userId: autoId } })) === 0);
    const gatedRep = await inWs(async () => await evaluateAccess(gateInput(rep.id)));
    ok("  while a person passes (the control)", gatedRep.ok, gatedRep);

    const salesKey = PERMISSIONS.find((p) => (p.defaultRoles as readonly string[]).includes("SALES"))!.key;
    await scratch.userPermission.create({ data: { userId: autoId, permission: salesKey, allowed: true } });
    await scratch.user.update({ where: { id: autoId }, data: { role: "SALES" } });
    ok("the permission resolver gives it nothing — not its role's, not a grant made to it", !(await inWs(async () => await can(autoId, salesKey))) && (await inWs(async () => await permissionsFor(autoId))).length === 0);
    ok("  while the same role and key hold for a person (the control)", await inWs(async () => await can(rep.id, salesKey)));
    await scratch.userPermission.deleteMany({ where: { userId: autoId } });
    await scratch.user.update({ where: { id: autoId }, data: { role: auto.role } });

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("3. Never listed, counted or picked");

    const people = await scratch.user.count({ where: { active: true, kind: "MEMBER" } });
    ok("it is not a seat", (await inWs(async () => await seatsInUse())) === people && (await scratch.user.count({ where: { active: true } })) === people + 1);
    tenant.entitlements = { ...UNRESTRICTED, seats: people + 1 };
    ok("  so the last seat is still free for a person", (await inWs(async () => await seatProblem(1))) === null);
    tenant.entitlements = { ...UNRESTRICTED };
    const listed = await inWs(async () => await db.user.findMany({ select: { id: true } }));
    ok("db's own listings leave it out", !listed.some((u) => u.id === autoId) && listed.some((u) => u.id === rep.id) && (await inWs(async () => await db.user.count())) === 3);
    const assignable = await inWs(async () => await listAssignableUsers());
    ok("owner and assignee pickers leave it out", !assignable.some((u) => u.id === autoId) && assignable.some((u) => u.id === rep.id));
    const tools = await inWs(async () => await copilot.toolsFor());
    const colleague = await inWs(async () => await copilot.runTool(tools, { userId: sa.id, conversationId: "zz" }, "find_colleague", { name: "Automation" }));
    const colleagueRep = await inWs(async () => await copilot.runTool(tools, { userId: sa.id, conversationId: "zz" }, "find_colleague", { name: "Zz Rep" }));
    ok("the Copilot's find_colleague never finds it", Array.isArray(colleague.output) && colleague.output.length === 0 && Array.isArray(colleagueRep.output) && colleagueRep.output.length === 1, [colleague.output, colleagueRep.output]);
    const task = await inWs(async () => await copilot.runTool(tools, { userId: sa.id, conversationId: "zz" }, "propose_task", { title: "Zz task", assigneeUserId: autoId }));
    ok("  and propose_task won't assign it anything", task.isError && /isn't an active user/.test(show(task.output)), task.output);
    const targets = await inWs(async () => await VA.listViewAsTargets());
    ok("view-as never offers it", !targets.some((u) => u.id === autoId) && targets.some((u) => u.id === rep.id));
    const locks = await inWs(async () => await getAccessLocks());
    ok("the lock screen never offers it", !!locks && !locks.candidates.some((u) => u.id === autoId) && locks.candidates.some((u) => u.id === rep.id));
    const now = new Date();
    await scratch.auditLog.createMany({
      data: [
        { userId: autoId, action: "CREATE", entityType: "JournalEntry", entityId: "zz-1", entityLabel: "Zz" },
        { userId: autoId, action: "CREATE", entityType: "JournalEntry", entityId: "zz-2", entityLabel: "Zz" },
        { userId: rep.id, action: "CREATE", entityType: "Company", entityId: "zz-3", entityLabel: "Zz" },
      ],
    });
    const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const standings = await inWs(async () => await standingsFor({ from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 86_400_000), firstDay: day(new Date(now.getTime() - 86_400_000)), lastDay: day(new Date(now.getTime() + 86_400_000)) }));
    ok("the Most Active standings never rank it, however much it posts", !standings.some((s) => s.userId === autoId) && standings.some((s) => s.userId === rep.id), standings);
    const users = await inWs(async () => await listUsers());
    ok("Users & access never lists it", !users.some((u) => u.id === autoId) && users.some((u) => u.id === newbie.id && u.setupPending));
    const exported = await inWs(async () => await usersExporter({ userId: sa.id, ownerUserIds: null }));
    ok("the users export leaves it out", !exported.some((r) => r.Email === A.AUTOMATION_EMAIL) && exported.some((r) => r.Email === rep.email));
    const ctx = { actorUserId: sa.id, area: "users", pendingKeys: new Set<string>() };
    const autoKey = `USR-${String(auto.userSeq).padStart(6, "0")}`;
    const byAddress = await inWs(async () => await usersImporter.plan({ Name: "Automation", Email: A.AUTOMATION_EMAIL, Role: "SALES" }, 2, ctx));
    const byKey = await inWs(async () => await usersImporter.plan({ Key: autoKey, Name: "Zz Renamed", Email: "", Role: "SALES" }, 3, ctx));
    const repKey = `USR-${String(rep.userSeq).padStart(6, "0")}`;
    const byRepKey = await inWs(async () => await usersImporter.plan({ Key: repKey, Name: rep.name, Email: rep.email, Role: "SALES" }, 4, ctx));
    ok("the users import won't touch it by its address", byAddress.action === "error" && /reserved address/.test(byAddress.error ?? ""), byAddress);
    ok("  nor by its key", byKey.action === "error" && /No user with key/.test(byKey.error ?? ""), byKey);
    ok("  while a person's row is read (the control)", byRepKey.action !== "error", byRepKey);
    const hr = await inWs(async () => await peopleImporter.plan({ User: autoKey, "Employee code": "ZZ1" }, 2, { ...ctx, area: "people" }));
    ok("the employee import won't attach a record to it", hr.action === "error" && /No user with key/.test(hr.error ?? ""), hr);
    const reserved = [A.AUTOMATION_EMAIL, "support.zz@platform.invalid"].map((email) => createUserSchema.safeParse({ name: "Zz Person", email, role: "SALES" }).success);
    ok("no new account can take its address (nor support's)", reserved.every((s) => s === false) && createUserSchema.safeParse({ name: "Zz Person", email: "zz@zzauto.example", role: "SALES" }).success);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section('4. "Posted automatically"');

    await ensureChartOfAccounts(scratch);
    const [cash, sales] = await Promise.all([scratch.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "CASH" } }), scratch.ledgerAccount.findUniqueOrThrow({ where: { systemKey: "SALES" } })]);
    const entry = (entryNumber: string, createdById: string) =>
      scratch.journalEntry.create({
        data: {
          entryNumber,
          date: now,
          narration: `Zz ${entryNumber}`,
          source: "MANUAL",
          createdById,
          lines: { create: [{ accountId: cash.id, debit: 100, sortOrder: 0 }, { accountId: sales.id, credit: 100, sortOrder: 1 }] },
        },
      });
    await entry("ZZ-AUTO-1", autoId);
    await entry("ZZ-REP-1", rep.id);
    const journal = await inWs(async () => await listJournalEntries({ page: 1, pageSize: 50 }));
    const autoEntry = journal.rows.find((r) => r.entryNumber === "ZZ-AUTO-1");
    ok("the journal list reads its creator's kind", autoEntry?.createdBy.kind === "AUTOMATION", autoEntry?.createdBy);
    const html = renderToStaticMarkup(createElement(JournalEntries, { entries: journal.rows as never, canReverse: false }) as ReactElement);
    const occurrences = (needle: string) => html.split(needle).length - 1;
    ok('its entry reads "Posted automatically"', occurrences("Posted automatically") === 1, occurrences("Posted automatically"));
    ok("  a person's reads their name", occurrences("by Zz Rep") === 1 && occurrences("by Automation") === 0);
    ok('authorLabel: "Posted automatically" for the kind, "by <name>" otherwise', P.authorLabel({ name: "Automation", kind: "AUTOMATION" }) === "Posted automatically" && P.authorLabel({ name: "Zz", kind: "MEMBER" }) === "by Zz" && P.authorLabel(null) === null);
    sessionUser = null;

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("5. Static scans");

    const src = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    const refusals: [string, number][] = [
      ["src/lib/auth.ts", 3],
      ["src/actions/auth.ts", 1],
      ["src/lib/access/gate.ts", 1],
      ["src/lib/platform/handoff-sign-in.ts", 1],
      ["src/actions/password-reset.ts", 2],
      ["src/lib/account-setup.ts", 1],
      ["src/actions/impersonation.ts", 1],
      ["src/lib/impersonation.ts", 1],
    ];
    for (const [file, n] of refusals) {
      const found = (src(file).match(/isAutomationKind\(/g) ?? []).length;
      ok(`${file} refuses it by kind (${n})`, found >= n, found);
    }
    ok("src/lib/authz/resolve.ts gives it nothing by kind", /user\.kind === "AUTOMATION"/.test(src("src/lib/authz/resolve.ts")));
    ok("src/lib/platform/handoff.ts makes no pass for its address", /AUTOMATION_EMAIL/.test(src("src/lib/platform/handoff.ts")));
    for (const file of ["src/lib/platform/linked/groups.ts", "src/lib/platform/linked/intents.ts", "src/actions/linked-sign-in.ts"]) {
      ok(`${file}: support's and the Automation account's addresses are never linked`, /const isSupportAddress = \(email: string\) => isSystemAddress\(email\);/.test(src(file)));
    }
    const pinned = ["src/actions/access-lock.ts", "src/actions/expense.ts", "src/actions/impersonation.ts", "src/lib/copilot/tools.ts", "src/lib/performance/announce.ts", "src/lib/seats.ts"];
    for (const file of pinned) ok(`${file}: a user query that names id or kind says PEOPLE_ONLY`, /\.\.\.PEOPLE_ONLY/.test(src(file)));
    const walk = (dir: string): string[] => {
      const fs = require("node:fs") as typeof import("node:fs");
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    };
    const literal = walk(path.join(ROOT, "src"))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .filter((file) => file !== "src/lib/people.ts" && file !== "src/lib/db.ts")
      .filter((file) => /kind: "MEMBER"/.test(src(file)));
    ok('`kind: "MEMBER"` is written only in src/lib/people.ts (PEOPLE_ONLY) and db.ts\'s own filter', literal.length === 0, literal.join(", "));
  } finally {
    mailerReset();
    for (const c of clients) await c.$disconnect().catch(() => {});
    if (closeTenancy) await closeTenancy().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_database WHERE datname = '${scratchName}'`).catch(() => [{ n: BigInt(-1) }]);
    ok("the scratch database is dropped", Number(left[0]?.n) === 0, left);
    await admin.$disconnect();
  }
}

function mailerReset() {
  try {
    (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
  } catch {
    // Never loaded.
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => {
    console.log(`\n${passes} ok, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
