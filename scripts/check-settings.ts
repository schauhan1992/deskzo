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
import { firstMatch, searchSettings, searchWords } from "../src/lib/settings/search";
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
    // One module, or several of which any will do.
    const named: readonly string[] = typeof item.module === "string" ? [item.module] : item.module!;
    ok(`${item.key} → ${named.join(" | ")}`, named.length > 0 && named.every((key) => moduleKeys.has(key)));
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

  // Retired pages that only send an old link on to where it moved, and render nothing of their own.
  const RETIRED = new Set(["/settings/access"]);
  for (const route of routes) {
    if (RETIRED.has(route)) {
      const source = fs.readFileSync(path.join(settingsDir, route.replace("/settings/", ""), "page.tsx"), "utf8");
      ok(`${route} is retired: it only redirects`, /\bredirect\(/.test(source) && !/return \(/.test(source) && !SETTINGS_ITEMS.some((i) => i.href === route));
      continue;
    }
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

  // All of it that is out: an entry whose feature isn't released yet (the Deskzo app's) is nobody's.
  const unreleased = SETTINGS_ITEMS.filter((i) => i.released && !i.released()).map((i) => i.key);
  const owner = visibleSettings([...permissionKeys], [...moduleKeys], { superAdmin: true });
  const ownerKeys = owner.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  ok(
    "  and the super admin, holding everything, sees all of it that is out",
    ownerKeys.length === SETTINGS_ITEMS.length - unreleased.length && unreleased.every((k) => !ownerKeys.includes(k)),
    `${SETTINGS_ITEMS.length} entries${unreleased.length ? `, not yet out: ${unreleased.join(", ")}` : ""}`,
  );
  // Unmasking logs are the super admin's alone (src/actions/unmask-log.ts), whatever else one holds.
  const admin = visibleSettings([...permissionKeys], [...moduleKeys]);
  const adminKeys = admin.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  const superOnly = SETTINGS_ITEMS.filter((i) => i.superAdminOnly).map((i) => i.key);
  ok(
    "  an admin holding every permission sees everything but what is the super admin's alone",
    superOnly.length > 0 && superOnly.every((k) => !adminKeys.includes(k)) && adminKeys.length === SETTINGS_ITEMS.length - superOnly.length - unreleased.length,
    superOnly.join(", "),
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
  ok("  a nested route still highlights its parent", activeSettingsKey("/settings/users/new") === "users");
  ok("  an unrelated page highlights nothing", activeSettingsKey("/companies") === null);

  section("Search");

  // The menu and the All settings page both narrow by typing (owner, 16 Oct 2026). Every word must
  // appear in the setting, or the group or section it sits under; case, accents and endings don't count.
  const found = (term: string) => searchSettings(SETTINGS, term).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  const labelOf = (key: string) => SETTINGS_ITEMS.find((i) => i.key === key)?.label ?? key;
  const labelsFor = (term: string) => found(term).map(labelOf).join(" | ") || "nothing";
  const finds = (term: string, labels: string[]) => {
    const got = found(term).map(labelOf);
    ok(`"${term}" finds ${labels.join(", ")}`, labels.every((l) => got.includes(l)), labelsFor(term));
  };

  finds("mail", ["Document emails", "Mail & messaging", "Support email"]);
  finds("invoice", ["e-Invoicing"]);
  finds("roles", ["Roles & Permissions"]);
  // Word endings: neither name says "notifications" or "pipelines" — only the stem finds them.
  finds("notifications", ["Notification preferences"]);
  finds("pipelines", ["Pipeline"]);
  // Branches (under Staff) says GSTIN only in its description.
  finds("gstin", ["Branches"]);
  finds("MAIL", ["Mail & messaging"]);
  finds("  mail  ", ["Mail & messaging"]);
  ok("  an accent is folded away — \"máil\" is \"mail\"", found("m\u00e1il").join() === found("mail").join());
  ok("  every word must match — \"support mail\" is narrower than \"mail\"", found("support mail").length > 0 && found("support mail").length < found("mail").length, labelsFor("support mail"));
  ok("  nonsense finds nothing", found("zzqxv").length === 0);
  ok("  a blank search is everything, untouched", searchSettings(SETTINGS, "   ") === SETTINGS);
  ok("  punctuation alone is a blank search", searchWords("—, /").length === 0);

  const narrowed = searchSettings(SETTINGS, "mail");
  ok(
    "  no empty group or section is left behind",
    narrowed.every((s) => s.groups.length > 0 && s.groups.every((g) => g.items.length > 0)),
  );
  const order = SETTINGS_ITEMS.map((i) => i.key);
  const mailKeys = found("mail");
  ok(
    "  matches keep the catalogue's order",
    mailKeys.every((k, n) => n === 0 || order.indexOf(mailKeys[n - 1]!) < order.indexOf(k)),
  );
  ok("Enter opens the first match", firstMatch(narrowed)?.key === mailKeys[0], firstMatch(narrowed)?.label);
  ok("  and nothing when nothing matches", firstMatch(searchSettings(SETTINGS, "zzqxv")) === null);
  const hidden = visibleSettings(["settings.view"], [], {}).flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)));
  ok(
    "  a search never finds what the viewer can't open",
    searchSettings(visibleSettings(["settings.view"], [], {}), "mail")
      .flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.key)))
      .every((k) => hidden.includes(k)),
  );

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
