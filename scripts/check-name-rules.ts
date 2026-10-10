/**
 * check:name-rules — staff manage workspace names, and hold an address for one customer (owner's
 * request, 1 Oct 2026).
 *
 *   · the pure verdict (src/lib/workspace-names.ts): every step and its order — pattern, platform
 *     address, staff's blocks, the built-in words unless released, held, taken — what a customer
 *     reads, and what staff may release or block;
 *   · the split of the old reserved list: the platform's own addresses, locked, which classifyHost
 *     refuses — never "deskzo" — and the releasable words, which a released or held workspace is
 *     served on; no existing workspace (the real control plane, read only) has a platform address;
 *   · then, on a scratch control plane built from its migrations (dropped at the end, pass or fail),
 *     with staff of all five roles signed in by a session made here: the rules loader (cached,
 *     forgotten on change, fail-safe), the console's actions and who may use them, their audit rows,
 *     releasing and blocking through signup and provisioning, the hold on an invitation from creation
 *     to signup — the lookup that reveals nothing for a bad code included — and the pages: the
 *     console's "Workspace names" and "Invitations", and the signup form with an address held.
 *
 * No workspace database is made: provisioning stops at the queued job. No mail leaves (the platform
 * mailer is replaced), no worker starts (the signup's spawn is stubbed). No password is typed: staff
 * are signed in by a session row. Renders are saved to $NAME_RULES_RENDERS when it is set.
 *
 *   npm run check:name-rules
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
process.env.REFERENCE_DATABASE_URL = "";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
async function part(title: string, work: () => Promise<void>) {
  section(title);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}` : String(err));
  }
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const RENDERS = process.env.NAME_RULES_RENDERS?.trim() || "";
function saveRender(name: string, html: string) {
  if (!RENDERS) return;
  mkdirSync(RENDERS, { recursive: true });
  writeFileSync(path.join(RENDERS, name), `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${html}`);
}

// ─── A request, as the console and signup see one ────────────────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:name-rules" });
let workerStarts = 0;
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {} };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  // The worker a verified signup starts: counted, not run.
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith("signup.ts")) {
    return { spawn: () => ((workerStarts += 1), { unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

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
async function render(page: Page, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The reserved list as it was before the split (src/lib/tenancy/host.ts, 1 Oct 2026). */
const OLD_RESERVED = (
  "www admin api app apps auth billing console dashboard devices docs help mail smtp imap pop pop3 mx ns ns1 ns2 dns ftp sftp vpn status support " +
  "static cdn assets files uploads media images img download downloads login logout signin signout signup register account accounts platform system root test testing " +
  "dev developer developers sandbox staging demo beta alpha preview blog news shop store cms partners partner reseller resellers affiliate affiliates portal my me " +
  "home about pricing contact careers jobs press events community forum learn academy training webinar webinars updates changelog roadmap feedback uptime " +
  "oauth sso id identity password reset verify verification secure security trust privacy legal terms compliance gdpr abuse postmaster hostmaster webmaster noreply " +
  "no-reply info hello sales enquiry enquiries care service services helpcenter helpcentre knowledgebase kb official officials staff team internal corp corporate " +
  "owner administrator sysadmin superadmin null undefined default example " +
  "one suite erp crm books accounting finance invoice invoices invoicing payments pay payroll people hr hrms recruit hiring expense expenses inventory stock " +
  "orders purchase procurement projects tasks desk helpdesk servicedesk tickets ticketing marketing campaigns mailer survey surveys forms analytics reports " +
  "insights vault sign esign drive workdrive chat meet connect workplace office commerce pos gst einvoice ewaybill copilot ai assistant"
).split(" ");
/** The platform's own addresses, as the owner's brief named them — plus mail's autodiscovery hosts. */
const BRIEF_HOSTS = (
  "www admin api app apps auth billing console dashboard devices docs help mail smtp imap pop pop3 mx ns ns1 ns2 dns ftp sftp vpn status support static cdn assets " +
  "files uploads media images img download downloads login logout signin signout signup register account accounts platform system root test testing dev developer " +
  "developers sandbox staging demo beta alpha preview cms partners partner portal my id identity oauth sso password reset verify verification secure security trust " +
  "privacy legal terms abuse postmaster hostmaster webmaster noreply no-reply null undefined default example"
).split(" ");
const ADDED_HOSTS = ["autodiscover", "autoconfig", "mta-sts"];
/** Product words reserved since the split: Deskzo Cards, and the signatures product to come (10 Oct 2026). */
const ADDED_WORDS = ["cards", "card", "businesscard", "signatures", "signature"];

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const names = require("../src/lib/workspace-names") as typeof import("../src/lib/workspace-names");
  const host = require("../src/lib/tenancy/host") as typeof import("../src/lib/tenancy/host");
  const labels = require("../src/lib/console-shared/labels") as typeof import("../src/lib/console-shared/labels");
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { nameVerdict, signupNameVerdict, NAME_RESERVED, NAME_TAKEN, NAME_PATTERN_MESSAGE } = names;
  type Rule = import("../src/lib/workspace-names").NameRule;
  const hostOf = (sub: string) => host.classifyHost(`${sub}.${host.PLATFORM_DOMAIN}:3000`);
  const rule = (kind: Rule["kind"], value: string): Rule => ({ kind, value });

  // ─── A. The pure verdict ───────────────────────────────────────────────────────────────────────
  await part("A. The verdict, without a database", async () => {
    const v = (slug: string, facts: import("../src/lib/workspace-names").NameFacts = {}) => nameVerdict(slug, facts);
    const ruleOf = (slug: string, facts: import("../src/lib/workspace-names").NameFacts = {}) => {
      const r = v(slug, facts);
      return r.ok ? "ok" : r.rule;
    };
    ok("the pattern first: \"-bad-\", \"Acme\", \"ab\"", ruleOf("-bad-") === "pattern" && ruleOf("Acme") === "pattern" && ruleOf("ab") === "pattern" && (v("-bad-") as { message: string }).message === NAME_PATTERN_MESSAGE);
    ok("a platform address: \"admin\", \"api\", \"mta-sts\"", ruleOf("admin") === "platform" && ruleOf("api") === "platform" && ruleOf("mta-sts") === "platform");
    ok("  never released — a RELEASE of it is ignored", ruleOf("admin", { rules: [rule("RELEASE", "admin")] }) === "platform");
    ok("  never held — not even with the reserved-word tick", ruleOf("admin", { hold: { slug: "admin", skipsReserved: true } }) === "platform");
    const blocks = [rule("BLOCK_EXACT", "acmecorp"), rule("BLOCK_WORD", "scam")];
    ok("BLOCK_EXACT: exactly that name", ruleOf("acmecorp", { rules: blocks }) === "blocked-exact" && ruleOf("acmecorp2", { rules: blocks }) === "ok" && ruleOf("acme-corp", { rules: blocks }) === "ok");
    ok("BLOCK_WORD: any name with the word, hyphens ignored", ruleOf("best-scam-co", { rules: blocks }) === "blocked-word" && ruleOf("sc-am-traders", { rules: blocks }) === "blocked-word" && ruleOf("scamper", { rules: blocks }) === "blocked-word");
    ok("  the word that decided is named, for staff", (v("sc-am-traders", { rules: blocks }) as { word: string }).word === "scam");
    ok("a reserved word: the whole address only", ruleOf("books") === "reserved" && ruleOf("booksandmore") === "ok" && ruleOf("acme-books") === "ok");
    ok("our names anywhere; competitors' as a word or a prefix", ruleOf("mydeskzo") === "ours" && ruleOf("deskzo-crm") === "ours" && ruleOf("zoho-india") === "competitor" && ruleOf("tallysolutions") === "competitor" && ruleOf("digitallyyours") === "ok");
    ok("RELEASE: a reserved word let through", ruleOf("books", { rules: [rule("RELEASE", "books")] }) === "ok" && JSON.stringify((v("books", { rules: [rule("RELEASE", "books")] }) as { released: string[] }).released) === '["books"]');
    ok("  our name let through: \"deskzosolutions\"", ruleOf("deskzosolutions", { rules: [rule("RELEASE", "deskzo")] }) === "ok");
    ok("  but only that one — \"deskzo-zoho\" still carries a competitor's", ruleOf("deskzo-zoho", { rules: [rule("RELEASE", "deskzo")] }) === "competitor");
    ok("  a competitor's let through: \"zoho-india\"", ruleOf("zoho-india", { rules: [rule("RELEASE", "zoho")] }) === "ok");
    ok("a block wins over a release (blocks come first)", ruleOf("books", { rules: [rule("RELEASE", "books"), rule("BLOCK_WORD", "books")] }) === "blocked-word");
    ok("order: platform before a block", ruleOf("support", { rules: [rule("BLOCK_EXACT", "support")] }) === "platform");
    ok("order: a block before the built-in words", ruleOf("books", { rules: [rule("BLOCK_EXACT", "books")] }) === "blocked-exact");
    ok("order: the built-in words before held and taken", ruleOf("books", { heldElsewhere: true, taken: true }) === "reserved");
    ok("order: held before taken", ruleOf("acmeworld", { heldElsewhere: true, taken: true }) === "held" && ruleOf("acmeworld", { taken: true }) === "taken");
    const said = (slug: string, facts: import("../src/lib/workspace-names").NameFacts = {}) => names.nameRefusal(slug, facts);
    ok(
      "a customer reads \"That name is reserved.\" for every reserved, blocked or protected refusal",
      [said("admin"), said("acmecorp", { rules: blocks }), said("best-scam-co", { rules: blocks }), said("books"), said("mydeskzo"), said("zoho-india")].every((m) => m === NAME_RESERVED),
    );
    ok("  and \"That name is taken.\" for held and taken", said("acmeworld", { heldElsewhere: true }) === NAME_TAKEN && said("acmeworld", { taken: true }) === NAME_TAKEN);
    ok("  never a staff word in either", ![said("best-scam-co", { rules: blocks }), said("books")].some((m) => /scam|books|staff|block/i.test(m ?? "")));

    section("  holds");
    const hold = { slug: "books", skipsReserved: true };
    ok("a hold with the tick: a reserved word, a blocked name, ours, a competitor's — all let through", ruleOf("books", { hold }) === "ok" && ruleOf("acmecorp", { rules: blocks, hold: { slug: "acmecorp", skipsReserved: true } }) === "ok" && ruleOf("deskzo-partner", { hold: { slug: "deskzo-partner", skipsReserved: true } }) === "ok");
    ok("  and says it was the hold", (v("books", { hold }) as { held: boolean }).held === true);
    ok("  never taken, never the pattern", ruleOf("books", { hold, taken: true }) === "taken" && ruleOf("Bo", { hold: { slug: "Bo", skipsReserved: true } }) === "pattern");
    ok("a hold without the tick: reserved, blocked and protected still refuse", ruleOf("books", { hold: { slug: "books", skipsReserved: false } }) === "reserved" && ruleOf("acmecorp", { rules: blocks, hold: { slug: "acmecorp", skipsReserved: false } }) === "blocked-exact");
    ok("a hold counts for its own address only", ruleOf("books2", { hold }) === "ok" && ruleOf("crm", { hold }) === "reserved");

    section("  signup");
    const legal = "Zenith Industries Pvt Ltd";
    const s = (slug: string, facts: import("../src/lib/workspace-names").NameFacts = {}, name = legal) => {
      const r = signupNameVerdict(slug, name, facts);
      return r.ok ? "ok" : r.rule;
    };
    ok("without a hold, the signup rules: eight letters, made from the registered name", s("zenithindustries") === "ok" && s("zenith") === "signup" && s("acmeworld") === "signup");
    ok("  the signup rule's words come before \"taken\"", (signupNameVerdict("acmeworld", legal, { taken: true }) as { message: string }).message.startsWith("Your address must come from your registered business name"));
    const zz = { slug: "zz-a", skipsReserved: false };
    ok("with a hold: exactly the held name, without the signup rules", s("zz-a", { hold: zz }) === "ok" && s("zenithindustries", { hold: zz }) === "hold-mismatch");
    ok("  the mismatch names the held address", (signupNameVerdict("zenithindustries", legal, { hold: zz }) as { message: string }).message === "Your invitation comes with its own address: zz-a.");
    ok("  a held name taken by a workspace in the meantime is refused", s("zz-a", { hold: zz, taken: true }) === "taken");
    ok("  with the tick, a reserved word; without it, refused", s("books", { hold }) === "ok" && s("books", { hold: { slug: "books", skipsReserved: false } }) === "reserved");
    ok("  never a platform address", s("admin", { hold: { slug: "admin", skipsReserved: true } }) === "platform");

    section("  what staff may release or block");
    ok("a platform address can't be released, in words that say why", (names.releaseProblem("admin") ?? "").includes("platform's own addresses") && (names.releaseProblem("www") ?? "").includes("never be released"));
    ok("only a built-in word can be released", names.releaseProblem("acme") !== null && names.releaseProblem("books") === null && names.releaseProblem("deskzo") === null && names.releaseProblem("zoho") === null);
    ok("a block: a whole address, or a word of three letters at least, never a platform address", names.blockProblem("acme", "BLOCK_EXACT") === null && names.blockProblem("scam", "BLOCK_WORD") === null && names.blockProblem("ab", "BLOCK_WORD") !== null && names.blockProblem("a-b", "BLOCK_WORD") !== null && names.blockProblem("www", "BLOCK_EXACT") !== null && names.blockProblem("-x-", "BLOCK_EXACT") !== null);
    ok("the words for each step are staff's", names.verdictInWords(v("best-scam-co", { rules: blocks })).includes('"scam"') && names.verdictInWords(v("books", { rules: [rule("RELEASE", "books")] })).includes("released"));
  });

  // ─── B. The split ──────────────────────────────────────────────────────────────────────────────
  await part("B. The built-in list, split", async () => {
    const hosts = [...names.PLATFORM_HOSTS].sort();
    ok(`PLATFORM_HOSTS is the brief's list, plus ${ADDED_HOSTS.join(", ")}`, JSON.stringify(hosts) === JSON.stringify([...BRIEF_HOSTS, ...ADDED_HOSTS].sort()), hosts.filter((h) => !BRIEF_HOSTS.includes(h) && !ADDED_HOSTS.includes(h)));
    const words = [...names.RESERVED_WORDS];
    ok(`RESERVED_WORDS is every other word of the old list, plus ${ADDED_WORDS.join(", ")} — none lost`, JSON.stringify([...words].sort()) === JSON.stringify([...OLD_RESERVED.filter((w) => !names.PLATFORM_HOSTS.has(w)), ...ADDED_WORDS].sort()));
    ok("  and every old word is in one of the two", OLD_RESERVED.every((w) => names.PLATFORM_HOSTS.has(w) || names.RESERVED_WORDS.has(w)));
    ok("no word is in two lists", words.every((w) => !names.PLATFORM_HOSTS.has(w)) && [...names.OUR_NAMES, ...names.COMPETITOR_NAMES].every((w) => !names.PLATFORM_HOSTS.has(w) && !names.RESERVED_WORDS.has(w)));
    ok('"deskzo" is never a platform address — the platform\'s own workspace is called that', !names.PLATFORM_HOSTS.has("deskzo"));
    ok("RESERVED_SLUGS (host.ts) is PLATFORM_HOSTS, under its old name", host.RESERVED_SLUGS === names.PLATFORM_HOSTS && host.PLATFORM_HOSTS === names.PLATFORM_HOSTS && host.SLUG_PATTERN === names.SLUG_PATTERN);
    ok('"cms", "partners" and "partner" are platform addresses (check:cms, check:partners)', ["cms", "partners", "partner"].every((w) => host.RESERVED_SLUGS.has(w)));
    const at = hostOf;
    ok("a product word is served as a workspace once one has it: books., crm., helpdesk.", ["books", "crm", "helpdesk", "official"].every((w) => { const k = at(w); return k.kind === "tenant" && k.slug === w; }));
    ok("a platform address never is: api., status., mail.", ["api", "status", "mail", "mta-sts"].every((w) => at(w).kind === "invalid"));
    ok("  the console, the CMS and the partner portal keep their own hosts", at("admin").kind === "console" && at("cms").kind === "cms" && at("partners").kind === "partners" && at("www").kind === "root");
    ok("deskzo. is a workspace", at("deskzo").kind === "tenant");
    const adopt = readFileSync(path.join(process.cwd(), "scripts", "platform-adopt.ts"), "utf8");
    ok("adoption refuses a default workspace named by a platform address only — \"deskzo\" passes", /RESERVED_SLUGS\.has\(slug\)/.test(adopt) && host.SLUG_PATTERN.test("deskzo") && !host.RESERVED_SLUGS.has("deskzo"));

    // The real control plane, read only: no workspace that exists may be named by a platform address.
    const { controlDb, controlConfigured, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    if (controlConfigured()) {
      const existing = await controlDb().tenant.findMany({ select: { slug: true } });
      const clash = existing.filter((t) => names.PLATFORM_HOSTS.has(t.slug));
      ok(`no existing workspace (${existing.length}) has a platform address — it would stop being served`, clash.length === 0, clash.map((t) => t.slug).join(", "));
      await closeControlDb();
    } else {
      ok("the real control plane is configured, to prove no workspace has a platform address", false);
    }
  });

  // ─── C. On a scratch control plane ─────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const controlName = `${realName}_namerules_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    section("C. A scratch control plane");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;

    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const rulesLib = require("../src/lib/platform/name-rules") as typeof import("../src/lib/platform/name-rules");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const signup = require("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const nameActions = require("../src/actions/platform/console-names") as typeof import("../src/actions/platform/console-names");
    const consoleData = require("../src/lib/platform/console-data") as typeof import("../src/lib/platform/console-data");
    const params = require("../src/lib/console-shared/params") as typeof import("../src/lib/console-shared/params");
    const findWorkspaces = require("../src/lib/platform/find-workspaces") as typeof import("../src/lib/platform/find-workspaces");
    const { SignupFlow } = require("../src/components/platform/signup-flow") as typeof import("../src/components/platform/signup-flow");
    const { SignupFormBlock } = require("../src/components/site/blocks/signup-form") as typeof import("../src/components/site/blocks/signup-form");
    const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
    const namesPage = pageAt("names/page");
    const invitesPage = pageAt("invites/page");
    cleanup = async () => {
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const applied = await control.$queryRaw<{ name: string }[]>`SELECT "migration_name"::text AS "name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`;
    ok("built from its migrations — the name rules' among them", applied.some((r) => r.name === "20261009100000_workspace_name_rules"));

    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:name-rules" } });
      jar.set("deskzo-console", token);
    };
    const addStaff = async (email: string, name: string, role: "OWNER" | "ADMIN" | "SUPPORT" | "BILLING" | "READONLY") => (await staffLib.createStaff({ email, name, role }, "script:check:name-rules")).id;
    const ids = {
      owner: await addStaff("owner@zznr.example", "Zz Names Owner", "OWNER"),
      admin: await addStaff("admin@zznr.example", "Zz Names Admin", "ADMIN"),
      support: await addStaff("support@zznr.example", "Zz Names Support", "SUPPORT"),
      billing: await addStaff("billing@zznr.example", "Zz Names Billing", "BILLING"),
      readonly: await addStaff("readonly@zznr.example", "Zz Names Readonly", "READONLY"),
    };
    const audits = (action: string, actor?: string) => control.platformAuditLog.findMany({ where: { action, ...(actor ? { actor } : {}) }, orderBy: { at: "asc" }, select: { actor: true, detail: true } });
    const why = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));
    // A workspace that already has a name: a block lets it keep it.
    const existing = await control.tenant.create({ data: { slug: "zznr-existing", name: "Zz Existing", status: "ACTIVE", keyBundleCipher: "zz", country: "IN", currency: "INR", timezone: "Asia/Kolkata" }, select: { id: true } });

    await part("C1. The rules loader", async () => {
      rulesLib.forgetNameRules();
      ok("no rules: the built-in rules alone", (await rulesLib.nameRules()).length === 0);
      await control.workspaceNameRule.create({ data: { value: "zzcached", kind: "BLOCK_EXACT", reason: "zz loader", createdBy: ids.owner } });
      ok("cached: a rule written behind its back is not seen at once", !(await rulesLib.nameRules()).some((r) => r.value === "zzcached"));
      rulesLib.forgetNameRules();
      ok("  and is, once forgotten", (await rulesLib.nameRules()).some((r) => r.value === "zzcached"));
      ok("slugProblem uses it", (await provisioning.slugProblem("zzcached")) === NAME_RESERVED);
      // A failed read: the table is away for a moment.
      await control.$executeRawUnsafe(`ALTER TABLE "workspace_name_rules" RENAME TO "workspace_name_rules_away"`);
      rulesLib.forgetNameRules();
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      let failed: readonly unknown[] | null = null;
      try {
        failed = await rulesLib.nameRules();
      } finally {
        console.error = originalError;
        await control.$executeRawUnsafe(`ALTER TABLE "workspace_name_rules_away" RENAME TO "workspace_name_rules"`);
      }
      ok("fail-safe: a failed read is the built-in rules alone, and it is logged", Array.isArray(failed) && failed.length === 0 && errors.some((e) => e.includes("only the built-in rules apply")), errors.join(" | "));
      rulesLib.forgetNameRules();
      ok("  and the next read finds them again", (await rulesLib.nameRules()).some((r) => r.value === "zzcached"));
      await control.workspaceNameRule.deleteMany({ where: { value: "zzcached" } });
      rulesLib.forgetNameRules();
    });

    await part("C2. Who may change the rules", async () => {
      for (const role of ["support", "billing", "readonly"] as const) {
        await actAs(ids[role]);
        const block = await nameActions.consoleBlockName({ value: "zznope", kind: "BLOCK_EXACT", reason: "zz no" });
        const release = await nameActions.consoleReleaseName({ value: "books", reason: "zz no" });
        const impact = await nameActions.consoleNameImpact({ value: "zznope", kind: "BLOCK_EXACT" });
        ok(`${role}: can't block, release or preview`, !block.ok && !release.ok && !impact.ok, [why(block), why(release)].join(" | "));
      }
      jar.delete("deskzo-console");
      ok("signed out: nothing", !(await nameActions.consoleTestName({ slug: "books" })).ok);
      await actAs(ids.readonly);
      const test = await nameActions.consoleTestName({ slug: "books", legalName: "Books Pvt Ltd" });
      ok("read-only staff may test a name", test.ok && test.data.signup.says === NAME_RESERVED && test.data.signup.decidedBy.includes("reserved word"), JSON.stringify(test));
      ok(`no rule was made by them`, (await control.workspaceNameRule.count()) === 0);
    });

    await part("C3. Blocking and unblocking", async () => {
      await actAs(ids.admin);
      const preview = await nameActions.consoleNameImpact({ value: "existing", kind: "BLOCK_WORD" });
      ok("the preview names the workspaces that already have such a name", preview.ok && preview.data.workspaceCount === 1 && preview.data.workspaces[0] === "zznr-existing", JSON.stringify(preview));
      const hostPreview = await nameActions.consoleNameImpact({ value: "www", kind: "BLOCK_EXACT" });
      ok("  and says a platform address can't be blocked — it is locked already", hostPreview.ok && (hostPreview.data.problem ?? "").includes("platform's own addresses"));
      const noReason = await nameActions.consoleBlockName({ value: "zznr-blocked", kind: "BLOCK_EXACT", reason: " " });
      ok("a block needs a reason", !noReason.ok && why(noReason).includes("Say why"));
      const exact = await nameActions.consoleBlockName({ value: "ZZNR-Blocked ", kind: "BLOCK_EXACT", reason: "zz an impostor" });
      ok("an admin blocks an exact name (as typed: trimmed, lower case)", exact.ok && (await control.workspaceNameRule.count({ where: { value: "zznr-blocked", kind: "BLOCK_EXACT" } })) === 1, why(exact));
      ok("  every new workspace is refused it, in the customer's words", (await provisioning.slugProblem("zznr-blocked")) === NAME_RESERVED && (await signup.checkWorkspaceName("zznr-blocked", "Zznr Blocked Ltd")).ok === false);
      const again = await nameActions.consoleBlockName({ value: "zznr-blocked", kind: "BLOCK_EXACT", reason: "zz twice" });
      ok("  twice is refused", !again.ok && why(again).includes("blocked already"));
      const word = await nameActions.consoleBlockName({ value: "existing", kind: "BLOCK_WORD", reason: "zz the word" });
      ok("a word an existing workspace has: allowed, and it says the workspace keeps it", word.ok && word.data.workspaces === 1, why(word));
      ok("  the workspace keeps its address — still there, still served", (await control.tenant.count({ where: { id: existing.id } })) === 1 && hostOf("zznr-existing").kind === "tenant");
      ok("  a new one with the word is refused", (await provisioning.slugProblem("zz-existing-two")) === NAME_RESERVED);
      const hostBlock = await nameActions.consoleBlockName({ value: "api", kind: "BLOCK_EXACT", reason: "zz no" });
      ok("a platform address can't be blocked", !hostBlock.ok && why(hostBlock).includes("platform's own addresses"));
      const entries = await audits("names.block", ids.admin);
      ok("each block is in the audit log, under the admin, with the workspaces that keep it", entries.length === 2 && (entries[1]?.detail as { value?: string; workspaces?: number }).value === "existing" && (entries[1]?.detail as { workspaces?: number }).workspaces === 1, JSON.stringify(entries));
      const exactRule = await control.workspaceNameRule.findFirstOrThrow({ where: { value: "zznr-blocked" } });
      const unblock = await nameActions.consoleRemoveNameRule(exactRule.id);
      ok("unblocking: the name may be had again", unblock.ok && (await provisioning.slugProblem("zznr-blocked")) === null, why(unblock));
      ok("  in the audit log as names.unblock", (await audits("names.unblock", ids.admin)).some((e) => (e.detail as { value?: string }).value === "zznr-blocked"));
      ok("  a rule that is gone is refused in words", why(await nameActions.consoleRemoveNameRule(exactRule.id)) === "That rule no longer exists.");
    });

    await part("C4. Releasing, and blocking again", async () => {
      await actAs(ids.owner);
      const hostRelease = await nameActions.consoleReleaseName({ value: "admin", reason: "zz no" });
      ok("a platform address can't be released, and it says why", !hostRelease.ok && why(hostRelease).includes("never be released"), why(hostRelease));
      const nothing = await nameActions.consoleReleaseName({ value: "acme", reason: "zz no" });
      ok("only a built-in word can be released", !nothing.ok && why(nothing).includes("nothing to release"));
      ok("before: \"books\" is reserved for everybody", (await provisioning.slugProblem("books")) === NAME_RESERVED);
      const books = await nameActions.consoleReleaseName({ value: "books", reason: "zz a bookshop chain asked" });
      ok("an owner releases \"books\"", books.ok, why(books));
      ok("  a workspace staff set up may be called books now", (await provisioning.slugProblem("books")) === null);
      ok("  signup still needs eight letters made from the registered name", (await signup.checkWorkspaceName("books", "Books Pvt Ltd")).ok === false && (await signup.checkWorkspaceName("booksandmore", "Books And More Pvt Ltd")).ok === true);
      ok("  books. is served once a workspace has it", hostOf("books").kind === "tenant");
      ok("\"deskzosolutions\" is refused before \"deskzo\" is released", !(await signup.checkWorkspaceName("deskzosolutions", "Deskzo Solutions Pvt Ltd")).ok);
      const ours = await nameActions.consoleReleaseName({ value: "deskzo", reason: "zz a licensed reseller" });
      ok("  and a signup may have it after", ours.ok && (await signup.checkWorkspaceName("deskzosolutions", "Deskzo Solutions Pvt Ltd")).ok === true, why(ours));
      const test = await nameActions.consoleTestName({ slug: "deskzosolutions", legalName: "Deskzo Solutions Pvt Ltd" });
      ok("Test a name: what signup says, which rule decided, and staff's reason", test.ok && test.data.signup.ok && test.data.signup.decidedBy.includes('released "deskzo"') && test.data.signup.reason === "deskzo: zz a licensed reseller" && test.data.signup.says.startsWith("deskzosolutions."), JSON.stringify(test));
      ok("  in the audit log as names.release", (await audits("names.release", ids.owner)).length === 2);
      const ourRelease = await control.workspaceNameRule.findFirstOrThrow({ where: { kind: "RELEASE", value: "deskzo" } });
      const reprotect = await nameActions.consoleRemoveNameRule(ourRelease.id);
      ok("  protecting it again: refused again", reprotect.ok && !(await signup.checkWorkspaceName("deskzosolutions", "Deskzo Solutions Pvt Ltd")).ok, why(reprotect));
      const rule =await control.workspaceNameRule.findFirstOrThrow({ where: { kind: "RELEASE", value: "books" } });
      const reblock = await nameActions.consoleRemoveNameRule(rule.id);
      ok("blocking \"books\" again: reserved again", reblock.ok && (await provisioning.slugProblem("books")) === NAME_RESERVED, why(reblock));
      ok("  in the audit log as names.unrelease", (await audits("names.unrelease", ids.owner)).some((e) => (e.detail as { value?: string }).value === "books"));
    });

    await part("C5. Holding an address on an invitation", async () => {
      await actAs(ids.admin);
      const make = (input: Partial<Parameters<typeof consoleActions.consoleCreateInvite>[0]>) => consoleActions.consoleCreateInvite({ note: "zz hold", uses: 3, days: 14, ...input });
      const held = await make({ holdSlug: "zznr-held" });
      ok("an admin holds an ordinary name on a new invitation", held.ok, why(held));
      const code = held.ok ? held.data.code : "";
      const row = await control.signupInvite.findUniqueOrThrow({ where: { codeHash: sha256(code) } });
      ok("  the invitation holds it, for one signup", row.heldSlug === "zznr-held" && row.maxUses === 1 && !row.heldSlugSkipsReserved);
      const holdEntry = (await audits("invite.hold", ids.admin))[0];
      ok("  in the audit log as invite.hold, by the hash's first eight characters only", (holdEntry?.detail as { slug?: string; codeHashPrefix?: string })?.slug === "zznr-held" && (holdEntry?.detail as { codeHashPrefix?: string }).codeHashPrefix === row.codeHash.slice(0, 8) && !JSON.stringify(holdEntry).includes(row.codeHash));
      ok("  nobody else may have it: \"That name is taken.\"", (await provisioning.slugProblem("zznr-held")) === NAME_TAKEN && (await signup.checkWorkspaceName("zznr-held", "Zznr Held Ltd")).ok === false);
      ok("  a second hold of it is refused", why(await make({ holdSlug: "zznr-held" })) === "Another live invitation already holds zznr-held.");
      ok("never a platform address, with the tick or without", why(await make({ holdSlug: "status", holdSkipsReserved: true })).includes("platform's own addresses"));
      ok("never one a workspace has", why(await make({ holdSlug: "zznr-existing", holdSkipsReserved: true })) === "A workspace already has zznr-existing.");
      ok("without the tick: never reserved, blocked or protected", why(await make({ holdSlug: "crm" })).includes("To hold it anyway") && why(await make({ holdSlug: "mydeskzo" })).includes("To hold it anyway"));
      ok("the tick without an address is refused", !(await make({ holdSkipsReserved: true })).ok);
      for (const role of ["support", "billing", "readonly"] as const) {
        await actAs(ids[role]);
        ok(`${role}: no invitations, so no hold and no tick`, !(await make({ holdSlug: "zznr-other", holdSkipsReserved: true })).ok);
      }
      await actAs(ids.owner);
      const crm = await make({ holdSlug: "crm", holdSkipsReserved: true });
      ok("an owner holds a reserved word with the tick", crm.ok && (await control.signupInvite.findFirst({ where: { heldSlug: "crm" } }))?.heldSlugSkipsReserved === true, why(crm));
      const crmCode = crm.ok ? crm.data.code : "";
      const plain = await make({});
      const plainCode = plain.ok ? plain.data.code : "";

      section("  the lookup the form uses");
      ok("the right code: exactly the held name", JSON.stringify(await signup.heldAddress(code)) === '{"slug":"zznr-held"}' && JSON.stringify(await signup.heldAddress(` ${crmCode} `)) === '{"slug":"crm"}');
      const answers = await Promise.all(["not-a-code-at-all", plainCode, "", "x".repeat(200), code.slice(0, -1)].map((c) => signup.heldAddress(c)));
      ok("a wrong code, one that holds nothing, a short or a huge one: the same null — nothing else", answers.every((a) => a === null), JSON.stringify(answers));
      ok("  the lookup is limited: past the process's ceiling, null for every code", await (async () => {
        findWorkspaces.resetSiteAllowances();
        for (let i = 0; i < 1000; i += 1) findWorkspaces.siteAllowance([{ key: "platform|held-lookup:all", max: 1000 }]);
        const limited = await signup.heldAddress(code);
        findWorkspaces.resetSiteAllowances();
        return limited === null && JSON.stringify(await signup.heldAddress(code)) === '{"slug":"zznr-held"}';
      })());

      section("  signing up with it");
      requestHeaders.set("host", "www.localhost:3000");
      const form = { companyName: "Unrelated Trading Company Pvt Ltd", slug: "zznr-held", ownerName: "Asha Zz", email: "asha@zznr-held.example", password: "correct horse battery", country: "IN", invite: code };
      const other = await signup.startSignup({ ...form, slug: "unrelatedtrading", email: "x@zznr-held.example" });
      ok("another address with this code is refused, naming the held one", why(other) === "Your invitation comes with its own address: zznr-held.", why(other));
      const without = await signup.startSignup({ ...form, companyName: "Zznr Held Pvt Ltd", invite: plainCode, email: "y@zznr-held.example" });
      ok("the held name with another code is refused: taken", why(without) === NAME_TAKEN, why(without));
      jar.clear();
      const started = await signup.startSignup(form);
      ok("the right code gets it — not made from the registered name, the signup rules skipped", started.ok && mail.some((m) => m.subject.includes("zznr-held.")), why(started));
      const codeSent = mail.find((m) => m.to === form.email)?.subject.match(/(\d{6})$/)?.[1] ?? "";
      const pending = await control.pendingSignup.findFirst({ where: { email: form.email } });
      ok("  the registered business name is still asked for and kept", pending?.companyName === form.companyName && pending.slug === "zznr-held");
      const verified = await signup.verifySignup(codeSent);
      const tenant = await control.tenant.findUnique({ where: { slug: "zznr-held" }, select: { status: true, name: true } });
      ok("  and provisioning, checking again with the same hold, queues the workspace", verified.ok && tenant?.status === "PROVISIONING" && tenant.name === form.companyName && workerStarts === 1, why(verified));
      ok("  the invitation is spent, and the name is now a workspace's", (await control.signupInvite.findUniqueOrThrow({ where: { codeHash: sha256(code) } })).uses === 1 && (await provisioning.slugProblem("zznr-held")) === NAME_TAKEN);
      ok("  a used-up invitation's code looks up nothing", (await signup.heldAddress(code)) === null);

      section("  a reserved word held with the tick");
      jar.clear();
      const crmForm = { ...form, companyName: "Acme Ltd", slug: "crm", email: "ravi@zznr-crm.example", invite: crmCode };
      const crmStarted = await signup.startSignup(crmForm);
      ok("\"crm\" — three letters, a reserved word — is the customer's with that code", crmStarted.ok, why(crmStarted));
      ok("  and nobody else's — to them it is still reserved", (await provisioning.slugProblem("crm")) === NAME_RESERVED &&why(await signup.startSignup({ ...crmForm, invite: plainCode, email: "z@zznr-crm.example" })) === NAME_RESERVED);
      const crmCodeSent = mail.find((m) => m.to === crmForm.email)?.subject.match(/(\d{6})$/)?.[1] ?? "";
      const crmVerified = await signup.verifySignup(crmCodeSent);
      ok("  provisioning honours the tick: the workspace is queued", crmVerified.ok && (await control.tenant.count({ where: { slug: "crm" } })) === 1, why(crmVerified));
      ok("  and crm. is served as it", hostOf("crm").kind === "tenant");
      ok("provisioning without the hold refuses a reserved word still", (await provisioning.slugProblem("helpdesk")) === NAME_RESERVED);

      section("  the tick is honoured only when set");
      await actAs(ids.admin);
      const plainHold = await make({ holdSlug: "zznr-plain" });
      const plainHoldCode = plainHold.ok ? plainHold.data.code : "";
      await nameActions.consoleBlockName({ value: "zznr-plain", kind: "BLOCK_EXACT", reason: "zz blocked after the hold" });
      jar.clear();
      const blockedSignup = await signup.startSignup({ ...form, slug: "zznr-plain", email: "b@zznr-plain.example", invite: plainHoldCode });
      ok("a hold without the tick, blocked afterwards: the signup is refused", why(blockedSignup) === NAME_RESERVED, why(blockedSignup));
      ok("  provisioning with that hold refuses it too", (await provisioning.slugProblem("zznr-plain", { hold: { codeHash: sha256(plainHoldCode), slug: "zznr-plain", skipsReserved: false } })) === NAME_RESERVED);
      ok("  the same hold with the tick would pass it", (await provisioning.slugProblem("zznr-plain", { hold: { codeHash: sha256(plainHoldCode), slug: "zznr-plain", skipsReserved: true } })) === null);

      section("  an expired, used or ended hold doesn't block");
      await actAs(ids.admin);
      const lapse = await make({ holdSlug: "zznr-lapse" });
      const lapseHash = sha256(lapse.ok ? lapse.data.code : "");
      await control.signupInvite.update({ where: { codeHash: lapseHash }, data: { expiresAt: new Date(Date.now() - DAY) } });
      ok("expired: anybody may have the name again", (await provisioning.slugProblem("zznr-lapse")) === null && (await signup.heldAddress(lapse.ok ? lapse.data.code : "")) === null);
      const rehold = await make({ holdSlug: "zznr-lapse" });
      ok("  a new hold of it is made, and the expired invitation lets go of it in the same transaction", rehold.ok && (await control.signupInvite.findUniqueOrThrow({ where: { codeHash: lapseHash } })).heldSlug === null, why(rehold));
      const used = await make({ holdSlug: "zznr-used" });
      await control.signupInvite.update({ where: { codeHash: sha256(used.ok ? used.data.code : "") }, data: { uses: 1 } });
      ok("used up: the same", (await provisioning.slugProblem("zznr-used")) === null && (await make({ holdSlug: "zznr-used" })).ok);
      const ending = await make({ holdSlug: "zznr-ending" });
      const endingHash = sha256(ending.ok ? ending.data.code : "");
      const ended = await consoleActions.consoleEndInvite(endingHash);
      ok("ending an invitation lets its address go at once", ended.ok && (await control.signupInvite.findUniqueOrThrow({ where: { codeHash: endingHash } })).heldSlug === null && (await provisioning.slugProblem("zznr-ending")) === null, why(ended));
      ok("  the audit entry names it", (await audits("invite.end", ids.admin)).some((e) => (e.detail as { heldSlug?: string }).heldSlug === "zznr-ending"));
      const race = await Promise.all([make({ holdSlug: "zznr-race" }), make({ holdSlug: "zznr-race" })]);
      ok("two holds of one name at once: one is made, the other is told it is held", race.filter((r) => r.ok).length === 1 && race.some((r) => why(r) === "Another live invitation already holds zznr-race."), race.map(why).join(" | "));
    });

    await part("C6. Audit labels", async () => {
      for (const action of ["names.block", "names.unblock", "names.release", "names.unrelease", "invite.hold"]) {
        const label = labels.auditLabel(action, {});
        ok(`${action}: "${label.title}", in ${label.category}`, label.title !== action && label.category === (action.startsWith("names.") ? "names" : "invites"));
      }
      ok("summaries say what changed", labels.auditSummary("names.block", { value: "acme", kind: "BLOCK_WORD", reason: "zz", workspaces: 2 }, indiaClock) === "acme · any name with this word · “zz” · 2 workspaces keep it" || (labels.auditSummary("names.block", { value: "acme", kind: "BLOCK_WORD", reason: "zz", workspaces: 2 }, indiaClock) ?? "").includes("2 workspaces keep it"));
      ok("  an ended invitation names the address it let go", labels.auditSummary("invite.end", { codeHashPrefix: "abcd1234", heldSlug: "acme" }, indiaClock) === "acme no longer held");
      ok("names.* entries lead to the Workspace names page", labels.auditHref("names.release", { value: "books" }, null) === "/names" && labels.auditHref("invite.hold", {}, null) === "/invites");
    });

    await part("C7. Pages", async () => {
      // A release, to show on the page.
      await actAs(ids.owner);
      await nameActions.consoleReleaseName({ value: "zoho", reason: "zz a partner's reseller" });
      const tick = await consoleActions.consoleCreateInvite({ note: "zz tick", uses: 1, days: 14, holdSlug: "zznr-tick", holdSkipsReserved: true });
      ok("a live invitation holding a name with the tick, to list", tick.ok, why(tick));
      const pages: Record<string, string> = {};
      for (const role of ["owner", "admin", "support", "billing", "readonly"] as const) {
        await actAs(ids[role]);
        const html = await render(namesPage).catch((err: Error) => `FAILED ${err.message}`);
        pages[role] = html;
        saveRender(`names-${role}.html`, html);
        // "null" and "undefined" are platform addresses, listed as such; anywhere else they would be a bug.
        const text = textOf(html.replace(/>(null|undefined)<\/li>/g, "></li>"));
        ok(`/names renders for ${role}`, !html.startsWith("FAILED") && text.includes("Workspace names") && text.includes("Test a name") && !/\bundefined\b|\bNaN\b/.test(text), html.startsWith("FAILED") ? html : (text.match(/.{60}\b(undefined|NaN)\b.{30}/)?.[0] ?? ""));
      }
      const owner = textOf(pages.owner);
      ok("the platform addresses: locked, with why", owner.includes("Platform addresses") && owner.includes("Locked") && owner.includes("can never be a workspace") && pages.owner.includes(">mta-sts<"));
      ok("  the reserved words, our name and competitors, each with its group", owner.includes("Reserved words") && owner.includes("Our name") && owner.includes("Competitors"));
      ok("managers get Block a name, Release and Block again", ["owner", "admin"].every((r) => pages[r].includes("Block a name") && pages[r].includes("Release books") && pages[r].includes("Block zoho again")));
      ok("  support, billing and read-only staff see the same lists, without them", ["support", "billing", "readonly"].every((r) => !pages[r].includes("Block a name") && !pages[r].includes("Release books") && !pages[r].includes("Block zoho again") && pages[r].includes("zoho") && pages[r].includes("zz a partner")));
      ok("staff rules: value, kind in words, reason, who, when", owner.includes("existing") && owner.includes("Blocked: any name with this word") && owner.includes("zz the word") && owner.includes("Zz Names Admin") && owner.includes("Released: a built-in word let through"));
      jar.delete("deskzo-console");
      ok("signed out, /names sends you to sign in", (await render(namesPage).catch((err: Error) => err.message)) === "redirect /login");

      await actAs(ids.admin);
      const invites = await render(invitesPage, { status: "all" }).catch((err: Error) => `FAILED ${err.message}`);
      saveRender("invites-all.html", invites);
      const inv = textOf(invites);
      ok("/invites shows the address each invitation holds", !invites.startsWith("FAILED") && inv.includes("Holds address") && inv.includes("zznr-plain") && inv.includes("Held · may be reserved") && inv.includes("No longer held"), invites.slice(0, 300));
      const board = await consoleData.invitesBoard(params.parseInviteFilters({ status: "all" }));
      ok("  the loader carries it, and the workspace suffix for the dialog", board.rows.some((r) => r.heldSlug === "zznr-plain" && r.state === "live") && board.workspaceSuffix.startsWith(`.${host.PLATFORM_DOMAIN}`));

      // The signup form, with an address held.
      const flowHeld = renderToStaticMarkup(createElement(SignupFlow, { suffix: ".localhost:3000", countries: [{ code: "IN", name: "India" }] as never, inviteRequired: true, invite: "zzCODE123", held: "zznr-plain" }));
      saveRender("signup-held.html", flowHeld);
      ok("the signup form with a held address: filled in, locked, and says so", /id="slug"[^>]*readonly=""/i.test(flowHeld) && flowHeld.includes('value="zznr-plain"') && flowHeld.includes("This address was set up for you") && flowHeld.includes('value="zzCODE123"'), flowHeld.slice(0, 400));
      ok("  the registered business name is still asked for, no longer said to make the address", flowHeld.includes('id="company"') && !flowHeld.includes("your address is made from it"));
      const flowPlain = renderToStaticMarkup(createElement(SignupFlow, { suffix: ".localhost:3000", countries: [{ code: "IN", name: "India" }] as never, inviteRequired: true }));
      saveRender("signup-plain.html", flowPlain);
      ok("  without one: the address is the visitor's, with the signup rules beside it", !/id="slug"[^>]*readonly/i.test(flowPlain) && flowPlain.includes("At least 8 letters or digits") && !flowPlain.includes("set up for you"));
      const ctx = (query: Record<string, string>) => ({ settings: { siteName: "Zz", tagline: "", displayDomain: "", salesEmail: "" }, signupOpen: false, trialDays: 14, searchParams: query, workspaceSuffix: ".localhost:3000", hiddenPaths: [] }) as never;
      const block = renderToStaticMarkup(createElement(SignupFormBlock, { props: { heading: "Set up" }, ctx: ctx({ invite: "zzCODE123", held: "zznr-plain" }) }));
      saveRender("signup-block-held.html", block);
      ok("the site's signup block passes the code and the held address from its query", block.includes("This address was set up for you") && block.includes('value="zznr-plain"'));
      const forged = renderToStaticMarkup(createElement(SignupFormBlock, { props: { heading: "Set up" }, ctx: ctx({ held: "zznr-plain" }) }));
      ok("  a held address without a code locks nothing", !forged.includes("set up for you"));
      const view = readFileSync(path.join(process.cwd(), "src", "components", "site", "page-view.tsx"), "utf8");
      const signupPage = readFileSync(path.join(process.cwd(), "src", "app", "platform-site", "signup", "page.tsx"), "utf8");
      ok("  and the site drops a visitor's own `held` everywhere but the signup page, which looks the code up itself", /REFERRAL_KEYS = \[[^\]]*"held"/.test(view) && /delete query\.held;/.test(signupPage) && /heldAddress\(invite\)/.test(signupPage));
    });

    await part("C8. The code behind it", async () => {
      const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
      const actions = src("src/actions/platform/console-names.ts");
      const exported = [...actions.matchAll(/export async function (\w+)\([\s\S]*?\{\n\s*return asStaff\((\w+)/g)].map((m) => `${m[1]}:${m[2]}`);
      ok("every names action checks the role: managers change, everybody tests", JSON.stringify(exported.sort()) === JSON.stringify(["consoleBlockName:MANAGERS", "consoleNameImpact:MANAGERS", "consoleReleaseName:MANAGERS", "consoleRemoveNameRule:MANAGERS", "consoleTestName:ALL_ROLES"]), exported);
      const consoleTs = src("src/actions/platform/console.ts");
      ok("the reserved-word tick is checked against OWNER and ADMIN on the server", /const HOLD_RESERVED = MANAGERS;/.test(consoleTs) && /skipsReserved && !hasRole\(staff\.role, HOLD_RESERVED\)/.test(consoleTs));
      ok("the dialog draws the tick only for them", /mayHoldReserved && heldSlug &&/.test(src("src/components/console/invites/new-invite-dialog.tsx")));
      ok("the console's action file is classified (check:module-guards)", /"platform\/console-names\.ts": "platform"/.test(src("src/lib/module-actions.ts")));
      ok("workspace-names.ts reads no database and imports nothing — client-safe", !/^import /m.test(src("src/lib/workspace-names.ts")));
    });
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch((err) => console.error("could not drop the scratch control plane", err));
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} name-rule checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
