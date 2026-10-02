/**
 * check:help-content — Help and What's new from Deskzo (owner, 2 Oct 2026): published once in the
 * platform console, kept in the control plane, and shown read-only in every workspace it is for —
 * beside the workspace's own guides and company news, never mixed with them.
 *
 * Without a database: where a link from Deskzo may point (the host allowlist), when a row is live,
 * which workspaces it reaches, and where a person's "seen" line may move (src/lib/platform/help-content.ts).
 *
 * The rest on a scratch control plane and a scratch workspace, each built from its migrations beside
 * the real one and dropped at the end, pass or fail:
 *
 *   · the console's actions (src/actions/platform/console-help.ts) are refused to the signed-out, to a
 *     session that was revoked or whose holder is switched off, to a workspace's own session, and to
 *     support, billing and read-only staff — and nothing is written; making something live or
 *     scheduled for every workspace is the owner's, or an admin's who types "publish"; every link is
 *     held to the host allowlist, with the database's CHECKs behind it;
 *   · what a workspace is shown, through the real actions (src/actions/help.ts) run as that workspace
 *     (`runAsTenant`): live rows only — never a draft, a scheduled row before its time, an archived or
 *     taken-down one, nor a row written past the console with a link off the list — and only those for
 *     a module in its plan and for its country, in the console's order; a change in the console shows
 *     at once; nothing a workspace does edits, hides or deletes Deskzo's;
 *   · never mixed: Deskzo's lists never hold a company row, nor the company's a Deskzo one, and the
 *     rail's Help and Videos panels, What's new and the dashboard's Recent Updates render the two as
 *     groups apart, each under its own heading — only the company's offering to add, and only to a
 *     manager;
 *   · two unread counts, each its own: one source's "seen" moves only its own line; Deskzo's moves to
 *     the newest post shown — never to now, never back, and never on a read that failed or showed
 *     nothing; the rail's What's new button carries a dot per source;
 *   · a control plane that is missing, refuses, or doesn't answer: nothing from Deskzo, said as a
 *     failure, never thrown, and the company's side as it was;
 *   · onboarding finishes with no help added — Deskzo's help being there ticks nothing;
 *   · the console's pages for each role (the item page included), and the audit: ids and titles,
 *     never a link or a body;
 *   · and the real workspace and control plane untouched.
 *
 * No mail leaves (the platform mailer is replaced). No password is typed anywhere: staff are signed in
 * by a session made here, and the workspace's people are named to its actions by a stand-in session.
 *
 *   npm run check:help-content
 *   TZ=UTC npm run check:help-content      (from PowerShell: $env:TZ = "UTC"; npm run check:help-content)
 */
import "dotenv/config";
import Module from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleResult } from "../src/actions/platform/console";
import type { Entitlements } from "../src/lib/entitlements";
import type { Tenant } from "../src/lib/tenancy/state";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

// ─── Output ──────────────────────────────────────────────────────────────────────────────────────
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${String(said).slice(0, 600)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
/** A section on its own: a throw inside one is a failure of that section, and the next still runs. */
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}` : String(err));
  }
}

const TAG = "ZzHC";
const MAIL = "@zzhelpcontent.example";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const why = (r: ConsoleResult<unknown>) => (r.ok ? "accepted" : r.error);
/** What a call threw, as text — or "" when it did not throw. */
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
/** Every console.warn while `work` runs — the loader logs a failed read, and says nothing else. */
async function withWarnings<T>(work: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
  const original = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    return { value: await work(), warned };
  } finally {
    console.warn = original;
  }
}
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
}

// ─── Who is calling: a console request, and a person in a workspace ─────────────────────────────
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:help-content" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const nextHeaders = {
  headers: async () => requestHeaders,
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
};
const navigation = {
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  permanentRedirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const session = {
  requireUser: async () => {
    if (!actor) throw new UnauthorizedError("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => (viewingAs && actor ? { user: actor, actor } : null),
  refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
  UnauthorizedError,
};
const auth = { auth: async () => null, signIn: async () => {}, signOut: async () => {} };
const email = { sendEmailNotification: async () => {} };
const byName = new Map<string, unknown>([
  ["next/headers", nextHeaders],
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["@/lib/auth", auth],
  ["@/lib/email", email],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/auth"), auth],
  [load.resolve("../src/lib/email"), email],
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
} as typeof realLoad;

// ─── Rendering ───────────────────────────────────────────────────────────────────────────────────
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
type Page = (props: never) => Promise<unknown>;
async function render(page: Page, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
const markup = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** One source's group of a rendered panel or feed — `data-source` marks them (rail-help.tsx, recent-updates.tsx). */
const group = (html: string, source: "deskzo" | "company") => html.match(new RegExp(`<section[^>]*data-source="${source}"[\\s\\S]*?</section>`))?.[0] ?? "";
const firstGroup = (html: string) => html.match(/data-source="(deskzo|company)"/)?.[1];
/** A feed heading's "2 new" (React may put a comment between the number and the word). */
const unreadIn = (html: string) => Number(html.match(/>(\d+)(?:<!-- -->)? new<\/span>/)?.[1] ?? 0);
/** The rail's What's new button. */
const newsButton = (html: string) => html.match(/<button[^>]*aria-label="What&#x27;s new[^"]*"[\s\S]*?<\/button>/)?.[0] ?? "";

const entitlements = (modules: string[]): Entitlements => ({ v: 1, all: false, modules, seats: null, copilotTokens: null, customDomains: null, plans: [] });

// ─── The pure rules ──────────────────────────────────────────────────────────────────────────────

function pure(hc: typeof import("../src/lib/platform/help-content")) {
  section("Where a link from Deskzo may point");
  const yes = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://vimeo.com/123456",
    "https://www.loom.com/share/abc",
    "https://loom.com/share/abc",
    "https://deskzo.com/help",
    "https://docs.deskzo.com/a?b=c#d",
    "https://DESKZO.com/x",
    "/orders/new",
    "/settings?tab=tax",
  ];
  const refusedGood = yes.filter((u) => !hc.checkPlatformLink(u).ok);
  ok("accepted: YouTube, Vimeo and Loom (bare and www.), deskzo.com and any name under it, a path in the app", refusedGood.length === 0, refusedGood.join(" "));
  const no: [string, string][] = [
    ["another site", "https://evil.example/guide"],
    ["plain http, even ours", "http://deskzo.com/help"],
    ["a lookalike that ends in another domain", "https://deskzo.com.evil.example/"],
    ["a lookalike that merely contains ours", "https://evildeskzo.com/"],
    ["a lookalike of YouTube", "https://youtube.com.evil.example/watch"],
    ["a YouTube name that is not on the list", "https://m.youtube.com/watch?v=x"],
    ["an allowed host on a port of its own", "https://www.youtube.com:8443/watch"],
    ["a name and password before the host", "https://user:pw@youtube.com/"],
    ["a protocol-relative address", "//evil.example/x"],
    ["a backslash path, which a browser reads as //", `/${BACKSLASH}evil.example`],
    ["a tab in a path, which a browser drops", `/${TAB}/evil.example`],
    ["a line break in a path", `/a${NEWLINE}b`],
    ["a space", "/orders new"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["a path without its slash", "orders/new"],
    ["nothing at all", "   "],
    ["more than 2,000 characters", `https://deskzo.com/${"a".repeat(2000)}`],
  ];
  for (const [label, url] of no) ok(`refused: ${label}`, !hc.checkPlatformLink(url).ok, hc.checkPlatformLink(url));
  ok("refused: something that isn't text", !hc.checkPlatformLink(42).ok && !hc.checkPlatformLink(null).ok);
  const written = hc.checkPlatformLink("https://deskzo.com");
  const inApp = hc.checkPlatformLink("/orders/new");
  ok(
    "an address comes back written out as it is stored (and external); a path as it is, in the app",
    written.ok && written.url === "https://deskzo.com/" && written.external && inApp.ok && inApp.url === "/orders/new" && !inApp.external,
    { written, inApp },
  );

  section("When a row is live, and whom it reaches");
  const now = new Date("2026-10-02T06:00:00.000Z");
  const ago = new Date(now.getTime() - 1000);
  const ahead = new Date(now.getTime() + 1000);
  ok(
    "no publish time: a draft; a time ahead: scheduled; a time past: live; archived whatever else it has",
    hc.publicationState({ publishedAt: null, archivedAt: null }, now) === "draft" &&
      hc.publicationState({ publishedAt: ahead, archivedAt: null }, now) === "scheduled" &&
      hc.publicationState({ publishedAt: ago, archivedAt: null }, now) === "live" &&
      hc.publicationState({ publishedAt: ago, archivedAt: ago }, now) === "archived" &&
      hc.publicationState({ publishedAt: null, archivedAt: ago }, now) === "archived",
  );
  ok("  live from its very moment, not a millisecond before", hc.isLive({ publishedAt: now, archivedAt: null }, now) && !hc.isLive({ publishedAt: now, archivedAt: null }, new Date(now.getTime() - 1)));
  const hrIndia = { country: "IN", entitlements: entitlements(["hr", "payroll"]) };
  const hrUs = { country: "US", entitlements: entitlements(["hr", "payroll"]) };
  const coreIndia = { country: "IN", entitlements: entitlements([]) };
  ok("no modules and no countries: every workspace", hc.reachesWorkspace({ modules: [], countries: [] }, coreIndia) && hc.reachesWorkspace({ modules: null, countries: null }, hrUs));
  ok("a country named: that country's workspaces, whatever case the workspace's is in", hc.reachesWorkspace({ countries: ["IN"] }, hrIndia) && hc.reachesWorkspace({ countries: ["IN"] }, { ...hrIndia, country: "in" }) && !hc.reachesWorkspace({ countries: ["IN"] }, hrUs));
  ok("a module named: a workspace with any one of them in its plan, and no other", hc.reachesWorkspace({ modules: ["helpdesk", "hr"] }, hrIndia) && !hc.reachesWorkspace({ modules: ["hr"] }, coreIndia));
  ok("  a module sold only in India (payroll) reaches no workspace elsewhere, whatever its plan says", hc.reachesWorkspace({ modules: ["payroll"] }, hrIndia) && !hc.reachesWorkspace({ modules: ["payroll"] }, hrUs));
  ok("  a key the registry doesn't know reaches nobody; a core one everybody", !hc.reachesWorkspace({ modules: ["nope"] }, hrIndia) && hc.reachesWorkspace({ modules: ["companies"] }, coreIndia));
  ok("  a module and a country both named: both must hold", !hc.reachesWorkspace({ modules: ["hr"], countries: ["US"] }, hrIndia) && hc.reachesWorkspace({ modules: ["hr"], countries: ["US"] }, hrUs));

  section("Where the 'seen' line for Deskzo's What's new may move");
  const shown = [{ publishedAt: new Date(now.getTime() - 3 * MIN) }, { publishedAt: new Date(now.getTime() - MIN) }, { publishedAt: new Date(now.getTime() - 2 * MIN) }];
  const posts = shown.map((p, i) => ({ id: `p${i}`, title: "t", body: "b", linkUrl: null, external: false, pinned: false, ...p }));
  ok("a read that failed moves it nowhere", hc.deskzoSeenThrough({ ok: false, updates: posts }, null) === null);
  ok("  nor one that showed nothing", hc.deskzoSeenThrough({ ok: true, updates: [] }, null) === null);
  ok("to the newest post shown — never to now", hc.deskzoSeenThrough({ ok: true, updates: posts }, null)?.getTime() === now.getTime() - MIN);
  ok("  forward from an older line; never back from a newer one", hc.deskzoSeenThrough({ ok: true, updates: posts }, new Date(now.getTime() - 10 * MIN))?.getTime() === now.getTime() - MIN && hc.deskzoSeenThrough({ ok: true, updates: posts }, now) === null);
}

