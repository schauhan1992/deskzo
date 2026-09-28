/**
 * check:support — Contact Support, from the workspace's dialog to the console's Support page.
 *
 * On a scratch control plane of its own (<db>_support_control, dropped at the end, pass or fail),
 * with SUPPORT_DIR a temporary folder (removed at the end), and fixtures all named `zzsup`:
 *
 *   · storage: what a file is comes from its bytes (png, pdf, docx, txt and webm in; svg, html, exe
 *     and HTML named .png out), the size caps stop a stream, a staged upload is claimed only by the
 *     person and workspace that made it, no id reaches outside SUPPORT_DIR, and the sweep takes only
 *     the old;
 *   · the upload route: cross-origin, no marker, no session, view-as and a type that can't be
 *     attached are refused; a good file is staged; one's own upload can be taken back, another's not;
 *   · the launcher's state, and who gets none;
 *   · sending: the request, its number, its files claimed, its context from the server (a forged
 *     workspace in the browser's context is ignored), the two mails, the throttles, and every refusal
 *     — no consent, recording off, DLP, view-as, a support account, support switched off, somebody
 *     else's upload — and a mail server that is down never failing it;
 *   · the console's actions: reply (emailed with Reply-To, first response, Open → In progress), note
 *     (no mail), status stamps, priority, assignment, settings; the role gates; audit rows that name
 *     no text anybody wrote;
 *   · the file route: its headers, ranges, refusals, 410 for a purged file, one audit row per look,
 *     and HEAD answering without the file or an audit row;
 *   · the inbox, a request, Settings, the launcher and the dialog rendered;
 *   · retention: closed requests' files purged after their days, the rows kept;
 *   · static scans of the files.
 *
 * No mail leaves (the platform mailer is replaced), no workspace database is opened (the workspace
 * session, its user lookup and its security policy are stand-ins), no password is typed anywhere
 * (staff are signed in by sessions made here). Every assertion is about the suite's own fixtures.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SecurityPolicyShape } from "../src/lib/security/policy";
import type { LauncherState, SupportSubmitInput, SupportSubmitResult } from "../src/lib/support/types";
import type { Tenant } from "../src/lib/tenancy/state";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.REFERENCE_DATABASE_URL = "";
/** Where every file of this run goes — never the real storage folder. */
const SUPPORT_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-check-support-"));
process.env.SUPPORT_DIR = SUPPORT_DIR;

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${String(detail).slice(0, 600)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
/** What the code under test warned or erred about, to be searched for anything it must never log. */
const logged: string[] = [];
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}
/** A section on its own: a throw inside one is a failure of that section, and the next still runs. */
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}` : String(err));
  }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const DAY = 86_400_000;
const HOUR = 3_600_000;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}
/** What a call threw, as text — or "" when it did not throw. */
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
/** The status a refusal carried (SupportRefused), or 0. */
async function refusedWith(work: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await work();
    return { status: 0, message: "" };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? 0, message: err instanceof Error ? err.message : String(err) };
  }
}
/** The same values under the same keys, whatever order they come in (jsonb sorts its keys). */
const sameFields = (a: unknown, b: Record<string, unknown>) => !!a && typeof a === "object" && Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => (a as Record<string, unknown>)[k] === v);
const why = (r: unknown) => (r && typeof r === "object" && "error" in r ? String((r as { error: unknown }).error) : "");

// ─── A request, as the workspace and the console see one ─────────────────────────────────────────
type WsUser = { id: string; name: string; email: string; role: string; kind: "USER" | "SUPPORT"; phone: string | null; active: boolean };
/** The workspace's people, as its database would answer for them. */
const people = new Map<string, WsUser>();
/** Who is signed in to the workspace, and whether they are viewing as somebody else. */
let actor: string | null = null;
let viewingAs = false;
/** The workspace's DLP policy (src/lib/security/store.ts), set once the defaults are loaded. */
let policy = null as unknown as SecurityPolicyShape;
const CONSOLE_HOST = "admin.localhost:3000";
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: CONSOLE_HOST, "user-agent": "check:support" });

const sessionUser = () => {
  const p = actor ? people.get(actor) : null;
  return p ? { id: p.id, name: p.name, email: p.email, role: p.role } : null;
};
/** The one model the requester reads from a workspace's database; anything else is a fault here. */
const workspaceDb = new Proxy(
  {},
  {
    get(_target, model) {
      if (model === "user") {
        return {
          findUnique: async ({ where }: { where: { id: string } }) => {
            const p = people.get(where.id);
            return p ? { kind: p.kind, phone: p.phone, active: p.active } : null;
          },
        };
      }
      throw new Error(`check:support opens no workspace database (db.${String(model)})`);
    },
  },
);
/** The Dialog primitive portals into document.body; here it renders where it stands, so the markup can be read. */
function InlineDialog({ open, title, children }: { open: boolean; onClose: () => void; title: string; children?: ReactNode; wide?: boolean }) {
  return open ? createElement("div", { role: "dialog", "aria-label": title }, createElement("h2", null, title), children) : null;
}

const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/auth") {
    return { auth: async () => (actor ? { user: { id: actor } } : null), signIn: async () => {}, signOut: async () => {}, handlers: {}, canManageLeads: () => false, canSourceCompanies: () => false };
  }
  if (request === "@/lib/session") {
    return {
      UnauthorizedError: class UnauthorizedError extends Error {},
      requireUser: async () => {
        const u = sessionUser();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => sessionUser(),
      viewAsContext: async () => (viewingAs && actor ? { user: { id: "zzsup-someone-else" }, actor: { id: actor } } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "You're viewing as someone else." : null),
    };
  }
  if (request === "@/lib/db") return { db: workspaceDb, getTenantDb: async () => workspaceDb };
  if (request === "@/lib/security/store") return { SECURITY_POLICY_ID: "global", getSecurityPolicy: async () => policy, invalidateSecurityPolicyCache() {} };
  if (request === "@/components/ui/dialog") return { Dialog: InlineDialog };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// ─── Rendering server pages ──────────────────────────────────────────────────────────────────────
type Page = (props: never) => Promise<unknown>;
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
async function render(page: Page, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}

// ─── Files, byte by byte ─────────────────────────────────────────────────────────────────────────
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(2), u32(2), Buffer.from([8, 6, 0, 0, 0]), u32(0), u32(0), Buffer.from("IEND"), u32(0)]);
const PDF = Buffer.from("%PDF-1.7\n%zz\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 7)]);
const TXT = Buffer.from("Invoice 42 failed at 10:04.\nSecond line, ünïcode ✓\n");
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(4096)]);
const MP4 = Buffer.concat([u32(0x20), Buffer.from("ftypisom"), Buffer.alloc(120, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>');
const HTML = Buffer.from("<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0]), Buffer.alloc(120)]);

/** Markers that must never reach an audit row. */
const BODY_MARKER = "ZZBODYMARKER-5c1e";
const REPLY_MARKER = "ZZREPLYMARKER-9d2a";
const NOTE_MARKER = "ZZNOTEMARKER-3b7f";
const SUPPORT_EMAIL = "help@zzsupport.example";
const THROTTLED = "You've sent several requests recently — please wait a few minutes, or call the helpline.";
const EXPIRED = "That attachment has expired — please add it again.";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A. A scratch control plane and SUPPORT_DIR");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_support_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const settingsLib = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { resetThrottle } = require("../src/lib/security/throttle") as typeof import("../src/lib/security/throttle");
    const { DEFAULT_SECURITY_POLICY } = require("../src/lib/security/policy") as typeof import("../src/lib/security/policy");
    const storage = require("../src/lib/support/storage") as typeof import("../src/lib/support/storage");
    const requests = require("../src/lib/support/requests") as typeof import("../src/lib/support/requests");
    const supportSettings = require("../src/lib/support/settings") as typeof import("../src/lib/support/settings");
    const supportConsole = require("../src/lib/support/console") as typeof import("../src/lib/support/console");
    const retention = require("../src/lib/support/retention") as typeof import("../src/lib/support/retention");
    const { ATTACHMENT_EXPIRED, TYPE_REFUSED } = require("../src/lib/support/refused") as typeof import("../src/lib/support/refused");
    const { supportRef } = require("../src/lib/support/types") as typeof import("../src/lib/support/types");
    const actions = require("../src/actions/support") as typeof import("../src/actions/support");
    const consoleActions = require("../src/actions/platform/console-support") as typeof import("../src/actions/platform/console-support");
    const uploadRoute = require("../src/app/api/support/uploads/route") as typeof import("../src/app/api/support/uploads/route");
    const fileRoute = require("../src/app/platform-console/support-files/[id]/route") as typeof import("../src/app/platform-console/support-files/[id]/route");
    cleanup = async () => {
      await closeControlDb();
    };
    // A workspace that switched every deterrent off, screenshots included (-1). The default policy counts
    // screenshots (two a day), which by spec §1's rule is a deterrent: see section D.
    const noDeterrents: SecurityPolicyShape = { ...DEFAULT_SECURITY_POLICY, screenshotLimitPerDay: -1 };
    policy = { ...noDeterrents };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string; replyTo?: string }[] = [];
    const collect = async (m: { to: string; subject: string; text: string; replyTo?: string }) => void mail.push(m);
    mailer.setTestPlatformMailer(collect);

    const applied = await control.$queryRaw<{ name: string }[]>`
      SELECT "migration_name"::text AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`;
    ok("built from its migrations — 20260930200000_support among them", applied.some((r) => r.name === "20260930200000_support"));
    ok("SUPPORT_DIR is this run's temporary folder", storage.supportDir() === path.resolve(SUPPORT_DIR), storage.supportDir());

    // ─── Workspaces, people and staff ────────────────────────────────────────────────────────────
    const tenantRow = async (key: string) => control.tenant.create({ data: { slug: `zzsup-${key}`, name: `Zz Support ${key}`, keyBundleCipher: "", country: "IN", currency: "INR", ownerEmail: `owner@zzsup-${key}.example` }, select: { id: true, slug: true, name: true } });
    const asTenant = (row: { id: string; slug: string; name: string }, source: Tenant["source"] = "control"): Tenant => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: "ACTIVE",
      dbUrl: "postgresql://unused.invalid/zz",
      primaryHost: `${row.slug}.localhost:3000`,
      hosts: [`${row.slug}.localhost:3000`],
      source,
      isDefault: false,
      keyBundleCipher: null,
      country: "IN",
      entitlements: { v: 1, all: true, modules: [] } as unknown as Tenant["entitlements"],
      holdReason: null,
    });
    const main = asTenant(await tenantRow("main"));
    const other = asTenant(await tenantRow("other"));
    const busy = asTenant(await tenantRow("busy"));
    const person = (key: string, data: Partial<WsUser> = {}) => {
      const p: WsUser = { id: `zzsupuser-${key}`, name: `Zz ${key}`, email: `${key}@zzsup.example`, role: "SALES", kind: "USER", phone: null, active: true, ...data };
      people.set(p.id, p);
      return p;
    };
    const asha = person("asha", { name: "Asha Zz", phone: "+91 98765 43210" });
    const ravi = person("ravi");
    const anil = person("anil", { role: "ADMIN" });
    const kiran = person("kiran");
    const platformSupport = person("staffinside", { kind: "SUPPORT", role: "ADMIN" });
    const inactive = person("gone", { active: false });

    /** Work done inside a workspace, signed in as this person, from behind a proxy that says where they are. */
    const inWs = <T>(tenant: Tenant, userId: string | null, work: () => Promise<T>) => {
      actor = userId;
      requestHeaders = new Headers({ host: tenant.primaryHost, "user-agent": "check:support", "x-forwarded-for": "203.0.113.50, 198.51.100.7" });
      return runAsTenant(tenant, work);
    };
    const atConsole = () => {
      actor = null;
      viewingAs = false;
      requestHeaders = new Headers({ host: CONSOLE_HOST, "user-agent": "check:support" });
    };
    const stage = (tenantId: string, userId: string, bytes: Buffer, filename: string, kind: "file" | "recording" = "file") =>
      storage.stageUpload(Readable.from([bytes]), { tenantId, userId, kind, filename });
    const put = (key: string, value: string | null) => settingsLib.setSetting(key as never, value, "script:check:support");
    const settingsDefaults = async () => {
      await put("support.enabled", null);
      await put("support.recording", null);
      await put("support.email", SUPPORT_EMAIL);
      await put("support.helpline", "+91 80 4000 1234");
      await put("support.hours", "Mon-Fri, 9:00 AM - 6:00 PM IST");
      await put("support.retentionDays", "365");
      supportSettings.forgetSupportSettings();
    };
    await settingsDefaults();

    const staffIds = {
      owner: (await staffLib.createStaff({ email: "owner@zzsup.example", name: "Zz Sup Owner", role: "OWNER" }, "script:check:support")).id,
      admin: (await staffLib.createStaff({ email: "admin@zzsup.example", name: "Zz Sup Admin", role: "ADMIN" }, "script:check:support")).id,
      support: (await staffLib.createStaff({ email: "support@zzsup.example", name: "Zz Sup Agent", role: "SUPPORT" }, "script:check:support")).id,
      readonly: (await staffLib.createStaff({ email: "readonly@zzsup.example", name: "Zz Sup Readonly", role: "READONLY" }, "script:check:support")).id,
      billing: (await staffLib.createStaff({ email: "billing@zzsup.example", name: "Zz Sup Billing", role: "BILLING" }, "script:check:support")).id,
    };
    /** Signed in to the console as this staff member, two-factor passed. */
    const actAs = async (userId: string) => {
      atConsole();
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:support" } });
      jar.clear();
      jar.set("wroffy-console", token);
    };
    const signedOut = () => {
      atConsole();
      jar.clear();
    };
    const requestsOf = (tenantId: string) => control.supportRequest.count({ where: { tenantId } });

    // Filled by the sections below and read by the later ones.
    let mainNumber = 0;
    const input = (over: Partial<SupportSubmitInput> & Record<string, unknown> = {}): SupportSubmitInput =>
      ({
        subject: "Zz invoices won't print",
        body: `${BODY_MARKER} The print button does nothing.\nSince this morning.`,
        mobile: "+91 98765 43210",
        priority: "URGENT",
        uploadIds: [],
        consent: true,
        context: { page: "/invoices/INV-42?token=zz-secret#top", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", screen: "1920×1080@2x", viewport: "1440×900", timezone: "Asia/Kolkata", language: "en-IN" },
        ...over,
      }) as SupportSubmitInput;
    const submit = (tenant: Tenant, userId: string | null, data: SupportSubmitInput): Promise<SupportSubmitResult> => inWs(tenant, userId, () => actions.submitSupportRequest(data));

    // ─── 1. Storage ──────────────────────────────────────────────────────────────────────────────
    await part("B. Storage: what a file is, the caps, claims, paths and the sweep", async () => {
      const sniff = storage.sniffSupportFile;
      ok("png, pdf, docx (a zip), txt and csv are attachable files", sniff(PNG, "shot.png", "file") === "image/png" && sniff(PDF, "invoice.pdf", "file") === "application/pdf" && sniff(ZIP, "report.docx", "file")?.includes("wordprocessingml") === true && sniff(TXT, "error.txt", "file") === "text/plain" && sniff(Buffer.from("a,b\n1,2\n"), "rows.csv", "file") === "text/csv");
      ok("  an image is an image whatever it is called", sniff(PNG, "not-an-image.bin", "file") === "image/png");
      ok("webm and mp4 are recordings; nothing else is", sniff(WEBM, "x.webm", "recording") === "video/webm" && sniff(MP4, "x.mp4", "recording") === "video/mp4" && sniff(PNG, "x.png", "recording") === null && sniff(WEBM, "x.webm", "file") === null);
      ok("svg is refused, whatever it is named", [sniff(SVG, "logo.svg", "file"), sniff(SVG, "logo.png", "file"), sniff(SVG, "logo.txt", "file")].every((m) => m === null));
      ok("html is refused, as .html, .txt or .png", [sniff(HTML, "page.html", "file"), sniff(HTML, "page.txt", "file"), sniff(HTML, "shot.png", "file")].every((m) => m === null));
      ok("an exe is refused, as .exe or renamed .zip", sniff(EXE, "setup.exe", "file") === null && sniff(EXE, "setup.zip", "file") === null);
      ok("a zip must be named as one of its kinds; text as .txt, .log or .csv", sniff(ZIP, "archive.exe", "file") === null && sniff(TXT, "notes.md", "file") === null && sniff(Buffer.from([0x61, 0x00, 0x62]), "nul.txt", "file") === null);

      const staged = await stage(main.id, asha.id, PNG, "../../shot<1>.png");
      ok("staging a png says what it is, its size and hash, under a clean name", staged.mime === "image/png" && staged.size === PNG.length && staged.sha256 === createHash("sha256").update(PNG).digest("hex") && staged.filename === "shot1.png" && /^[A-Za-z0-9_-]{22}$/.test(staged.uploadId), JSON.stringify(staged));
      ok("  the file and its record sit in the workspace's staging folder", existsSync(path.join(SUPPORT_DIR, main.id, "staging", staged.uploadId)) && existsSync(path.join(SUPPORT_DIR, main.id, "staging", `${staged.uploadId}.json`)));
      const disguised = await refusedWith(() => stage(main.id, asha.id, HTML, "shot.png"));
      ok("HTML named shot.png is refused as a type that can't be attached (415)", disguised.status === 415 && disguised.message === TYPE_REFUSED, JSON.stringify(disguised));
      const empty = await refusedWith(() => stage(main.id, asha.id, Buffer.alloc(0), "empty.txt"));
      ok("an empty file is refused", empty.status === 400 && /empty/.test(empty.message));
      const recording = await stage(main.id, asha.id, WEBM, "blob", "recording");
      ok("a recording is named for what it is", recording.filename === "blob.webm" && recording.mime === "video/webm");

      const leftovers = () => readdirSync(path.join(SUPPORT_DIR, main.id, "staging")).filter((n) => n.endsWith(".part"));
      const eleven = Array.from({ length: 11 }, () => Buffer.alloc(1024 * 1024, 1));
      const tooBig = await refusedWith(() => storage.stageUpload(Readable.from(eleven), { tenantId: main.id, userId: asha.id, kind: "file", filename: "big.txt" }));
      ok("a file past 10 MB stops as it streams (413), and leaves nothing behind", tooBig.status === 413 && tooBig.message === "That file is over 10 MB." && leftovers().length === 0, JSON.stringify(tooBig));
      const pastRoom = await refusedWith(() => storage.stageUpload(Readable.from([Buffer.alloc(4096, 65)]), { tenantId: main.id, userId: asha.id, kind: "file", filename: "a.txt", maxBytes: 1000 }));
      ok("  and so does one past the room a person has left — even when the first chunk is already over", pastRoom.status === 413 && /too many attachments/.test(pastRoom.message) && leftovers().length === 0, `${JSON.stringify(pastRoom)} ${leftovers().join(",")}`);
      ok("the caps are 10 MB a file and 80 MB a recording", storage.uploadCap("file") === 10 * 1024 * 1024 && storage.uploadCap("recording") === 80 * 1024 * 1024);

      const mine = await stage(main.id, asha.id, PDF, "invoice.pdf");
      const reqId = "zzsupreq0000000001";
      const attId = "zzsupatt0000000001";
      const byRavi = await refusedWith(() => storage.claimStaged(main.id, ravi.id, mine.uploadId, reqId, attId));
      ok("another person's upload can't be claimed", byRavi.message === ATTACHMENT_EXPIRED);
      const fromOther = await refusedWith(() => storage.claimStaged(other.id, asha.id, mine.uploadId, reqId, attId));
      ok("nor the same person's from another workspace", fromOther.message === ATTACHMENT_EXPIRED);
      ok("  and after both, it is still there for its owner", (await storage.readStaged(main.id, mine.uploadId))?.userId === asha.id);
      ok("another person can't take it back either", (await storage.discardStaged(main.id, ravi.id, mine.uploadId)) === false && (await storage.readStaged(main.id, mine.uploadId)) !== null);
      const claimed = await storage.claimStaged(main.id, asha.id, mine.uploadId, reqId, attId);
      ok("its owner claims it: moved under the request, out of staging", claimed.storageKey === `${main.id}/${reqId}/${attId}` && existsSync(path.join(SUPPORT_DIR, main.id, reqId, attId)) && (await storage.readStaged(main.id, mine.uploadId)) === null);
      ok("  once", (await refusedWith(() => storage.claimStaged(main.id, asha.id, mine.uploadId, reqId, "zzsupatt0000000002"))).message === ATTACHMENT_EXPIRED);

      const traversal = ["..", "../../etc", "..%2F..%2Fetc", "zz/../../x", "C:\\Windows\\x", "short", "a".repeat(65), "zz supatt 0001"];
      const claims = await Promise.all(traversal.flatMap((bad) => [refusedWith(() => storage.claimStaged(bad, asha.id, staged.uploadId, reqId, attId)), refusedWith(() => storage.claimStaged(main.id, asha.id, bad, reqId, attId)), refusedWith(() => storage.claimStaged(main.id, asha.id, staged.uploadId, bad, attId)), refusedWith(() => storage.claimStaged(main.id, asha.id, staged.uploadId, reqId, bad))]));
      ok("an id that is not one is refused in each place a claim takes one", claims.every((c) => c.message === ATTACHMENT_EXPIRED), claims.map((c) => c.message).join(" | "));
      ok("  and the upload those claims named is untouched", (await storage.readStaged(main.id, staged.uploadId)) !== null);
      ok("reading staging with such ids finds nothing", (await Promise.all(traversal.map((bad) => storage.readStaged(bad, staged.uploadId)))).every((m) => m === null) && (await storage.readStaged(main.id, "../staging")) === null);
      const keys = ["../../../etc/passwd", `${main.id}/../${main.id}/${attId}`, `${main.id}/${reqId}`, `${main.id}/${reqId}/${attId}/x`, `..\\..\\${attId}`, "", `/${main.id}/${reqId}/${attId}`];
      ok("an attachment key that is not three ids opens nothing and purges nothing", (await Promise.all(keys.map((k) => storage.openAttachment(k)))).every((o) => o === null) && (await Promise.all(keys.map((k) => storage.purgeAttachment(k)))).every((p) => p === false));
      ok("staging into a folder named by a bad id is refused", (await refusedWith(() => storage.stageUpload(Readable.from([PNG]), { tenantId: "../escape", userId: asha.id, kind: "file", filename: "x.png" }))).status === 400);
      ok("  and nothing was written outside SUPPORT_DIR", !existsSync(path.join(path.dirname(SUPPORT_DIR), "escape")));

      const opened = await storage.openAttachment(claimed.storageKey, { start: 0, end: 4 });
      const head = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        opened!.stream.on("data", (c) => chunks.push(c as Buffer)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
      });
      ok("an attachment opens by its key, whole or a range", opened?.size === PDF.length && head.toString() === "%PDF-");
      ok("  and its size is read without opening it", (await storage.attachmentSize(claimed.storageKey)) === PDF.length && (await storage.attachmentSize("../../etc/passwd")) === null);
      ok("ranges: 0-9, the last 5, open-ended, past the end, several", JSON.stringify([storage.parseByteRange("bytes=0-9", 100), storage.parseByteRange("bytes=-5", 100), storage.parseByteRange("bytes=90-", 100), storage.parseByteRange("bytes=100-", 100), storage.parseByteRange("bytes=0-1,5-6", 100)]) === JSON.stringify([{ start: 0, end: 9 }, { start: 95, end: 99 }, { start: 90, end: 99 }, "unsatisfiable", null]));

      // The sweep: one upload a day and a half old (and a half-finished one), one fresh, one foreign file.
      const oldOne = await stage(other.id, ravi.id, TXT, "old.txt");
      const freshOne = await stage(other.id, ravi.id, TXT, "fresh.txt");
      const dir = path.join(SUPPORT_DIR, other.id, "staging");
      writeFileSync(path.join(dir, "zzhalffinished0001.part"), "partial");
      writeFileSync(path.join(dir, "notes-by-hand.md"), "not ours");
      const past = new Date(Date.now() - 1.5 * DAY);
      for (const name of [oldOne.uploadId, `${oldOne.uploadId}.json`, "zzhalffinished0001.part", "notes-by-hand.md"]) utimesSync(path.join(dir, name), past, past);
      const swept = await storage.sweepStaging(DAY);
      const left = readdirSync(dir);
      ok("the sweep takes uploads older than a day, and half-finished ones", !left.includes(oldOne.uploadId) && !left.includes(`${oldOne.uploadId}.json`) && !left.includes("zzhalffinished0001.part"), left.join(", "));
      ok("  and leaves the fresh one, and a file that is not an upload", left.includes(freshOne.uploadId) && left.includes(`${freshOne.uploadId}.json`) && left.includes("notes-by-hand.md"));
      ok("  counting uploads, not their records", swept === 2, swept);
      await storage.discardStaged(other.id, ravi.id, freshOne.uploadId);
      await storage.discardStaged(main.id, asha.id, staged.uploadId);
      await storage.discardStaged(main.id, asha.id, recording.uploadId);
      await storage.deleteRequestFiles(main.id, reqId);
      ok("a request's files are deleted together", !existsSync(path.join(SUPPORT_DIR, main.id, reqId)));
    });

    // ─── The upload route ────────────────────────────────────────────────────────────────────────
    await part("C. The upload route (POST and DELETE /api/support/uploads)", async () => {
      resetThrottle();
      const upload = (t: Tenant, body: Buffer | null, o: { kind?: string; name?: string; origin?: string | null; marker?: boolean; length?: number } = {}) => {
        const headers = new Headers({ host: t.primaryHost });
        if (o.origin !== null) headers.set("origin", o.origin ?? `http://${t.primaryHost}`);
        if (o.marker !== false) headers.set("x-support-upload", "1");
        headers.set("x-support-kind", o.kind ?? "file");
        headers.set("x-file-name", encodeURIComponent(o.name ?? "shot.png"));
        if (o.length !== undefined) headers.set("content-length", String(o.length));
        return new Request(`http://${t.primaryHost}/api/support/uploads`, { method: "POST", headers, body: body ? new Uint8Array(body) : null, duplex: "half" } as RequestInit);
      };
      const post = async (t: Tenant, userId: string | null, req: Request) => {
        const res = await inWs(t, userId, () => uploadRoute.POST(req));
        return { status: res.status, body: (await res.json()) as { uploadId?: string; filename?: string; mime?: string; size?: number; error?: string }, cache: res.headers.get("cache-control") };
      };
      const stagedCount = () => readdirSync(path.join(SUPPORT_DIR, main.id, "staging")).filter((n) => n.endsWith(".json")).length;
      const before = stagedCount();

      const cross = await post(main, asha.id, upload(main, PNG, { origin: "https://evil.example" }));
      ok("an upload from another site's page is refused (403)", cross.status === 403 && cross.body.error === "Uploads are only accepted from this app.", JSON.stringify(cross));
      const noOrigin = await post(main, asha.id, upload(main, PNG, { origin: null }));
      ok("  so is one with no Origin at all", noOrigin.status === 403);
      const noMarker = await post(main, asha.id, upload(main, PNG, { marker: false }));
      ok("an upload without the x-support-upload marker is refused (403)", noMarker.status === 403);
      const otherWs = await post(main, asha.id, upload(main, PNG, { origin: `http://${other.primaryHost}` }));
      ok("  and one whose Origin is another workspace", otherWs.status === 403);
      ok("  none of them staged anything", stagedCount() === before);
      const badKind = await post(main, asha.id, upload(main, PNG, { kind: "script" }));
      ok("a kind that is neither file nor recording is refused (400)", badKind.status === 400);
      const declared = await post(main, asha.id, upload(main, PNG, { length: 20 * 1024 * 1024 }));
      ok("a declared length over 10 MB is refused before a byte is read (413)", declared.status === 413 && declared.body.error === "That file is over 10 MB.", JSON.stringify(declared));
      const nobody = await post(main, null, upload(main, PNG));
      ok("nobody signed in: 401", nobody.status === 401);
      viewingAs = true;
      const viewAs = await post(main, asha.id, upload(main, PNG));
      viewingAs = false;
      ok("viewing as someone else: 403", viewAs.status === 403 && /viewing as someone else/.test(viewAs.body.error ?? ""));
      const staffInside = await post(main, platformSupport.id, upload(main, PNG));
      ok("a platform support account inside the workspace: 403", staffInside.status === 403 && /Platform support/.test(staffInside.body.error ?? ""));
      const envTenant = await post(asTenant({ id: "zzsupenvtenant01", slug: "zzsup-env", name: "Zz Env" }, "env"), asha.id, upload(asTenant({ id: "zzsupenvtenant01", slug: "zzsup-env", name: "Zz Env" }, "env"), PNG));
      ok("a workspace from the environment, with no control-plane row: 403", envTenant.status === 403);
      const html = await post(main, asha.id, upload(main, HTML, { name: "shot.png" }));
      ok("HTML sent as shot.png is refused (415) and not kept", html.status === 415 && html.body.error === TYPE_REFUSED && stagedCount() === before, JSON.stringify(html));
      await put("support.recording", "0");
      const recOff = await post(main, asha.id, upload(main, WEBM, { kind: "recording", name: "rec.webm" }));
      await put("support.recording", null);
      ok("a recording while recording is switched off: 403", recOff.status === 403 && /isn't available/.test(recOff.body.error ?? ""));
      policy = { ...noDeterrents, blockCopy: true };
      const recDlp = await post(main, asha.id, upload(main, WEBM, { kind: "recording", name: "rec.webm" }));
      policy = { ...noDeterrents };
      ok("  and while the workspace's DLP deterrents apply to them: 403, saying so", recDlp.status === 403 && recDlp.body.error === "Your organisation's security settings don't allow screen recording.");
      const good = await post(main, asha.id, upload(main, PNG, { name: "screen shot.png" }));
      ok("a png from the app is staged: its id, name, size and type", good.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(good.body.uploadId ?? "") && good.body.filename === "screen shot.png" && good.body.size === PNG.length && good.body.mime === "image/png" && good.cache === "no-store", JSON.stringify(good));
      const meta = await storage.readStaged(main.id, good.body.uploadId ?? "");
      ok("  staged for that person, in that workspace — from the session, not the request", meta?.userId === asha.id && meta.tenantId === main.id);
      const rec = await post(main, asha.id, upload(main, WEBM, { kind: "recording", name: "anything" }));
      ok("a webm recording is staged as video/webm", rec.status === 200 && rec.body.mime === "video/webm" && rec.body.filename === "anything.webm");

      const del = (t: Tenant, userId: string, id: string, marker = true) =>
        inWs(t, userId, () => uploadRoute.DELETE(new Request(`http://${t.primaryHost}/api/support/uploads?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { host: t.primaryHost, origin: `http://${t.primaryHost}`, ...(marker ? { "x-support-upload": "1" } : {}) } })));
      ok("taking back somebody else's upload answers as if it didn't exist (404)", (await del(main, ravi.id, good.body.uploadId ?? "")).status === 404 && (await storage.readStaged(main.id, good.body.uploadId ?? "")) !== null);
      ok("  without the marker, 403", (await del(main, asha.id, good.body.uploadId ?? "", false)).status === 403);
      ok("one's own is taken back", (await del(main, asha.id, good.body.uploadId ?? "")).status === 200 && (await storage.readStaged(main.id, good.body.uploadId ?? "")) === null);
      await storage.discardStaged(main.id, asha.id, rec.body.uploadId ?? "");
    });

    // ─── The launcher ────────────────────────────────────────────────────────────────────────────
    await part("D. The launcher's state (the dashboard layout)", async () => {
      supportSettings.forgetSupportSettings();
      const state = (t: Tenant, userId: string | null) => inWs(t, userId, () => actions.supportLauncherState());
      const s = await state(main, asha.id);
      ok("signed in: the button, with their email and phone, the helpline and the brand", !!s && s.email === asha.email && s.phone === asha.phone && s.helpline === "+91 80 4000 1234" && s.hours === "Mon-Fri, 9:00 AM - 6:00 PM IST" && s.brandName === "Wroffy ERP", JSON.stringify(s));
      ok("  recording offered", s?.recordingAllowed === true && s.recordingBlockedReason === null);
      policy = { ...noDeterrents, blockCopy: true };
      const dlp = await state(main, asha.id);
      const dlpAdmin = await state(main, anil.id);
      policy = { ...noDeterrents };
      ok("with a copy-blocking DLP policy that applies to them: recording off, for DLP", dlp?.recordingAllowed === false && dlp.recordingBlockedReason === "dlp");
      ok("  but not for an admin, whom DLP never applies to", dlpAdmin?.recordingAllowed === true);
      policy = { ...DEFAULT_SECURITY_POLICY };
      const untouched = await state(main, asha.id);
      policy = { ...noDeterrents, screenshotLimitPerDay: 5 };
      const allowance = await state(main, asha.id);
      policy = { ...noDeterrents, screenshotLimitPerDay: 0 };
      const noShots = await state(main, asha.id);
      policy = { ...noDeterrents };
      ok("  a workspace that never changed its policy (the default screenshot allowance): recording offered", untouched?.recordingAllowed === true && untouched.recordingBlockedReason === null, JSON.stringify(untouched));
      ok("  a daily screenshot allowance alone does not refuse it", allowance?.recordingAllowed === true);
      ok("  but no screenshots at all does, for DLP", noShots?.recordingAllowed === false && noShots.recordingBlockedReason === "dlp");
      await put("support.recording", "0");
      supportSettings.forgetSupportSettings();
      const off = await state(main, asha.id);
      await put("support.recording", null);
      supportSettings.forgetSupportSettings();
      ok("recording switched off in the console: off, for the setting", off?.recordingAllowed === false && off.recordingBlockedReason === "setting");
      viewingAs = true;
      const viewAs = await state(main, asha.id);
      viewingAs = false;
      ok("no button while viewing as someone else", viewAs === null);
      ok("no button for a platform support account", (await state(main, platformSupport.id)) === null);
      ok("no button for a switched-off account, or nobody", (await state(main, inactive.id)) === null && (await state(main, null)) === null);
      ok("no button in a workspace from the environment", (await state(asTenant({ id: "zzsupenvtenant01", slug: "zzsup-env", name: "Zz Env" }, "env"), asha.id)) === null);
      await put("support.enabled", "0");
      supportSettings.forgetSupportSettings();
      const disabled = await state(main, asha.id);
      await put("support.enabled", null);
      supportSettings.forgetSupportSettings();
      ok("no button anywhere while Contact Support is switched off", disabled === null);
      const failing = await supportSettings.cachedSupportConfig(Date.now(), async () => {
        throw new Error("control plane down at postgresql://zz:hunter2@db/x");
      });
      const slow = await supportSettings.cachedSupportConfig(Date.now(), () => new Promise(() => {}));
      ok("settings that can't be read, or take over 1.5 s, hide the button rather than fail the page", failing === null && slow === null);
    });

    // ─── Sending ─────────────────────────────────────────────────────────────────────────────────
    await part("E. Sending a request", async () => {
      resetThrottle();
      mail.length = 0;
      const png = await stage(main.id, asha.id, PNG, "screen.png");
      const pdf = await stage(main.id, asha.id, PDF, "invoice.pdf");
      const webm = await stage(main.id, asha.id, WEBM, "recording", "recording");
      const forged = {
        uploadIds: [png.uploadId, pdf.uploadId],
        recording: { uploadId: webm.uploadId, durationMs: 42_400, consent: true, consoleLog: [{ at: new Date().toISOString(), level: "error", message: "TypeError: print is not a function" }, { at: "not a date", level: "error", message: "dropped" }], perf: { dns: 12.4, ttfb: 180.6, load: 1500, transferSize: 245_760 } },
        // What a tampered browser might add: none of it may be believed.
        tenantId: other.id,
        requesterEmail: "ceo@elsewhere.example",
        context: { ...input().context, workspace: { id: other.id, slug: other.slug, name: other.name }, tenantId: other.id, user: { id: ravi.id, email: ravi.email }, ip: "6.6.6.6" },
      };
      process.env.TRUST_PROXY = "1";
      const sent = await submit(main, asha.id, input(forged as never));
      process.env.TRUST_PROXY = "";
      ok("the request is sent, with its number and the address the answer goes to", sent.ok && sent.number >= 1001 && sent.email === asha.email, JSON.stringify(sent));
      if (!sent.ok) return;
      mainNumber = sent.number;
      const row = await control.supportRequest.findUniqueOrThrow({ where: { number: sent.number }, include: { attachments: true } });
      const context = row.context as Record<string, unknown>;
      ok("numbered from 1001 (SR-1001 is the first)", row.number >= 1001 && supportRef(row.number) === `SR-${row.number}`);
      ok("in the workspace the session is in — not the one the browser named", row.tenantId === main.id && (context.workspace as { id: string }).id === main.id && JSON.stringify(context).includes(main.slug) && !JSON.stringify(context).includes(other.id), JSON.stringify(context));
      ok("  from the person signed in, with their role", row.requesterUserId === asha.id && row.requesterEmail === asha.email && row.requesterName === asha.name && row.requesterRole === "SALES" && (context.user as { id: string }).id === asha.id);
      ok("  the caller's address from the proxy's own entry, in its column; the browser's claim nowhere", row.ip === "198.51.100.7" && !JSON.stringify(row).includes("6.6.6.6"), row.ip);
      ok("the page as a path only, and the browser's details capped and kept", context.page === "/invoices/INV-42" && context.timezone === "Asia/Kolkata" && context.language === "en-IN" && context.screen === "1920×1080@2x" && String(context.userAgent).startsWith("Mozilla/5.0"), JSON.stringify(context));
      ok("the body kept as plain text, with its line breaks", row.body === `${BODY_MARKER} The print button does nothing.\nSince this morning.` && row.priority === "URGENT" && row.status === "OPEN" && row.mobile === "+91 98765 43210");
      const kinds = row.attachments.map((a) => `${a.kind}:${a.mime}`).sort();
      ok("two files and the recording attached, as sniffed", JSON.stringify(kinds) === JSON.stringify(["FILE:application/pdf", "FILE:image/png", "RECORDING:video/webm"]), kinds.join(", "));
      ok("  each moved under the request, out of staging", row.attachments.every((a) => a.storageKey === `${main.id}/${row.id}/${a.id}` && existsSync(path.join(SUPPORT_DIR, ...a.storageKey.split("/")))) && (await Promise.all([png, pdf, webm].map((u) => storage.readStaged(main.id, u.uploadId)))).every((m) => m === null));
      ok("  the recording with its length", row.attachments.find((a) => a.kind === "RECORDING")?.durationMs === 42_400);
      const log = row.consoleLog as { level: string; message: string }[] | null;
      ok("with consent: the console log (bad entries dropped), the perf timings and the consent time", !!row.recordingConsentAt && log?.length === 1 && log[0].message === "TypeError: print is not a function" && sameFields(context.perf, { dns: 12, ttfb: 181, load: 1500, transferSize: 245760 }), JSON.stringify({ log, perf: context.perf }));

      const ref = supportRef(sent.number);
      const ack = mail.find((m) => m.to === asha.email);
      const note = mail.find((m) => m.to === SUPPORT_EMAIL);
      ok("two mails: one to the person, one to the support address", mail.length === 2 && !!ack && !!note, mail.map((m) => `${m.to}: ${m.subject}`).join(" | "));
      ok("  the acknowledgement: its subject, Reply-To the support address, what they sent", ack?.subject === `We've received your request ${ref}: Zz invoices won't print` && ack.replyTo === SUPPORT_EMAIL && ack.text.includes(BODY_MARKER) && ack.text.includes("Critical"), ack?.subject);
      ok("  the notification: [SR][URGENT] workspace: subject, the console link, no Reply-To", note?.subject === `[${ref}][URGENT] ${main.name}: Zz invoices won't print` && note.text.includes(`/support/${sent.number}`) && note.text.includes("2 files and a screen recording") && !note.replyTo, note?.subject);

      const plain = await submit(main, asha.id, input({ subject: "Line one\r\nBcc: victim@example.com", priority: "LOW", mobile: "" }));
      const plainRow = plain.ok ? await control.supportRequest.findUnique({ where: { number: plain.number } }) : null;
      ok("a subject with CR/LF is one line, and a request without a recording keeps no log or consent", plain.ok && plainRow?.subject === "Line one Bcc: victim@example.com" && plainRow.consoleLog === null && plainRow.recordingConsentAt === null && plainRow.mobile === null && !mail.some((m) => /[\r\n]/.test(m.subject)), JSON.stringify(plain));

      const count = await requestsOf(main.id);
      const refusals: [string, Promise<SupportSubmitResult>, string][] = [];
      const recordingOf = async (userId: string, consent: unknown) => ({ uploadId: (await stage(main.id, userId, WEBM, "r", "recording")).uploadId, durationMs: 5000, consent, consoleLog: [] });
      refusals.push(["no consent in the form", submit(main, asha.id, input({ consent: undefined as never })), "Tick the box to agree to what's sent with your request."]);
      refusals.push(["consent as the string 'true'", submit(main, asha.id, input({ consent: "true" as never })), "Tick the box to agree to what's sent with your request."]);
      refusals.push(["a recording without consent", submit(main, asha.id, input({ recording: (await recordingOf(asha.id, false)) as never })), "A recording needs your consent — tick the box before you record."]);
      refusals.push(["a recording with consent as the string 'true'", submit(main, asha.id, input({ recording: (await recordingOf(asha.id, "true")) as never })), "A recording needs your consent — tick the box before you record."]);
      refusals.push(["a recording over five minutes", submit(main, asha.id, input({ recording: { ...(await recordingOf(asha.id, true)), durationMs: 400_000 } as never })), "A recording can be at most 5 minutes long."]);
      for (const [label, p, expected] of refusals) {
        const r = await p;
        ok(`${label} is refused`, !r.ok && r.error === expected, why(r));
      }
      await put("support.recording", "0");
      const recOff = await submit(main, asha.id, input({ recording: (await recordingOf(asha.id, true)) as never }));
      await put("support.recording", null);
      ok("a recording while recording is switched off is refused", !recOff.ok && recOff.error === "Screen recording isn't available right now — attach a screenshot instead.", why(recOff));
      policy = { ...noDeterrents, blockPrint: true };
      const recDlp = await submit(main, asha.id, input({ recording: (await recordingOf(asha.id, true)) as never }));
      policy = { ...noDeterrents };
      ok("  and while DLP applies to them", !recDlp.ok && recDlp.error === "Your organisation's security settings don't allow screen recording.", why(recDlp));
      viewingAs = true;
      const viewAs = await submit(main, asha.id, input());
      viewingAs = false;
      ok("viewing as someone else is refused", !viewAs.ok && viewAs.error === "You're viewing as someone else. Switch back to yourself to contact support.", why(viewAs));
      const staffInside = await submit(main, platformSupport.id, input());
      ok("a platform support account is refused", !staffInside.ok && staffInside.error === "Platform support can't raise a support request from inside a workspace.", why(staffInside));
      const nobody = await submit(main, null, input());
      ok("nobody signed in is refused", !nobody.ok && nobody.error === "Sign in first.");
      await put("support.enabled", "0");
      const disabled = await submit(main, asha.id, input());
      await put("support.enabled", null);
      ok("Contact Support switched off refuses", !disabled.ok && disabled.error === "Contact support isn't available right now.", why(disabled));
      const bad = [
        await submit(main, asha.id, input({ subject: "   " })),
        await submit(main, asha.id, input({ subject: "x".repeat(151) })),
        await submit(main, asha.id, input({ body: "" })),
        await submit(main, asha.id, input({ body: "😀".repeat(5001) })),
        await submit(main, asha.id, input({ mobile: "call me maybe" })),
        await submit(main, asha.id, input({ priority: "BLOCKER" as never })),
        await submit(main, asha.id, input({ uploadIds: ["aaaaaaaaaaaa1", "aaaaaaaaaaaa2", "aaaaaaaaaaaa3", "aaaaaaaaaaaa4", "aaaaaaaaaaaa5", "aaaaaaaaaaaa6"] })),
      ];
      ok("the fields' own limits hold", bad.every((r) => !r.ok), bad.map(why).join(" | "));
      ok("  counting characters as the database does (an emoji is one)", (await submit(main, asha.id, input({ subject: "😀".repeat(150) }))).ok);

      // Refusals after the throttle count against it, as a real person's would: a fresh hour for these.
      resetThrottle();
      const ravis = await stage(main.id, ravi.id, PNG, "ravi.png");
      const theirs = await submit(main, asha.id, input({ uploadIds: [ravis.uploadId] }));
      ok("another person's upload id is refused, in the same words as an expired one", !theirs.ok && theirs.error === EXPIRED, why(theirs));
      ok("  and it is still theirs, unmoved", (await storage.readStaged(main.id, ravis.uploadId))?.userId === ravi.id);
      const elsewhere = await stage(other.id, asha.id, PNG, "elsewhere.png");
      const fromOther = await submit(main, asha.id, input({ uploadIds: [elsewhere.uploadId] }));
      ok("the same person's upload from another workspace is refused", !fromOther.ok && fromOther.error === EXPIRED, why(fromOther));
      const fileAsRecording = await stage(main.id, asha.id, PNG, "as-rec.png");
      const kindSwap = await submit(main, asha.id, input({ recording: { uploadId: fileAsRecording.uploadId, durationMs: 5000, consent: true, consoleLog: [] } }));
      ok("a file sent as the recording is refused", !kindSwap.ok && kindSwap.error === EXPIRED, why(kindSwap));
      const made = await requestsOf(main.id);
      ok("no refusal wrote a request (only the one emoji subject did)", made === count + 1, `${count} → ${made}`);

      resetThrottle();
      mailer.setTestPlatformMailer(async (m) => {
        throw new Error(`SMTP refused ${m.to} at smtp://mailer:secretpass@mail.zz:587`);
      });
      const down = await submit(main, asha.id, input({ subject: "Zz mail server down" }));
      mailer.setTestPlatformMailer(collect);
      ok("a mail server that is down never fails the request", down.ok && (await control.supportRequest.count({ where: { subject: "Zz mail server down" } })) === 1, JSON.stringify(down));
    });

    // ─── Throttles ───────────────────────────────────────────────────────────────────────────────
    await part("F. Throttles: 5 an hour a person, 40 a day a workspace", async () => {
      resetThrottle();
      const results: SupportSubmitResult[] = [];
      for (let i = 0; i < 6; i++) results.push(await submit(main, kiran.id, input({ subject: `Zz kiran ${i}` })));
      ok("a person's first five in an hour are sent", results.slice(0, 5).every((r) => r.ok), results.map(why).join(" | "));
      ok("  the sixth is refused, saying to wait or call", !results[5].ok && results[5].error === THROTTLED, why(results[5]));
      ok("  and was not written", (await control.supportRequest.count({ where: { requesterUserId: kiran.id } })) === 5);
      ok("somebody else in the same workspace is not held up by it", (await submit(main, ravi.id, input({ subject: "Zz ravi after kiran" }))).ok);

      resetThrottle();
      const crowd = Array.from({ length: 9 }, (_, i) => person(`busy${i + 1}`));
      let sentBusy = 0;
      for (const p of crowd.slice(0, 8)) for (let i = 0; i < 5; i++) if ((await submit(busy, p.id, input({ subject: `Zz busy ${p.id} ${i}` }))).ok) sentBusy += 1;
      ok("forty from one workspace in a day are sent (eight people, five each)", sentBusy === 40, sentBusy);
      const fortyFirst = await submit(busy, crowd[8].id, input({ subject: "Zz one too many" }));
      ok("  the forty-first is refused, even from somebody who has sent none", !fortyFirst.ok && fortyFirst.error === THROTTLED, why(fortyFirst));
      ok("  another workspace is not held up by it", (await submit(other, asha.id, input({ subject: "Zz other workspace" }))).ok);
      ok("  and the busy workspace has exactly forty", (await requestsOf(busy.id)) === 40);
      resetThrottle();
    });

    // ─── The console's actions ───────────────────────────────────────────────────────────────────
    await part("G. The console's actions", async () => {
      if (!mainNumber) throw new Error("no request from section E");
      const n = mainNumber;
      const rowOf = () => control.supportRequest.findUniqueOrThrow({ where: { number: n } });
      mail.length = 0;

      for (const role of ["readonly", "billing"] as const) {
        await actAs(staffIds[role]);
        const r = await consoleActions.replySupport(n, `${REPLY_MARKER} should not go`);
        const s = await consoleActions.setSupportStatus(n, "CLOSED");
        ok(`${role} staff can't reply or change a request`, !r.ok && r.error === "Your role cannot do that." && !s.ok, `${why(r)} | ${why(s)}`);
      }
      signedOut();
      ok("nor can anybody signed out", why(await consoleActions.noteSupport(n, "x")) === "Sign in to the console.");
      ok("  and nothing was sent or changed", mail.length === 0 && (await rowOf()).status === "OPEN");

      await actAs(staffIds.support);
      ok("an empty reply, and one over 5,000 characters, are refused", why(await consoleActions.replySupport(n, "  \n ")) === "Write the reply first." && /5,000/.test(why(await consoleActions.replySupport(n, "x".repeat(5001)))));
      ok("an unknown request is gone", why(await consoleActions.replySupport(999_999, "hello")) === "That support request no longer exists." && why(await consoleActions.noteSupport("SR-1" as never, "x")) === "That support request no longer exists.");
      const reply = await consoleActions.replySupport(String(n) as never, `${REPLY_MARKER} Thanks — we're on it.\nTry again now.`);
      const afterReply = await rowOf();
      const replyMail = mail.find((m) => m.to === asha.email);
      ok("support replies: emailed", reply.ok && reply.data.emailed && reply.data.error === null, JSON.stringify(reply));
      ok("  to the requester, Re: [SR] subject, Reply-To the support address", replyMail?.subject === `Re: [${supportRef(n)}] Zz invoices won't print` && replyMail.replyTo === SUPPORT_EMAIL && replyMail.text.includes(REPLY_MARKER) && replyMail.text.includes("Zz Sup Agent"), replyMail?.subject);
      ok("  the first response is stamped, and Open moves to In progress", !!afterReply.firstResponseAt && afterReply.status === "IN_PROGRESS");
      const entries = await control.supportEntry.findMany({ where: { requestId: afterReply.id }, orderBy: { createdAt: "asc" } });
      ok("  on the timeline: the reply, marked emailed, and the status move", entries.some((e) => e.kind === "REPLY" && (e.meta as { emailed?: boolean }).emailed === true && e.authorId === staffIds.support) && entries.some((e) => e.kind === "STATUS" && sameFields(e.meta, { from: "OPEN", to: "IN_PROGRESS" })));
      const firstAt = afterReply.firstResponseAt!.getTime();
      await consoleActions.replySupport(n, "A second reply.");
      ok("a second reply leaves the first response where it was", (await rowOf()).firstResponseAt!.getTime() === firstAt);

      const mailsBefore = mail.length;
      const note = await consoleActions.noteSupport(n, `${NOTE_MARKER} customer is on the old plan`);
      ok("a note is kept on the timeline and mailed to nobody", note.ok && mail.length === mailsBefore && (await control.supportEntry.count({ where: { requestId: afterReply.id, kind: "NOTE", body: { contains: NOTE_MARKER } } })) === 1);

      const resolved = await consoleActions.setSupportStatus(n, "RESOLVED");
      const r1 = await rowOf();
      ok("Resolved stamps when; not closed", resolved.ok && !!r1.resolvedAt && r1.closedAt === null && r1.status === "RESOLVED");
      await consoleActions.setSupportStatus(n, "CLOSED");
      const r2 = await rowOf();
      ok("Closed stamps when, and keeps when it was resolved", r2.status === "CLOSED" && !!r2.closedAt && r2.resolvedAt?.getTime() === r1.resolvedAt?.getTime());
      await consoleActions.setSupportStatus(n, "WAITING");
      const r3 = await rowOf();
      ok("reopening (Waiting) clears both", r3.status === "WAITING" && r3.resolvedAt === null && r3.closedAt === null);
      ok("the same status again changes nothing", (await consoleActions.setSupportStatus(n, "WAITING")).ok && (await control.supportEntry.count({ where: { requestId: r3.id, kind: "STATUS" } })) === 4);
      ok("a status that is not one is refused", why(await consoleActions.setSupportStatus(n, "DONE" as never)) === "Choose a status.");
      await consoleActions.setSupportStatus(n, "IN_PROGRESS");
      const pri = await consoleActions.setSupportPriority(n, "HIGH");
      ok("the priority changes, with its entry", pri.ok && (await rowOf()).priority === "HIGH" && (await control.supportEntry.count({ where: { requestId: r3.id, kind: "PRIORITY" } })) === 1);
      const toReadonly = await consoleActions.assignSupport(n, staffIds.readonly);
      ok("it can't be assigned to read-only staff", !toReadonly.ok && toReadonly.error === "Choose a staff member who works on support requests.");
      const toAgent = await consoleActions.assignSupport(n, staffIds.support);
      const toOwner = await consoleActions.assignSupport(n, staffIds.owner);
      ok("it is assigned to an agent, then passed on", toAgent.ok && toOwner.ok && (await rowOf()).assigneeId === staffIds.owner);
      const assignEntry = await control.supportEntry.findFirst({ where: { requestId: r3.id, kind: "ASSIGN" }, orderBy: { createdAt: "desc" } });
      ok("  the timeline names who from and who to", JSON.stringify(assignEntry?.meta).includes("Zz Sup Agent") && JSON.stringify(assignEntry?.meta).includes("Zz Sup Owner"));
      ok("  and unassigned", (await consoleActions.assignSupport(n, null)).ok && (await rowOf()).assigneeId === null);

      // A reply whose mail fails: kept, marked, and no first response.
      const fresh = await submit(main, ravi.id, input({ subject: "Zz reply mail fails" }));
      await actAs(staffIds.support);
      if (!fresh.ok) throw new Error(fresh.error);
      mailer.setTestPlatformMailer(async () => {
        throw new Error("Connection refused by smtp://user:hunter2@mail.zz");
      });
      const failed = await consoleActions.replySupport(fresh.number, "Hello");
      mailer.setTestPlatformMailer(collect);
      const freshRow = await control.supportRequest.findUniqueOrThrow({ where: { number: fresh.number } });
      ok("a reply whose mail fails is kept, marked, and says why — with no secret in it", failed.ok && !failed.data.emailed && !!failed.data.error && !failed.data.error.includes("hunter2"), JSON.stringify(failed));
      ok("  no first response, but In progress", freshRow.firstResponseAt === null && freshRow.status === "IN_PROGRESS");

      // Settings.
      const settingsInput = { enabled: true, email: "desk@zzsupport.example", helpline: "+91 80 4000 1234", hours: "Mon-Sat", languages: "English, Hindi", recording: true, retentionDays: 365 };
      for (const role of ["support", "readonly", "billing"] as const) {
        await actAs(staffIds[role]);
        ok(`${role} staff can't change the Support settings`, why(await consoleActions.saveSupportSettings(settingsInput)) === "Your role cannot do that.");
      }
      await actAs(staffIds.admin);
      ok("an address that isn't one, or retention out of range, is refused", !(await consoleActions.saveSupportSettings({ ...settingsInput, email: "not an address" })).ok && !(await consoleActions.saveSupportSettings({ ...settingsInput, retentionDays: 10 })).ok);
      const saved = await consoleActions.saveSupportSettings(settingsInput);
      ok("an admin saves them", saved.ok && (await supportSettings.getSupportSettings()).email === "desk@zzsupport.example", why(saved));
      await consoleActions.saveSupportSettings({ ...settingsInput, email: SUPPORT_EMAIL });

      const audit = await control.platformAuditLog.findMany({ where: { action: { startsWith: "support." } } });
      const actionsSeen = new Set(audit.map((a) => a.action));
      const expected = ["support.reply", "support.note", "support.status", "support.priority", "support.assign", "support.settings"];
      ok("every change is in the audit log", expected.every((a) => actionsSeen.has(a)), expected.filter((a) => !actionsSeen.has(a)).join(", "));
      ok("  by who did it, against the workspace", audit.filter((a) => a.action === "support.reply").every((a) => a.actor === staffIds.support && a.tenantId === main.id));
      const auditText = JSON.stringify(audit.map((a) => a.detail));
      ok("  and never what anybody wrote: no body, reply or note text, no address", ![BODY_MARKER, REPLY_MARKER, NOTE_MARKER, "Thanks", "desk@zzsupport.example", asha.email].some((m) => auditText.includes(m)), auditText.slice(0, 300));
      ok("  a reply's row has its length instead", audit.some((a) => a.action === "support.reply" && typeof (a.detail as { length?: unknown }).length === "number"));
    });

    // ─── The file route ──────────────────────────────────────────────────────────────────────────
    await part("H. The file route (/support-files/<id>)", async () => {
      if (!mainNumber) throw new Error("no request from section E");
      const atts = await control.supportAttachment.findMany({ where: { request: { number: mainNumber } } });
      const png = atts.find((a) => a.mime === "image/png")!;
      const pdf = atts.find((a) => a.mime === "application/pdf")!;
      const webm = atts.find((a) => a.mime === "video/webm")!;
      const call = async (method: "GET" | "HEAD", id: string, range?: string) => {
        const req = new Request(`http://${CONSOLE_HOST}/support-files/${encodeURIComponent(id)}`, { method, headers: range ? { range } : {} });
        const res = await fileRoute[method](req, { params: Promise.resolve({ id }) });
        // Read to the end, so no file is left open.
        const body = res.body ? Buffer.from(await res.arrayBuffer()) : null;
        return { status: res.status, h: (name: string) => res.headers.get(name) ?? "", body };
      };
      const opens = () => control.platformAuditLog.count({ where: { action: "support.file.open" } });
      supportConsole.forgetAuditedOpens();

      signedOut();
      const nobody = await call("GET", png.id);
      ok("no staff session: 401, and nothing sent", nobody.status === 401 && !nobody.body?.includes(PNG));
      for (const role of ["readonly", "billing"] as const) {
        await actAs(staffIds[role]);
        ok(`${role} staff: 403`, (await call("GET", png.id)).status === 403);
      }
      ok("  and none of those was an opening", (await opens()) === 0);

      await actAs(staffIds.support);
      const image = await call("GET", png.id);
      ok("an image: 200, the bytes, its sniffed type, shown inline", image.status === 200 && image.body?.equals(PNG) === true && image.h("content-type") === "image/png" && image.h("content-disposition").startsWith("inline; filename*=UTF-8''"), `${image.status} ${image.h("content-type")} ${image.h("content-disposition")}`);
      ok("  never sniffed, never cached, sandboxed", image.h("x-content-type-options") === "nosniff" && image.h("cache-control") === "private, no-store" && image.h("content-security-policy") === "sandbox; default-src 'none'; media-src 'self'; img-src 'self'");
      const doc = await call("GET", pdf.id);
      ok("a PDF downloads, under its name", doc.status === 200 && doc.h("content-disposition") === "attachment; filename*=UTF-8''invoice.pdf" && doc.h("content-type") === "application/pdf", doc.h("content-disposition"));
      const whole = await call("GET", webm.id);
      const ranged = await call("GET", webm.id, "bytes=0-99");
      const tail = await call("GET", webm.id, "bytes=-10");
      ok("a recording plays inline, and says it takes ranges", whole.status === 200 && whole.h("content-type") === "video/webm" && whole.h("content-disposition").startsWith("inline") && whole.h("accept-ranges") === "bytes" && whole.body?.length === WEBM.length);
      ok("  a range answers 206 with its Content-Range and just those bytes", ranged.status === 206 && ranged.h("content-range") === `bytes 0-99/${WEBM.length}` && ranged.h("content-length") === "100" && ranged.body?.equals(WEBM.subarray(0, 100)) === true, `${ranged.status} ${ranged.h("content-range")}`);
      ok("  the last ten bytes too", tail.status === 206 && tail.body?.equals(WEBM.subarray(WEBM.length - 10)) === true);
      const past = await call("GET", webm.id, `bytes=${WEBM.length}-`);
      ok("  a range past the end: 416", past.status === 416 && past.h("content-range") === `bytes */${WEBM.length}`);
      ok("the three files, one opening each — the range requests were the same look", (await opens()) === 3, await opens());
      ok("  each row naming the file, its kind and type, and no name or bytes", (await control.platformAuditLog.findMany({ where: { action: "support.file.open" } })).every((a) => {
        const d = a.detail as Record<string, unknown>;
        return a.actor === staffIds.support && a.tenantId === main.id && typeof d.attachmentId === "string" && !JSON.stringify(d).includes("invoice.pdf");
      }));
      await actAs(staffIds.owner);
      await call("GET", png.id);
      ok("another staff member's look is their own opening", (await opens()) === 4);

      supportConsole.forgetAuditedOpens();
      const before = await opens();
      const head = await call("HEAD", webm.id);
      const headRange = await call("HEAD", webm.id, "bytes=10-19");
      ok("HEAD: GET's status and headers, without the bytes", head.status === 200 && head.h("content-length") === String(WEBM.length) && head.h("content-type") === "video/webm" && head.h("x-content-type-options") === "nosniff" && !head.body?.length, `${head.status} ${head.h("content-length")}`);
      ok("  a ranged HEAD: 206 and its Content-Range", headRange.status === 206 && headRange.h("content-range") === `bytes 10-19/${WEBM.length}` && headRange.h("content-length") === "10");
      ok("  and no opening audited", (await opens()) === before);
      signedOut();
      ok("  HEAD with no session: 401", (await call("HEAD", webm.id)).status === 401);

      await actAs(staffIds.support);
      ok("an unknown id, and one that is not an id: 404", (await call("GET", "zzsupnosuchattachment01")).status === 404 && (await call("GET", "../../etc/passwd")).status === 404);
      await control.supportAttachment.update({ where: { id: pdf.id }, data: { purgedAt: new Date() } });
      ok("a file removed by retention: 410 (GET and HEAD)", (await call("GET", pdf.id)).status === 410 && (await call("HEAD", pdf.id)).status === 410);
    });

    // ─── Rendered ────────────────────────────────────────────────────────────────────────────────
    await part("I. The pages and the workspace's components, rendered", async () => {
      if (!mainNumber) throw new Error("no request from section E");
      const hostileSubject = '<script>alert("zz")</script> Zz hostile subject';
      await requests.createSupportRequest({
        tenantId: main.id,
        requester: { userId: ravi.id, name: "<b>Ravi</b>", email: ravi.email, role: "SALES" },
        mobile: null,
        subject: hostileSubject,
        body: '<img src=x onerror="alert(1)"> zz hostile body',
        priority: "HIGH",
        context: { v: 1, page: "/<script>" },
        consoleLog: null,
        recordingConsentAt: null,
        ip: null,
        attachments: [],
      });
      const hostile = await control.supportRequest.findFirstOrThrow({ where: { subject: hostileSubject } });
      const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
      const Inbox = pageAt("support/page");
      const Detail = pageAt("support/[number]/page");
      const Settings = pageAt("settings/page");

      await actAs(staffIds.owner);
      // The main request is High by now, behind forty Urgent ones: searched for, so it is on the first page.
      const inbox = await render(Inbox, {}, { status: "all", q: "invoices won" });
      ok("the inbox lists the requests, by number and subject", inbox.includes(supportRef(mainNumber)) && inbox.includes("Zz invoices won&#x27;t print"), inbox.length);
      const { parseSupportFilters } = require("../src/lib/console-shared/params") as typeof import("../src/lib/console-shared/params");
      const open = await supportConsole.supportInbox(parseSupportFilters({}), staffIds.owner);
      const rank = (p: string) => ["LOW", "NORMAL", "HIGH", "URGENT"].indexOf(p);
      const ordered = open.rows.every((r, i) => {
        const prev = open.rows[i - 1];
        return !prev || rank(prev.priority) > rank(r.priority) || (prev.priority === r.priority && prev.createdAt.getTime() <= r.createdAt.getTime());
      });
      ok("  the Open tab: most critical first, then the oldest, fifty a page", ordered && open.rows[0]?.priority === "URGENT" && open.rows.length === Math.min(50, open.counts.open) && open.rows.every((r) => r.status === "OPEN" || r.status === "IN_PROGRESS"), open.rows.slice(0, 3).map((r) => `${r.ref} ${r.priority}`).join(", "));
      const hostileRow = await render(Inbox, {}, { status: "all", q: "Zz hostile" });
      ok("  a subject is text, never markup", !hostileRow.includes('<script>alert("zz")') && hostileRow.includes("&lt;script&gt;alert") && hostileRow.includes(supportRef(hostile.number)), hostileRow.length);
      const byNumber = await render(Inbox, {}, { status: "all", q: supportRef(mainNumber) });
      ok("  searching by SR number finds it", byNumber.includes(supportRef(mainNumber)) && !byNumber.includes("Zz kiran 0"));

      await actAs(staffIds.support);
      const detail = await render(Detail, { number: String(mainNumber) });
      const webm = await control.supportAttachment.findFirstOrThrow({ where: { request: { number: mainNumber }, kind: "RECORDING" } });
      ok("a request, for support staff: the body, the composer, the recording's player", detail.includes(BODY_MARKER) && detail.includes("Reply to customer") && detail.includes("Internal note") && detail.includes(`src="/support-files/${webm.id}"`) && detail.includes('preload="metadata"'));
      ok("  the console log and the page it was sent from", detail.includes("TypeError: print is not a function") && detail.includes("/invoices/INV-42"));
      ok("  the timeline's reply and internal note", detail.includes(REPLY_MARKER) && detail.includes(NOTE_MARKER));
      const hostileDetail = await render(Detail, { number: String(hostile.number) });
      ok("  a hostile body and name are text", !hostileDetail.includes("<img src=x") && hostileDetail.includes("&lt;img src=x") && !hostileDetail.includes("<b>Ravi</b>"));
      await actAs(staffIds.readonly);
      const readonly = await render(Detail, { number: String(mainNumber) });
      ok("read-only staff see the request, with no composer, no controls and no file links", readonly.includes(BODY_MARKER) && !readonly.includes("Reply to customer") && !readonly.includes("/support-files/") && !readonly.includes("<video"));
      await actAs(staffIds.billing);
      ok("billing staff: not found", (await thrown(() => render(Detail, { number: String(mainNumber) }))) === "notFound" && (await thrown(() => render(Inbox))) === "notFound");
      await actAs(staffIds.support);
      ok("a number that is not one, or no such request: not found", (await thrown(() => render(Detail, { number: `SR-${mainNumber}` }))) === "notFound" && (await thrown(() => render(Detail, { number: "999999" }))) === "notFound");
      signedOut();
      ok("signed out: sent to sign in", (await thrown(() => render(Inbox))) === "redirect /login" && (await thrown(() => render(Detail, { number: String(mainNumber) }))) === "redirect /login");
      await actAs(staffIds.owner);
      const settings = await render(Settings);
      ok("Settings has the Support section, with its address", settings.includes('id="support"') && settings.includes(SUPPORT_EMAIL));

      // The workspace side: nothing touches the browser at import, and the markup reads right.
      const { SupportLauncher } = require("../src/components/support/support-launcher") as typeof import("../src/components/support/support-launcher");
      const { SupportDialog } = require("../src/components/support/support-dialog") as typeof import("../src/components/support/support-dialog");
      const { RecordingConsent } = require("../src/components/support/recording-consent") as typeof import("../src/components/support/recording-consent");
      require("../src/components/support/recorder");
      ok("the workspace's support components import with no window or document", typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { document?: unknown }).document === "undefined");
      const state: LauncherState = { email: "asha@zzsup.example", phone: "+91 98765 43210", helpline: "+91 80 4000 1234", hours: "Mon-Fri", recordingAllowed: true, recordingBlockedReason: null, brandName: "Wroffy ERP" };
      const launcher = renderToStaticMarkup(createElement(SupportLauncher, { state }));
      ok("the launcher: nothing on the page until the sidebar asks — the dialog closed", !launcher.includes('role="dialog"'), launcher.slice(0, 300));
      const dialog = renderToStaticMarkup(createElement(SupportDialog, { state, open: true, onClose: () => {} }));
      ok("the dialog: its title, the fields, the priorities, the footer and the disclosure", ["How can we help you today?", "Subject", "Tell us in detail", "Mobile number", "How critical is your request?", "Just a question", "Critical — our business is stopped", "asha@zzsup.example", "I agree to send this request with the page I was on"].every((t) => dialog.includes(t)), ["How can we help you today?", "Subject", "Tell us in detail", "Mobile number", "How critical is your request?", "Just a question", "asha@zzsup.example"].filter((t) => !dialog.includes(t)).join(", "));
      ok("  the phone prefilled, and NORMAL chosen", dialog.includes('value="+91 98765 43210"') && /<option value="NORMAL" selected="">/.test(dialog));
      const dlpDialog = renderToStaticMarkup(createElement(SupportDialog, { state: { ...state, recordingAllowed: false, recordingBlockedReason: "dlp" }, open: true, onClose: () => {} }));
      ok("  with DLP, Record says the organisation doesn't allow it", dlpDialog.includes("Your organisation&#x27;s security settings don&#x27;t allow screen recording."));
      const consent = renderToStaticMarkup(createElement(RecordingConsent, { open: true, brandName: "<b>Zz</b>", microphone: false, onMicrophoneChange: () => {}, starting: false, onStart: () => {}, onCancel: () => {} }));
      ok("the consent dialog: what is collected, the agreement, Start recording", consent.includes("Provide consent for recording") && consent.includes("Your IP address") && consent.includes("Start recording") && consent.includes("&lt;b&gt;Zz&lt;/b&gt;"), consent.slice(0, 300));
    });

    // ─── Retention ───────────────────────────────────────────────────────────────────────────────
    await part("J. Retention (the platform tick's support step)", async () => {
      resetThrottle();
      const now = new Date();
      const make = async (subject: string) => {
        const up = await stage(main.id, anil.id, TXT, `${subject}.txt`);
        const attachments = await requests.stagedAttachments(main.id, anil.id, [up.uploadId], null);
        const made = await requests.createSupportRequest({ tenantId: main.id, requester: { userId: anil.id, name: anil.name, email: anil.email, role: "ADMIN" }, mobile: null, subject, body: "zz retention", priority: "LOW", context: { v: 1 }, consoleLog: null, recordingConsentAt: null, ip: null, attachments });
        return control.supportRequest.findUniqueOrThrow({ where: { id: made.id }, include: { attachments: true } });
      };
      const oldClosed = await make("Zz closed long ago");
      const recentClosed = await make("Zz closed recently");
      const stillOpen = await make("Zz still open");
      await control.supportRequest.update({ where: { id: oldClosed.id }, data: { status: "CLOSED", resolvedAt: new Date(now.getTime() - 400 * DAY), closedAt: new Date(now.getTime() - 400 * DAY) } });
      await control.supportRequest.update({ where: { id: recentClosed.id }, data: { status: "CLOSED", closedAt: new Date(now.getTime() - 10 * DAY) } });
      const fileOf = (r: typeof oldClosed) => path.join(SUPPORT_DIR, ...r.attachments[0].storageKey.split("/"));
      const abandoned = await stage(main.id, anil.id, TXT, "abandoned.txt");
      const abandonedAt = new Date(now.getTime() - 2 * DAY);
      for (const name of [abandoned.uploadId, `${abandoned.uploadId}.json`]) utimesSync(path.join(SUPPORT_DIR, main.id, "staging", name), abandonedAt, abandonedAt);
      ok("(the files are there to begin with)", [oldClosed, recentClosed, stillOpen].every((r) => existsSync(fileOf(r))));

      const result = await retention.runSupportRetention(now);
      ok("a request closed over 365 days ago loses its files", !existsSync(fileOf(oldClosed)) && result.purged >= 1, JSON.stringify(result));
      const kept = await control.supportRequest.findUniqueOrThrow({ where: { id: oldClosed.id }, include: { attachments: true } });
      ok("  its rows stay, each attachment marked purged", kept.attachments.length === 1 && !!kept.attachments[0].purgedAt && kept.subject === "Zz closed long ago");
      ok("one closed ten days ago, and one still open, keep theirs", existsSync(fileOf(recentClosed)) && existsSync(fileOf(stillOpen)) && (await control.supportAttachment.count({ where: { requestId: { in: [recentClosed.id, stillOpen.id] }, purgedAt: { not: null } } })) === 0);
      ok("uploads abandoned in staging for over a day are swept", result.swept >= 1 && !existsSync(path.join(SUPPORT_DIR, main.id, "staging", abandoned.uploadId)));
      ok("  nothing is stuck", result.stuck === 0);
      const again = await retention.runSupportRetention(now);
      ok("a second run purges nothing more", again.purged === 0 && again.stuck === 0, JSON.stringify(again));
      await put("support.retentionDays", "30");
      await control.supportRequest.update({ where: { id: recentClosed.id }, data: { closedAt: new Date(now.getTime() - 31 * DAY) } });
      const shorter = await retention.runSupportRetention(now);
      await put("support.retentionDays", "365");
      ok("a shorter retention setting is followed", shorter.purged === 1 && !existsSync(fileOf(recentClosed)) && existsSync(fileOf(stillOpen)), JSON.stringify(shorter));
    });

    // ─── Static scans ────────────────────────────────────────────────────────────────────────────
    await part("K. Static scans", async () => {
      const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
      const light = ["src/lib/support/requests.ts", "src/lib/support/requester.ts", "src/lib/support/settings.ts", "src/lib/support/mail.ts", "src/lib/support/storage.ts", "src/lib/support/refused.ts", "src/lib/support/types.ts", "src/lib/platform/brand.ts", "src/actions/support.ts"];
      const heavy = light.filter((f) => /from "@\/lib\/(platform\/console-guard|platform\/provisioning|billing\/)/.test(read(f)));
      ok("what a workspace imports never pulls in the console guard, provisioning or billing", heavy.length === 0, heavy.join(", "));
      ok("the client-safe types import nothing", !/^import /m.test(read("src/lib/support/types.ts")));
      ok("the console's support actions can't grant support access", !read("src/actions/platform/console-support.ts").includes("grantSupportAccess"));
      const atInfo = ["src/lib/support/console.ts", "src/lib/support/retention.ts", "src/actions/platform/console-support.ts", "src/app/api/support/uploads/route.ts", "src/app/platform-console/support-files/[id]/route.ts", ...light].filter((f) => /console\.(log|info)\(/.test(read(f)));
      ok("nothing about a request is logged at info level", atInfo.length === 0, atInfo.join(", "));
      const tick = read("src/app/api/platform/tick/route.ts");
      ok("the platform tick runs the support step and reports it", tick.includes("runSupportRetention") && /support:/.test(tick));
      const said = logged.join("\n");
      const leaked = ["secretpass", "hunter2", BODY_MARKER, REPLY_MARKER, NOTE_MARKER, "@zzsup.example", "victim@example.com", "invoices won"].filter((m) => said.includes(m));
      ok("what was logged along the way (warnings about mail and settings) carries no password, address or text anybody wrote", logged.length >= 5 && leaked.length === 0, `${logged.length} lines; ${leaked.join(", ")}`);
      ok("the file route answers HEAD itself (Next would run GET for it)", /export async function HEAD\(/.test(read("src/app/platform-console/support-files/[id]/route.ts")));
      ok("the console's recording player learns a WebM's length", read("src/components/console/support/recording-player.tsx").includes("MAX_SAFE_INTEGER") && read("src/components/console/support/attachments.tsx").includes("RecordingPlayer"));
    });
  } finally {
    mailerReset();
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
    rmSync(SUPPORT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    ok("the temporary SUPPORT_DIR is removed", !existsSync(SUPPORT_DIR));
  }

  console.log(failures === 0 ? `\nAll ${passes} support checks passed.` : `\n${failures} check(s) FAILED, ${passes} passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

function mailerReset() {
  try {
    (require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer")).setTestPlatformMailer(null);
  } catch {
    // Never loaded: nothing to put back.
  }
}

main().catch((err) => {
  console.error(err);
  try {
    rmSync(SUPPORT_DIR, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
  process.exit(1);
});
