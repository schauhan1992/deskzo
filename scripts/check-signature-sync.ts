/**
 * check:signature-sync — Deskzo Signatures: the company's signatures, put into everybody's Gmail or
 * Zoho Mail and kept in step (src/lib/signatures, src/actions/signature.ts).
 *
 * Built like check:calendar: a scratch workspace database beside the real one (made from the
 * migrations, dropped at the end) and a stand-in Google and Zoho on a local port — the real services
 * are never called and the real workspace is never written. Google is a service account with
 * domain-wide delegation, so the stand-in checks the signed token itself; Zoho is an administrator's
 * grant, an organisation, its accounts and an admin-added signature per person.
 *
 * Microsoft 365 is the Outlook add-in (src/lib/signatures/outlook.ts): its manifest is checked for shape,
 * and its script is run in a stand-in Outlook (node:vm) whose fetch reaches the real signature route.
 *
 *   npm run check:signature-sync
 */
import "dotenv/config";
import Module from "node:module";
import http from "node:http";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { execSync } from "node:child_process";
import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ZOHO_REGION_KEYS, type ZohoRegion } from "../src/lib/workplace/providers";
import { renderHtml } from "./lib/render-html";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
const withDatabase = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const TAG = "ZZSIGNATURE";
const DOMAIN = "zzsig.example";
const ZOHO_CLIENT = "1000.ZZSIGNATURE";
const ZOHO_SECRET = "zz-zoho-secret";

// ── Who the code thinks is calling ──────────────────────────────────────────────────────────────

let actor: { id: string; name: string; email: string; role: string } | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const navigation = {
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/signatures",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const nextHeaders = {
  headers: async () => new Headers({ host: "zzsignatures.localhost:3000" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] }),
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
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

// ── A stand-in Google and Zoho ──────────────────────────────────────────────────────────────────

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const SERVICE_EMAIL = "deskzo-signatures@zz-project.iam.gserviceaccount.com";
const keyFile = (email = SERVICE_EMAIL) => JSON.stringify({ type: "service_account", client_email: email, private_key: keys.privateKey, token_uri: "https://oauth2.googleapis.com/token" });

