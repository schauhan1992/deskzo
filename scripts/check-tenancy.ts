/**
 * Multi-tenancy guard rails — the static half. src/lib/tenancy and the SaaS plan.
 *
 * One server answers for every workspace, each with its own database. What can leak one
 * customer's data or settings into another's is not a query — each query goes to the right
 * database — but everything a process remembers between requests, and everything that reaches
 * past the per-workspace plumbing to the install's own settings. This fails on:
 *
 *   · the array form of $transaction (its queries must be built on one client up front, which the
 *     per-workspace db can't offer — the interactive form is the only one);
 *   · `new PrismaClient()` outside the files allowed to open one;
 *   · reading the install's own DATABASE_URL, AUTH_SECRET or public address directly;
 *   · trusting `x-forwarded-host` outside the one place that validates it;
 *   · reading the caller's address (`x-forwarded-for`, `x-real-ip`) outside the one place that knows
 *     which entry to believe;
 *   · module-level caches, counters and timers — each must be listed below as per-workspace,
 *     shared on purpose (public data), a read-only lookup, or a test override;
 *   · Next's data cache (`"use cache"`, `unstable_cache`) and a bare `after()`;
 *   · starting a worker process without saying which workspace it is for.
 *
 * Entries marked `pending` are the known places the plan converts in a named milestone. They are
 * allowed until then, and the check fails if one disappears without being taken off the list — so
 * the list only ever shrinks, and always says exactly what is left.
 *
 *   npm run check:tenancy
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type Allowed = { reason: string; pending?: `M${number}`; keyed?: boolean };

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

// ─── What is allowed, and why ────────────────────────────────────────────────────────────────────

/** Files that may open a database client of their own. */
const PRISMA_CLIENTS: Record<string, Allowed> = {
  "src/lib/tenancy/clients.ts": { reason: "the one client every workspace shares, routing each query to its workspace's pool — every db call goes through it" },
  "src/lib/tenancy/direct-client.ts": { reason: "a client of its own on one named database — the provisioner, a new workspace before it is served, scripts and seeds" },
  "src/lib/platform/control-db.ts": { reason: "the control plane's own client — which workspaces exist, never workspace data" },
  "src/lib/platform/reference-db.ts": { reason: "the shared reference database — facts about the world, the same for every workspace" },
};

/** Reads of the install's own identity: its database, its secret, its public address. */
const PLATFORM_ENV = /process\.env\.(DATABASE_URL|AUTH_SECRET|NEXTAUTH_URL|AUTH_URL|INTERNAL_APP_URL)\b/;
const ENV_READS: Record<string, Allowed> = {
  "src/lib/tenancy/registry.ts": { reason: "DATABASE_URL is the first workspace until it is adopted into the control plane" },
  "src/lib/tenancy/keys.ts": { reason: "AUTH_SECRET: the first workspace's keys before adoption, and check-suite workspaces'" },
  "src/lib/platform/provisioner.ts": { reason: "DATABASE_URL: in development, the provisioner is the same server's maintenance database" },
  "src/lib/tenancy/render-target.ts": { reason: "INTERNAL_APP_URL: where the server's own browser reaches the app, used with the workspace's hostname" },
  "src/lib/tenancy/direct-client.ts": { reason: "DATABASE_URL: the default address of a script's or seed's own client — requests go through db, never here" },
};

/** `x-forwarded-host` is a claim anybody can send; only src/lib/tenancy/host.ts may weigh it. */
const FORWARDED_HOST: Record<string, Allowed> = {};

/** The caller's address: its first X-Forwarded-For entry is the caller's own claim; only src/lib/client-ip.ts may read it. */
const FORWARDED_FOR: Record<string, Allowed> = {};

/** Worker processes: each must be told its workspace (DESKZO_TENANT_ID) rather than inherit the install's. */
const SPAWNS: Record<string, Allowed> = {
  "src/lib/platform/reference-sync.ts": { reason: "PIN and GeoNames sync workers write the shared reference database, which belongs to no workspace" },
  "src/lib/platform/migrate.ts": { reason: "prisma migrate deploy, told the one database it migrates — not a workspace" },
  "src/actions/platform/signup.ts": { reason: "the platform worker, which sets workspaces up — it belongs to none of them" },
  "src/actions/platform/console.ts": { reason: "the platform worker, started from the console to retry a job or top up the warm pool" },
};

