/**
 * Whether the settings catalogue tells the truth.
 *
 * `src/lib/settings/catalogue.ts` is the only list of settings in the app: the index of grouped
 * cards and the sidebar are both renderings of it. That makes it load-bearing in a way a menu
 * usually is not, and it fails in ways nobody notices:
 *
 *   · **A key that does not exist.** `mayOpen` asks whether the person holds the named permission.
 *     An unheld key and a misspelt key are indistinguishable, so "accounting.manage" — which is not
 *     a permission in this app — hid the chart of accounts from everybody including a super admin,
 *     silently, and would have gone on doing so.
 *   · **A key the destination does not test.** Backups was listed under `settings.manage` while the
 *     page required `backups.manage`: offered to people it would refuse, hidden from the one person
 *     the key exists for. That is the invitation-to-a-locked-door problem, in both directions at
 *     once.
 *   · **A link to nothing**, after a route is renamed.
 *   · **A page reachable from nowhere**, after one is added — which is how the previous navigation
 *     ended up listing six of the fourteen settings screens.
 *
 *   npm run check:settings
 *
 * Pure: the catalogue, the permission registry and the page sources are all read off disk.
 */
import fs from "node:fs";
import path from "node:path";
import { SETTINGS, SETTINGS_ITEMS, mayOpen, activeSettingsKey, visibleSettings } from "../src/lib/settings/catalogue";
import { PERMISSIONS } from "../src/lib/permissions";
import { MODULE_REGISTRY } from "../src/lib/modules";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

const APP = "src/app/(dashboard)";

