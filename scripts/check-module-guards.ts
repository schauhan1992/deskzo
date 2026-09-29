/**
 * check:module-guards — no module's actions are reachable from a workspace whose plan leaves it out.
 *
 * Static, with the TypeScript compiler:
 *
 *   · every file in src/actions is classified in src/lib/module-actions.ts, and nothing listed there
 *     is missing; every module named is a real, non-core one;
 *   · every exported function of a file a module owns calls `requireModuleUser` with that module
 *     (or, for a file several own, some of them) — directly, or through a local helper that does;
 *   · every exported function of a public file calls `moduleAvailableForTenant`, or is listed as
 *     always open with a reason;
 *   · a page, layout or server component that uses a module's actions from outside that module's
 *     own pages mentions the module — the check it makes before asking. A module outside the plan
 *     would otherwise break the page that borrowed from it, instead of quietly not being there.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ACTION_MODULES, ALWAYS_OPEN } from "../src/lib/module-actions";
import { withDependencies } from "../src/lib/entitlements";
import { MODULE_REGISTRY, getModuleDefinition } from "../src/lib/modules";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —`);

const ROOT = process.cwd();
const ACTIONS = path.join(ROOT, "src", "actions");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (full: string, from: string) => path.relative(from, full).split(path.sep).join("/");

// ─── The functions in a file, and which of them reach a guard ─────────────────────────────────

type Fn = { name: string; exported: boolean; body: ts.Node };

function functionsOf(source: ts.SourceFile): { fns: Fn[]; otherExports: string[] } {
  const fns: Fn[] = [];
  const otherExports: string[] = [];
  const exportedMod = (node: ts.Node) => !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      fns.push({ name: stmt.name.text, exported: exportedMod(stmt), body: stmt.body });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = exportedMod(stmt);
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          fns.push({ name: decl.name.text, exported, body: init.body });
        } else if (exported && ts.isIdentifier(decl.name)) {
          otherExports.push(decl.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (!el.isTypeOnly) otherExports.push(el.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name && exportedMod(stmt)) {
      otherExports.push(stmt.name.text);
    }
  }
  return { fns, otherExports };
}

/** The names called anywhere inside a node, with their first argument. */
function callsIn(node: ts.Node): { name: string; arg: ts.Expression | undefined }[] {
  const out: { name: string; arg: ts.Expression | undefined }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) out.push({ name: n.expression.text, arg: n.arguments[0] });
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The module keys a guard call names, or null when they are not written out as literals. */
function literalKeys(arg: ts.Expression | undefined): string[] | null {
  if (!arg) return null;
  if (ts.isStringLiteral(arg)) return [arg.text];
  if (ts.isArrayLiteralExpression(arg) && arg.elements.every(ts.isStringLiteral)) return arg.elements.map((e) => (e as ts.StringLiteral).text);
  return null;
}

/** Which functions reach a qualifying guard — directly, or through a local function that does. */
function guarded(fns: Fn[], qualifies: (call: { name: string; arg: ts.Expression | undefined }) => boolean): Set<string> {
  const calls = new Map(fns.map((f) => [f.name, callsIn(f.body)]));
  const set = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of fns) {
      if (set.has(f.name)) continue;
      if (calls.get(f.name)!.some((c) => qualifies(c) || set.has(c.name))) {
        set.add(f.name);
        grew = true;
      }
    }
  }
  return set;
}

// ─── The map ───────────────────────────────────────────────────────────────────────────────────

section("Every action file is classified");
const actionFiles = walk(ACTIONS).map((f) => rel(f, ACTIONS));
const unlisted = actionFiles.filter((f) => !(f in ACTION_MODULES));
const stale = Object.keys(ACTION_MODULES).filter((f) => !actionFiles.includes(f));
ok("every file in src/actions is in src/lib/module-actions.ts", unlisted.length === 0, unlisted.join(", "));
ok("  and everything listed there exists", stale.length === 0, stale.join(", "));
const badKeys = Object.entries(ACTION_MODULES).flatMap(([file, scope]) =>
  Array.isArray(scope) ? scope.filter((k) => !getModuleDefinition(k) || getModuleDefinition(k)!.core).map((k) => `${file}:${k}`) : [],
);
ok("  every module named is a real one, and not a core one (a core module is always in the plan)", badKeys.length === 0, badKeys.join(", "));
const staleOpen = Object.keys(ALWAYS_OPEN).filter((k) => ACTION_MODULES[k.split(":")[0]!] !== "public");
ok("  every always-open action is in a public file", staleOpen.length === 0, staleOpen.join(", "));

// ─── The actions ───────────────────────────────────────────────────────────────────────────────