/**
 * Module-level state in server code, by `file:name`. Everything not listed fails, and so does a
 * listed entry that no longer exists. A `const` Map or Set that nothing ever adds to or removes from
 * is a read-only lookup and needs no entry.
 */
/** Keyed by tenantKey() — the file must import it, which the check confirms. */
const PER_WORKSPACE: Allowed = { reason: "remembers something about one workspace — keyed by tenantKey()", keyed: true };
/** Keyed by strings its callers build; each caller prefixes the workspace (see the grep below). */
const CALLER_KEYED = (why: string): Allowed => ({ reason: `per workspace — ${why}` });
const STATE: Record<string, Allowed> = {
  "src/lib/access/gate.ts:verdicts": PER_WORKSPACE,
  "src/lib/branches/identity.ts:adopted": PER_WORKSPACE,
  "src/lib/access/gate.ts:rulesCache": PER_WORKSPACE,
  "src/lib/access/gate.ts:policyCache": PER_WORKSPACE,
  "src/lib/access/gate.ts:seenRecently": PER_WORKSPACE,
  "src/lib/access/lock.ts:cached": PER_WORKSPACE,
  "src/lib/maintenance.ts:cached": PER_WORKSPACE,
  "src/lib/maintenance.ts:bypassCache": PER_WORKSPACE,
  "src/lib/security/bulk-read.ts:windows": CALLER_KEYED("noteReads is called with the workspace-prefixed key"),
  "src/lib/security/lockout.ts:buckets": CALLER_KEYED("sign-in builds its keys with the workspace (actions/auth.ts)"),
  "src/lib/security/store.ts:cache": PER_WORKSPACE,
  "src/lib/security/throttle.ts:entries": CALLER_KEYED("every throttle() key starts with the workspace"),
  "src/lib/security-settings.ts:cache": PER_WORKSPACE,
  "src/lib/performance/announce.ts:lastLazyRun": PER_WORKSPACE,
  "src/lib/wins/detect.ts:lastLazyRun": PER_WORKSPACE,
  "src/lib/wins/prize-announce.ts:lastLazyRun": PER_WORKSPACE,
  "src/lib/automation-user.ts:memo": PER_WORKSPACE,

  "src/lib/access/geo.ts:loaded": { reason: "shared: the GeoIP database file, public data, one per install" },
  "src/lib/access/geo.ts:checkedAt": { reason: "shared: when the GeoIP file was last looked at" },
  "src/lib/email-verification-lookup.ts:mxCache": { reason: "shared: public DNS answers" },
  "src/lib/finance/exchange-rate.ts:cache": { reason: "shared: public exchange rates" },
  "src/lib/platform/support.ts:grantCache": CALLER_KEYED("keyed by the workspace's id, which every caller passes"),
  "src/lib/platform/kek.ts:cached": { reason: "shared: the platform key, derived once from PLATFORM_MASTER_KEY" },
  "src/lib/platform/announcements.ts:cache": { reason: "shared: the platform's live announcements, the same for every workspace — filtered per workspace when read" },
  "src/lib/platform/help-content.ts:cache": { reason: "shared: Deskzo's live help articles, videos and What's new (control plane), the same for every workspace — filtered per workspace when read, cleared by the console on save" },
  "src/lib/platform/help-content.ts:generation": { reason: "shared: counts the help content cache's invalidations, so a read begun before one is not stored — no workspace data" },
  "src/lib/platform/help-content.ts:inflight": { reason: "shared: the read of Deskzo's help content in progress, so concurrent pages share one query — no workspace data" },
  "src/lib/platform/site-content.ts:cache": { reason: "shared: the public site's published content, the same for every visitor, no workspace data — cleared by the CMS on publish" },
  "src/lib/platform/site-content.ts:generation": { reason: "shared: counts the site content cache's invalidations, so a read begun before one is not stored — no workspace data" },
  "src/lib/platform/site-content.ts:lastFailureLog": { reason: "shared: when the site last logged that its published content was unreachable (at most every ten minutes)" },
  "src/lib/cms/redirects.ts:loadedMap": { reason: "shared: the public site's enabled redirects (control plane), the same for every visitor, no workspace data — read every 60 s, and again after a save" },
  "src/lib/cms/redirects.ts:loadingMap": { reason: "shared: the read of the public site's redirect map in progress, so concurrent lookups share one query — no workspace data" },
  "src/lib/cms/redirects.ts:lastLoadFailure": { reason: "shared: when the redirect map last failed to load, so a down database is not asked on every request — no workspace data" },
  "src/lib/cms/redirects.ts:lastFailureLog": { reason: "shared: when the redirect manager last logged a failure (at most every ten minutes)" },
  "src/lib/cms/redirects.ts:pendingHits": { reason: "shared: hit counts of the public site's redirects waiting for their once-a-minute write — redirect ids and counts, no workspace data" },
  "src/lib/cms/redirects.ts:hitFlushTimer": { reason: "shared: the timer that writes the public site's redirect hits once a minute" },
  "src/lib/cms/redirects.ts:testLoader": { reason: "test override, set only by check scripts" },
  "src/lib/support/settings.ts:cache": { reason: "shared: the platform's support settings and brand name, the same for every workspace — cleared by the console on save" },
  "src/lib/support/console.ts:opened": { reason: "console-wide: when each staff member last had each support attachment's opening audited (ten-minute dedupe, bounded) — platform staff, no workspace's data" },
  "src/lib/partners/settings.ts:referralCookieCache": { reason: "shared: the platform's referral-cookie lifetime, a platform setting cached for a minute — no workspace's data" },
  "src/lib/platform/linked/groups.ts:enabledCache": { reason: "shared: the platform's linked sign-in switch (kill switch), one per install — no workspace's data" },
  "src/lib/platform/name-rules.ts:cache": { reason: "shared: staff's rules for new workspace names (control plane), the same for every workspace — read every 30 s, and again after a change" },
  "src/lib/platform/name-rules.ts:generation": { reason: "shared: counts the name rules cache's invalidations, so a read begun before one is not stored — no workspace data" },
  "src/lib/platform/name-rules.ts:lastFailureLog": { reason: "shared: when a failed read of the name rules was last logged (at most once a minute)" },
  "src/lib/platform/find-workspaces.ts:allowances": { reason: "shared: the public site's request counts (find my workspaces, the contact form, the address an invitation holds), keyed platform|… by hashed address, caller or all — no workspace's data" },
  "src/lib/tenancy/log-labels.ts:requestStore": { reason: "shared: a reference to Next's own request store, looked up once — it holds no workspace's data" },

  "src/lib/access/lock.ts:testLock": { reason: "test override, set only by check scripts" },
  "src/lib/copilot/providers/index.ts:override": { reason: "test override, set only by check scripts" },
  "src/lib/copilot/settings.ts:testSettings": { reason: "test override, set only by check scripts" },
  "src/lib/documents/pdf.ts:testRenderer": { reason: "test override, set only by check scripts" },
  "src/lib/mail/microsoft.ts:endpoints": { reason: "test override of Microsoft's addresses, set only by check scripts" },
  "src/lib/platform/mailer.ts:testSender": { reason: "test override, set only by check scripts — no check sends platform mail" },
  "src/lib/platform/domains.ts:testResolver": { reason: "test override, set only by check scripts — no check asks real DNS" },
};

