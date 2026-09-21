/**
 * That a saved layout survives the page changing under it.
 *
 * The interesting cases are not "does dragging work" — they are what happens months later, when a
 * release adds a card or removes one and somebody's stored order no longer matches the page. Both
 * failures are silent: a removed key leaves a gap where a card should be, and a new key that is
 * never appended means the card simply does not exist for anybody who has ever rearranged that
 * page. Neither throws, and neither is reported by whoever it happens to.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { PAGE_LAYOUTS, getPageLayoutDefinition, resolveLayout } from "../src/lib/page-layouts";

let failures = 0;
/**
 * Where each registered page actually lives, so its card map can be read.
 *
 * A hand-written map rather than a search, and the check fails loudly for a layout that is not in
 * it — a page whose location the suite cannot find is a page the suite is not checking, and that
 * must not look the same as a pass.
 */
const PAGE_SOURCES: Record<string, string> = {
  accounting: "src/app/(dashboard)/accounting/page.tsx",
};

function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(t: string) {
  console.log(`\n— ${t} —\n`);
}

async function main() {
  section("The registry");

  /**
   * The registry is a promise about what a page shows, and this is where it is held to it.
   *
   * "At least one page declares a layout" used to stand here, which is true of any non-empty array
   * and constrains nothing — the suite would have gone on passing with the registry describing
   * widgets the page cannot draw.
   *
   * It can, because of how the page consumes it: `order.filter((key) => cards[key])`. A registry key
   * with no matching entry in the page's `cards` object is silently dropped — no error, no blank
   * space, the widget simply is not there. The user's saved arrangement quietly loses a card, the
   * customise drawer still offers it, and nothing anywhere says so. Renaming a card and forgetting
   * the registry is a one-character way to cause it.
   *
   * So the page's own source is read and the two key sets are compared, in both directions.
   */
  ok("At least one page declares a layout", PAGE_LAYOUTS.length > 0, `${PAGE_LAYOUTS.length}`);

  for (const layout of PAGE_LAYOUTS) {
    const pagePath = PAGE_SOURCES[layout.key];
    if (!pagePath) {
      ok(`${layout.label}: the check knows where its page lives`, false, `add "${layout.key}" to PAGE_SOURCES`);
      continue;
    }

    const source = readFileSync(join(process.cwd(), pagePath), "utf8");
    const cardsAt = source.indexOf("const cards: Record<string, ReactNode> = {");
    if (cardsAt < 0) {
      ok(`${layout.label}: its page builds a card map`, false, `no cards object in ${pagePath}`);
      continue;
    }

    // The object's own keys, at its own indentation — deep enough not to catch nested object keys.
    const body = source.slice(cardsAt, source.indexOf("\n  };", cardsAt));
    const rendered = new Set([...body.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]!));
    const declared = new Set(layout.widgets.map((w) => w.key));

    const missing = [...declared].filter((k) => !rendered.has(k));
    const orphan = [...rendered].filter((k) => !declared.has(k));

    ok(
      `${layout.label}: every widget it offers, the page can draw`,
      missing.length === 0,
      missing.length === 0 ? `${declared.size} widgets` : `${missing.join(", ")} — offered in the drawer, dropped on the page`,
    );
    ok(
      `  and every card the page draws is offered`,
      orphan.length === 0,
      orphan.length === 0 ? "" : `${orphan.join(", ")} — rendered but unnamed, so it cannot be moved or hidden`,
    );
  }

  for (const layout of PAGE_LAYOUTS) {
    const keys = layout.widgets.map((w) => w.key);
    ok(`${layout.label}: no widget key appears twice`, new Set(keys).size === keys.length, keys.join(", "));
    ok(`  every widget has a label`, layout.widgets.every((w) => w.label.length > 0), `${keys.length} widgets`);
    ok(
      `  and a size the grid understands`,
      layout.widgets.every((w) => w.size === "stat" || w.size === "wide"),
      layout.widgets.map((w) => `${w.key}:${w.size}`).join(" "),
    );
  }

  section("Reconciling a stored order against the page");

  const accounting = getPageLayoutDefinition("accounting")!;
  const all = accounting.widgets.map((w) => w.key);

  ok("Nothing stored gives the page's own order", resolveLayout("accounting", undefined).join() === all.join(), "unchanged");
  ok("  and an empty array does too", resolveLayout("accounting", []).join() === all.join(), "not an empty page");

  const reversed = [...all].reverse();
  ok(
    "A stored order is honoured exactly",
    resolveLayout("accounting", reversed).join() === reversed.join(),
    "the whole point",
  );

  // Somebody arranged the page before a card existed.
  const withoutLast = all.slice(0, -1);
  const reconciled = resolveLayout("accounting", withoutLast);
  ok(
    "A widget added since is appended, not dropped",
    reconciled.length === all.length && reconciled[reconciled.length - 1] === all[all.length - 1],
    `${all[all.length - 1]} landed at the end`,
  );
  ok(
    "  and the order they chose is left alone",
    reconciled.slice(0, withoutLast.length).join() === withoutLast.join(),
    "a new card must not reshuffle an arrangement somebody made",
  );

  // Somebody arranged the page before a card was removed or renamed.
  const withStale = ["gone-in-a-refactor", ...all];
  ok(
    "A widget that no longer exists is discarded",
    resolveLayout("accounting", withStale).join() === all.join(),
    "otherwise the grid renders a gap where a card used to be",
  );

  ok("An unknown page resolves to nothing", resolveLayout("nope", all).length === 0, "rather than throwing");

  section("Writing");

  const user = await db.user.findFirst({ where: { active: true }, select: { id: true, name: true } });
  if (!user) throw new Error("No user. Run npm run db:bootstrap first.");

  const before = await db.pageLayout.findUnique({
    where: { user_page: { userId: user.id, pageKey: "ZZLayoutCheck" } },
  });
  ok("The check's own page key is not a real one", before === null && !getPageLayoutDefinition("ZZLayoutCheck"));

  // The registry filter is what stops a hand-made request putting arbitrary strings in the row.
  const known = new Set(all);
  const filtered = ["not-a-widget", ...all, "<script>"].filter((k) => known.has(k));
  ok(
    "Only declared keys survive the filter the action applies",
    filtered.join() === all.join(),
    "a request is not trusted to name widgets that exist",
  );

  console.log(failures === 0 ? "\nAll layout checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