/** The file that renders a route, or null when nothing does. */
function pageFor(href: string): string | null {
  const candidate = path.join(APP, href.replace(/^\//, ""), "page.tsx");
  return fs.existsSync(candidate) ? candidate : null;
}

/** Every permission key a page source tests, however it phrases the test. */
function gatesIn(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bcan\(\s*[A-Za-z0-9_.?!]+\s*,\s*"([^"]+)"/g)) keys.add(m[1]!);
  for (const m of source.matchAll(/hasEffectivePermission\(\s*[A-Za-z0-9_.?!]+\s*,\s*"([^"]+)"/g)) keys.add(m[1]!);
  return [...keys];
}

function main() {
  const permissionKeys = new Set(PERMISSIONS.map((p) => p.key));
  const moduleKeys = new Set(MODULE_REGISTRY.map((m) => m.key));

  section("The catalogue is well formed");

  const keys = SETTINGS_ITEMS.map((i) => i.key);
  ok("Every entry has a unique key", new Set(keys).size === keys.length, `${keys.length} entries`);

  const hrefs = SETTINGS_ITEMS.map((i) => i.href);
  ok("  and a unique destination", new Set(hrefs).size === hrefs.length, `${new Set(hrefs).size} routes`);

  ok(
    "  a label and a description each",
    SETTINGS_ITEMS.every((i) => i.label.trim().length > 0 && i.description.trim().length > 0),
  );

  // A description that just restates the label tells a reader nothing they did not already see.
  const lazy = SETTINGS_ITEMS.filter((i) => i.description.toLowerCase().trim() === i.label.toLowerCase().trim());
  ok("  and the description says something the label does not", lazy.length === 0, lazy.map((i) => i.key).join(", "));

  section("Every key is a real key");

  for (const item of SETTINGS_ITEMS) {
    if (item.permission === null) continue;
    const named = Array.isArray(item.permission) ? item.permission : [item.permission];
    for (const key of named) {
      /**
       * A prefix is checked against the registry too, by asking whether anything starts with it.
       * `data.` is not a key, but ten keys begin with it; a typo like `dta.` matches none and would
       * otherwise hide Import & export from everybody.
       */
      const real = item.permissionPrefix
        ? [...permissionKeys].some((k) => k.startsWith(key))
        : permissionKeys.has(key);
      ok(`${item.key} → ${key}`, real, real ? "" : "no such permission");
    }
  }

  section("Every module named is a real module");

  for (const item of SETTINGS_ITEMS.filter((i) => i.module)) {
    ok(`${item.key} → ${item.module}`, moduleKeys.has(item.module!));
  }

  section("Every destination exists");

  for (const item of SETTINGS_ITEMS) {
    const file = pageFor(item.href);
    ok(`${item.key} → ${item.href}`, file !== null, file ?? "no page renders this route");
  }

  section("Every settings page is reachable");

  const settingsDir = path.join(APP, "settings");
  const routes = fs
    .readdirSync(settingsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(settingsDir, e.name, "page.tsx")))
    .map((e) => `/settings/${e.name}`);

  for (const route of routes) {
    const listed = SETTINGS_ITEMS.some((i) => i.href === route);
    // The failure this catches: a feature adds a settings screen, links it from its own module, and
    // it never appears in Settings — which is how e-way bills was reachable only by typing the URL.
    ok(`${route} is in the catalogue`, listed, listed ? "" : "reachable only by typing the URL");
  }

  section("The link and the page agree");

  for (const item of SETTINGS_ITEMS) {
    if (!item.href.startsWith("/settings/")) continue;
    const file = pageFor(item.href);
    if (!file) continue;

    const source = fs.readFileSync(file, "utf8");
    const gates = gatesIn(source);

    /**
     * A page rendered through `<SettingsPage settingsKey=…>` takes its gate from this very
     * catalogue, so the two cannot disagree — there is nothing to compare. Only a page that states
     * its own gate has to be checked against what the link promises.
     */
    if (source.includes("settingsKey=")) {
      const declared = /settingsKey="([^"]+)"/.exec(source)?.[1];
      ok(`${item.key}: gate derived from the catalogue`, declared === item.key, declared ?? "none");
      continue;
    }

    if (gates.length === 0) {
      ok(`${item.key}: states a gate`, item.permission === null, item.permission === null ? "open by design" : "none found");
      continue;
    }

    const named = item.permission === null ? [] : Array.isArray(item.permission) ? item.permission : [item.permission];
    const agrees = item.permissionPrefix
      ? gates.some((g) => named.some((n) => g.startsWith(n)))
      : gates.some((g) => named.includes(g));

    ok(
      `${item.key}: the link names what the page tests`,
      agrees,
      agrees ? gates.join(", ") : `link says ${named.join("/") || "open"}, page tests ${gates.join(", ")}`,
    );
  }

  section("Filtering");

  const nobody = visibleSettings([], []);
  // The personal ones only: your own profile is not an administrator's to withhold.
  const openToAll = SETTINGS_ITEMS.filter((i) => i.permission === null && !i.module);
  ok(
    "Somebody with no permissions sees only what needs none",
    nobody.flatMap((s) => s.groups.flatMap((g) => g.items)).length === openToAll.length,
    openToAll.map((i) => i.key).join(", "),
  );

  const admin = visibleSettings([...permissionKeys], [...moduleKeys]);
  ok(
    "  and somebody holding everything sees all of it",
    admin.flatMap((s) => s.groups.flatMap((g) => g.items)).length === SETTINGS_ITEMS.length,
    `${SETTINGS_ITEMS.length} entries`,
  );

  ok(
    "  an empty group is dropped rather than left as a heading with nothing under it",
    nobody.every((s) => s.groups.every((g) => g.items.length > 0)),
  );

  const backups = SETTINGS_ITEMS.find((i) => i.key === "backups")!;
  ok("  a settings.manage admin is not offered Backups", !mayOpen(backups, ["settings.manage"]));
  ok("    and a backups.manage holder is", mayOpen(backups, ["backups.manage"]));

  const data = SETTINGS_ITEMS.find((i) => i.key === "data")!;
  // An accountant who exports statements is not an administrator; the prefix is what lets them in.
  ok("  one export key opens Import & export", mayOpen(data, ["data.exportFinance"]));
  ok("    and an unrelated key does not", !mayOpen(data, ["orders.process"]));

  section("Which entry a path is looking at");

  ok("/settings/data is Import & export", activeSettingsKey("/settings/data") === "data");
  ok("  /settings itself is nothing — it is the index", activeSettingsKey("/settings") === null);
  ok("  a nested route still highlights its parent", activeSettingsKey("/settings/access/somebody") === "access");
  ok("  an unrelated page highlights nothing", activeSettingsKey("/companies") === null);

  section("Coverage");

  const sections = SETTINGS.length;
  const groups = SETTINGS.reduce((n, s) => n + s.groups.length, 0);
  ok(
    "The catalogue covers every settings route and then some",
    SETTINGS_ITEMS.length >= routes.length,
    `${SETTINGS_ITEMS.length} entries · ${sections} sections · ${groups} groups · ${routes.length} routes under /settings`,
  );

  console.log(failures === 0 ? "\nAll settings checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exitCode = 1;
}

main();