type Sig = { id: string; name: string; content: string; position: number };
const stand = {
  google: {
    /** "ok", or "undelegated" — the Admin console never got the client ID. */
    mode: "ok" as "ok" | "undelegated",
    /** Addresses Google Workspace doesn't have. */
    unknown: new Set<string>(),
    signatures: new Map<string, string>(),
    patches: 0,
    badTokens: 0,
  },
  zoho: {
    revoked: false,
    accounts: [] as { zuid: number; email: string }[],
    signatures: new Map<string, Sig[]>(),
    posts: 0,
    puts: 0,
    seq: 0,
  },
};

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function startStandIn(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const body = (() => {
        try {
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          return Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>;
        }
      })();
      const auth = String(req.headers.authorization ?? "");

      // Google: the token, as the service account acting for one person.
      if (path === "/g-token" && req.method === "POST") {
        const [head, claims, signature] = String(body.assertion ?? "").split(".");
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${head}.${claims}`);
        if (!head || !claims || !signature || !verifier.verify(keys.publicKey, b64(signature))) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        const c = JSON.parse(b64(claims).toString("utf8")) as { iss: string; sub: string; scope: string; exp: number; iat: number };
        if (stand.google.mode === "undelegated") return json(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method." });
        if (c.iss !== SERVICE_EMAIL || c.scope !== "https://www.googleapis.com/auth/gmail.settings.basic" || c.exp - c.iat !== 3600) return json(400, { error: "invalid_grant", error_description: "Bad claims." });
        if (stand.google.unknown.has(c.sub)) return json(400, { error: "invalid_grant", error_description: "Invalid email or User ID" });
        return json(200, { access_token: `gtok:${c.sub}`, expires_in: 3600, token_type: "Bearer" });
      }
      const gmail = /^\/g-gmail\/gmail\/v1\/users\/([^/]+)\/settings\/sendAs(?:\/([^/]+))?$/.exec(path);
      if (gmail) {
        const user = decodeURIComponent(gmail[1]!);
        if (auth !== `Bearer gtok:${user}`) {
          stand.google.badTokens++;
          return json(401, { error: { code: 401 } });
        }
        if (req.method === "GET") return json(200, { sendAs: [{ sendAsEmail: user, isPrimary: true, signature: stand.google.signatures.get(user) ?? "" }] });
        if (req.method === "PATCH" && gmail[2] && decodeURIComponent(gmail[2]) === user) {
          stand.google.patches++;
          stand.google.signatures.set(user, String(body.signature ?? ""));
          return json(200, { sendAsEmail: user, signature: body.signature });
        }
        return json(404, { error: { code: 404 } });
      }

      // Zoho: the administrator's grant.
      if (path === "/z-in-accounts/oauth/v2/token" && req.method === "POST") {
        if (body.client_id !== ZOHO_CLIENT || body.client_secret !== ZOHO_SECRET) return json(200, { error: "invalid_client" });
        if (body.grant_type === "authorization_code") return body.code === "good-code" ? json(200, { access_token: "ztok", refresh_token: "zrefresh", expires_in: 3600, scope: "ZohoMail.organization.accounts.ALL" }) : json(200, { error: "invalid_code" });
        if (body.grant_type === "refresh_token") return stand.zoho.revoked || body.refresh_token !== "zrefresh" ? json(200, { error: "invalid_code" }) : json(200, { access_token: "ztok", expires_in: 3600 });
        return json(400, { error: "unsupported_grant_type" });
      }
      if (path === "/z-in-accounts/oauth/user/info") return json(200, { Email: `admin@${DOMAIN}`, Display_Name: "Zoho Admin" });
      if (path.startsWith("/z-in-mail/") && auth !== "Zoho-oauthtoken ztok") return json(401, { status: { code: 401, description: "Invalid OAuthtoken" } });
      if (path === "/z-in-mail/api/accounts") return json(200, { status: { code: 200, description: "success" }, data: [{ accountId: "1", zuid: 1, policyId: { zoid: 777, "1082700000003462021": "home POLICY1." } }] });
      if (path === "/z-in-mail/api/organization/777/accounts") {
        const start = Number(url.searchParams.get("start") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const page = stand.zoho.accounts.slice(start, start + limit).map((a) => ({ zuid: a.zuid, accountId: String(a.zuid), primaryEmailAddress: a.email, mailboxAddress: a.email }));
        return json(200, { status: { code: 200, description: "success" }, data: page });
      }
      const zsig = /^\/z-in-mail\/api\/organization\/777\/accounts\/(\d+)\/signature$/.exec(path);
      if (zsig) {
        const zuid = zsig[1]!;
        const list = stand.zoho.signatures.get(zuid) ?? [];
        if (req.method === "GET") return json(200, { status: { code: 200, description: "success" }, data: list });
        if (req.method === "POST") {
          stand.zoho.posts++;
          if (list.some((s) => s.name === body.name)) return json(500, { status: { code: 500, description: "Internal Error" }, data: { moreInfo: "The name you have entered is already exists." } });
          const sig: Sig = { id: `9000${++stand.zoho.seq}`, name: String(body.name), content: String(body.content), position: Number(body.position) };
          stand.zoho.signatures.set(zuid, [...list, sig]);
          return json(201, { status: { code: 201, description: "Created" }, data: { ...sig, signatureType: "USER_SIGNATURE" } });
        }
        if (req.method === "PUT") {
          stand.zoho.puts++;
          const found = list.find((s) => s.id === String(body.id));
          if (!found) return json(500, { status: { code: 500, description: "Internal Error" }, data: { moreInfo: "The input passed is invalid" } });
          found.content = String(body.content);
          return json(200, { status: { code: 200, description: "success" }, data: { ...found, signatureType: "USER_SIGNATURE" } });
        }
      }
      json(404, { error: "no such stand-in", path });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ── The scratch database ────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_signatures`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  const server = await startStandIn();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closeAll: (() => Promise<void>) | null = null;
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
    /* eslint-enable @typescript-eslint/no-require-imports */
    closeAll = () => db.$disconnect();
    await run(scratchUrl, base);
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
  ok("its signature settings, templates and syncs are as they were", realAfter === realBefore, realAfter);
  console.log(failures === 0 ? `\nAll ${passes} signature sync checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function snapshot(client: PrismaClient): Promise<string> {
  const [settings, templates, rules, syncs] = await Promise.all([
    client.signatureSettings.findMany({ select: { provider: true, updatedAt: true } }).catch(() => "none"),
    client.signatureTemplate.findMany({ select: { id: true, updatedAt: true } }).catch(() => "none"),
    client.signatureRule.count().catch(() => -1),
    client.signatureSync.count().catch(() => -1),
  ]);
  return JSON.stringify({ settings, templates, rules, syncs });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(scratchUrl: string, base: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant, tenantOrigin } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { encryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const settingsLib = require("../src/lib/workplace/settings") as typeof import("../src/lib/workplace/settings");
  const zohoMail = require("../src/lib/mail/zoho") as typeof import("../src/lib/mail/zoho");
  const google = require("../src/lib/signatures/google") as typeof import("../src/lib/signatures/google");
  const person = require("../src/lib/signatures/person") as typeof import("../src/lib/signatures/person");
  const sync = require("../src/lib/signatures/sync") as typeof import("../src/lib/signatures/sync");
  const connect = require("../src/lib/signatures/connect") as typeof import("../src/lib/signatures/connect");
  const actions = require("../src/actions/signature") as typeof import("../src/actions/signature");
  const photoRoute = require("../src/app/api/signatures/photo/[token]/route") as typeof import("../src/app/api/signatures/photo/[token]/route");
  const connectRoute = require("../src/app/api/mail/[provider]/connect/route") as typeof import("../src/app/api/mail/[provider]/connect/route");
  const callbackRoute = require("../src/app/api/mail/[provider]/callback/route") as typeof import("../src/app/api/mail/[provider]/callback/route");
  const connectState = require("../src/lib/mail/connect-state") as typeof import("../src/lib/mail/connect-state");
  const outlookLib = require("../src/lib/signatures/outlook") as typeof import("../src/lib/signatures/outlook");
  const signatureRoute = require("../src/app/api/signatures/outlook/signature/route") as typeof import("../src/app/api/signatures/outlook/signature/route");
  const scriptRoute = require("../src/app/api/signatures/outlook/launch.js/route") as typeof import("../src/app/api/signatures/outlook/launch.js/route");
  const pageRoute = require("../src/app/api/signatures/outlook/launch.html/route") as typeof import("../src/app/api/signatures/outlook/launch.html/route");
  const allowedRoute = require("../src/app/api/signatures/outlook/allowed/route") as typeof import("../src/app/api/signatures/outlook/allowed/route");
  const manifestRoute = require("../src/app/api/signatures/outlook/manifest.xml/route") as typeof import("../src/app/api/signatures/outlook/manifest.xml/route");
  const iconRoute = require("../src/app/api/signatures/outlook/icon/[size]/route") as typeof import("../src/app/api/signatures/outlook/icon/[size]/route");
  const MyPage = (require("../src/app/(dashboard)/signatures/page") as { default: () => Promise<unknown> }).default;
  const ManagePage = (require("../src/app/(dashboard)/signatures/manage/page") as { default: (p: unknown) => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  google.setTestGoogleHosts({ token: `${base}/g-token`, gmail: `${base}/g-gmail` });
  zohoMail.setTestZohoRegions(Object.fromEntries(ZOHO_REGION_KEYS.map((r) => [r, { accounts: `${base}/z-${r}-accounts`, mail: `${base}/z-${r}-mail` }])) as Record<ZohoRegion, { accounts: string; mail: string }>);
  const tenant = {
    id: randomUUID(),
    slug: "zzsignatures",
    name: "zzsignatures",
    status: "ACTIVE" as const,
    dbUrl: scratchUrl,
    primaryHost: "zzsignatures.localhost",
    hosts: ["zzsignatures.localhost"],
    source: "env" as const,
    isDefault: false,
    keyBundleCipher: null,
    country: "IN",
    timezone: "Asia/Kolkata",
    entitlements: { v: 1 as const, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] },
    holdReason: null,
  };

  try {
    await runAsTenant(tenant, async () => {
      section("The pure parts");
      ok("a key file that isn't JSON is refused", "error" in google.readServiceAccount("nope"));
      ok("...nor a key that isn't a service account's", "error" in google.readServiceAccount(JSON.stringify({ type: "authorized_user" })));
      const sa = google.readServiceAccount(keyFile());
      ok("a service account's key file is read", !("error" in sa) && sa.clientEmail === SERVICE_EMAIL);
      if ("error" in sa) throw new Error(sa.error);
      const assertion = google.signAssertion(sa, `rep@${DOMAIN}`, 1_800_000_000_000);
      const [h, c, s] = assertion.split(".");
      const v = createVerify("RSA-SHA256");
      v.update(`${h}.${c}`);
      const claims = JSON.parse(b64(c!).toString("utf8")) as Record<string, unknown>;
      ok("the token request is signed with the account's key, for one person, with the one scope", v.verify(keys.publicKey, b64(s!)) && claims.sub === `rep@${DOMAIN}` && claims.scope === google.GMAIL_SIGNATURE_SCOPE, JSON.stringify(claims));
      const rules = [
        { templateId: "person", target: "PERSON", targetId: "u1" },
        { templateId: "dept", target: "DEPARTMENT", targetId: "d1" },
        { templateId: "branch", target: "BRANCH", targetId: "b1" },
        { templateId: "role", target: "ROLE", targetId: "SALES" },
      ];
      const who = (p: Partial<{ id: string; departmentId: string | null; branchId: string | null; role: string }>) => person.templateIdFor({ id: "x", departmentId: null, branchId: null, role: "HR", ...p }, rules, "default");
      ok("a person's own rule wins over everything", who({ id: "u1", departmentId: "d1", branchId: "b1", role: "SALES" }) === "person");
      ok("then the department's, the branch's, the role's — then the default", who({ departmentId: "d1", branchId: "b1", role: "SALES" }) === "dept" && who({ branchId: "b1", role: "SALES" }) === "branch" && who({ role: "SALES" }) === "role" && who({}) === "default");

      section("The fixture");
      const mk = (key: string, role = "SALES", extra: Record<string, unknown> = {}) =>
        db.user.create({ data: { name: `${TAG} ${key}`, email: `${key.toLowerCase()}@${DOMAIN}`, role, passwordHash: "!", ...extra }, select: { id: true, name: true, email: true, role: true } });
      const boss = await mk("Boss", "MANAGEMENT");
      const rep = await mk("Rep", "SALES", { phone: "+91 98765 43210" });
      const other = await mk("Other", "SALES");
      const stranger = await mk("Stranger", "SALES");
      const sales = await db.department.create({ data: { name: `${TAG} Sales` }, select: { id: true } });
      await db.user.update({ where: { id: rep.id }, data: { departmentId: sales.id } });
      await db.employeeProfile.create({ data: { userId: rep.id, designation: "Account manager" } });
      await db.userPhoto.create({ data: { userId: rep.id, dataUrl: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", byteSize: 8 } });
      await db.user.update({ where: { id: rep.id }, data: { photoUpdatedAt: new Date() } });
      await db.organisationSettings.upsert({ where: { id: "global" }, create: { id: "global", legalName: `${TAG} Traders Pvt Ltd`, tradeName: `${TAG} Traders` }, update: { tradeName: `${TAG} Traders` } });
      await db.workplaceSettings.create({ data: { id: "global", zohoClientId: ZOHO_CLIENT, zohoClientSecretCipher: await encryptSecret(ZOHO_SECRET), zohoRegion: "in", zohoMail: true } });
      settingsLib.invalidateWorkplaceSettingsCache();
      ok("four people, a department, a photo and a Zoho app", true);

      section("A person's signature");
      const ctx = await person.signatureContext(boss.id);
      const repPerson = (await person.loadPerson(rep.id))!;
      const repSig = await person.personSignature(repPerson, ctx);
      ok("from the default template, made when there was none", ctx.templates.get(ctx.defaultId)?.isDefault === true && repSig.templateId === ctx.defaultId);
      ok("their name, title, phone and email from the record, the company from the organisation", repSig.html.includes(`${TAG} Rep`) && repSig.html.includes("Account manager") && repSig.html.includes("tel:+919876543210") && repSig.html.includes(`mailto:rep@${DOMAIN}`) && repSig.html.includes(`${TAG} Traders`));
      ok("the department is left off by default", !repSig.html.includes(`${TAG} Sales`));
      ok("no credit line — that is the free generator's", !repSig.html.includes("Made with"));
      const token = await person.photoToken(rep.id);
      ok("the photo is a public address that names one person", repSig.html.includes(`/api/signatures/photo/${token}?v=`) && (await person.userOfPhotoToken(token)) === rep.id);
      ok("...and can't be made up for anybody else", (await person.userOfPhotoToken(`${other.id}.${token.split(".")[1]}`)) === null && (await person.userOfPhotoToken("junk")) === null);
      const photo = await photoRoute.GET(new Request("http://x"), { params: Promise.resolve({ token }) });
      const fakePhoto = await photoRoute.GET(new Request("http://x"), { params: Promise.resolve({ token: `${rep.id}.AAAAAAAAAAAAAAAAAAAAAA` }) });
      ok("the photo address answers with the picture; a forged one with nothing", photo.status === 200 && photo.headers.get("content-type") === "image/png" && fakePhoto.status === 404);

      section("Templates and who gets which");
      actor = rep;
      ok("somebody without signatures.manage can't change a template", !(await actions.saveSignatureTemplate({ id: null, name: "x", layout: "CLASSIC", color: "#111111", font: "arial", shown: [], website: "", logoUrl: "", social: {}, ctaLabel: "", ctaUrl: "", signOff: "", disclaimer: "" })).ok);
      actor = boss;
      const base0 = { id: null, name: `${TAG} Sales`, layout: "MODERN", color: "#0f766e", font: "verdana", shown: ["title", "department", "phone", "email"], website: "zzsig.example", logoUrl: "", social: { linkedin: "linkedin.com/company/zz" }, ctaLabel: "Book a demo", ctaUrl: "zzsig.example/demo", signOff: "Regards,", disclaimer: "" };
      ok("a logo picked from a computer is refused — mail programs fetch it from an address", !(await actions.saveSignatureTemplate({ ...base0, logoUrl: "data:image/png;base64,iVBORw0KGgo=" })).ok);
      ok("a social profile that isn't an address is refused", !(await actions.saveSignatureTemplate({ ...base0, social: { linkedin: "javascript:alert(1)" } })).ok);
      const salesTemplate = await actions.saveSignatureTemplate(base0);
      ok("a manager makes a second template — not the default", salesTemplate.ok && !(await db.signatureTemplate.findUniqueOrThrow({ where: { id: salesTemplate.ok ? salesTemplate.data.id : "" } })).isDefault, errorOf(salesTemplate));
      const salesId = salesTemplate.ok ? salesTemplate.data.id : "";
      ok("the Sales department gets it", (await actions.setSignatureRule({ target: "DEPARTMENT", targetId: sales.id, templateId: salesId })).ok);
      const ctx2 = await person.signatureContext();
      const repSales = await person.personSignature((await person.loadPerson(rep.id))!, ctx2);
      ok("...so the rep's signature is the Sales one, with the department and the button", repSales.templateId === salesId && repSales.html.includes(`${TAG} Sales`) && repSales.html.includes("Book a demo") && repSales.html.includes("border-top:3px solid #0f766e"));
      ok("the default can't be deleted", !(await actions.deleteSignatureTemplate(ctx.defaultId)).ok);

      section("Google Workspace");
      stand.google.mode = "undelegated";
      const refused = await actions.connectGoogleSignatures({ keyJson: keyFile(), adminEmail: `boss@${DOMAIN}` });
      ok("without domain-wide delegation it is refused, and says what to do in the Admin console", !refused.ok && /Domain-wide delegation/.test(errorOf(refused) ?? ""), errorOf(refused));
      ok("...and nothing is kept", (await db.signatureSettings.findUnique({ where: { id: "global" } }))?.provider == null);
      stand.google.mode = "ok";
      const connected = await actions.connectGoogleSignatures({ keyJson: keyFile(), adminEmail: `boss@${DOMAIN}` });
      const saved = await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } });
      ok("with it, Google Workspace is connected — tried on the administrator first", connected.ok && saved.provider === "GOOGLE" && saved.googleServiceEmail === SERVICE_EMAIL, errorOf(connected));
      ok("the key is kept encrypted, never as it was pasted", !!saved.googleKeyCipher && !saved.googleKeyCipher.includes("PRIVATE KEY"));

      stand.google.unknown.add(`stranger@${DOMAIN}`);
      const fixture = [boss.id, rep.id, other.id, stranger.id];
      const first = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture });
      ok("everybody's signature goes into Gmail — but the one Google doesn't know", first.synced === 3 && first.failed === 1 && first.stopped === null, JSON.stringify(first));
      ok("...each as themselves, with their own signature", stand.google.badTokens === 0 && (stand.google.signatures.get(`rep@${DOMAIN}`) ?? "").includes("Account manager") && (stand.google.signatures.get(`other@${DOMAIN}`) ?? "").includes(`${TAG} Other`));
      const strangerRow = await db.signatureSync.findUniqueOrThrow({ where: { userId: stranger.id } });
      ok("the one who failed says why, and waits for the next try", strangerRow.status === "FAILED" && /no such user/.test(strangerRow.lastError ?? "") && strangerRow.attempts === 1, strangerRow.lastError);
      const patchesBefore = stand.google.patches;
      const second = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture });
      ok("a second run sends nothing: the same signature is never sent twice, and the failure waits its turn", second.unchanged === 3 && second.waiting === 1 && stand.google.patches === patchesBefore, JSON.stringify(second));
      await db.user.update({ where: { id: other.id }, data: { phone: "+91 90000 00001" } });
      const third = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture });
      ok("a changed phone sends that one person's signature, and only theirs", third.synced === 1 && stand.google.patches === patchesBefore + 1 && (stand.google.signatures.get(`other@${DOMAIN}`) ?? "").includes("+91 90000 00001"), JSON.stringify(third));
      const forced = await sync.syncSignatures({ budgetMs: 30_000, userIds: [stranger.id], force: true });
      ok("Sync now tries the one who failed straight away", forced.failed === 1 && (await db.signatureSync.findUniqueOrThrow({ where: { userId: stranger.id } })).attempts === 2);
      stand.google.mode = "undelegated";
      const stopped = await sync.recordRun(await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture, force: true }));
      ok("when the delegation is taken away, the run stops at once — said once, on the settings", stopped.stopped !== null && stopped.synced === 0 && (await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } })).lastError === stopped.stopped, stopped.stopped);
      stand.google.mode = "ok";
      actor = rep;
      ok("somebody who doesn't manage signatures can't press Sync now", !(await actions.syncSignaturesNow()).ok);

      section("The pages");
      actor = rep;
      const mine = textOf(await renderHtml(await MyPage()));
      ok("My email signature: theirs, and that it is in their Gmail", mine.includes("My email signature") && mine.includes("Account manager") && mine.includes("In your Gmail") && mine.includes("Copy signature"), mine.slice(0, 260));
      actor = boss;
      const people = textOf(await renderHtml(await ManagePage({ searchParams: Promise.resolve({}) })));
      ok("Email signatures: each person, their template and whether it is in their mailbox", people.includes(`${TAG} Rep`) && people.includes(`${TAG} Sales`) && people.includes("In their mailbox") && people.includes("Failed"), people.slice(0, 300));
      const conn = textOf(await renderHtml(await ManagePage({ searchParams: Promise.resolve({ tab: "connection" }) })));
      ok("...and the connection, with the steps for Google and Zoho", conn.includes("Google Workspace") && conn.includes("gmail.settings.basic") && conn.includes("Connect Zoho Mail again") === false && conn.includes("Connect Zoho Mail"), conn.slice(0, 200));
      actor = rep;
      ok("somebody who doesn't manage signatures gets a 404 for it", await ManagePage({ searchParams: Promise.resolve({}) }).then(() => false, (e: Error) => e.message === "NOT_FOUND_CALLED"));

      section("Zoho Mail");
      actor = rep;
      const started = await connectRoute.GET(new NextRequest(`http://zzsignatures.localhost:3000/api/mail/zoho/connect?purpose=signatures&next=/signatures/manage`), { params: Promise.resolve({ provider: "zoho" }) });
      ok("somebody who doesn't manage signatures can't start the Zoho grant", (started.headers.get("location") ?? "").includes("mailbox=failed"));
      actor = boss;
      const go = await connectRoute.GET(new NextRequest(`http://zzsignatures.localhost:3000/api/mail/zoho/connect?purpose=signatures&next=/signatures/manage?tab=connection`), { params: Promise.resolve({ provider: "zoho" }) });
      const to = new URL(go.headers.get("location") ?? "http://x");
      ok("a manager is sent to Zoho asking for the organisation's accounts — through the mailbox callback already registered", to.pathname.endsWith("/oauth/v2/auth") && (to.searchParams.get("scope") ?? "").includes("ZohoMail.organization.accounts.ALL") && (to.searchParams.get("redirect_uri") ?? "").endsWith("/api/mail/zoho/callback"), to.toString());
      const cookie = go.cookies.get(connectState.CONNECT_COOKIE)?.value ?? "";
      const state = (await connectState.openState(cookie))!;
      ok("...with a state that says it is for signatures", state?.purpose === "signatures");
      const back = await callbackRoute.GET(
        new NextRequest(`http://zzsignatures.localhost:3000/api/mail/zoho/callback?code=good-code&state=${state.state}`, { headers: { cookie: `${connectState.CONNECT_COOKIE}=${cookie}` } }),
        { params: Promise.resolve({ provider: "zoho" }) },
      );
      const zohoSettings = await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } });
      ok("the grant comes back and is kept: Zoho, the organisation, who approved it", (back.headers.get("location") ?? "").includes("mailbox=connected") && zohoSettings.provider === "ZOHO" && zohoSettings.zohoOrgId === "777" && zohoSettings.zohoAdminEmail === `admin@${DOMAIN}`, back.headers.get("location"));
      ok("...the grant encrypted, and Google's key let go", !!zohoSettings.zohoRefreshCipher && zohoSettings.zohoRefreshCipher !== "zrefresh" && zohoSettings.googleKeyCipher === null);
      ok("...and nobody's mailbox ever saw a person's own Zoho connection made", (await db.mailConnection.count()) === 0);
      ok("finishing a grant for signatures needs the permission too", (await connect.mayConnectSignatures(rep.id)) === false);

      stand.zoho.accounts = [
        { zuid: 101, email: `boss@${DOMAIN}` },
        { zuid: 102, email: `rep@${DOMAIN}` },
        { zuid: 103, email: `other@${DOMAIN}` },
      ];
      const z1 = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture });
      ok("everybody with a Zoho Mail account gets the signature added; the one without is skipped", z1.synced === 3 && z1.skipped === 1 && stand.zoho.posts === 3, JSON.stringify(z1));
      const repZ = await db.signatureSync.findUniqueOrThrow({ where: { userId: rep.id } });
      ok("...Zoho's id for it is kept, against their account", repZ.provider === "ZOHO" && !!repZ.zohoSignatureId && repZ.zohoAccountId === "102");
      ok("...and it is the person's own signature, placed above the quoted text", (stand.zoho.signatures.get("102")?.[0]?.content ?? "").includes("Account manager") && stand.zoho.signatures.get("102")?.[0]?.position === 1);
      await db.employeeProfile.update({ where: { userId: rep.id }, data: { designation: "Senior account manager" } });
      const z2 = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture });
      ok("a new title updates it in place — no second signature", z2.synced === 1 && stand.zoho.puts === 1 && stand.zoho.signatures.get("102")?.length === 1 && (stand.zoho.signatures.get("102")?.[0]?.content ?? "").includes("Senior account manager"), JSON.stringify(z2));
      stand.zoho.signatures.set("102", []);
      await db.employeeProfile.update({ where: { userId: rep.id }, data: { designation: "Head of accounts" } });
      const z3 = await sync.syncSignatures({ budgetMs: 30_000, userIds: [rep.id] });
      ok("deleted in Zoho meanwhile: it is added again", z3.synced === 1 && (stand.zoho.signatures.get("102")?.[0]?.content ?? "").includes("Head of accounts"), JSON.stringify(z3));
      await db.signatureSync.update({ where: { userId: rep.id }, data: { zohoSignatureId: null } });
      const z4 = await sync.syncSignatures({ budgetMs: 30_000, userIds: [rep.id], force: true });
      ok("its id lost here: Zoho's own copy is found by name and updated, not doubled", z4.synced === 1 && stand.zoho.signatures.get("102")?.length === 1, JSON.stringify(z4));
      stand.zoho.revoked = true;
      const z5 = await sync.syncSignatures({ budgetMs: 30_000, userIds: fixture, force: true });
      ok("a withdrawn grant stops the run and says to connect again", z5.stopped !== null && /Connect Zoho Mail again/.test(z5.stopped ?? ""), z5.stopped);
      stand.zoho.revoked = false;

      section("Microsoft 365: the Outlook add-in");
      const ORIGIN = await tenantOrigin();
      const ask = (email: string) => signatureRoute.GET(new NextRequest(`${ORIGIN}/api/signatures/outlook/signature?email=${encodeURIComponent(email)}`));
      outlookLib.resetOutlookMisses();
      const offAnswer = await ask(`rep@${DOMAIN}`);
      ok("off until a manager turns it on: not found, and nothing for the add-in to say", offAnswer.status === 404 && (await offAnswer.json()).message === null);
      actor = rep;
      ok("somebody who doesn't manage signatures can't turn it on", !(await actions.setOutlookAddin(true)).ok);
      actor = boss;
      ok("a manager turns it on", (await actions.setOutlookAddin(true)).ok);
      const addinId = (await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } })).outlookAddinId ?? "";
      ok("...which gives the add-in its id, a GUID as Office wants", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(addinId), addinId);
      await actions.setOutlookAddin(false);
      await actions.setOutlookAddin(true);
      ok("off and on again keeps the id, so the uploaded manifest keeps working", (await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } })).outlookAddinId === addinId);

      // The manifest.
      const manifest = outlookLib.outlookManifest({ origin: ORIGIN, addinId, company: `${TAG} Traders & <Sons>` });
      const stack: string[] = [];
      let wellFormed = true;
      for (const m of manifest.replace(/<\?xml[^>]*\?>/, "").matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
        if (m[3]) continue;
        if (m[1]) wellFormed = wellFormed && stack.pop() === m[2];
        else stack.push(m[2]!);
      }
      ok("the manifest is well-formed XML, with every & and < in the company's name escaped", wellFormed && stack.length === 0 && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(manifest) && manifest.includes(`${TAG} Traders &amp; &lt;Sons&gt; signatures`));
      const order = ["<Id>", "<Version>", "<ProviderName>", "<DefaultLocale>", "<DisplayName", "<Description", "<IconUrl", "<HighResolutionIconUrl", "<SupportUrl", "<AppDomains>", "<Hosts>", "<Requirements>", "<FormSettings>", "<Permissions>", "<Rule ", "<VersionOverrides"];
      ok("...its elements in the order Office's schema reads them", order.every((tag, i) => i === 0 || manifest.indexOf(tag) > manifest.indexOf(order[i - 1]!)));
      ok("...the add-in's id, and read/write item — the least it can ask for to set a signature", manifest.includes(`<Id>${addinId}</Id>`) && manifest.includes("<Permissions>ReadWriteItem</Permissions>") && !manifest.includes("ReadWriteMailbox"));
      ok(
        "...a new message starts it on the desktop and on phones; classic Outlook gets the script itself",
        (manifest.match(/<LaunchEvent Type="OnNewMessageCompose" FunctionName="deskzoOnNewMessageCompose"\/>/g) ?? []).length === 2 &&
          /<DesktopFormFactor>[\s\S]*LaunchEvent[\s\S]*<\/DesktopFormFactor>\s*<MobileFormFactor>[\s\S]*LaunchEvent[\s\S]*<\/MobileFormFactor>/.test(manifest) &&
          manifest.includes(`<Override type="javascript" resid="LaunchScript.Url"/>`),
      );
      const urls = [...manifest.matchAll(/DefaultValue="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
      ok("...every address in it is this workspace's own, whole", urls.length >= 9 && urls.every((u) => u.startsWith(`${ORIGIN}/`)), urls.length);

      // The script, in a stand-in Outlook.
      const scriptRes = await scriptRoute.GET();
      const script = await scriptRes.text();
      ok("the script is served as JavaScript with the workspace's address written in", scriptRes.status === 200 && (scriptRes.headers.get("content-type") ?? "").startsWith("text/javascript") && script.includes(`var DESKZO_ORIGIN = "${ORIGIN}";`));
      ok("...and is one file with no imports, as classic Outlook for Windows needs", !/^\s*(import|export)\s/m.test(script) && !/require\(/.test(script) && (() => {
        try {
          new vm.Script(script);
          return true;
        } catch {
          return false;
        }
      })());
      type Fetched = { status: number; json: () => Promise<unknown> };
      const outlook = (o: { email: string; bodyType?: "html" | "text"; own?: boolean; failSet?: boolean; page?: boolean; fetchImpl?: (url: string) => Promise<Fetched> }) => {
        const calls = { set: [] as { data: string; coercion: string }[], disabled: 0, notes: [] as string[], completed: 0, onReady: 0, fetched: [] as string[] };
        const handlers = new Map<string, (event: unknown) => void>();
        type Cb = (r: { status: string; value?: unknown; error?: { message: string } }) => void;
        const item = {
          body: {
            getTypeAsync: (cb: Cb) => cb({ status: "succeeded", value: o.bodyType ?? "html" }),
            setSignatureAsync: (data: string, options: { coercionType: string }, cb: Cb) => {
              calls.set.push({ data, coercion: options.coercionType });
              cb(o.failSet ? { status: "failed", error: { message: "The data is too long" } } : { status: "succeeded" });
            },
          },
          isClientSignatureEnabledAsync: (cb: Cb) => cb({ status: "succeeded", value: o.own ?? true }),
          disableClientSignatureAsync: (cb: Cb) => {
            calls.disabled += 1;
            cb({ status: "succeeded" });
          },
          notificationMessages: {
            replaceAsync: (_key: string, m: { message: string }, cb: Cb) => {
              calls.notes.push(m.message);
              cb({ status: "succeeded" });
            },
          },
        };
        const realFetch = async (url: string): Promise<Fetched> => {
          const res = await signatureRoute.GET(new NextRequest(url));
          return { status: res.status, json: () => res.json() };
        };
        const Office = {
          context: { mailbox: { item, userProfile: { emailAddress: o.email } } },
          actions: { associate: (name: string, fn: (event: unknown) => void) => handlers.set(name, fn) },
          onReady: () => {
            calls.onReady += 1;
          },
        };
        vm.runInContext(
          script,
          vm.createContext({
            Office,
            setTimeout,
            clearTimeout,
            fetch: (url: string) => {
              calls.fetched.push(url);
              return (o.fetchImpl ?? realFetch)(url);
            },
            ...(o.page ? { document: {} } : {}),
          }),
        );
        const fire = (name: string) =>
          new Promise<void>((resolve) =>
            handlers.get(name)!({
              completed: () => {
                calls.completed += 1;
                resolve();
              },
            }),
          );
        return { calls, handlers, fire };
      };

      const classic = outlook({ email: `REP@${DOMAIN.toUpperCase()}` });
      ok("both handlers are made known to Office by the names in the manifest", classic.handlers.has(outlookLib.OUTLOOK_HANDLERS.compose) && classic.handlers.has(outlookLib.OUTLOOK_HANDLERS.button));
      await classic.fire(outlookLib.OUTLOOK_HANDLERS.compose);
      ok("a new message: it asks the workspace by the mailbox's address, with the whole address", classic.calls.fetched.length === 1 && classic.calls.fetched[0]!.startsWith(`${ORIGIN}/api/signatures/outlook/signature?email=`));
      ok("...and puts the rep's own signature in as HTML (the address matched whatever its case)", classic.calls.set.length === 1 && classic.calls.set[0]!.coercion === "html" && classic.calls.set[0]!.data.includes("Head of accounts") && classic.calls.set[0]!.data.includes(`${TAG} Rep`));
      ok("...turns off their own Outlook signature, so there is never two, and finishes the event once", classic.calls.disabled === 1 && classic.calls.completed === 1 && classic.calls.notes.length === 0);
      ok("...without a page it doesn't wait for one (classic Outlook for Windows)", classic.calls.onReady === 0);
      const web = outlook({ email: `rep@${DOMAIN}`, page: true, own: false });
      await web.fire(outlookLib.OUTLOOK_HANDLERS.button);
      ok("in a page (the web, the new Outlook, Mac, phones) it tells Office.js it is ready; the button puts it in too", web.calls.onReady === 1 && web.calls.set.length === 1 && web.calls.completed === 1);
      ok("...and leaves a person's own signature alone when there is none on", web.calls.disabled === 0);
      const plain = outlook({ email: `rep@${DOMAIN}`, bodyType: "text" });
      await plain.fire(outlookLib.OUTLOOK_HANDLERS.compose);
      ok("a plain-text message gets the plain-text twin", plain.calls.set[0]?.coercion === "text" && plain.calls.set[0]!.data.includes(`\n${TAG} Rep\n`) && !plain.calls.set[0]!.data.includes("<"), plain.calls.set[0]?.data.slice(0, 80));
      const nobody = outlook({ email: `nobody@${DOMAIN}` });
      await nobody.fire(outlookLib.OUTLOOK_HANDLERS.compose);
      ok("an address that is nobody's here: nothing put in, and the person is told whom to ask", nobody.calls.set.length === 0 && nobody.calls.completed === 1 && /Ask whoever manages/.test(nobody.calls.notes[0] ?? ""), nobody.calls.notes[0]);
      const refusedSet = outlook({ email: `rep@${DOMAIN}`, failSet: true });
      await refusedSet.fire(outlookLib.OUTLOOK_HANDLERS.compose);
      ok("Outlook refusing it: said, and the event still finished", refusedSet.calls.completed === 1 && /couldn't be put in: The data is too long/.test(refusedSet.calls.notes[0] ?? ""));
      const offline = outlook({ email: `rep@${DOMAIN}`, fetchImpl: () => Promise.reject(new Error("offline")) });
      await offline.fire(outlookLib.OUTLOOK_HANDLERS.compose);
      ok("the workspace out of reach: said, with the button to try again, and the event still finished", offline.calls.completed === 1 && /Insert signature/.test(offline.calls.notes[0] ?? ""));

      // What the signature endpoint answers.
      outlookLib.resetOutlookMisses();
      const repNow = await person.personSignature((await person.loadPerson(rep.id))!, await person.signatureContext());
      const seen = await db.signatureOutlook.findUniqueOrThrow({ where: { userId: rep.id } });
      ok("each fetch is noted against the person, with the signature's digest", seen.hash === repNow.hash);
      await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-a", seen.fetchedAt.getTime() + 5 * 60_000);
      ok("...but not written again within the hour for the same signature", (await db.signatureOutlook.findUniqueOrThrow({ where: { userId: rep.id } })).fetchedAt.getTime() === seen.fetchedAt.getTime());
      await db.employeeProfile.update({ where: { userId: rep.id }, data: { designation: "Director of accounts" } });
      const changed = await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-a");
      ok("a changed title is in the very next message, and noted", changed.status === 200 && (changed.body as { html: string }).html.includes("Director of accounts") && (await db.signatureOutlook.findUniqueOrThrow({ where: { userId: rep.id } })).hash !== seen.hash);
      ok("an address that isn't one is refused outright", (await outlookLib.outlookSignature("not an address", "caller-a")).status === 400);
      await db.user.update({ where: { id: other.id }, data: { active: false } });
      ok("a switched-off account has no signature", (await outlookLib.outlookSignature(`other@${DOMAIN}`, "caller-a")).status === 404);
      await db.user.update({ where: { id: other.id }, data: { active: true } });
      for (let i = 0; i < 25; i++) await outlookLib.outlookSignature(`guess${i}@${DOMAIN}`, "caller-guessing");
      ok("somebody guessing addresses is stopped — even for a real one — after twenty wrong", (await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-guessing")).status === 429);
      ok("...and only they are: everybody else is answered", (await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-b")).status === 200);
      ok("...and they are again ten minutes later", (await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-guessing", Date.now() + 11 * 60_000)).status === 200);
      ok("any origin may read it, and nothing keeps it", (await ask(`rep@${DOMAIN}`)).headers.get("access-control-allow-origin") === "*" && (await ask(`rep@${DOMAIN}`)).headers.get("cache-control") === "no-store");
      await actions.setOutlookReplaceOwn(false);
      ok("a manager can leave people's own Outlook signatures alone", ((await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-a")).body as { replaceOwn: boolean }).replaceOwn === false);
      await actions.setOutlookReplaceOwn(true);

      // The other files Outlook fetches, and the manifest's download.
      const page = await (await pageRoute.GET()).text();
      ok("the page loads Office.js from Microsoft, then the script from this workspace", page.indexOf(outlookLib.OFFICE_JS) > 0 && page.indexOf(`${ORIGIN}/api/signatures/outlook/launch.js`) > page.indexOf(outlookLib.OFFICE_JS));
      ok("the well-known file allows that one script", JSON.stringify(await (await allowedRoute.GET()).json()) === JSON.stringify({ allowed: [`${ORIGIN}/api/signatures/outlook/launch.js`] }));
      const icon = await iconRoute.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ size: "80" }) });
      const iconBytes = Buffer.from(await icon.arrayBuffer());
      ok("the icons are PNGs at the sizes Outlook asks for, and only those", icon.status === 200 && iconBytes.subarray(1, 4).toString("ascii") === "PNG" && iconBytes.readUInt32BE(16) === 80 && (await iconRoute.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ size: "81" }) })).status === 404);
      actor = null;
      ok("the manifest isn't given to somebody signed out", (await manifestRoute.GET()).status === 404);
      actor = rep;
      ok("...nor to somebody who doesn't manage signatures", (await manifestRoute.GET()).status === 404);
      actor = boss;
      const download = await manifestRoute.GET();
      const downloaded = await download.text();
      ok("a manager downloads it, as a file, with this workspace's id and address", download.status === 200 && (download.headers.get("content-disposition") ?? "").startsWith("attachment") && downloaded.includes(`<Id>${addinId}</Id>`) && downloaded.includes(`<AppDomain>${ORIGIN}</AppDomain>`));

      // The pages.
      const connTab = textOf(await renderHtml(await ManagePage({ searchParams: Promise.resolve({ tab: "connection" }) })));
      ok("the Connection tab: the add-in on, its file, and the steps in the Microsoft 365 admin center", connTab.includes("Microsoft 365 (Outlook)") && connTab.includes("Add-in on") && connTab.includes("Download the add-in file") && connTab.includes("Integrated apps") && /fetched signatures for \d+ (person|people)/.test(connTab), connTab.slice(connTab.indexOf("Microsoft 365"), connTab.indexOf("Microsoft 365") + 200));
      const peopleTab = textOf(await renderHtml(await ManagePage({ searchParams: Promise.resolve({}) })));
      ok("the People tab: when Outlook last fetched each person's signature", peopleTab.includes("In Outlook") && peopleTab.includes("Fetched") && peopleTab.includes("Not yet"));
      actor = rep;
      const mineNow = textOf(await renderHtml(await MyPage()));
      ok("My email signature: that it is in their Outlook", mineNow.includes("In your Outlook"), mineNow.slice(0, 300));
      actor = boss;
      ok("turned off, the add-in gets nothing again", (await actions.setOutlookAddin(false)).ok && (await outlookLib.outlookSignature(`rep@${DOMAIN}`, "caller-a")).status === 404);

      section("Letting go");
      actor = boss;
      ok("disconnecting stops the signatures going out", (await actions.disconnectSignatures()).ok && (await db.signatureSettings.findUniqueOrThrow({ where: { id: "global" } })).provider === null);
      ok("...and a run then says there is nothing connected", (await sync.syncSignatures({ budgetMs: 1000, userIds: fixture })).stopped === "No mail suite is connected yet.");
    });
  } finally {
    google.setTestGoogleHosts(null);
    zohoMail.setTestZohoRegions(null);
    actor = null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