section("Every module action checks the plan");
let examined = 0;
const unguarded: string[] = [];
const notFunctions: string[] = [];
for (const [file, scope] of Object.entries(ACTION_MODULES)) {
  if (scope === "core" || scope === "platform" || !actionFiles.includes(file)) continue;
  const text = readFileSync(path.join(ACTIONS, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { fns, otherExports } = functionsOf(source);
  notFunctions.push(...otherExports.map((n) => `${file}:${n}`));
  const qualifies =
    scope === "public"
      ? (c: { name: string; arg: ts.Expression | undefined }) => c.name === "moduleAvailableForTenant" && !!literalKeys(c.arg)?.every((k) => getModuleDefinition(k))
      : (c: { name: string; arg: ts.Expression | undefined }) => {
          if (c.name !== "requireModuleUser") return false;
          const keys = literalKeys(c.arg);
          return !!keys && keys.length > 0 && keys.every((k) => scope.includes(k));
        };
  const reach = guarded(fns, qualifies);
  for (const f of fns.filter((fn) => fn.exported)) {
    examined += 1;
    if (reach.has(f.name)) continue;
    if (scope === "public" && ALWAYS_OPEN[`${file}:${f.name}`]) continue;
    unguarded.push(`${file}:${f.name}`);
  }
}
ok(`every exported action of a module's file checks its plan (${examined} examined)`, unguarded.length === 0, unguarded.join(", "));
ok("  and nothing else is exported from them — only functions can be checked", notFunctions.length === 0, notFunctions.join(", "));

// ─── Pages borrowing another module's actions ────────────────────────────────────────────────

section("A page that borrows a module's actions asks after the module first");
/** Each module's pages, longest first, so /items/brands is found before /items. */
const hrefs = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => [i.href, m.key] as const)).sort((a, b) => b[0].length - a[0].length);
/** Pages that are a module's own though its nav does not list them. */
const EXTRA_ROUTES: [string, string][] = [
  ["/documents", "sales_documents"],
  ["/documents", "purchase_documents"],
  // Printed or downloaded from inside the module: an HR letter, a payslip, an employee's document.
  ["/letters", "hr"],
  ["/payslips", "payroll"],
  ["/api/hr", "hr"],
];
/** Component folders that belong to one module. */
const COMPONENT_FOLDERS: Record<string, string[]> = {
  accounting: ["accounting"],
  assets: ["it_assets"],
  close: ["revenue_close"],
  credit: ["receivables"],
  documents: ["sales_documents", "purchase_documents"],
  forms: ["forms"],
  hr: ["hr"],
  notes: ["notes"],
  revenue: ["revenue_close"],
  support: ["helpdesk"],
  targets: ["targets"],
  tickets: ["helpdesk"],
  wins: ["wins"],
  workspace: ["workspace"],
};
/** The modules a file belongs to, with everything they require — which are always there with them. */
function ownModules(file: string): string[] {
  const path_ = rel(file, ROOT);
  const own: string[] = [];
  const page = path_.match(/^src\/app\/\((?:dashboard|print|tv)\)(\/.*?)\/[^/]+\.tsx?$/) ?? path_.match(/^src\/app(\/api\/.*?)\/[^/]+\.tsx?$/);
  if (page) {
    const route = page[1]!.replace(/\/\[[^\]]+\]/g, "/x");
    own.push(...hrefs.filter(([h]) => route === h || route.startsWith(`${h}/`)).map(([, k]) => k).slice(0, 1));
    own.push(...EXTRA_ROUTES.filter(([h]) => route === h || route.startsWith(`${h}/`)).map(([, k]) => k));
  }
  const folder = path_.match(/^src\/components\/([^/]+)\//)?.[1];
  if (folder) own.push(...(COMPONENT_FOLDERS[folder] ?? []));
  return [...withDependencies(own)];
}
/** In every plan, so always there to borrow from. */
const EVERYWHERE = new Set(MODULE_REGISTRY.filter((m) => m.core || m.inEveryPlan).map((m) => m.key));
const sources = [...walk(path.join(ROOT, "src", "app")), ...walk(path.join(ROOT, "src", "components")), ...walk(path.join(ROOT, "src", "lib"))];
const texts = new Map(sources.map((f) => [f, readFileSync(f, "utf8")]));
/**
 * Whether a file asks after one of these modules — in a call that answers that question, not merely
 * anywhere: a tab called "forms" is not a check that the Forms module is there.
 */
const CHECKS = "isModuleEnabled|isModuleEntitled|moduleAccess|moduleAccessFor|moduleAvailableForTenant|planGate|requireModuleUser";
const mentions = (file: string, keys: readonly string[]) =>
  keys.some((k) => {
    const key = k.replace(/[^a-z_]/g, "");
    const inCall = new RegExp(`\\b(?:${CHECKS})\\(\\s*(?:\\[[^\\]]*)?"${key}"`);
    // Also a copilot tool's `module: "..."`, which the tool list is filtered on (src/lib/copilot/tools.ts).
    return inCall.test(texts.get(file)!) || texts.get(file)!.includes(`moduleKey="${key}"`) || new RegExp(`\\bmodule: "${key}"`).test(texts.get(file)!);
  });
/** The files that import this one by its @/ path — a component is shown only where they put it. */
function importersOf(file: string): string[] {
  const spec = `from "@/${rel(file, path.join(ROOT, "src")).replace(/\.tsx?$/, "")}"`;
  return sources.filter((f) => texts.get(f)!.includes(spec));
}
const borrowed: string[] = [];
let serverFiles = 0;
for (const file of sources) {
  const text = texts.get(file)!;
  // A client component asks nothing on render; it is shown by a page that has already decided.
  if (/^\s*["']use client["']/.test(text)) continue;
  serverFiles += 1;
  const own = ownModules(file);
  for (const imp of text.matchAll(/from "@\/actions\/([a-z0-9/-]+)"/g)) {
    const scope = ACTION_MODULES[`${imp[1]}.ts`];
    if (!Array.isArray(scope) || scope.some((k) => own.includes(k) || EVERYWHERE.has(k))) continue;
    if (mentions(file, scope)) continue;
    // A component rendered only by files that ask after the module first.
    const importers = importersOf(file);
    if (importers.length > 0 && importers.every((f) => mentions(f, scope) || ownModules(f).some((k) => scope.includes(k)))) continue;
    borrowed.push(`${rel(file, ROOT)} ← ${imp[1]} (${scope.join("|")})`);
  }
}
ok(`every server file that borrows another module's actions mentions that module (${serverFiles} examined)`, borrowed.length === 0, borrowed.length ? `\n    ${borrowed.join("\n    ")}` : "");

console.log(failures === 0 ? "\nAll module guard checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