// ─── The scan ────────────────────────────────────────────────────────────────────────────────────

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

const files = walk(SRC).map((file) => {
  const text = readFileSync(file, "utf8");
  return { file: rel(file), text, client: /^\s*["']use client["']/.test(text) };
});

function parse(file: string, text: string) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const found = {
  arrayTx: [] as string[],
  clients: new Set<string>(),
  env: new Set<string>(),
  xfh: new Set<string>(),
  xff: new Set<string>(),
  spawns: new Map<string, boolean>(),
  state: new Set<string>(),
  nextCache: [] as string[],
  after: [] as string[],
};

for (const { file, text, client } of files) {
  // A client under any name: `PrismaClient` from @prisma/client or the control plane's generated client,
  // however it is aliased on import.
  const clientNames = new Set(["PrismaClient"]);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](@prisma\/client|@deskzo\/control-client|@deskzo\/reference-client)["']/g)) {
    for (const spec of m[1].split(",")) {
      const alias = spec.trim().match(/^PrismaClient(?:\s+as\s+(\w+))?$/);
      if (alias) clientNames.add(alias[1] ?? "PrismaClient");
    }
  }
  if ([...clientNames].some((name) => new RegExp(`new\\s+${name}\\s*\\(`).test(text))) found.clients.add(file);
  if (PLATFORM_ENV.test(text)) found.env.add(file);
  if (/["'`]x-forwarded-host["'`]/i.test(text) && file !== "src/lib/tenancy/host.ts") found.xfh.add(file);
  if (/["'`]x-(forwarded-for|real-ip)["'`]/i.test(text) && file !== "src/lib/client-ip.ts") found.xff.add(file);
  if (/^\s*["']use cache["']/m.test(text) || /\bunstable_cache\b/.test(text)) found.nextCache.push(file);
  if (/import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\/server["']/.test(text) && !file.startsWith("src/lib/tenancy/")) found.after.push(file);

  const sf = parse(file, text);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "$transaction" &&
      node.arguments[0] &&
      // Only a callback is the interactive form; a literal array or a .map() of queries is the batch form.
      !ts.isArrowFunction(node.arguments[0]) &&
      !ts.isFunctionExpression(node.arguments[0])
    ) {
      found.arrayTx.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    if (ts.isCallExpression(node) && node.expression.getText(sf) === "spawn" && node.arguments[0]?.getText(sf) === "process.execPath") {
      found.spawns.set(file, (found.spawns.get(file) ?? true) && /DESKZO_TENANT_ID/.test(node.getText(sf)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Module-level state, in server code only: a "use client" module lives in one person's browser.
  if (client) continue;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const isLet = (st.declarationList.flags & ts.NodeFlags.Let) !== 0;
    for (const d of st.declarationList.declarations) {
      const name = d.name.getText(sf);
      const init = d.initializer?.getText(sf) ?? "";
      if (isLet) {
        found.state.add(`${file}:${name}`);
        continue;
      }
      if (/^new (Map|Set|WeakMap|WeakSet)\b/.test(init)) {
        // A const collection that is filled once and only read is a lookup table, not state.
        const mutated = new RegExp(`\\b${name}\\s*\\.\\s*(set|add|delete|clear)\\s*\\(`).test(text);
        if (mutated) found.state.add(`${file}:${name}`);
      }
    }
  }
}

function judge(label: string, seen: Set<string> | string[], allowed: Record<string, Allowed>) {
  const seenSet = new Set(seen);
  const unlisted = [...seenSet].filter((k) => !allowed[k]);
  const stale = Object.keys(allowed).filter((k) => !seenSet.has(k));
  ok(`${label}: nothing new`, unlisted.length === 0, unlisted.join(", "));
  ok(`${label}: the list is current`, stale.length === 0, stale.length ? `no longer found — take off the list: ${stale.join(", ")}` : "");
}

section("Transactions");
ok("only interactive $transaction — no arrays, no .map() of queries", found.arrayTx.length === 0, found.arrayTx.join(", "));

section("Database clients");
judge("new PrismaClient()", found.clients, PRISMA_CLIENTS);

section("The install's own database, secret and address");
judge("platform env reads", found.env, ENV_READS);
judge("x-forwarded-host", found.xfh, FORWARDED_HOST);
judge("x-forwarded-for / x-real-ip", found.xff, FORWARDED_FOR);

section("Worker processes");
const unscoped = [...found.spawns].filter(([, scoped]) => !scoped).map(([f]) => f);
judge("spawns without DESKZO_TENANT_ID", unscoped, SPAWNS);

section("Module-level state");
judge("caches, counters and timers", found.state, STATE);
const unkeyed = Object.entries(STATE)
  .filter(([, a]) => a.keyed)
  .map(([k]) => k.split(":")[0])
  .filter((file, i, all) => all.indexOf(file) === i)
  .filter((file) => !/import \{[^}]*\btenantKey\b[^}]*\} from "@\/lib\/tenancy\/cache"/.test(files.find((x) => x.file === file)?.text ?? ""));
ok("every per-workspace cache is keyed by tenantKey()", unkeyed.length === 0, unkeyed.join(", "));
const bareThrottles = files
  .filter((x) => x.file !== "src/lib/security/throttle.ts")
  .flatMap((x) => [...x.text.matchAll(/\bthrottle\(([^,]+),/g)].map((m) => ({ file: x.file, arg: m[1].trim() })))
  .filter((c) => !c.arg.startsWith("`${await tenantKey()}|") && !c.arg.startsWith("`${workspace}|"));
ok("every throttle() key starts with the workspace", bareThrottles.length === 0, bareThrottles.map((c) => `${c.file}: ${c.arg}`).join("; "));

section("Caches Next shares across workspaces");
ok('no "use cache" or unstable_cache', found.nextCache.length === 0, found.nextCache.join(", "));
ok("no bare after() — tenantAfter() instead", found.after.length === 0, found.after.join(", "));
const root = readFileSync(path.join(SRC, "app", "layout.tsx"), "utf8");
ok("every page renders per request (root layout is force-dynamic)", /export const dynamic = "force-dynamic"/.test(root));
const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
ok("workspace subdomains may load dev assets", /allowedDevOrigins:\s*\[\s*"\*\.localhost"/.test(config));

section("Browser bundles");
/**
 * A client component that imports — however indirectly — a module that reaches src/lib/tenancy
 * pulls node:async_hooks into the browser bundle, and Turbopack refuses to build the page. Found
 * when a table imported a label from a file that also queried the database. Constants and helpers
 * a client component needs belong in a file of their own (see src/lib/portal/state-labels.ts).
 */
{
  const byFile = new Map(files.map((x) => [path.join(ROOT, x.file), x]));
  const resolveImport = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = path.join(path.dirname(from), spec);
    else return null;
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      if (byFile.has(cand)) return cand;
    }
    return null;
  };
  const importsOf = (file: string): string[] => {
    const src = byFile.get(file)?.text ?? "";
    const specs = [
      ...[...src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...src.matchAll(/^import\s+["']([^"']+)["']/gm)].map((m) => m[1]),
    ];
    return specs.map((spec) => resolveImport(file, spec)).filter((r): r is string => !!r);
  };
  // The control plane's client and the platform key are server-only for the same reason.
  const serverOnly = [path.join(SRC, "lib", "tenancy"), path.join(SRC, "lib", "platform")].map((d) => d + path.sep);
  const chains: string[] = [];
  for (const start of [...byFile.keys()].filter((f) => byFile.get(f)!.client)) {
    const seen = new Set<string>();
    const stack: [string, string[]][] = [[start, [start]]];
    while (stack.length) {
      const [file, trail] = stack.pop()!;
      for (const next of importsOf(file)) {
        if (seen.has(next)) continue;
        seen.add(next);
        // A "use server" module reaches the browser only as a reference, never its code.
        if (/^\s*["']use server["']/.test(byFile.get(next)?.text ?? "")) continue;
        const t = [...trail, next];
        if (serverOnly.some((d) => next.startsWith(d))) {
          chains.push(t.map((p) => rel(p)).join(" → "));
          continue;
        }
        stack.push([next, t]);
      }
    }
  }
  ok("no client component reaches src/lib/tenancy or src/lib/platform", chains.length === 0, chains.join("; "));
}

section("What is left, by milestone");
const pending = new Map<string, number>();
for (const list of [PRISMA_CLIENTS, ENV_READS, FORWARDED_HOST, FORWARDED_FOR, SPAWNS, STATE]) {
  for (const entry of Object.values(list)) if (entry.pending) pending.set(entry.pending, (pending.get(entry.pending) ?? 0) + 1);
}
for (const [milestone, count] of [...pending].sort()) console.log(`  ${milestone}: ${count} place${count === 1 ? "" : "s"} to convert`);

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll tenancy checks passed.");
process.exit(failures ? 1 : 0);