// ─── The real databases, read only ───────────────────────────────────────────────────────────────

/** What the suite must never change in the real workspace and control plane. Read-only. */
async function snapshot(realUrl: string, realControlUrl: string | null) {
  const ws = directClient(realUrl, { max: 1 });
  let workspace: string;
  let wsTagged: number;
  try {
    const [helpLinks, posts, users, deskzoSeen, lines, tagged] = await Promise.all([
      ws.helpLink.count(),
      ws.announcement.count(),
      ws.user.count(),
      ws.user.count({ where: { deskzoUpdatesSeenAt: { not: null } } }),
      ws.user.aggregate({ _max: { deskzoUpdatesSeenAt: true, updatesSeenAt: true, onboardingCompletedAt: true } }),
      Promise.all([
        ws.helpLink.count({ where: { title: { startsWith: TAG } } }),
        ws.announcement.count({ where: { title: { startsWith: TAG } } }),
        ws.user.count({ where: { email: { endsWith: MAIL } } }),
      ]),
    ]);
    workspace = JSON.stringify({ helpLinks, posts, users, deskzoSeen, lines: lines._max });
    wsTagged = tagged.reduce((a, b) => a + b, 0);
  } finally {
    await ws.$disconnect();
  }
  if (!realControlUrl) return { workspace, control: "(no control plane configured)", tagged: wsTagged };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: ControlClient } = require("@deskzo/control-client") as typeof import("@deskzo/control-client");
  const control = new ControlClient({ datasourceUrl: realControlUrl });
  try {
    const [links, updates, audit, staff, sessions, tenants, tagged] = await Promise.all([
      control.platformHelpLink.count(),
      control.platformUpdate.count(),
      control.platformAuditLog.count({ where: { action: { startsWith: "help." } } }),
      control.platformUser.count(),
      control.platformSession.count(),
      control.tenant.count(),
      Promise.all([
        control.platformHelpLink.count({ where: { title: { startsWith: TAG } } }),
        control.platformUpdate.count({ where: { title: { startsWith: TAG } } }),
        control.platformUser.count({ where: { email: { endsWith: MAIL } } }),
        control.tenant.count({ where: { slug: { startsWith: "zzhc-" } } }),
      ]),
    ]);
    return { workspace, control: JSON.stringify({ links, updates, audit, staff, sessions, tenants }), tagged: wsTagged + tagged.reduce((a, b) => a + b, 0) };
  } finally {
    await control.$disconnect();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realControlUrl = process.env.CONTROL_DATABASE_URL?.trim() || null;
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);

  /* eslint-disable @typescript-eslint/no-require-imports */
  pure(require("../src/lib/platform/help-content") as typeof import("../src/lib/platform/help-content"));
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Scratch databases");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database server is a local one, so scratch databases may be made beside the real ones", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_helpcontent`;
  const controlName = `${realName}_helpcontent_control`;
  const realControlName = realControlUrl ? new URL(realControlUrl).pathname.slice(1) : null;
  ok("  neither is the real workspace or the real control plane", ![realName, realControlName].includes(scratchName) && ![realName, realControlName].includes(controlName));
  const scratchUrl = withDatabase(realUrl, scratchName);
  const controlUrl = withDatabase(realUrl, controlName);

  const realBefore = await snapshot(realUrl, realControlUrl);

  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    for (const name of [scratchName, controlName]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    const started = Date.now();
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("a control plane and a workspace, each built from its migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);

    // From here on anything reaching for the environment's databases lands in the scratch ones.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = controlUrl;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    /* eslint-enable @typescript-eslint/no-require-imports */
    mailer.setTestPlatformMailer(async () => {});
    closeAll = async () => {
      mailer.setTestPlatformMailer(null);
      await db.$disconnect().catch(() => {});
      await closeControlDb();
    };
    await run({ scratchUrl, controlUrl, controlName, at: (name: string) => withDatabase(realUrl, name) });
  } finally {
    await closeAll?.().catch(() => {});
    for (const name of [scratchName, controlName]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname in ('${scratchName}', '${controlName}')`);
    ok("both scratch databases are dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  section("The real workspace and control plane were not touched");
  const realAfter = await snapshot(realUrl, realControlUrl);
  ok("the workspace's guides, news, people and their 'seen' lines are as they were", realAfter.workspace === realBefore.workspace, `${realBefore.workspace} → ${realAfter.workspace}`);
  ok("  the control plane's help, What's new, help audit, staff, sessions and workspaces too", realAfter.control === realBefore.control, `${realBefore.control} → ${realAfter.control}`);
  ok("  and nothing of this suite's is in either", realAfter.tagged === 0 && realBefore.tagged === 0, realAfter.tagged);

  console.log(failures === 0 ? `\nAll ${passes} help-content checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ─── The suite ───────────────────────────────────────────────────────────────────────────────────

async function run(ctx: { scratchUrl: string; controlUrl: string; controlName: string; at: (name: string) => string }) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { newKeyBundle, sealKeyBundle } = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
  const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
  const hc = require("../src/lib/platform/help-content") as typeof import("../src/lib/platform/help-content");
  const { istDateKey } = require("../src/lib/india-time") as typeof import("../src/lib/india-time");
  const A = require("../src/actions/platform/console-help") as typeof import("../src/actions/platform/console-help");
  const help = require("../src/actions/help") as typeof import("../src/actions/help");
  const onb = require("../src/actions/onboarding") as typeof import("../src/actions/onboarding");
  const { gettingStartedFor } = require("../src/lib/help/onboarding-facts") as typeof import("../src/lib/help/onboarding-facts");
  const rail = require("../src/components/layout/rail-help") as typeof import("../src/components/layout/rail-help");
  const shared = require("../src/components/console/help-content/shared") as typeof import("../src/components/console/help-content/shared");
  const labels = require("../src/lib/console-shared/labels") as typeof import("../src/lib/console-shared/labels");
  const { RecentUpdates } = require("../src/components/help/recent-updates") as typeof import("../src/components/help/recent-updates");
  const { SideRail } = require("../src/components/layout/side-rail") as typeof import("../src/components/layout/side-rail");
  const Dashboard = (require("../src/app/(dashboard)/dashboard/page") as { default: Page }).default;
  const consolePage = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const pages = { list: consolePage("help-content/page"), create: consolePage("help-content/new/page"), item: consolePage("help-content/[id]/page") };
  const control = controlDb();

  // ─── Staff, their sessions, and the workspaces ────────────────────────────────────────────────
  const addStaff = async (key: string, role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY") =>
    (await staffLib.createStaff({ email: `${key}${MAIL}`, name: `${TAG} ${key}`, role }, "script:check-help-content")).id;
  const staff = {
    owner: await addStaff("owner", "OWNER"),
    admin: await addStaff("admin", "ADMIN"),
    support: await addStaff("support", "SUPPORT"),
    billing: await addStaff("billing", "BILLING"),
    readonly: await addStaff("readonly", "READONLY"),
    gone: await addStaff("gone", "ADMIN"),
  };
  /** Signed in to the console as this staff member, second factor passed. Returns the session's id. */
  const actAs = async (userId: string) => {
    const token = randomBytes(32).toString("base64url");
    const id = sha256(token);
    await control.platformSession.create({ data: { id, userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:help-content" } });
    jar.clear();
    jar.set(COOKIE, token);
    return id;
  };

  /** A workspace on the scratch control plane, and the registry's record of it — pointing at the scratch workspace database. */
  const workspace = async (slug: string, country: string, modules: string[], status: "ACTIVE" | "SUSPENDED" = "ACTIVE"): Promise<Tenant> => {
    const id = randomUUID();
    const keyBundleCipher = sealKeyBundle(id, newKeyBundle());
    await control.tenant.create({ data: { id, slug, name: slug, status, keyBundleCipher, country, currency: "INR", ownerEmail: `owner@${slug}.example`, entitlements: entitlements(modules) } });
    return {
      id,
      slug,
      name: slug,
      status,
      dbUrl: ctx.scratchUrl,
      primaryHost: `${slug}.localhost`,
      hosts: [`${slug}.localhost`],
      source: "control",
      isDefault: false,
      keyBundleCipher,
      country,
      entitlements: entitlements(modules),
      holdReason: null,
    };
  };
  const inHr = await workspace("zzhc-in-hr", "IN", ["hr", "payroll"]);
  const usHr = await workspace("zzhc-us-hr", "US", ["hr", "payroll"]);
  const inCore = await workspace("zzhc-in-core", "IN", []);
  await workspace("zzhc-held", "IN", ["hr"], "SUSPENDED");
  /** A workspace from the environment — the installation before workspaces. Deskzo's content is the control plane's. */
  const fromEnv: Tenant = { ...inHr, id: randomUUID(), slug: "zzhc-env", source: "env", keyBundleCipher: null };

  type Person = { id: string; name: string; email: string; role: string };
  const as = (p: Person) => {
    actor = { id: p.id, name: p.name, email: p.email, role: p.role };
  };
  /** Work as this workspace: every query `db` makes inside lands in its database. */
  const inWs = <T,>(t: Tenant, work: () => Promise<T>) => runAsTenant(t, work);
  const people = await inWs(inHr, async () => {
    const person = (key: string, data: Record<string, unknown> = {}) =>
      db.user.create({
        data: { name: `${TAG} ${key}`, email: `zzhc-${key.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), ...data },
        select: { id: true, name: true, email: true, role: true },
      });
    return {
      owner: await person("Owner", { role: "ADMIN", isSuperAdmin: true }),
      manager: await person("Manager", { permissionGrants: { create: [{ permission: "help.manage", allowed: true, reason: TAG }] } }),
      // Joined a day ago, so every post below is news to them.
      reader: await person("Reader", { createdAt: new Date(Date.now() - DAY) }),
    };
  });
  const lineOf = () => inWs(inHr, async () => db.user.findUniqueOrThrow({ where: { id: people.reader.id }, select: { deskzoUpdatesSeenAt: true, updatesSeenAt: true } }));

  // ─── The gate ─────────────────────────────────────────────────────────────────────────────────
  await part("The console's actions: staff only, and only owners and admins", async () => {
    const tryAll = async () => [
      await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} gate article`, url: "/orders/new", publish: "now", confirm: "publish" }),
      await A.consoleSaveHelpPost({ title: `${TAG} gate post`, body: "Everybody, now.", publish: "now", confirm: "publish" }),
      await A.consolePublishHelpItem("link", "zzhcnothing", { confirm: "publish" }),
      await A.consoleUnpublishHelpItem("post", "zzhcnothing"),
      await A.consoleArchiveHelpItem("link", "zzhcnothing"),
      await A.consoleRestoreHelpItem("post", "zzhcnothing"),
      await A.consoleReorderHelpLinks("ARTICLE", []),
      await A.consoleHelpReach([], []),
    ];
    const allRefused = (rs: ConsoleResult<unknown>[], pattern: RegExp) => rs.every((r) => !r.ok && pattern.test(r.error));

    jar.clear();
    const signedOut = await tryAll();
    ok("signed out: every action is refused", allRefused(signedOut, /Sign in to the console/), signedOut.map(why));
    jar.set(COOKIE, randomBytes(32).toString("base64url"));
    ok("  a token the console never issued: the same", allRefused(await tryAll(), /Sign in to the console/));
    jar.clear();
    jar.set("authjs.session-token", randomBytes(32).toString("base64url"));
    jar.set("__Secure-authjs.session-token", randomBytes(32).toString("base64url"));
    ok("  a workspace's own session means nothing to the console", allRefused(await tryAll(), /Sign in to the console/));
    const revoked = await actAs(staff.admin);
    await control.platformSession.update({ where: { id: revoked }, data: { revokedAt: new Date() } });
    ok("  an admin's session, revoked: refused", allRefused(await tryAll(), /Sign in to the console/));
    await actAs(staff.gone);
    await control.platformUser.update({ where: { id: staff.gone }, data: { active: false } });
    ok("  an admin who has been switched off: refused", allRefused(await tryAll(), /Sign in to the console/));
    for (const [role, id] of [["support", staff.support], ["billing", staff.billing], ["read-only", staff.readonly]] as const) {
      await actAs(id);
      const rs = await tryAll();
      ok(`${role} staff: every action is refused — their role cannot`, allRefused(rs, /role cannot/), rs.map(why));
    }
    ok(
      "nothing refused was written, and nothing audited",
      (await control.platformHelpLink.count()) === 0 && (await control.platformUpdate.count()) === 0 && (await control.platformAuditLog.count({ where: { action: { startsWith: "help." } } })) === 0,
    );
  });

  // ─── Every workspace at once ──────────────────────────────────────────────────────────────────
  await part("Every workspace at once: the owner's, or an admin's with publish typed", async () => {
    const accepted: { item: "link" | "post"; id: string }[] = [];
    const keep = (item: "link" | "post", r: ConsoleResult<{ id: string; state: string }>) => {
      if (r.ok) accepted.push({ item, id: r.data.id });
      return r;
    };
    const typeIt = /type publish to confirm/;
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    await actAs(staff.admin);
    const draft = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule draft`, url: "/orders/new" }));
    ok("an admin saves a draft for every workspace without typing anything — a draft reaches nobody", draft.ok && draft.data.state === "draft", why(draft));
    const plain = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule live`, url: "https://deskzo.com/help/a", publish: "now" }));
    ok("an admin publishing one to every workspace without typing publish is refused, and told why", !plain.ok && typeIt.test(plain.error), why(plain));
    const wrong = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule live`, url: "https://deskzo.com/help/a", publish: "now", confirm: "Publish!" }));
    ok("  with the wrong word too", !wrong.ok && typeIt.test(wrong.error), why(wrong));
    const typed = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule live`, url: "https://deskzo.com/help/a", publish: "now", confirm: " publish " }));
    ok("  with publish typed, it goes live", typed.ok && typed.data.state === "live", why(typed));
    const schedPlain = keep("link", await A.consoleSaveHelpLink({ kind: "VIDEO", title: `${TAG} rule scheduled`, url: "https://youtu.be/dQw4w9WgXcQ", publish: "at", publishAt: tomorrow }));
    ok("scheduling one for every workspace needs it too", !schedPlain.ok && typeIt.test(schedPlain.error), why(schedPlain));
    const schedTyped = keep("link", await A.consoleSaveHelpLink({ kind: "VIDEO", title: `${TAG} rule scheduled`, url: "https://youtu.be/dQw4w9WgXcQ", publish: "at", publishAt: tomorrow, confirm: "publish" }));
    ok("  and with it, it is scheduled", schedTyped.ok && schedTyped.data.state === "scheduled", why(schedTyped));
    const byModule = keep("link", await A.consoleSaveHelpLink({ kind: "VIDEO", title: `${TAG} rule HR video`, url: "https://vimeo.com/123456", modules: ["hr"], publish: "now" }));
    const byCountry = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule India article`, url: "/settings", countries: ["in"], publish: "now" }));
    const storedCountry = byCountry.ok ? await control.platformHelpLink.findUnique({ where: { id: byCountry.data.id }, select: { countries: true } }) : null;
    ok("narrowed to a module, or to a country, an admin publishes without typing", byModule.ok && byCountry.ok, `${why(byModule)} / ${why(byCountry)}`);
    ok("  the country stored as its code, upper case", storedCountry?.countries.join() === "IN", storedCountry);
    // A module every plan has narrows nothing: "Workspace" — every product's plan comes with it, and One has
    // every module — would put it in nearly every workspace without the typed "publish".
    const everyPlan: string[] = [];
    for (const key of ["workspace", "notifications", "tasks"]) {
      const r = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule base module`, url: "/workspace", modules: [key], publish: "now" }));
      if (r.ok || !/narrows nothing/.test(r.error)) everyPlan.push(`${key}: ${why(r)}`);
    }
    const besidePayroll = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule base module post`, body: "x", modules: ["payroll", "workspace"], publish: "now" }));
    ok("a module every plan has (Workspace, Notifications, Tasks) is refused as a target — alone or beside another", everyPlan.length === 0 && !besidePayroll.ok, [...everyPlan, why(besidePayroll)]);
    ok("  and the editor never offers one", ["workspace", "notifications", "tasks"].every((k) => !shared.TARGET_MODULES.some((m) => m.key === k) && !shared.TARGET_PRODUCTS.some((p) => p.modules.includes(k))));
    const uk = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule UK`, url: "/settings", countries: ["UK"], publish: "now" }));
    ok("a two-letter code that is no country's (UK — the United Kingdom is GB) is refused, not saved to reach nobody", !uk.ok && /isn't a country/.test(uk.error), why(uk));
    const gb = keep("link", await A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} rule GB`, url: "/settings", countries: ["gb"], publish: "now" }));
    ok("  GB is", gb.ok, why(gb));
    const postPlain = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule post`, body: "For everybody.", publish: "now" }));
    ok("a What's new post for every workspace: the same rule", !postPlain.ok && typeIt.test(postPlain.error), why(postPlain));
    const postTyped = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule post`, body: "For everybody.", publish: "now", confirm: "publish" }));
    ok("  typed, it is live", postTyped.ok && postTyped.data.state === "live", why(postTyped));
    if (draft.ok) {
      const verbPlain = await A.consolePublishHelpItem("link", draft.data.id);
      ok("publishing a draft for every workspace from its menu: refused to an admin without publish typed", !verbPlain.ok && typeIt.test(verbPlain.error), why(verbPlain));
      const verbTyped = await A.consolePublishHelpItem("link", draft.data.id, { confirm: "publish" });
      ok("  and live with it", verbTyped.ok && verbTyped.data.state === "live", why(verbTyped));
    }
    if (typed.ok) {
      const before = await control.platformHelpLink.findUniqueOrThrow({ where: { id: typed.data.id }, select: { publishedAt: true } });
      const editPlain = await A.consoleSaveHelpLink({ id: typed.data.id, title: `${TAG} rule live, fixed`, url: "https://deskzo.com/help/a" });
      ok("an admin's edit that keeps one live everywhere needs publish typed too", !editPlain.ok && typeIt.test(editPlain.error), why(editPlain));
      const editTyped = await A.consoleSaveHelpLink({ id: typed.data.id, title: `${TAG} rule live, fixed`, url: "https://deskzo.com/help/a", publish: "now", confirm: "publish" });
      const after = await control.platformHelpLink.findUniqueOrThrow({ where: { id: typed.data.id }, select: { publishedAt: true, title: true } });
      ok("  typed, saved — and 'now' on one already live keeps the moment it went live, so it isn't news again", editTyped.ok && after.title.endsWith("fixed") && after.publishedAt?.getTime() === before.publishedAt?.getTime(), why(editTyped));
    }
    await actAs(staff.owner);
    const ownerLink = keep("link", await A.consoleSaveHelpLink({ kind: "VIDEO", title: `${TAG} rule owner video`, url: "https://www.loom.com/share/abc", publish: "now" }));
    const ownerPost = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule owner post`, body: "From the owner.", publish: "now" }));
    const ownerSched = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule owner scheduled`, body: "Later.", publish: "at", publishAt: tomorrow }));
    ok("the owner publishes and schedules for every workspace without typing anything", ownerLink.ok && ownerPost.ok && ownerSched.ok && ownerSched.data.state === "scheduled", [ownerLink, ownerPost, ownerSched].map(why));
    // The editor's datetime-local value is India's wall clock, wherever the server runs (run this under TZ=UTC too).
    const dayKey = istDateKey(new Date(Date.now() + 2 * DAY));
    const local = keep("post", await A.consoleSaveHelpPost({ title: `${TAG} rule India time`, body: "At half past nine.", modules: ["hr"], publish: "at", publishAt: `${dayKey}T09:30` }));
    const localRow = local.ok ? await control.platformUpdate.findUnique({ where: { id: local.data.id }, select: { publishedAt: true } }) : null;
    ok("a time from the editor is India time: 09:30 there is 04:00 UTC, whatever this machine's zone", localRow?.publishedAt?.toISOString() === `${dayKey}T04:00:00.000Z`, localRow?.publishedAt?.toISOString() ?? why(local));
    const ruleRows = (await control.platformHelpLink.count({ where: { title: { startsWith: `${TAG} rule` } } })) + (await control.platformUpdate.count({ where: { title: { startsWith: `${TAG} rule` } } }));
    ok("nothing refused was written: only what was accepted is there", ruleRows === accepted.length, `${ruleRows} rows, ${accepted.length} accepted`);
    // Filed away, so the workspaces below are shown only the fixture made for them.
    const archived = await Promise.all(accepted.map((a) => A.consoleArchiveHelpItem(a.item, a.id)));
    ok("  the owner archives them all", archived.every((r) => r.ok), archived.map(why));
  });

  // ─── Links ────────────────────────────────────────────────────────────────────────────────────
  await part("Every link from Deskzo is held to the allowlist — by the console, and by the database", async () => {
    await actAs(staff.admin);
    const linkCase = (url: string) => A.consoleSaveHelpLink({ kind: "ARTICLE", title: `${TAG} link case`, url, modules: ["hr"] });
    const refused: string[] = [];
    for (const bad of ["https://evil.example/", "http://deskzo.com/", "https://deskzo.com.evil.example/", "https://m.youtube.com/watch?v=x", "https://youtube.com:8443/x", "//evil.example", `/${BACKSLASH}evil.example`, `/${TAB}/evil.example`, "javascript:alert(1)", "/a b", "orders/new", ""]) {
      const r = await linkCase(bad);
      if (r.ok) refused.push(bad);
    }
    ok("an article's link off the list, or not a link, is refused on save", refused.length === 0, refused);
    const postLink = await A.consoleSaveHelpPost({ title: `${TAG} link case post`, body: "Read more.", linkUrl: "https://evil.example/notes", modules: ["hr"] });
    ok("  as is a post's read-more", !postLink.ok, why(postLink));
    const good = await linkCase("https://deskzo.com");
    const goodRow = good.ok ? await control.platformHelpLink.findUnique({ where: { id: good.data.id }, select: { url: true } }) : null;
    ok("one on the list is saved, written out as the workspace will open it", good.ok && goodRow?.url === "https://deskzo.com/", why(good));
    ok("  and nothing refused was stored", (await control.platformHelpLink.count({ where: { title: `${TAG} link case` } })) === 1 && (await control.platformUpdate.count({ where: { title: `${TAG} link case post` } })) === 0);
    if (good.ok) await A.consoleArchiveHelpItem("link", good.data.id);

    // Behind the console, the database refuses what no workspace may ever be sent to.
    const base = { kind: "ARTICLE" as const, title: `${TAG} db probe`, createdById: staff.owner, updatedById: staff.owner };
    const refusedByDb = async (work: () => Promise<unknown>) => /check constraint|23514/i.test(await thrown(work));
    const dbCases: [string, () => Promise<unknown>][] = [
      ["javascript:", () => control.platformHelpLink.create({ data: { ...base, url: "javascript:alert(1)" } })],
      ["plain http", () => control.platformHelpLink.create({ data: { ...base, url: "http://deskzo.com/" } })],
      ["protocol-relative", () => control.platformHelpLink.create({ data: { ...base, url: "//evil.example/x" } })],
      ["a tab in a path", () => control.platformHelpLink.create({ data: { ...base, url: `/${TAB}/evil.example` } })],
      ["a two-letter title", () => control.platformHelpLink.create({ data: { ...base, title: "Zz", url: "/x" } })],
      ["a post's http read-more", () => control.platformUpdate.create({ data: { title: `${TAG} db probe`, body: "x", linkUrl: "http://evil.example/", createdById: staff.owner, updatedById: staff.owner } })],
      ["a lower-case country", () => control.platformUpdate.create({ data: { title: `${TAG} db probe`, body: "x", countries: ["in"], createdById: staff.owner, updatedById: staff.owner } })],
    ];
    const notRefused: string[] = [];
    for (const [label, work] of dbCases) if (!(await refusedByDb(work))) notRefused.push(label);
    ok("the database's own CHECKs refuse javascript:, http, //, a tab in a path, a too-short title, a bad read-more and a bad country", notRefused.length === 0, notRefused);
    ok("  and kept none of them", (await control.platformHelpLink.count({ where: { title: `${TAG} db probe` } })) + (await control.platformUpdate.count({ where: { title: `${TAG} db probe` } })) === 0);
  });

  // ─── The fixture ──────────────────────────────────────────────────────────────────────────────
  section("Deskzo's help, videos and What's new, published from the console");
  await actAs(staff.owner);
  const made = async (r: Promise<ConsoleResult<{ id: string; state: string }>>) => {
    const res = await r;
    if (!res.ok) throw new Error(`the fixture was refused: ${res.error}`);
    return res.data.id;
  };
  const link = (o: Parameters<typeof A.consoleSaveHelpLink>[0]) => made(A.consoleSaveHelpLink(o));
  const post = (o: Parameters<typeof A.consoleSaveHelpPost>[0]) => made(A.consoleSaveHelpPost(o));
  const soon = new Date(Date.now() + 30 * MIN).toISOString();
  const L = {
    all: await link({ kind: "ARTICLE", title: `${TAG} Dz article for everybody`, url: "/orders/new", description: "Punching an order, step by step", publish: "now" }),
    hr: await link({ kind: "ARTICLE", title: `${TAG} Dz article for HR`, url: "https://deskzo.com/help/hr", modules: ["hr"], publish: "now" }),
    india: await link({ kind: "ARTICLE", title: `${TAG} Dz article for India`, url: "https://docs.deskzo.com/gst", countries: ["IN"], publish: "now" }),
    us: await link({ kind: "ARTICLE", title: `${TAG} Dz article for the US`, url: "https://docs.deskzo.com/sales-tax", countries: ["US"], publish: "now" }),
    payroll: await link({ kind: "ARTICLE", title: `${TAG} Dz article for payroll`, url: "/payroll", modules: ["payroll"], publish: "now" }),
    draft: await link({ kind: "ARTICLE", title: `${TAG} Dz article still a draft`, url: "/dashboard" }),
    soon: await link({ kind: "ARTICLE", title: `${TAG} Dz article scheduled`, url: "/renewals", publish: "at", publishAt: soon }),
    archived: await link({ kind: "ARTICLE", title: `${TAG} Dz article archived`, url: "/orders", publish: "now" }),
    down: await link({ kind: "ARTICLE", title: `${TAG} Dz article taken down`, url: "/companies", publish: "now" }),
    video: await link({ kind: "VIDEO", title: `${TAG} Dz video for everybody`, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", publish: "now" }),
    videoHr: await link({ kind: "VIDEO", title: `${TAG} Dz video for HR`, url: "https://www.loom.com/share/zzhc", modules: ["hr"], publish: "now" }),
  };
  await A.consoleArchiveHelpItem("link", L.archived);
  await A.consoleUnpublishHelpItem("link", L.down);
  const P = {
    pinned: await post({ title: `${TAG} Dz post pinned`, body: "Read this first.", pinned: true, linkUrl: "https://deskzo.com/notes/1", publish: "now" }),
    older: await post({ title: `${TAG} Dz post older`, body: "An older release.", linkUrl: "/renewals", publish: "now" }),
    hr: await post({ title: `${TAG} Dz post for HR`, body: "Leave requests, faster.", modules: ["hr"], publish: "now" }),
    us: await post({ title: `${TAG} Dz post for the US`, body: "Sales tax.", countries: ["US"], publish: "now" }),
    draft: await post({ title: `${TAG} Dz post still a draft`, body: "Not yet." }),
    soon: await post({ title: `${TAG} Dz post scheduled`, body: "In half an hour.", publish: "at", publishAt: soon }),
    archived: await post({ title: `${TAG} Dz post archived`, body: "Filed away.", publish: "now" }),
  };
  await A.consoleArchiveHelpItem("post", P.archived);
  // Written past the console: the database takes any https address — the workspace's read must not.
  const offList = (
    await control.platformHelpLink.create({
      data: { kind: "ARTICLE", title: `${TAG} Dz article off the list`, url: "https://evil.example/guide", sortOrder: 9000, publishedAt: new Date(Date.now() - HOUR), createdById: staff.owner, updatedById: staff.owner },
      select: { id: true },
    })
  ).id;
  const offListPost = (
    await control.platformUpdate.create({
      data: { title: `${TAG} Dz post with an off-list link`, body: "Kept, its link dropped.", linkUrl: "https://evil.example/notes", createdById: staff.owner, updatedById: staff.owner },
      select: { id: true },
    })
  ).id;
  // Distinct times, so "newest first" and "seen up to" are exact: all after the reader joined.
  const postAt = { pinned: Date.now() - 60 * MIN, offList: Date.now() - 50 * MIN, older: Date.now() - 40 * MIN, hr: Date.now() - 30 * MIN, us: Date.now() - 20 * MIN };
  await control.platformUpdate.update({ where: { id: P.pinned }, data: { publishedAt: new Date(postAt.pinned) } });
  await control.platformUpdate.update({ where: { id: offListPost }, data: { publishedAt: new Date(postAt.offList) } });
  await control.platformUpdate.update({ where: { id: P.older }, data: { publishedAt: new Date(postAt.older) } });
  await control.platformUpdate.update({ where: { id: P.hr }, data: { publishedAt: new Date(postAt.hr) } });
  await control.platformUpdate.update({ where: { id: P.us }, data: { publishedAt: new Date(postAt.us) } });
  // Changed outside the console, so this process's minute-long copy is dropped by hand, as a save would.
  hc.forgetHelpContent();
  ok("the owner publishes articles, videos and posts for everybody, for modules and for countries; drafts, scheduled, archived and taken down besides", true);

  // ─── Onboarding ───────────────────────────────────────────────────────────────────────────────
  await part("Onboarding finishes with no help added — Deskzo's help being there ticks nothing", async () => {
    await inWs(inHr, async () => {
      as(people.reader);
      const deskzoHelp = await help.deskzoHelpLinks("ARTICLE");
      as(people.owner);
      const before = await gettingStartedFor(people.owner.id);
      const step = before.steps.find((s) => s.key === "helpline");
      ok(
        "Deskzo's help is live here, yet the help step is not done by it: the company's own guides, optional, never required",
        deskzoHelp.links.length > 0 && !!step && !step.done && !step.required && step.skippable && step.title === "Add your company's own guides",
        JSON.stringify({ deskzo: deskzoHelp.links.length, step }),
      );
      await db.user.update({ where: { id: people.owner.id }, data: { twoFactorEnabledAt: new Date() } });
      const profile = await onb.saveCompanyProfile({ legalName: `${TAG} Traders Private Limited`, gstin: "", addressLine1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" });
      ok("the owner sets the company profile; two-factor is on", profile.ok, JSON.stringify(profile));
      const early = await onb.completeOnboarding();
      ok("  with the optional steps still open, finishing is refused", !early.ok, JSON.stringify(early));
      const open = (await gettingStartedFor(people.owner.id)).steps.filter((s) => !s.finished);
      // One at a time: the company's skips are one list on one row, read and written back.
      const skips = [];
      for (const s of open) skips.push(await onb.skipStep(s.key));
      ok("every step left is optional, and skipped — the help step among them", open.some((s) => s.key === "helpline") && open.every((s) => s.skippable) && skips.every((r) => r.ok), JSON.stringify(open.map((s) => s.key)));
      const done = await onb.completeOnboarding();
      const me = await db.user.findUniqueOrThrow({ where: { id: people.owner.id }, select: { onboardingCompletedAt: true } });
      ok("onboarding is finished", done.ok && !!me.onboardingCompletedAt, JSON.stringify(done));
      ok("  with no guide of the company's own and no company news — none was needed", (await db.helpLink.count()) === 0 && (await db.announcement.count()) === 0);
      const helpStep = (await gettingStartedFor(people.owner.id)).steps.find((s) => s.key === "helpline");
      ok("  the help step counted as skipped, not as done", !!helpStep?.skipped && helpStep.finished && !helpStep.done, JSON.stringify(helpStep));
    });
  });

  // ─── What each workspace is shown ─────────────────────────────────────────────────────────────
  type Seen = { articles: string[]; videos: string[]; feed: string[]; ok: boolean };
  const seenBy = (t: Tenant): Promise<Seen> =>
    inWs(t, async () => {
      as(people.reader);
      const [articles, videos, feed] = [await help.deskzoHelpLinks("ARTICLE"), await help.deskzoHelpLinks("VIDEO"), await help.deskzoUpdates()];
      return { articles: articles.links.map((l) => l.id), videos: videos.links.map((l) => l.id), feed: feed.posts.map((p) => p.id), ok: articles.ok && videos.ok && feed.ok };
    });
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const nameOf = new Map<string, string>([...Object.entries(L).map(([k, v]) => [v, `article:${k}`] as const), ...Object.entries(P).map(([k, v]) => [v, `post:${k}`] as const), [offList, "article:offList"], [offListPost, "post:offList"]]);
  const named = (ids: string[]) => ids.map((id) => nameOf.get(id) ?? id).join(", ");

  await part("What each workspace is shown: live, for its plan and its country, in the console's order", async () => {
    const india = await seenBy(inHr);
    const us = await seenBy(usHr);
    const core = await seenBy(inCore);
    ok(
      "India with HR and payroll: the articles for everybody, for HR, for India and for payroll — in the console's order",
      india.ok && same(india.articles, [L.all, L.hr, L.india, L.payroll]),
      named(india.articles),
    );
    ok("  never a draft, a scheduled one, an archived one, one taken down, another country's, or one off the list", ![L.draft, L.soon, L.archived, L.down, L.us, offList].some((id) => india.articles.includes(id)));
    ok("  both videos; What's new pinned first, then newest — the HR post, not the US one", same(india.videos, [L.video, L.videoHr]) && same(india.feed, [P.pinned, P.hr, P.older, offListPost]), `${named(india.videos)} | ${named(india.feed)}`);
    ok("the US with HR and payroll: no India article, and no payroll one — payroll isn't sold there", us.ok && same(us.articles, [L.all, L.hr, L.us]), named(us.articles));
    ok("  its own country's post, and HR's", same(us.feed, [P.pinned, P.us, P.hr, P.older, offListPost]), named(us.feed));
    ok("India on the core plan: nothing for HR or payroll", core.ok && same(core.articles, [L.all, L.india]) && same(core.videos, [L.video]) && same(core.feed, [P.pinned, P.older, offListPost]), `${named(core.articles)} | ${named(core.videos)} | ${named(core.feed)}`);
    const env = await inWs(fromEnv, async () => hc.deskzoContentFor(fromEnv));
    ok("a workspace from the environment is shown nothing from Deskzo — and nothing failed", env.ok && env.links.length === 0 && env.updates.length === 0, env);

    const shown = await inWs(inHr, async () => {
      as(people.reader);
      return { videos: await help.deskzoHelpLinks("VIDEO"), feed: await help.deskzoUpdates(), other: await help.deskzoHelpLinks("PODCAST" as never) };
    });
    const video = shown.videos.links.find((l) => l.id === L.video);
    ok("a YouTube video carries its thumbnail id and opens off-site", video?.youtubeId === "dQw4w9WgXcQ" && video.external === true, video);
    const byId = new Map(shown.feed.posts.map((p) => [p.id, p]));
    ok(
      "a post's read-more off the list is dropped, the post kept; deskzo.com opens off-site, a path in the app",
      byId.get(offListPost)?.linkUrl === null && byId.get(P.pinned)?.linkUrl === "https://deskzo.com/notes/1" && byId.get(P.pinned)?.external === true && byId.get(P.older)?.linkUrl === "/renewals" && byId.get(P.older)?.external === false,
    );
    ok("  Deskzo speaks as Deskzo: no staff name on a post", shown.feed.posts.every((p) => p.author === null));
    ok("a kind that is neither is nothing, not everything", shown.other.ok && shown.other.links.length === 0);
    const later = await inWs(inHr, async () => hc.deskzoContentFor(inHr, new Date(Date.now() + 31 * MIN)));
    ok("the scheduled article and post show once their time comes", later.links.some((l) => l.id === L.soon) && later.updates.some((u) => u.id === P.soon));
  });

  await part("A change in the console shows at once; nothing a workspace does changes Deskzo's", async () => {
    await actAs(staff.owner);
    const down = await A.consoleUnpublishHelpItem("link", L.hr);
    ok("taken down in the console, the HR article is gone from the workspace at once", down.ok && !(await seenBy(inHr)).articles.includes(L.hr), why(down));
    const back = await A.consolePublishHelpItem("link", L.hr);
    ok("  published again, it is back", back.ok && (await seenBy(inHr)).articles.includes(L.hr), why(back));
    const order = (await control.platformHelpLink.findMany({ where: { kind: "ARTICLE", archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true } })).map((r) => r.id).reverse();
    const reordered = await A.consoleReorderHelpLinks("ARTICLE", order);
    const india = await seenBy(inHr);
    ok("reordered in the console, the workspace lists them in the new order", reordered.ok && same(india.articles, [L.payroll, L.india, L.hr, L.all]), `${why(reordered)} ${named(india.articles)}`);

    // A rail that was read just before a change outside the console keeps its minute; the console's own saves don't wait.
    await control.platformHelpLink.update({ where: { id: L.draft }, data: { publishedAt: new Date(Date.now() - MIN) } });
    ok("a row changed outside the console waits for the minute-long copy", !(await seenBy(inHr)).articles.includes(L.draft));
    hc.forgetHelpContent();
    ok("  and shows once the copy is dropped", (await seenBy(inHr)).articles.includes(L.draft));
    await control.platformHelpLink.update({ where: { id: L.draft }, data: { publishedAt: null } });
    hc.forgetHelpContent();

    const tried = await inWs(inHr, async () => {
      as(people.manager);
      return {
        edit: await help.saveHelpLink({ id: L.all, kind: "ARTICLE", title: "Hijacked", url: "/x" }),
        editPost: await help.saveUpdate({ id: P.pinned, title: "Hijacked", body: "x" }),
        drop: await help.deleteHelpLink(L.all),
        dropPost: await help.deleteUpdate(P.pinned),
      };
    });
    const stillAll = await control.platformHelpLink.findUniqueOrThrow({ where: { id: L.all }, select: { title: true, archivedAt: true, publishedAt: true } });
    const stillPinned = await control.platformUpdate.findUniqueOrThrow({ where: { id: P.pinned }, select: { title: true, archivedAt: true } });
    const after = await seenBy(inHr);
    ok("a workspace's manager can't edit Deskzo's article or post — they aren't the company's", !tried.edit.ok && !tried.editPost.ok, JSON.stringify(tried));
    ok(
      "  and deleting them deletes nothing: the rows are as published, and still shown",
      stillAll.title === `${TAG} Dz article for everybody` && !stillAll.archivedAt && !!stillAll.publishedAt && stillPinned.title === `${TAG} Dz post pinned` && !stillPinned.archivedAt && after.articles.includes(L.all) && after.feed.includes(P.pinned),
    );
    const source = readFileSync(path.join(__dirname, "..", "src", "actions", "help.ts"), "utf8");
    ok("  the workspace's help actions never write to the control plane (no control client, no Deskzo tables)", !/controlDb|platformHelpLink|platformUpdate/.test(source));
  });

  // ─── Never mixed ──────────────────────────────────────────────────────────────────────────────
  const C = await inWs(inHr, async () => {
    as(people.manager);
    const saved = async (r: Promise<{ ok: boolean; data?: { id: string }; error?: string }>) => {
      const res = await r;
      if (!res.ok || !res.data) throw new Error(`the company fixture was refused: ${res.error}`);
      return res.data.id;
    };
    return {
      // The same page as Deskzo's article, and a title that names Deskzo: still the company's own.
      sop: await saved(help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Co returns SOP`, url: "/orders/new" })),
      tips: await saved(help.saveHelpLink({ kind: "ARTICLE", title: `${TAG} Co Deskzo tips we wrote`, url: "https://example.com/tips" })),
      video: await saved(help.saveHelpLink({ kind: "VIDEO", title: `${TAG} Co onboarding video`, url: "https://youtu.be/dQw4w9WgXcQ" })),
      newsOne: await saved(help.saveUpdate({ title: `${TAG} Co news one`, body: "The canteen opens at nine." })),
      newsTwo: await saved(help.saveUpdate({ title: `${TAG} Co news two`, body: "Quarter close on Friday.", linkUrl: "/reports" })),
    };
  });

  await part("Never mixed: two groups on every surface, each with its own", async () => {
    await inWs(inHr, async () => {
      as(people.reader);
      const dzArticles = await help.deskzoHelpLinks("ARTICLE");
      const dzVideos = await help.deskzoHelpLinks("VIDEO");
      const coArticles = await help.listHelpLinks("ARTICLE");
      const coVideos = await help.listHelpLinks("VIDEO");
      const dzFeed = await help.deskzoUpdates();
      const coFeed = await help.listUpdates();
      const dzIds = new Set([...Object.values(L), ...Object.values(P), offList, offListPost]);
      const coIds = new Set(Object.values(C));
      ok(
        "Deskzo's lists hold none of the company's rows, and the company's none of Deskzo's",
        [...dzArticles.links, ...dzVideos.links, ...dzFeed.posts].every((x) => dzIds.has(x.id) && !coIds.has(x.id)) &&
          [...coArticles, ...coVideos, ...coFeed].every((x) => coIds.has(x.id) && !dzIds.has(x.id)) &&
          coArticles.length === 2 && coVideos.length === 1 && coFeed.length === 2,
      );

      const titles = <T extends { title: string }>(xs: T[]) => xs.map((x) => x.title);
      const apart = (html: string, deskzo: string[], company: string[]) =>
        deskzo.every((t) => group(html, "deskzo").includes(t) && !group(html, "company").includes(t)) && company.every((t) => group(html, "company").includes(t) && !group(html, "deskzo").includes(t));

      // The check itself, first: a panel with a company guide slipped into Deskzo's group must fail it.
      const mixed = markup(createElement(rail.RailHelpView, { desk: null, deskzo: { ok: true, links: [...dzArticles.links, coArticles[0]] }, company: coArticles.slice(1), canManage: false }));
      ok("(the never-mixed test fails a panel that mixes them, so its passes below mean something)", !apart(mixed, titles(dzArticles.links), titles(coArticles)));
      const helpPanel = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dzArticles, company: coArticles, canManage: false }));
      ok("the Help panel: From Deskzo first, then From your company", firstGroup(helpPanel) === "deskzo" && group(helpPanel, "deskzo").includes("From Deskzo") && group(helpPanel, "company").includes("From your company"));
      ok("  each article in its own group only — the company's 'Deskzo tips' among the company's", apart(helpPanel, titles(dzArticles.links), titles(coArticles)), textOf(helpPanel).slice(0, 600));
      ok(
        "  the same page in both lists is shown once in each, under its own source",
        (group(helpPanel, "deskzo").match(/href="\/orders\/new"/g) ?? []).length === 1 && (group(helpPanel, "company").match(/href="\/orders\/new"/g) ?? []).length === 1,
      );
      ok("  Deskzo's group never offers to add", !/Add/.test(group(helpPanel, "deskzo")) && !group(helpPanel, "deskzo").includes("/settings/"));
      const namedPanel = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dzArticles, company: coArticles, canManage: false, companyName: "Zz Traders" }));
      const namedVideos = markup(createElement(rail.RailVideosView, { deskzo: dzVideos, company: coVideos, canManage: false, companyName: "Zz Traders" }));
      ok(
        "  with the company's name known, its group is headed by it — Deskzo's stays From Deskzo",
        group(namedPanel, "company").includes("From Zz Traders") && group(namedVideos, "company").includes("From Zz Traders") && group(namedPanel, "deskzo").includes("From Deskzo") && !group(namedPanel, "deskzo").includes("Zz Traders"),
      );
      const ourOwn = markup(createElement(rail.RailHelpView, { desk: null, deskzo: dzArticles, company: coArticles, canManage: false, companyName: "Deskzo Technologies" }));
      ok("  a company named Deskzo-something keeps From your company — its group never reads as Deskzo's", group(ourOwn, "company").includes("From your company") && !group(ourOwn, "company").includes("From Deskzo"));
      const emptyCompany = (canManage: boolean) => markup(createElement(rail.RailHelpView, { desk: null, deskzo: dzArticles, company: [], canManage }));
      ok(
        "  the company's empty group offers a manager — nobody else — a quiet link to add their own",
        group(emptyCompany(true), "company").includes("Add your company&#x27;s own guide") && group(emptyCompany(true), "company").includes('href="/settings/help"') && !emptyCompany(false).includes("/settings/help") && !/Add/.test(group(emptyCompany(true), "deskzo")),
      );

      const videosPanel = markup(createElement(rail.RailVideosView, { deskzo: dzVideos, company: coVideos, canManage: true }));
      ok("the Videos panel: the same two groups, each with its own videos", firstGroup(videosPanel) === "deskzo" && apart(videosPanel, titles(dzVideos.links), titles(coVideos)));
      ok("  even the same YouTube video, once in each", (group(videosPanel, "deskzo").match(/i\.ytimg\.com\/vi\/dQw4w9WgXcQ/g) ?? []).length === 1 && (group(videosPanel, "company").match(/i\.ytimg\.com\/vi\/dQw4w9WgXcQ/g) ?? []).length === 1);
      ok("  never embedded", !videosPanel.includes("<iframe"));

      const feed = markup(createElement(RecentUpdates, { deskzo: dzFeed, company: coFeed, canManage: true }));
      ok("What's new: From Deskzo first, then Company news, each holding its own posts only", firstGroup(feed) === "deskzo" && group(feed, "deskzo").includes("From Deskzo") && group(feed, "company").includes("Company news") && apart(feed, titles(dzFeed.posts), titles(coFeed)));
      ok("  each feed counts its own unread", unreadIn(group(feed, "deskzo")) === 4 && unreadIn(group(feed, "company")) === 2, { deskzo: unreadIn(group(feed, "deskzo")), company: unreadIn(group(feed, "company")) });
      ok("  only the company's feed offers to post, to a manager", group(feed, "company").includes("Post company news") && !group(feed, "deskzo").includes("/settings/"));

      const dashboard = await render(Dashboard, {}, { tab: "updates" });
      ok("the dashboard's Recent Updates: the two feeds apart", firstGroup(dashboard) === "deskzo" && apart(dashboard, titles(dzFeed.posts), titles(coFeed)));
      // The counts show on the tab until it is opened, so they are read from another tab.
      const elsewhere = await render(Dashboard, {}, { tab: "getting-started" });
      const tab = elsewhere.match(/href="\/dashboard\?tab=updates"[\s\S]*?<\/a>/)?.[0] ?? "";
      ok("  and, from another tab, Recent Updates carries two pills, never one sum: 4 new from Deskzo, 2 new from your company", tab.includes('title="4 new from Deskzo"') && tab.includes('title="2 new from your company"') && !tab.includes(">6<"), tab);
    });
  });

  // ─── Two unread counts ────────────────────────────────────────────────────────────────────────
  await part("Two unread counts, each its own — and the rail's button a dot for each", async () => {
    await inWs(inHr, async () => {
      as(people.reader);
      const counts = await help.unreadUpdateCounts();
      ok("Deskzo's 4 (the pinned, HR, older and off-list posts) and the company's 2", counts.deskzo === 4 && counts.company === 2 && (await help.deskzoUnreadCount()) === 4 && (await help.unreadUpdateCount()) === 2, counts);
      const both = newsButton(markup(createElement(SideRail, { unreadUpdates: counts.company, unreadDeskzoUpdates: counts.deskzo })));
      ok("the rail's What's new names both counts, apart", both.includes("What&#x27;s new — 4 new from Deskzo, 2 new from your company"), both.slice(0, 300));
      ok("  a dot for each: the company's red at the top, Deskzo's in the brand's colour below", /top-1\.5[^"]*bg-danger/.test(both) && /bottom-1\.5[^"]*bg-brand/.test(both));
      const onlyCompany = newsButton(markup(createElement(SideRail, { unreadUpdates: 2, unreadDeskzoUpdates: 0 })));
      const onlyDeskzo = newsButton(markup(createElement(SideRail, { unreadUpdates: 0, unreadDeskzoUpdates: 4 })));
      ok("  one source with nothing new has no dot, and isn't named", !onlyCompany.includes("bg-brand") && !onlyCompany.includes("from Deskzo") && !onlyDeskzo.includes("bg-danger") && !onlyDeskzo.includes("your company"));
    });
  });

  await part("A control plane that is missing, refuses or doesn't answer: nothing from Deskzo, never a throw", async () => {
    const lineBefore = await lineOf();
    ok("(the reader has opened neither feed yet)", lineBefore.deskzoUpdatesSeenAt === null && lineBefore.updatesSeenAt === null);
    try {
      // A database that isn't there.
      await closeControlDb();
      process.env.CONTROL_DATABASE_URL = ctx.at(`${ctx.controlName}_missing`);
      hc.forgetHelpContent();
      const { value, warned } = await withWarnings(async () =>
        inWs(inHr, async () => {
          as(people.reader);
          const read = await timed(() => hc.deskzoContentFor(inHr));
          const again = await hc.deskzoContentFor(inHr);
          return {
            read,
            again,
            articles: await help.deskzoHelpLinks("ARTICLE"),
            feed: await help.deskzoUpdates(),
            unread: await help.deskzoUnreadCount(),
            counts: await help.unreadUpdateCounts(),
            company: await help.listHelpLinks("ARTICLE"),
            companyFeed: await help.listUpdates(),
            marked: [await help.markDeskzoUpdatesSeen(), await help.markDeskzoUpdatesSeen(new Date().toISOString())],
          };
        }),
      );
      ok("the read: nothing, said as a failure (ok false), no throw, and quick", !value.read.value.ok && value.read.value.links.length === 0 && value.read.value.updates.length === 0 && value.read.ms < 2500, `${value.read.ms} ms`);
      ok("  logged once — the next page of the minute doesn't ask again", warned.filter((w) => w.includes("[help-content]")).length === 1 && !value.again.ok, warned);
      ok("  logged without the address's password", warned.every((w) => !w.includes(new URL(ctx.controlUrl).password || "no-password-in-the-address")));
      ok("Deskzo's Help list and What's new say they couldn't be read; Deskzo's dot is 0", !value.articles.ok && value.articles.links.length === 0 && !value.feed.ok && value.feed.posts.length === 0 && value.unread === 0 && value.counts.deskzo === 0);
      ok("  the company's guides, news and dot are all still there", value.company.length === 2 && value.companyFeed.length === 2 && value.counts.company === 2);
      ok("  opening What's new on the failed read moves Deskzo's line nowhere", value.marked.every((r) => r.ok) && (await lineOf()).deskzoUpdatesSeenAt === null);
      const helpDown = markup(createElement(rail.RailHelpView, { desk: null, deskzo: value.articles, company: value.company, canManage: false }));
      const feedDown = markup(createElement(RecentUpdates, { deskzo: value.feed, company: value.companyFeed, canManage: false }));
      ok(
        "  the panels say so in Deskzo's group only, and still show the company's",
        group(helpDown, "deskzo").includes("couldn&#x27;t be reached") && value.company.every((l) => group(helpDown, "company").includes(l.title)) && group(feedDown, "deskzo").includes("couldn&#x27;t be reached") && value.companyFeed.every((p) => group(feedDown, "company").includes(p.title)),
      );

      // A server that refuses the connection.
      await closeControlDb();
      process.env.CONTROL_DATABASE_URL = "postgresql://zz:zz@127.0.0.1:1/zz";
      hc.forgetHelpContent();
      const refused = await withWarnings(() => timed(() => inWs(inHr, async () => hc.deskzoContentFor(inHr))));
      ok("a server that refuses the connection: nothing, ok false, within the 1.5 s the loader allows", !refused.value.value.ok && refused.value.value.links.length === 0 && refused.value.ms < 2500, `${refused.value.ms} ms`);

      // One that doesn't answer, one that throws, one that hands back rubbish — through the loader's own test hook.
      await closeControlDb();
      process.env.CONTROL_DATABASE_URL = ctx.controlUrl;
      hc.forgetHelpContent();
      const quiet = await withWarnings(async () => ({
        hung: await timed(() => hc.deskzoContentFor(inHr, new Date(), () => new Promise(() => {}))),
        threw: await hc.deskzoContentFor(inHr, new Date(), async () => Promise.reject(new Error("connect ECONNREFUSED postgresql://zz:secretpw@db.example/x"))),
        threwAtOnce: await hc.deskzoContentFor(inHr, new Date(), (() => {
          throw new Error("at once");
        }) as never),
        rubbish: await hc.deskzoContentFor(inHr, new Date(), async () => ({ links: [null, 7, { id: "x" }], updates: "no" }) as never),
      }));
      ok("a control plane that doesn't answer: nothing after 1.5 s, ok false", !quiet.value.hung.value.ok && quiet.value.hung.ms >= 1400 && quiet.value.hung.ms < 2500, `${quiet.value.hung.ms} ms`);
      ok("  one that throws, at once or later: nothing, ok false, never thrown on", !quiet.value.threw.ok && !quiet.value.threwAtOnce.ok && quiet.value.threw.links.length === 0);
      ok("  its password never in the log", quiet.warned.length >= 2 && quiet.warned.every((w) => !w.includes("secretpw")), quiet.warned);
      ok("  rows that aren't rows are skipped", quiet.value.rubbish.links.length === 0 && quiet.value.rubbish.updates.length === 0, quiet.value.rubbish);

      // No control plane at all — an installation from before workspaces.
      await closeControlDb();
      process.env.CONTROL_DATABASE_URL = "";
      hc.forgetHelpContent();
      const none = await inWs(inHr, async () => {
        as(people.reader);
        const content = await hc.deskzoContentFor(inHr);
        await help.markDeskzoUpdatesSeen();
        return content;
      });
      ok("no control plane at all: nothing from Deskzo, and nothing failed", none.ok && none.links.length === 0 && none.updates.length === 0, none);
      ok("  an empty read moves Deskzo's line nowhere either", (await lineOf()).deskzoUpdatesSeenAt === null);
    } finally {
      await closeControlDb();
      process.env.CONTROL_DATABASE_URL = ctx.controlUrl;
      hc.forgetHelpContent();
    }
    const back = await inWs(inHr, async () => {
      as(people.reader);
      return help.unreadUpdateCounts();
    });
    ok("the control plane back: Deskzo's 4 again, the company's 2", back.deskzo === 4 && back.company === 2, back);
  });

  await part("Each 'seen' moves its own line: Deskzo's to the newest post shown, never to now, never back", async () => {
    await inWs(inHr, async () => {
      as(people.reader);
      await help.markUpdatesSeen();
      const afterCompany = await lineOf();
      ok("the company's 'seen' clears the company's dot only", (await help.unreadUpdateCount()) === 0 && (await help.deskzoUnreadCount()) === 4 && afterCompany.deskzoUpdatesSeenAt === null && !!afterCompany.updatesSeenAt);
      viewingAs = true;
      await help.markDeskzoUpdatesSeen();
      viewingAs = false;
      ok("opening Deskzo's while viewing as them leaves their dot alone", (await lineOf()).deskzoUpdatesSeenAt === null && (await help.deskzoUnreadCount()) === 4);
      await help.markDeskzoUpdatesSeen("not a time");
      ok("  a 'shown up to' that isn't a time marks nothing", (await lineOf()).deskzoUpdatesSeenAt === null);
      await help.markDeskzoUpdatesSeen(new Date(postAt.older).toISOString());
      ok(
        "shown up to the older post: the line is that post's time — so only the HR post, newer, is still unread",
        (await lineOf()).deskzoUpdatesSeenAt?.getTime() === postAt.older && (await help.deskzoUnreadCount()) === 1 && (await help.deskzoUpdates()).posts.filter((p) => p.unread).map((p) => p.id).join() === P.hr,
      );
      await help.markDeskzoUpdatesSeen();
      const all = await lineOf();
      ok("all of it: the newest post's time, half an hour ago — not now", all.deskzoUpdatesSeenAt?.getTime() === postAt.hr && (await help.deskzoUnreadCount()) === 0, all.deskzoUpdatesSeenAt?.toISOString());
      await help.markDeskzoUpdatesSeen(new Date(postAt.pinned).toISOString());
      ok("  never back: an older post's time leaves it where it is", (await lineOf()).deskzoUpdatesSeenAt?.getTime() === postAt.hr);
      ok("  and the company's line never moved with it", (await lineOf()).updatesSeenAt?.getTime() === afterCompany.updatesSeenAt?.getTime());
    });

    await actAs(staff.owner);
    await post({ title: `${TAG} Dz post newer for HR`, body: "Shifts.", modules: ["hr"], publish: "now" });
    await post({ title: `${TAG} Dz post newer for the US`, body: "Payroll in the US? Not yet.", countries: ["US"], publish: "now" });
    const india = await inWs(inHr, async () => {
      as(people.reader);
      return help.unreadUpdateCounts();
    });
    const core = await inWs(inCore, async () => {
      as(people.reader);
      return help.unreadUpdateCounts();
    });
    ok("a new HR post from Deskzo: Deskzo's dot is back — 1, at once — and the company's stays clear", india.deskzo === 1 && india.company === 0, india);
    ok("  the US post and the HR post light nothing for a workspace neither reaches", core.deskzo === 0, core);
    await inWs(inHr, async () => {
      as(people.manager);
      await help.saveUpdate({ title: `${TAG} Co news three`, body: "Diwali party." });
      as(people.reader);
      const counts = await help.unreadUpdateCounts();
      ok("company news posted: the company's dot is 1, Deskzo's still 1", counts.company === 1 && counts.deskzo === 1, counts);
    });
  });

  // ─── Reach ────────────────────────────────────────────────────────────────────────────────────
  await part("The console's reach is the workspace's own rule", async () => {
    await actAs(staff.admin);
    const reach = async (modules: string[], countries: string[]) => {
      const r = await A.consoleHelpReach(modules, countries);
      return r.ok ? `${r.data.count}/${r.data.total} ${r.data.sample.join(",")}` : r.error;
    };
    ok("HR: the two open workspaces with it, not the held one", (await reach(["hr"], [])) === "2/3 zzhc-in-hr,zzhc-us-hr");
    ok("  payroll: India's only — it isn't sold in the US", (await reach(["payroll"], [])) === "1/3 zzhc-in-hr");
    ok("  India: both Indian workspaces; nothing chosen: every open one", (await reach([], ["in"])) === "2/3 zzhc-in-core,zzhc-in-hr" && (await reach([], [])) === "3/3 zzhc-in-core,zzhc-in-hr,zzhc-us-hr");
  });

  // ─── The console's pages ──────────────────────────────────────────────────────────────────────
  await part("The console's pages, for each role", async () => {
    const visit = (page: Page, params?: Record<string, string>, sp?: Record<string, string>) =>
      render(page, params, sp).catch((err: Error) => `FAILED ${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}`);
    const views: [string, Page, Record<string, string>, Record<string, string>][] = [
      ["/help-content", pages.list, {}, {}],
      ["/help-content?tab=videos", pages.list, {}, { tab: "videos" }],
      ["/help-content?tab=updates", pages.list, {}, { tab: "updates" }],
      ["/help-content?show=archived", pages.list, {}, { show: "archived" }],
      ["/help-content/new?kind=article", pages.create, {}, { kind: "article" }],
      ["/help-content/new?kind=video", pages.create, {}, { kind: "video" }],
      ["/help-content/new?kind=post", pages.create, {}, { kind: "post" }],
      ["/help-content/[an article]", pages.item, { id: L.all }, {}],
      ["/help-content/[a video]", pages.item, { id: L.video }, {}],
      ["/help-content/[a post]", pages.item, { id: P.pinned }, {}],
      ["/help-content/[a draft post]", pages.item, { id: P.draft }, {}],
      ["/help-content/[archived]", pages.item, { id: L.archived }, {}],
    ];
    for (const [who, id] of [["the owner", staff.owner], ["an admin", staff.admin]] as const) {
      await actAs(id);
      const bad: string[] = [];
      for (const [label, page, params, sp] of views) {
        const html = await visit(page, params, sp);
        const t = textOf(html);
        if (html.startsWith("FAILED") || /\bNaN\b|\bundefined\b|\bnull\b/.test(t)) bad.push(`${label}: ${html.startsWith("FAILED") ? html.slice(0, 300) : "NaN/undefined/null in the text"}`);
      }
      ok(`every view renders for ${who}`, bad.length === 0, bad.join(" | "));
    }
    await actAs(staff.admin);
    const list = textOf(await visit(pages.list));
    ok("the list: Deskzo's articles with their state and whom they are for, and a way to add one", list.includes("Dz article for everybody") && list.includes("Live") && list.includes("Draft") && list.includes("Scheduled") && list.includes("Every workspace") && list.includes("New article"), list.slice(0, 600));
    const item = textOf(await visit(pages.item, { id: L.all }));
    ok("  an item is the editor for an admin, with its verbs", item.includes("Who sees it") && item.includes("Take down"), item.slice(0, 600));
    const updates = textOf(await visit(pages.list, {}, { tab: "updates" }));
    ok("  What's new lists the posts, pinned marked", updates.includes("Dz post pinned") && updates.includes("Pinned"), updates.slice(0, 600));
    for (const [who, id] of [["support", staff.support], ["billing staff", staff.billing], ["read-only staff", staff.readonly]] as const) {
      await actAs(id);
      const theirList = await visit(pages.list);
      const theirItem = await visit(pages.item, { id: P.pinned });
      ok(`${who}: the list, with no way to change anything`, !theirList.startsWith("FAILED") && !textOf(theirList).includes("New article") && !theirList.includes("Actions for "), theirList.slice(0, 300));
      ok(`  an item read-only — what it says, no editor, no verbs`, !theirItem.startsWith("FAILED") && textOf(theirItem).includes("Details") && textOf(theirItem).includes("Read this first.") && !textOf(theirItem).includes("Who sees it") && !textOf(theirItem).includes("Take down"), theirItem.slice(0, 300));
      ok("  and no page for a new one", (await thrown(() => render(pages.create))) === "notFound");
    }
    await actAs(staff.owner);
    ok("an item that isn't one is not found", (await thrown(() => render(pages.item, { id: "zzhcnobody" }))) === "notFound" && (await thrown(() => render(pages.item, { id: "../x" }))) === "notFound");
    jar.clear();
    ok("signed out, every page sends you to sign in", (await thrown(() => render(pages.list))) === "redirect /login" && (await thrown(() => render(pages.create))) === "redirect /login" && (await thrown(() => render(pages.item, { id: L.all }))) === "redirect /login");
  });

  // ─── The audit ────────────────────────────────────────────────────────────────────────────────
  await part("The audit: every change, by id and title — never a link or a body", async () => {
    const audit = await control.platformAuditLog.findMany({ where: { action: { startsWith: "help." } }, select: { action: true, actor: true, actorKind: true, detail: true } });
    const text = JSON.stringify(audit.map((a) => a.detail));
    const actions = new Set(audit.map((a) => a.action));
    ok(
      "creates, publishes, schedules, take-downs, archives and reorders are all there",
      ["help.article.create", "help.article.publish", "help.article.unpublish", "help.article.archive", "help.article.reorder", "help.video.create", "help.post.create", "help.post.archive"].every((a) => actions.has(a)),
      [...actions].join(" "),
    );
    ok("  under the staff member who did it", audit.every((a) => a.actorKind === "STAFF" && [staff.owner, staff.admin].includes(a.actor)));
    ok(
      "  naming the item, never its link or what it says",
      text.includes(`${TAG} Dz article for everybody`) && !/https?:\/\//.test(text) && !text.includes("/orders/new") && !text.includes("Read this first.") && !text.includes("Leave requests, faster."),
      text.slice(0, 400),
    );
    // The console's audit log shows each as words, under Console, and leads to the item.
    const unlabelled = [...actions].filter((a) => labels.auditLabel(a, {}).title === a || labels.categoryOf(a) !== "console");
    ok("  each read in the console's log as words, filed under Console", actions.size > 0 && unlabelled.length === 0, unlabelled);
    const entry = audit.find((a) => a.action === "help.article.create");
    ok(
      "  summed up by its title, and leading to the item's page",
      !!entry && (labels.auditSummary(entry.action, entry.detail) ?? "").includes("“") && labels.auditHref(entry.action, entry.detail, null)?.startsWith("/help-content/") === true,
      entry ? `${labels.auditSummary(entry.action, entry.detail)} → ${labels.auditHref(entry.action, entry.detail, null)}` : "none",
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
