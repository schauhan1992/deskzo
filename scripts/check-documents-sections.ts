/**
 * The owner's list of 8 Oct 2026:
 *
 *   · **A cancelled document says why.** Cancelling — from its page, a list's bulk bar, or with its
 *     e-invoice — needs a reason, kept on the document with who and when, and shown on it.
 *   · **A proforma issued by accounts tells its salesperson** — in the app and by email (through the
 *     platform's Alerts mail), naming who issued it.
 *   · **A role sees only its sections.** Every module is a section a role can be unticked from; then it
 *     is gone from the menu and the Create menu, its pages say there's no access, and its dashboard
 *     widgets aren't offered. Every role — custom ones too — sees every section until one is unticked,
 *     and presets leave sections alone.
 *   · **The printed invoice keeps to its page** — A4, fixed columns — and the service period's two dates
 *     share one row (checked in the markup).
 *
 * Builds a scratch database beside the local one from the migrations and drives the real actions in
 * it as stubbed users. Mail is caught by the platform mailer's test hook: nothing is sent.
 *
 *   npm run check:documents-sections
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { MODULE_REGISTRY } from "../src/lib/modules";
import { PERMISSIONS, getPermissionDefinition, heldByDefault, sectionPermission } from "../src/lib/permissions";
import { ROLE_PRESETS, presetDiff } from "../src/lib/authz/presets";
import { cancelReasonOrRefusal } from "../src/lib/documents/cancel-reason";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const json = (v: unknown) => JSON.stringify(v);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const TAG = "ZZDS";

// ── Who is calling ──────────────────────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const pathname = "/dashboard";

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
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND_CALLED");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT_CALLED ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const moduleOverrides = { requireModuleUser: async () => session.requireUser(), moduleAvailableForTenant: async () => true };
let modulesAccess: unknown = null;
const stubs = new Map<string, () => unknown>([
  ["next/cache", () => nextCache],
  ["next/navigation", () => navigation],
  ["@/lib/session", () => session],
]);
const files = new Map<string, () => unknown>([
  [load.resolve("next/navigation"), () => navigation],
  [load.resolve("next/cache"), () => nextCache],
  [load.resolve("../src/lib/session"), () => session],
]);
const modulesFile = load.resolve("../src/lib/modules-access");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  const named = stubs.get(request);
  if (named) return named();
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved && files.has(resolved)) return files.get(resolved)!();
  if (request === "@/lib/modules-access" || resolved === modulesFile) {
    modulesAccess ??= { ...(realLoad.call(this, request, parent, isMain) as object), ...moduleOverrides };
    return modulesAccess;
  }
  return realLoad.call(this, request, parent, isMain);
};

// ── Without a database ──────────────────────────────────────────────────────────────────────────

function pure() {
  section("1. Sections, one per module");
  const missing = MODULE_REGISTRY.filter((m) => !getPermissionDefinition(sectionPermission(m.key)));
  ok("every module is a section a role can be unticked from", missing.length === 0, missing.map((m) => m.key).join(", "));
  const sections = PERMISSIONS.filter((p) => p.everyone);
  ok("  and nothing else is held by every role", sections.every((p) => p.key.startsWith("section.")) && sections.length === MODULE_REGISTRY.length, sections.length);
  const it = getPermissionDefinition(sectionPermission("it_assets"))!;
  ok("a section is held by every role, a custom one too, with nothing written", heldByDefault(it, "SALES") && heldByDefault(it, "REGIONAL_MANAGER_ZZ"));
  ok("  a capability, only by the roles listed", !heldByDefault(getPermissionDefinition("assets.manage")!, "REGIONAL_MANAGER_ZZ"));
  const touched = ROLE_PRESETS.flatMap((p) => [...presetDiff(p, {}).willGrant, ...presetDiff(p, Object.fromEntries(sections.map((s) => [s.key, true]))).willRevoke]);
  ok("no preset grants or takes away a section", !touched.some((k) => k.startsWith("section.")), touched.filter((k) => k.startsWith("section.")).join(", "));

  section("2. A cancellation's reason");
  ok("none is refused", !cancelReasonOrRefusal("").ok && !cancelReasonOrRefusal("  ").ok && !cancelReasonOrRefusal("no").ok);
  const kept = cancelReasonOrRefusal("  Customer   chose another vendor ");
  ok("  one is kept tidied", kept.ok && kept.reason === "Customer chose another vendor", kept.ok ? kept.reason : kept.error);
  ok("  and a novel is refused", !cancelReasonOrRefusal("x".repeat(501)).ok);

  section("3. The printed document and the editor, in their markup");
  const print = read("src/app/(print)/documents/[id]/print/page.tsx");
  const printLayout = read("src/app/(print)/layout.tsx");
  ok("the print page lays out on A4 with fixed margins", /@page \{ size: A4; margin: 10mm; \}/.test(printLayout));
  ok("  its amounts table has fixed columns and stays inside its frame", print.includes('<table className="w-full table-fixed">') && print.includes("<colgroup>") && print.includes("overflow-hidden border border-neutral-300"));
  ok("  its amounts keep to one line, its description wraps", (print.match(/whitespace-nowrap px-2 py-2 text-right/g) ?? []).length >= 6 && print.includes('className="break-words px-2 py-2"'));
  const form = read("src/components/documents/document-form.tsx");
  ok(
    "the editor's service period: its two dates share one row, each taking half",
    (form.match(/className="h-8 min-w-0 flex-1 px-2 text-xs"/g) ?? []).length === 2 && form.includes('<div className="flex items-center gap-1.5">') && !form.includes('className="h-8 w-36 text-xs"'),
  );
  ok("  in a column wide enough for them", form.includes('<th className="min-w-[19rem] px-3 py-2">Item details</th>'));
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
  const scratchName = `${realName}_docs_sections`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and it is not the real one", scratchName !== realName, scratchName);

  const real = directClient(realUrl, { max: 1 });
  const realBefore = await snapshot(real);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
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
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace was not touched");
  const realAfter = await snapshot(real);
  await real.$disconnect();
  ok("its documents, notifications and role permissions are as they were", realAfter === realBefore, realAfter);

  console.log(failures === 0 ? `\nAll ${passes} document and section checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function snapshot(client: PrismaClient) {
  const [documents, notifications, rolePermissions] = await Promise.all([client.tradeDocument.count(), client.notification.count(), client.rolePermission.count()]);
  return JSON.stringify({ documents, notifications, rolePermissions });
}

// ── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const documents = require("../src/actions/trade-document") as typeof import("../src/actions/trade-document");
  const { cancellationOf } = require("../src/lib/documents/cancellation") as typeof import("../src/lib/documents/cancellation");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { can, permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { moduleAccessFor } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const { Sidebar } = require("../src/components/layout/sidebar") as typeof import("../src/components/layout/sidebar");
  const { DEFAULT_BRANDING } = require("../src/lib/branding") as typeof import("../src/lib/branding");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const person = (key: string, role: string, extra: Record<string, unknown> = {}) =>
    db.user.create({
      data: { name: `${TAG} ${key}`, email: `${TAG.toLowerCase()}-${key.toLowerCase()}@example.test`, passwordHash: "!", role, ...extra },
      select: { id: true, name: true, email: true, role: true },
    });
  const boss = await person("Admin", "ADMIN");
  const accounts = await person("Accounts", "ACCOUNTS");
  const seller = await person("Sales", "SALES");
  const as = <T,>(who: Actor, work: () => Promise<T>) => {
    actor = who;
    return work();
  };
  const client = await db.company.create({
    data: {
      name: `${TAG} Client`,
      normalizedName: `${TAG.toLowerCase()} client`,
      relationshipType: "CLIENT",
      createdById: seller.id,
      ownerUserId: seller.id,
      locations: { create: { label: "HQ", city: "Mumbai", state: "Maharashtra", country: "India", pincode: "400001", isPrimary: true, isBilling: true, isShipping: true } },
    },
    include: { locations: true },
  });
  const today = new Date().toISOString().slice(0, 10);
  const draft = async (who: Actor, docType: string) => {
    const made = await as(who, () =>
      documents.createTradeDocument({
        docType,
        issueDate: today,
        companyId: client.id,
        locationId: client.locations[0]!.id,
        gstTreatment: "UNREGISTERED",
        salespersonId: seller.id,
        billing: { line1: "1 Road", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", country: "India" },
        shippingSameAsBilling: true,
        shipping: {},
        lines: [{ name: `${TAG} Licence`, hsnCode: "998314", unit: "NOS", quantity: 1, unitPrice: 1000, taxRatePercent: 18 }],
      }),
    );
    if (!made.ok) throw new Error(`The ${docType} wasn't created: ${made.error}`);
    return made.data.id;
  };

  // ── Cancelling says why ─────────────────────────────────────────────────────────────────────

  section("4. A cancelled proposal says why");
  const proposal = await draft(seller, "PROPOSAL");
  await db.tradeDocument.update({ where: { id: proposal }, data: { status: "ISSUED", docNumber: `${TAG}-P-1` } });
  // Cancelling is documents.void's — accounts', not a salesperson's.
  const bare = await as(accounts, () => documents.setTradeDocumentStatus(proposal, "CANCELLED"));
  ok("cancelling without a reason is refused", !bare.ok && /why/.test(bare.ok ? "" : bare.error), bare.ok ? "cancelled" : bare.error);
  ok("  and the proposal is as it was", (await db.tradeDocument.findUnique({ where: { id: proposal }, select: { status: true } }))?.status === "ISSUED");
  const cancelled = await as(accounts, () => documents.setTradeDocumentStatus(proposal, "CANCELLED", "Customer chose another vendor on price"));
  const kept = await cancellationOf(proposal);
  ok(
    "with one, it is cancelled — the reason kept with who and when",
    cancelled.ok && kept?.reason === "Customer chose another vendor on price" && kept.by === accounts.name && !!kept.at,
    json(kept),
  );
  const trail = await db.auditLog.findFirst({ where: { entityId: proposal }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
  ok("  and the audit says why too", !!trail?.entityLabel.includes("Customer chose another vendor"), trail?.entityLabel);
  const revived = await as(accounts, () => documents.setTradeDocumentStatus(proposal, "ACCEPTED"));
  ok("moved on from cancelled, it no longer reads as cancelled", revived.ok && (await cancellationOf(proposal)) === null && (await db.tradeDocument.findUnique({ where: { id: proposal }, select: { cancelReason: true } }))?.cancelReason === null);

  const p2 = await draft(seller, "PROPOSAL");
  const p3 = await draft(seller, "PROPOSAL");
  await db.tradeDocument.updateMany({ where: { id: { in: [p2, p3] } }, data: { status: "ISSUED" } });
  await db.tradeDocument.update({ where: { id: p2 }, data: { docNumber: `${TAG}-P-2` } });
  await db.tradeDocument.update({ where: { id: p3 }, data: { docNumber: `${TAG}-P-3` } });
  const bulkBare = await as(accounts, () => documents.bulkUpdateTradeDocuments({ documentIds: [p2, p3], action: "status", status: "CANCELLED" }));
  ok("the bulk bar refuses to cancel without a reason, touching none", !bulkBare.ok && (await db.tradeDocument.count({ where: { id: { in: [p2, p3] }, status: "CANCELLED" } })) === 0);
  const bulk = await as(accounts, () => documents.bulkUpdateTradeDocuments({ documentIds: [p2, p3], action: "status", status: "CANCELLED", reason: "Budget frozen this quarter" }));
  ok(
    "  and with one, every one of them keeps it",
    bulk.ok && bulk.data.count === 2 && (await db.tradeDocument.count({ where: { id: { in: [p2, p3] }, cancelReason: "Budget frozen this quarter", cancelledById: accounts.id } })) === 2,
  );

  // ── A proforma issued by accounts ───────────────────────────────────────────────────────────

  section("5. A proforma issued by accounts tells its salesperson");
  const sent: { type: string; to: string; subject: string; text: string }[] = [];
  setTestPlatformMailer(async (mail) => {
    sent.push({ type: mail.type, to: mail.to, subject: mail.subject, text: mail.text });
  });
  try {
    const pi = await draft(seller, "PROFORMA");
    const issued = await as(accounts, () => documents.issueTradeDocument({ id: pi }));
    const told = await db.notification.findMany({ where: { userId: seller.id, type: "PROFORMA_ISSUED" }, select: { title: true, message: true, link: true } });
    ok(
      "the salesperson is told it's issued, by whom, and that it's ready to send",
      issued.ok && told.length === 1 && told[0]!.message!.includes(`${accounts.name} issued proforma invoice`) && told[0]!.message!.includes("ready to be sent to the client") && told[0]!.link === `/documents/${pi}`,
      issued.ok ? json(told) : issued.error,
    );
    ok(
      "  and by email, through the Alerts mail, to their own address, with a link to it",
      sent.length === 1 && sent[0]!.type === "ALERTS" && sent[0]!.to === seller.email && sent[0]!.subject.startsWith("PI ") && sent[0]!.text.includes(`/documents/${pi}`) && sent[0]!.text.includes(accounts.name),
      json(sent.map((m) => ({ type: m.type, to: m.to, subject: m.subject }))),
    );
    ok("nobody else is told", (await db.notification.count({ where: { type: "PROFORMA_ISSUED", userId: { not: seller.id } } })) === 0);

    const own = await draft(seller, "PROFORMA");
    await as(seller, () => documents.issueTradeDocument({ id: own }));
    ok("a salesperson who issues their own proforma isn't told about it", (await db.notification.count({ where: { userId: seller.id, type: "PROFORMA_ISSUED" } })) === 1 && sent.length === 1);

    await db.notificationPreference.create({ data: { userId: seller.id, type: "PROFORMA_ISSUED", inApp: true, email: false } });
    const quiet = await draft(seller, "PROFORMA");
    await as(accounts, () => documents.issueTradeDocument({ id: quiet }));
    ok("with its email switched off, they're told in the app only", (await db.notification.count({ where: { userId: seller.id, type: "PROFORMA_ISSUED" } })) === 2 && sent.length === 1);

    const invoice = await draft(seller, "INVOICE");
    await as(accounts, () => documents.issueTradeDocument({ id: invoice }));
    ok("an invoice issued by accounts sends no such email", sent.length === 1);
  } finally {
    setTestPlatformMailer(null);
  }

  // ── Sections a role sees ────────────────────────────────────────────────────────────────────

  section("6. A role sees only the sections it hasn't been unticked from");
  await db.role.create({ data: { key: "ZZ_FIELD_AGENT", name: `${TAG} Field agent` } });
  const agent = await person("Agent", "ZZ_FIELD_AGENT");
  ok("a custom role with nothing written sees every section", await can(agent.id, sectionPermission("it_assets")) && (await moduleAccessFor(agent.id, "it_assets")) === "available");
  ok("  but holds no capability", !(await can(agent.id, "assets.manage")));
  await db.rolePermission.createMany({
    data: [
      { role: "SALES", permission: sectionPermission("it_assets"), allowed: false },
      // People is four modules: the whole menu group goes when all four are unticked.
      ...["hr", "visitors", "engagement", "payroll"].map((m) => ({ role: "SALES", permission: sectionPermission(m), allowed: false })),
    ],
  });
  ok("unticked for Sales, IT Assets is no section of a salesperson's", !(await can(seller.id, sectionPermission("it_assets"))) && (await moduleAccessFor(seller.id, "it_assets")) === "no-permission");
  ok("  nor People", (await moduleAccessFor(seller.id, "hr")) === "no-permission");
  ok("  while accounts still see both", (await moduleAccessFor(accounts.id, "it_assets")) === "available" && (await moduleAccessFor(accounts.id, "hr")) === "available");
  ok("an admin sees every section", (await moduleAccessFor(boss.id, "it_assets")) === "available");
  const sellerHolds = await permissionsFor(seller.id);
  const enabled = MODULE_REGISTRY.map((m) => m.key);
  const menu = (holds: string[]) =>
    renderToStaticMarkup(createElement(Sidebar, { enabledKeys: enabled, canViewPerformance: false, permissions: holds, branding: DEFAULT_BRANDING }));
  const sellerMenu = menu(sellerHolds);
  const accountsMenu = menu(await permissionsFor(accounts.id));
  // Sections render folded: their headings are what is there.
  const heading = (html: string, name: string) => html.includes(`>${name}<`);
  ok("the salesperson's menu has no IT Assets section, and no People", !heading(sellerMenu, "IT Assets") && !heading(sellerMenu, "People"));
  ok("  accounts' still has both", heading(accountsMenu, "IT Assets") && heading(accountsMenu, "People"));
  ok("  and the salesperson's keeps what wasn't unticked", heading(sellerMenu, "Sales") && heading(sellerMenu, "Directory"));
  await db.userPermission.create({ data: { userId: seller.id, permission: sectionPermission("it_assets"), allowed: true, grantedById: boss.id, reason: "Covers the asset desk on Fridays" } });
  ok("a person given a section of their own sees it, whatever their role", (await moduleAccessFor(seller.id, "it_assets")) === "available");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
